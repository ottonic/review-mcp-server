import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getDb } from './db.js';
import {
  assertDecisionWellFormed,
  decisionInputSchema,
  decisionKey,
  decisionOutSchema,
  recallDecisionsInput,
  rowToDecision,
  type DecisionRow,
} from './decisions.js';
import { encodeEntityIds, entityIdPredicate, entityIdsOf } from './entities.js';
import {
  artifactAliases,
  artifactKey,
  artifactReferenceSchema,
  echoArtifact,
  subjectReference,
  subjectReferenceSchema,
} from './revision.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

type ReviewRow = {
  review_key: string;
  source_file: string;
  name: string | null;
  entity_ids: string;
  note: string;
  tags: string;
  model_revision: string;
  entity_id_scheme: string;
  artifact_units: string | null;
  created_at: string;
  updated_at: string;
};

// A named review is a FEATURE keyed by (source_file, name). An unnamed review
// is a NOTE anchored to an entity set, keyed by a stable JSON of sorted ids.
function namedKey(sourceFile: string, name: string): string {
  return sourceFile + '|' + name;
}
function anonymousKey(
  sourceFile: string,
  revision: string,
  idScheme: string,
  entityIds: string[],
): string {
  const sorted = [...entityIds].sort();
  return sourceFile + '|@' + revision + '|' + idScheme + '|' + JSON.stringify(sorted);
}
function normalizeTags(tags: string[] | undefined): string[] {
  return [
    ...new Set(
      (tags ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => t.replace(/^#/, '')),
    ),
  ];
}
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// Shared output schema: one revision-aware "review" block.
const reviewOut = z.object({
  kind: z.enum(['feature', 'note']),
  name: z.string().optional(),
  entities: z.array(z.string()),
  artifact: artifactReferenceSchema,
  entity_id_scheme: z.string(),
  note: z.string().optional(),
  tags: z.array(z.string()).default([]),
  revision: z.string(),
  stale: z.boolean().optional(),
  updatedAt: z.string().optional(),
});

// Convert a DB row to the portable review shape.
function rowToReview(
  row: ReviewRow,
  currentArtifact: z.output<typeof artifactReferenceSchema>,
  currentRevision?: string,
) {
  const ids = JSON.parse(row.entity_ids) as string[];
  const tags = JSON.parse(row.tags) as string[];
  const artifact = echoArtifact(
    { revision: row.model_revision, units: row.artifact_units },
    currentArtifact,
  );
  return {
    kind: row.name ? 'feature' : 'note',
    name: row.name ?? undefined,
    entities: ids,
    artifact,
    entity_id_scheme: row.entity_id_scheme,
    note: row.note || undefined,
    tags,
    revision: row.model_revision,
    stale: currentRevision ? row.model_revision !== currentRevision : undefined,
    updatedAt: row.updated_at,
  };
}

const rememberInput = z
  .object({
    artifact: artifactReferenceSchema,
    entity_id_scheme: z
      .string()
      .min(1)
      .describe(
        "ID scheme the entity IDs come from, as reported by the producer, e.g. 'occt-topology-v1' for Geometry. IDs are meaningless across schemes.",
      ),
    entities: z
      .array(z.string())
      .min(1)
      .describe(
        "Geometry this review refers to, e.g. ['face:26','face:27'] or component-scoped ['component:wheel-axle/face:0']. IDs come from a Geometry find_entities result.",
      ),
    name: z
      .string()
      .optional()
      .describe(
        "Optional feature name (a semantic, reusable label). Provide it when this is a named group like 'mounting holes' or 'bottom face'; omit for a plain note.",
      ),
    note: z
      .string()
      .optional()
      .describe(
        'Prose about the geometry. What does it do, what did we decide, what should we remember?',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Searchable tags (without '#'), e.g. ['holes','mount']."),
  })
  .strict();

const recallInput = z
  .object({
    artifact: artifactReferenceSchema,
    entity_id: z
      .string()
      .optional()
      .describe(
        "If set, only return reviews that include this entity (e.g. 'face:2' or a component-scoped 'component:wheel-axle/face:0').",
      ),
    search: z
      .string()
      .optional()
      .describe('Free-text match across feature names and note bodies (case-insensitive).'),
    tags: z
      .array(z.string())
      .optional()
      .describe("Only return reviews carrying all these tags (without '#')."),
    limit: z.number().int().min(1).default(100).optional().describe('Max reviews. Default 100.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .optional()
      .describe('Skip N reviews for pagination.'),
  })
  .strict();

const forgetInput = z
  .object({
    artifact: artifactReferenceSchema,
    name: z.string().optional().describe('Feature name to remove (when a named feature).'),
    entity_id: z
      .string()
      .optional()
      .describe('Entity whose anonymous notes to remove (when not named).'),
    subject: z
      .string()
      .optional()
      .describe('Subject of the decision to remove (when forgetting a decision).'),
  })
  .strict();

/** A registry entry with its input type erased so the array stays homogeneous. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (args: unknown) => Promise<Record<string, unknown>>;
}

/**
 * Erase a tool's per-tool input type so it can join a homogeneous registry while
 * the handler keeps its exact input type. MCP validates inputs before the
 * handler runs.
 */
function defineTool<I>(tool: {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (args: I) => Promise<Record<string, unknown>>;
}): ToolDefinition {
  return { ...tool, handler: (args: unknown) => tool.handler(args as I) };
}

export const TOOL_REGISTRY: ToolDefinition[] = [
  defineTool({
    name: 'remember',
    title: 'Remember a Review',
    description:
      "Save a durable review about geometry: a semantic feature (give it a name, e.g. 'mounting holes') or a plain note (no name). " +
      'Re-remembering a named feature REPLACES it (use this to correct the AI). Re-remembering the same entities without a name APPENDS facts. ' +
      'The more you save, the more the system understands the part across sessions.',
    inputSchema: rememberInput,
    outputSchema: z.object({
      review: reviewOut,
      replaced: z
        .boolean()
        .describe('True when this overwrote a record that already existed at this key.'),
    }),
    annotations: WRITE,
    handler: async ({
      artifact,
      entity_id_scheme,
      entities,
      name,
      note,
      tags,
    }: z.output<typeof rememberInput>): Promise<Record<string, unknown>> => {
      const db = getDb();
      const source = artifactKey(artifact);
      if (
        entities.some(
          (id) =>
            !subjectReferenceSchema.safeParse(subjectReference(artifact, id, entity_id_scheme))
              .success,
        )
      )
        throw {
          code: 'invalid_subject',
          message: 'One or more entity IDs are not valid subjects for this artifact and ID scheme.',
        };
      const tagList = normalizeTags(tags);
      const isNamed = !!name && name.trim().length > 0;
      const key = isNamed
        ? namedKey(source, name!.trim())
        : anonymousKey(source, artifact.revision, entity_id_scheme, entities);
      const existing = db
        .prepare('SELECT note, tags FROM reviews WHERE review_key = ?')
        .get(key) as { note: string; tags: string } | undefined;
      // A named feature replaces whatever was there. A note appends: the same entity
      // set is the same subject, so a second remark adds to the first instead of
      // erasing it.
      const carried = isNamed ? '' : (existing?.note.trim() ?? '');
      const noteText = [carried, note?.trim() ?? ''].filter(Boolean).join('\n\n');
      const tagsToStore = isNamed
        ? tagList
        : dedupe([
            ...(existing === undefined ? [] : (JSON.parse(existing.tags) as string[])),
            ...tagList,
          ]);
      // One statement covers both cases. The upsert is what keeps created_at saying
      // when the record first appeared, rather than when it was last touched.
      db.prepare(
        'INSERT INTO reviews (review_key, source_file, name, entity_ids, note, tags, model_revision, entity_id_scheme, artifact_units) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          "ON CONFLICT(review_key) DO UPDATE SET note = excluded.note, tags = excluded.tags, model_revision = excluded.model_revision, entity_id_scheme = excluded.entity_id_scheme, artifact_units = excluded.artifact_units, updated_at = datetime('now')",
      ).run(
        key,
        source,
        isNamed ? name!.trim() : null,
        encodeEntityIds(entities),
        noteText,
        JSON.stringify(tagsToStore),
        artifact.revision,
        entity_id_scheme,
        artifact.units ?? null,
      );
      const row = db.prepare('SELECT * FROM reviews WHERE review_key = ?').get(key) as ReviewRow;
      return { review: rowToReview(row, artifact), replaced: existing !== undefined };
    },
  }),
  defineTool({
    name: 'recall',
    title: 'Recall Reviews',
    description:
      'Retrieve saved reviews for a STEP file, optionally filtered by an entity, free-text search, or tags. ' +
      'Pass the current ArtifactRef from Geometry inspect; its revision is used to mark each returned record stale or current. Each record returns one artifact reference, its entity IDs and the ID scheme; use these together when handing an annotation to another tool. ' +
      'An entity filter matches only reviews written against the supplied revision, because a face ID denotes different geometry in a different revision; text and tag filters are not scoped that way. ' +
      'Use early in a conversation to restore persistent context about a part. ' +
      'Uses the supplied artifact revision to mark saved records stale; it does not open the artifact or require shared filesystem access.',
    inputSchema: recallInput,
    outputSchema: z.object({
      reviews: z.array(reviewOut).default([]),
      current_revision: z.string().optional(),
    }),
    annotations: READ_ONLY,
    handler: async ({
      artifact,
      entity_id,
      search,
      tags,
      limit,
      offset,
    }: z.output<typeof recallInput>): Promise<Record<string, unknown>> => {
      const db = getDb();
      const params: (string | number)[] = [];
      const aliases = artifactAliases(artifact);
      const clauses: string[] = [`source_file IN (${aliases.map(() => '?').join(',')})`];
      params.push(...aliases);
      if (entity_id) {
        // Entity addressing is revision-scoped, because an ID denotes different
        // geometry in a different revision: a review of face:3 from another revision
        // is not a review of face:3 now. Text and tag searches are not scoped this
        // way — finding that a part was reviewed before is exactly what they are for.
        clauses.push('model_revision = ?');
        params.push(artifact.revision);
        clauses.push(entityIdPredicate('reviews.entity_ids'));
        params.push(entity_id);
      }
      if (search && search.trim()) {
        clauses.push("(COALESCE(name,'') LIKE ? OR note LIKE ?)");
        const term = '%' + search.trim() + '%';
        params.push(term, term);
      }
      const tagList = normalizeTags(tags);
      for (const tag of tagList) {
        clauses.push('tags LIKE ?');
        params.push('%"' + tag + '"%');
      }
      const where = 'WHERE ' + clauses.join(' AND ');
      params.push(limit ?? 100, offset ?? 0);
      const currentRevision = artifact.revision;
      const rows = db
        .prepare(
          'SELECT review_key, source_file, name, entity_ids, note, tags, model_revision, entity_id_scheme, artifact_units, created_at, updated_at ' +
            'FROM reviews ' +
            where +
            ' ORDER BY updated_at DESC LIMIT ? OFFSET ?',
        )
        .all(...params) as ReviewRow[];
      return {
        reviews: rows.map((row) => rowToReview(row, artifact, currentRevision)),
        current_revision: currentRevision,
      };
    },
  }),
  defineTool({
    name: 'forget',
    title: 'Forget a Review',
    description:
      'Delete a saved record. Pass the feature name to remove a named feature, an entity id to remove the anonymous notes attached to that entity, or a subject to remove a decision. Idempotent. Use only when the user explicitly asks to remove it.',
    inputSchema: forgetInput,
    outputSchema: z.object({
      deleted: z.literal(true),
      name: z.string().optional(),
      entity_id: z.string().optional(),
      subject: z.string().optional(),
    }),
    annotations: DESTRUCTIVE,
    handler: async ({
      artifact,
      name,
      entity_id,
      subject,
    }: z.output<typeof forgetInput>): Promise<Record<string, unknown>> => {
      const db = getDb();
      const aliases = artifactAliases(artifact);
      const selectors = [name, entity_id, subject].filter((value) => value !== undefined);
      if (selectors.length !== 1) {
        throw {
          code: 'invalid_selection',
          message:
            'Pass exactly one of name (a named feature), entity_id (anonymous notes on that entity), or subject (a decision).',
        };
      }
      if (name) {
        db.prepare(
          `DELETE FROM reviews WHERE source_file IN (${aliases.map(() => '?').join(',')}) AND name = ?`,
        ).run(...aliases, name);
      } else if (entity_id) {
        // Delete anonymous reviews containing this entity (note: entity_ids is a JSON array in the DB).
        db.prepare(
          `DELETE FROM reviews WHERE source_file IN (${aliases.map(() => '?').join(',')}) AND name IS NULL AND ${entityIdPredicate('reviews.entity_ids')}`,
        ).run(...aliases, entity_id);
      } else if (subject) {
        db.prepare(
          `DELETE FROM decisions WHERE source_file IN (${aliases.map(() => '?').join(',')}) AND subject = ?`,
        ).run(...aliases, subject);
      }
      return { deleted: true, name, entity_id, subject };
    },
  }),
  defineTool({
    name: 'remember_decision',
    title: 'Remember a Decision',
    description:
      'Save the disposition reached about an artifact revision, with the basis it rests on: a list of requirement-checks, each saying where its requirement came from and what happened when it was checked. ' +
      'Re-remembering the same subject on the same artifact revision REPLACES that decision, which is how a decision is revised as the engineer answers questions or disagrees with a line. A different subject starts a separate decision, because one part can carry several at once. ' +
      'Record each engineer verdict when they have given one: a requirement the engineer accepted is a different thing from one that was proposed. ' +
      'Store each requirement as stated and each piece of evidence as it was reported. This server never opens or measures the artifact, so recall returns what was concluded, not a measurement — Geometry remains the authority for numbers.',
    inputSchema: decisionInputSchema,
    outputSchema: z.object({
      decision: decisionOutSchema,
      replaced: z
        .boolean()
        .describe('True when this revised a decision that already existed at this subject.'),
    }),
    annotations: WRITE,
    handler: async (
      input: z.output<typeof decisionInputSchema>,
    ): Promise<Record<string, unknown>> => {
      assertDecisionWellFormed(input);
      const db = getDb();
      const source = artifactKey(input.artifact);
      const key = decisionKey(source, input.artifact.revision, input.subject);
      const entityIds = encodeEntityIds(entityIdsOf(input.basis));
      const existing = db
        .prepare('SELECT decision_key FROM decisions WHERE decision_key = ?')
        .get(key);
      if (existing === undefined) {
        db.prepare(
          'INSERT INTO decisions (decision_key, source_file, model_revision, subject, recommendation, confidence, status, basis, entity_ids, artifact_units, supersedes) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          key,
          source,
          input.artifact.revision,
          input.subject,
          input.recommendation,
          input.confidence,
          input.status,
          JSON.stringify(input.basis),
          entityIds,
          input.artifact.units ?? null,
          input.supersedes ?? null,
        );
      } else {
        // Update in place so created_at keeps saying when this decision first
        // appeared, which is what an audit reads it for.
        db.prepare(
          "UPDATE decisions SET recommendation = ?, confidence = ?, status = ?, basis = ?, entity_ids = ?, artifact_units = ?, supersedes = ?, updated_at = datetime('now') WHERE decision_key = ?",
        ).run(
          input.recommendation,
          input.confidence,
          input.status,
          JSON.stringify(input.basis),
          entityIds,
          input.artifact.units ?? null,
          input.supersedes ?? null,
          key,
        );
      }
      const row = db
        .prepare('SELECT * FROM decisions WHERE decision_key = ?')
        .get(key) as DecisionRow;
      return { decision: rowToDecision(row, input.artifact), replaced: existing !== undefined };
    },
  }),
  defineTool({
    name: 'recall_decisions',
    title: 'Recall Decisions',
    description:
      'Retrieve decisions saved for an artifact, newest first, each marked stale when it was made against a different revision than the one supplied. ' +
      'Pass the current ArtifactRef from Geometry inspect. Filter by subject text, status, or an entity that appears in the basis. ' +
      'An entity filter matches only decisions made against the supplied revision, because a face ID is scoped to the revision that produced it: a decision about face:3 in an older revision is not a decision about face:3 now. ' +
      'Use this when a revision reappears, to recover what was already concluded instead of reaching it again.',
    inputSchema: recallDecisionsInput,
    outputSchema: z.object({
      decisions: z.array(decisionOutSchema).default([]),
      current_revision: z.string().optional(),
    }),
    annotations: READ_ONLY,
    handler: async ({
      artifact,
      subject,
      status,
      entity_id,
      limit,
      offset,
    }: z.output<typeof recallDecisionsInput>): Promise<Record<string, unknown>> => {
      const db = getDb();
      const params: (string | number)[] = [];
      const aliases = artifactAliases(artifact);
      const clauses: string[] = [`source_file IN (${aliases.map(() => '?').join(',')})`];
      params.push(...aliases);
      if (subject !== undefined && subject.trim() !== '') {
        clauses.push('subject LIKE ?');
        params.push('%' + subject.trim() + '%');
      }
      if (status !== undefined) {
        clauses.push('status = ?');
        params.push(status);
      }
      if (entity_id !== undefined && entity_id !== '') {
        clauses.push('model_revision = ?');
        params.push(artifact.revision);
        clauses.push(entityIdPredicate('decisions.entity_ids'));
        params.push(entity_id);
      }
      params.push(limit ?? 100, offset ?? 0);
      const rows = db
        .prepare(
          'SELECT * FROM decisions WHERE ' +
            clauses.join(' AND ') +
            ' ORDER BY updated_at DESC LIMIT ? OFFSET ?',
        )
        .all(...params) as DecisionRow[];
      return {
        decisions: rows.map((row) => rowToDecision(row, artifact, artifact.revision)),
        current_revision: artifact.revision,
      };
    },
  }),
];
