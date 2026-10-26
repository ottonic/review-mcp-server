import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { runTool } from '../src/tool-helper.js';
import { resetDb } from '../src/db.js';
import { artifactReferenceSchema, subjectReferenceSchema } from '../src/revision.js';

type RegisteredTool = {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
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

function handler(name: string) {
  return (args: Record<string, unknown>) => {
    const tool = server._registeredTools[name];
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.handler(args);
  };
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
  artifact: { revision: string; units?: string };
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

it('does not infer units for legacy reviews that predate artifact-unit storage', async () => {
  const source = pathToFileURL(file).href;
  const oldRevision = `sha256:${'a'.repeat(64)}`;
  const legacy = new DatabaseSync(process.env.REVIEW_MCP_DB_PATH!);
  legacy.exec(`CREATE TABLE reviews (
    review_key TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    name TEXT,
    entity_ids TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    author TEXT NOT NULL DEFAULT 'ai',
    model_revision TEXT NOT NULL,
    entity_id_scheme TEXT NOT NULL DEFAULT 'occt-topology-v1',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  legacy
    .prepare(
      'INSERT INTO reviews (review_key, source_file, name, entity_ids, note, model_revision, entity_id_scheme) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(`${source}|legacy`, source, 'legacy', '["face:0"]', 'Unknown units', oldRevision, scheme);
  legacy.close();

  const nextRevision = `sha256:${'b'.repeat(64)}`;
  const recalled = resultData(
    await handler('recall')({ artifact: artifact(source, nextRevision, 'mm') }),
  );
  const saved = first(recalled.reviews);
  expect(saved.stale).toBe(true);
  expect(saved.artifact.revision).toBe(oldRevision);
  expect(saved.artifact).not.toHaveProperty('units');
  expect(saved.entities).toEqual(['face:0']);
  expect(saved.artifact).not.toHaveProperty('units');
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
