import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { runTool } from '../src/tool-helper.js';
import { resetDb } from '../src/db.js';
import { artifactReferenceSchema, subjectReferenceSchema } from '../src/revision.js';

type ParseOutcome = { success: true; data: unknown } | { success: false; error: unknown };
type RegisteredTool = {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  inputSchema: { safeParse: (value: unknown) => ParseOutcome };
};
type AnyServer = { _registeredTools: Record<string, RegisteredTool> };

let dir: string;
let file: string;
let revision: string;
let server: AnyServer;
const scheme = 'occt-topology-v1';
function artifact(uri = pathToFileURL(file).href, rev = revision, units = 'mm') {
  return { uri, revision: rev, format: 'step', units };
}

async function writeFixture(text = 'ISO-10303-21; HEADER; DATA; END-ISO-10303-21;') {
  await writeFile(file, text);
  revision = `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

async function hashFile(path: string) {
  return `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}

function registered(name: string): RegisteredTool {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

/**
 * Call a tool the way MCP does: validate the arguments against the declared
 * schema, then run the handler.
 *
 * Validation happens before dispatch, so a test that reaches straight for a
 * handler is not testing the interface a model sees — the gap that let a plain
 * filesystem path in `artifact.uri` reach a caller as `Invalid URL`. Schemas also
 * carry defaults, so skipping them changes the arguments the handler receives.
 */
function handler(name: string) {
  return (args: Record<string, unknown>) => {
    const tool = registered(name);
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(`arguments for ${name} failed the declared schema: ${String(parsed.error)}`);
    }
    return tool.handler(parsed.data as Record<string, unknown>);
  };
}

/** Validate only, for asserting the declared interface itself. */
function validate(name: string, args: Record<string, unknown>) {
  return registered(name).inputSchema.safeParse(args);
}

/** The first element, or a clear failure — keeps tests free of `!`. */
function first<T>(items: readonly T[]): T {
  const [head] = items;
  if (head === undefined) throw new Error('expected at least one item');
  return head;
}

type Review = {
  kind: string;
  name?: string;
  note?: string;
  tags: string[];
  revision: string;
  stale?: boolean;
  artifact: { revision: string; uri?: string; units?: string };
  entities: string[];
  entity_id_scheme: string;
};
type StructuredResult = {
  review: Review;
  reviews: Review[];
  current_revision?: string;
  deleted?: boolean;
};

function resultData(result: unknown): StructuredResult {
  return (result as { structuredContent: StructuredResult }).structuredContent;
}

function remember(filePath: string) {
  return (args: Record<string, unknown>) =>
    handler('remember')({
      artifact: artifact(pathToFileURL(filePath).href),
      entity_id_scheme: scheme,
      entities: ['face:0'],
      ...args,
    });
}
function recall(filePath: string) {
  return (args: Record<string, unknown>) =>
    handler('recall')({
      artifact: artifact(pathToFileURL(filePath).href),
      ...args,
    });
}
function forget(filePath: string) {
  return (args: Record<string, unknown>) =>
    handler('forget')({
      artifact: artifact(pathToFileURL(filePath).href),
      ...args,
    });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-mcp-'));
  process.env.REVIEW_MCP_DB_PATH = join(dir, 'review.db');
  resetDb();
  file = join(dir, 'part.step');
  await writeFixture();
  server = createServer() as unknown as AnyServer;
});

afterEach(async () => {
  resetDb();
  delete process.env.REVIEW_MCP_DB_PATH;
  await rm(dir, { recursive: true, force: true });
});

it('remember saves a named feature; re-remember REPLACES it', async () => {
  const a = await remember(file)({
    name: 'mounting holes',
    note: '4x M4',
    tags: ['holes'],
  });
  const revA = resultData(a).review;
  expect(revA.kind).toBe('feature');
  expect(revA.name).toBe('mounting holes');
  expect(revA.note).toBe('4x M4');
  expect(revA.tags).toEqual(['holes']);
  expect(revA.revision).toBe(revision);

  const b = await remember(file)({
    name: 'mounting holes',
    note: '5x M4',
    tags: ['holes'],
  });
  const revB = resultData(b).review;
  expect(revB.note).toBe('5x M4');
  expect(revB.tags).toEqual(['holes']);
});

it('remember anonymous note APPENDS to the same entity-set', async () => {
  const note = (text: string) => remember(file)({ entities: ['face:1', 'face:2'], note: text });
  const first = resultData(await note('thin here')).review;
  expect(first.kind).toBe('note');
  expect(first.name).toBeUndefined();

  const second = resultData(await note('and draft issues')).review;
  expect(second.note).toBe('thin here\n\nand draft issues');
});

it('recall filters by entity, search, and tags; returns current_revision', async () => {
  await remember(file)({
    name: 'bolt holes',
    entities: ['face:3', 'face:4'],
    note: 'six M6',
    tags: ['mount'],
  });
  await remember(file)({ entities: ['face:3'], note: 'recessed' });

  const all = resultData(await recall(file)({}));
  expect(all.reviews.length).toBe(2);
  expect(all.current_revision).toBe(revision);

  const byEntity = resultData(await recall(file)({ entity_id: 'face:4' }));
  expect(byEntity.reviews.length).toBe(1);
  expect(first(byEntity.reviews).name).toBe('bolt holes');

  const bySearch = resultData(await recall(file)({ search: 'six m6' }));
  expect(bySearch.reviews.length).toBe(1);
  expect(first(bySearch.reviews).name).toBe('bolt holes');
});

it('recall does not require the artifact file to be locally accessible', async () => {
  const missing = join(dir, 'does-not-exist.step');
  const result = (await recall(missing)({})) as { isError?: unknown };
  expect(result.isError).toBeUndefined();
  expect(resultData(result).reviews.length).toBe(0);
});

it('forget removes a named feature by name and an anonymous note by entity', async () => {
  await remember(file)({ name: 'bolt holes', entities: ['face:3'] });
  await remember(file)({ entities: ['face:7'], note: 'some note' });

  const delNamed = resultData(await forget(file)({ name: 'bolt holes' }));
  expect(delNamed.deleted).toBe(true);

  const afterNamed = resultData(await recall(file)({}));
  expect(afterNamed.reviews.length).toBe(1);

  const delNote = resultData(await forget(file)({ entity_id: 'face:7' }));
  expect(delNote.deleted).toBe(true);
  const afterNote = resultData(await recall(file)({}));
  expect(afterNote.reviews.length).toBe(0);
});

it('revision changes mark stale reviews', async () => {
  const revision1 = revision;
  await remember(file)({ name: 'old volume', note: 'v1' });
  await writeFixture('ISO-10303-21; DATA; DIFFERENT;');
  const revision2 = await hashFile(file);

  const result = resultData(
    await handler('recall')({
      artifact: artifact(pathToFileURL(file).href, revision2),
    }),
  );
  expect(result.current_revision).toBe(revision2);
  expect(first(result.reviews).stale).toBe(true);
  expect(first(result.reviews).artifact.revision).toBe(revision1);
  expect(first(result.reviews).artifact.revision).toBe(revision1);
});

it('preserves the stored artifact unit when recalled against a later revision', async () => {
  const source = pathToFileURL(file).href;
  await handler('remember')({
    artifact: artifact(source, revision, 'in'),
    entity_id_scheme: scheme,
    entities: ['face:0'],
    name: 'inch feature',
    note: 'Measured in inches.',
  });

  const nextRevision = `sha256:${'f'.repeat(64)}`;
  const recalled = resultData(
    await handler('recall')({ artifact: artifact(source, nextRevision, 'mm') }),
  );
  const saved = first(recalled.reviews);
  expect(saved.stale).toBe(true);
  expect(saved.artifact.revision).toBe(revision);
  expect(saved.artifact.units).toBe('in');
  expect(saved.entities).toEqual(['face:0']);
  expect(saved.entity_id_scheme).toBe(scheme);
});

it('does not invent a unit for a record stored without one', async () => {
  const source = pathToFileURL(file).href;
  await handler('remember')({
    artifact: { uri: source, revision, format: 'step' },
    entity_id_scheme: scheme,
    entities: ['face:0'],
    name: 'unitless feature',
    note: 'Stored before any unit was declared.',
  });

  const nextRevision = `sha256:${'b'.repeat(64)}`;
  const recalled = resultData(
    await handler('recall')({ artifact: artifact(source, nextRevision, 'mm') }),
  );
  const saved = first(recalled.reviews);
  expect(saved.stale).toBe(true);
  expect(saved.artifact.revision).toBe(revision);
  expect(saved.artifact).not.toHaveProperty('units');
  expect(saved.entities).toEqual(['face:0']);
});

it('anonymous notes remain scoped to artifact revision and ID scheme', async () => {
  const old = resultData(
    await remember(file)({ entities: ['face:0'], note: 'old revision fact' }),
  ).review;
  const nextRevision = `sha256:${'f'.repeat(64)}`;
  const next = resultData(
    await handler('remember')({
      artifact: artifact(pathToFileURL(file).href, nextRevision),
      entity_id_scheme: scheme,
      entities: ['face:0'],
      note: 'new revision fact',
    }),
  ).review;
  expect(old.note).toBe('old revision fact');
  expect(next.note).toBe('new revision fact');
  const recalled = resultData(
    await handler('recall')({
      artifact: artifact(pathToFileURL(file).href, nextRevision),
    }),
  );
  expect(recalled.reviews.length).toBe(2);
  expect(recalled.reviews.find((review) => review.note === 'old revision fact')?.stale).toBe(true);
});

it('accepts a filesystem path wherever it accepts an artifact URI', () => {
  const base = { revision, format: 'step', units: 'mm' };
  expect(
    validate('remember', {
      artifact: { ...base, uri: file },
      entity_id_scheme: scheme,
      entities: ['face:0'],
      note: 'a note',
    }).success,
  ).toBe(true);
  expect(validate('recall', { artifact: { ...base, uri: file } }).success).toBe(true);
  expect(validate('forget', { artifact: { ...base, uri: file } }).success).toBe(true);
  // The URI form is unchanged, and a locator still has to say something.
  expect(validate('recall', { artifact: { ...base, uri: pathToFileURL(file).href } }).success).toBe(
    true,
  );
  expect(validate('recall', { artifact: { ...base, uri: '' } }).success).toBe(false);
});

it('addresses one artifact by path or by URI, in either direction', async () => {
  // Saved with the URI Geometry reports, recalled with the path an engineer copied.
  await remember(file)({ name: 'mounting holes', note: '4x M4' });
  const byPath = resultData(await handler('recall')({ artifact: artifact(file) }));
  expect(byPath.reviews.map((review) => review.name)).toEqual(['mounting holes']);
  // Echoed as a URI, whichever spelling was sent.
  expect(first(byPath.reviews).artifact.uri).toBe(pathToFileURL(file).href);

  // Saved with a path, recalled with the URI.
  await handler('forget')({ artifact: artifact(file), name: 'mounting holes' });
  await handler('remember')({
    artifact: artifact(file),
    entity_id_scheme: scheme,
    entities: ['face:0'],
    name: 'bottom face',
  });
  const byUri = resultData(
    await handler('recall')({ artifact: artifact(pathToFileURL(file).href) }),
  );
  expect(byUri.reviews.map((review) => review.name)).toEqual(['bottom face']);

  // A relative path resolves against the server working directory.
  const byRelative = resultData(
    await handler('recall')({ artifact: artifact(relative(process.cwd(), file)) }),
  );
  expect(byRelative.reviews.map((review) => review.name)).toEqual(['bottom face']);
});

it('an entity filter on reviews is scoped to the revision that produced the face', async () => {
  await remember(file)({ entities: ['face:3'], note: 'near the bore' });
  const sameRevision = resultData(
    await handler('recall')({ artifact: artifact(), entity_id: 'face:3' }),
  );
  expect(sameRevision.reviews).toHaveLength(1);

  await writeFixture('ISO-10303-21; HEADER; DATA; /* second revision */ END-ISO-10303-21;');
  const laterRevision = resultData(
    await handler('recall')({ artifact: artifact(), entity_id: 'face:3' }),
  );
  expect(laterRevision.reviews).toEqual([]);

  // Text is not scoped that way: finding an earlier record is what search is for.
  const byText = resultData(await handler('recall')({ artifact: artifact(), search: 'bore' }));
  expect(first(byText.reviews).stale).toBe(true);
});

it('runTool returns text + structured output and surfaces errors', async () => {
  const ok = await runTool('t', async () => ({ ok: true }));
  expect(ok.structuredContent).toEqual({ ok: true });
  expect((ok.content[0] as { text: string }).text).toBe('{\n  "ok": true\n}');
  const bad = await runTool('t', async () => {
    throw new Error('boom');
  });
  expect(bad.isError).toBe(true);
});

it('accepts local ArtifactRef and SubjectRef examples', () => {
  const artifactFixture = {
    revision: `sha256:${'a'.repeat(64)}`,
    uri: 'file:///work/part.step',
    format: 'step',
    units: 'mm',
  };
  const subjectFixture = {
    type: 'geometry',
    artifact: artifactFixture,
    entity: {
      authority: 'cad-mcp-server',
      idScheme: 'occt-topology-v1',
      id: 'face:0',
      kind: 'face',
    },
  };
  expect(artifactReferenceSchema.safeParse(artifactFixture).success).toBe(true);
  expect(subjectReferenceSchema.safeParse(subjectFixture).success).toBe(true);
});

// ------------------------------------------------------------------ decisions

type DecisionItemView = {
  id: string;
  requirement: string;
  source: string;
  state: string;
  faces: string[];
  question?: string;
  verdict?: { verdict: string; note?: string };
};
type DecisionView = {
  subject: string;
  recommendation: string;
  confidence: string;
  status: string;
  basis: DecisionItemView[];
  artifact: { revision: string; uri?: string; units?: string };
  revision: string;
  stale?: boolean;
  supersedes?: string;
};
type DecisionsResult = {
  decision: DecisionView;
  replaced?: boolean;
  decisions: DecisionView[];
  current_revision?: string;
};

function decisionsData(result: unknown): DecisionsResult {
  return (result as { structuredContent: DecisionsResult }).structuredContent;
}

/** The error text of a refused call, or null when it succeeded. */
function errorText(result: unknown): string | null {
  const value = result as { isError?: boolean; content?: Array<{ text?: string }> };
  if (value.isError !== true) return null;
  return value.content?.[0]?.text ?? '';
}

/** One valid basis item; override whatever a test is about. */
function basisItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'solid-validity',
    requirement: 'The solid must be a valid closed B-rep.',
    source: 'standard',
    state: 'satisfied',
    evidence: 'inspect: is_valid=true, face_count=5',
    ...overrides,
  };
}

const RELEASE = 'Release of part.step';

function decisionArgs(overrides: Record<string, unknown> = {}) {
  return {
    artifact: artifact(),
    subject: RELEASE,
    recommendation: 'Hold until the drawing arrives.',
    confidence: 'medium',
    basis: [basisItem()],
    ...overrides,
  };
}

it('remember_decision saves a decision, then revises it in place at the same subject', async () => {
  const created = decisionsData(await handler('remember_decision')(decisionArgs()));
  expect(created.replaced).toBe(false);
  expect(created.decision.status).toBe('proposed');
  expect(created.decision.revision).toBe(revision);
  expect(created.decision.artifact.uri).toBe(pathToFileURL(file).href);
  // faces are always present, so a caller never has to tell absent from empty.
  expect(created.decision.basis[0]?.faces).toEqual([]);

  const revised = decisionsData(
    await handler('remember_decision')(
      decisionArgs({
        recommendation: 'Release for geometry-only purposes.',
        status: 'confirmed',
        basis: [basisItem({ verdict: { verdict: 'accepted', note: 'agreed, geometry-only' } })],
      }),
    ),
  );
  expect(revised.replaced).toBe(true);
  expect(revised.decision.recommendation).toBe('Release for geometry-only purposes.');
  expect(revised.decision.status).toBe('confirmed');
  expect(revised.decision.basis[0]?.verdict?.verdict).toBe('accepted');

  const recalled = decisionsData(await handler('recall_decisions')({ artifact: artifact() }));
  expect(recalled.decisions).toHaveLength(1);
  expect(first(recalled.decisions).recommendation).toBe('Release for geometry-only purposes.');
});

it('a different subject is a second decision, not a replacement', async () => {
  await handler('remember_decision')(decisionArgs());
  await handler('remember_decision')(decisionArgs({ subject: 'Coating callout' }));
  const recalled = decisionsData(await handler('recall_decisions')({ artifact: artifact() }));
  expect(recalled.decisions.map((decision) => decision.subject).sort()).toEqual([
    'Coating callout',
    RELEASE,
  ]);
});

it('recall_decisions keeps a decision on its own revision and marks it stale elsewhere', async () => {
  await handler('remember_decision')(decisionArgs());
  const madeAt = revision;
  await writeFixture('ISO-10303-21; HEADER; DATA; /* second revision */ END-ISO-10303-21;');

  const recalled = decisionsData(await handler('recall_decisions')({ artifact: artifact() }));
  const decision = first(recalled.decisions);
  expect(decision.stale).toBe(true);
  expect(decision.revision).toBe(madeAt);
  expect(decision.artifact.units).toBe('mm');
  expect(recalled.current_revision).toBe(revision);
});

it('an entity filter matches the exact face, and only in the revision that produced it', async () => {
  await handler('remember_decision')(
    decisionArgs({ subject: 'Face 30', basis: [basisItem({ faces: ['face:30'] })] }),
  );
  await handler('remember_decision')(
    decisionArgs({ subject: 'Face 3', basis: [basisItem({ faces: ['face:3'] })] }),
  );

  // 'face:3' must not match the 'face:30' entry.
  const exact = decisionsData(
    await handler('recall_decisions')({ artifact: artifact(), entity_id: 'face:3' }),
  );
  expect(exact.decisions.map((decision) => decision.subject)).toEqual(['Face 3']);

  // A face ID means nothing in another revision, so it does not match there...
  await writeFixture('ISO-10303-21; HEADER; DATA; /* second revision */ END-ISO-10303-21;');
  const later = decisionsData(
    await handler('recall_decisions')({ artifact: artifact(), entity_id: 'face:3' }),
  );
  expect(later.decisions).toEqual([]);

  // ...while the decision itself is still recalled, marked stale.
  const bySubject = decisionsData(
    await handler('recall_decisions')({ artifact: artifact(), subject: 'Face 3' }),
  );
  expect(first(bySubject.decisions).stale).toBe(true);
});

it('remember_decision refuses a basis item that cannot answer for itself', async () => {
  const noQuestion = await handler('remember_decision')(
    decisionArgs({ basis: [basisItem({ state: 'unresolved' })] }),
  );
  expect(errorText(noQuestion)).toContain('missing_question');

  // Two items sharing an id: an id addresses one line.
  const duplicate = await handler('remember_decision')(
    decisionArgs({ basis: [basisItem(), basisItem()] }),
  );
  expect(errorText(duplicate)).toContain('duplicate_basis_item');

  const answered = decisionsData(
    await handler('remember_decision')(
      decisionArgs({ basis: [basisItem({ state: 'unresolved', question: 'Which material?' })] }),
    ),
  );
  expect(answered.decision.basis[0]?.question).toBe('Which material?');
});

it('forget removes a decision by subject, and refuses a selection it cannot act on', async () => {
  await handler('remember_decision')(decisionArgs());
  const removed = resultData(await handler('forget')({ artifact: artifact(), subject: RELEASE }));
  expect(removed.deleted).toBe(true);
  const left = decisionsData(await handler('recall_decisions')({ artifact: artifact() }));
  expect(left.decisions).toEqual([]);

  // Two selectors is ambiguous, and no selector is not a silent success.
  const ambiguous = await handler('forget')({ artifact: artifact(), name: 'x', subject: 'y' });
  expect(errorText(ambiguous)).toContain('invalid_selection');
  const nothing = await handler('forget')({ artifact: artifact() });
  expect(errorText(nothing)).toContain('invalid_selection');
});
