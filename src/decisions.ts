/**
 * Decision records: the disposition reached about an artifact revision, and the
 * basis it rests on.
 *
 * A decision is a different kind of thing from a review. A review names or
 * annotates geometry; a decision *concludes* something about a revision, and its
 * basis is a list of requirement-checks, each of which says where its requirement
 * came from and what happened when it was checked. `unresolved` and `conflicting`
 * are first-class outcomes, because the honest answer to "can we release this?" is
 * often "not until someone answers this".
 *
 * What is stored is the caller's own account: the disposition, each requirement as
 * stated, and the evidence as quoted. This server never opens the artifact and
 * never measures it, so a recalled decision is a record of what was concluded, not
 * a measurement cache — Geometry stays the authority for numbers.
 *
 * The schemas live here rather than being imported from the producer because an
 * advertised MCP schema has to be self-contained (see the contributor notes), and
 * because this server must stay usable by a client with no CAD file access and no
 * other server running.
 */
import { z } from 'zod';
import { artifactReferenceSchema, echoArtifact } from './revision.js';

/**
 * Where a requirement came from.
 *
 * These are not interchangeable, which is the point: a dimension on a drawing and
 * a dimension the assistant proposed carry different authority, and a record that
 * cannot say which it is has not recorded anything usable.
 */
export const requirementSourceSchema = z
  .enum([
    'model-pmi',
    'drawing',
    'shop-spec',
    'supplier-cert',
    'standard',
    'prior-decision',
    'engineer-stated',
    'assistant-proposed',
  ])
  .describe(
    'Where the requirement comes from. Use assistant-proposed only for a requirement you raised yourself and the engineer has not yet made theirs.',
  );

/** What happened when a requirement was checked. */
export const checkStateSchema = z
  .enum(['satisfied', 'violated', 'unresolved', 'conflicting', 'not-applicable'])
  .describe(
    'unresolved means the input needed to check it is missing; conflicting means two requirements or pieces of evidence disagree. Both are real outcomes.',
  );

/** The engineer's judgement on one basis item. */
export const itemVerdictSchema = z
  .object({
    verdict: z.enum(['accepted', 'rejected']).describe('Whether the engineer accepted this line.'),
    note: z.string().optional().describe('Why, when they gave a reason.'),
  })
  .strict();

/** One requirement the decision rests on. */
export const basisItemSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('Stable within the decision. Use it again when revising this line.'),
    requirement: z.string().min(1).describe('What has to hold, stated so it can be checked.'),
    source: requirementSourceSchema,
    sourceDetail: z
      .string()
      .optional()
      .describe('Clause, note number, document or spec name a reader can follow.'),
    evidence: z
      .string()
      .optional()
      .describe(
        'The measured or computed value as it was reported, quoted with its provenance, e.g. "inspect: is_valid=true, face_count=5".',
      ),
    state: checkStateSchema,
    question: z
      .string()
      .optional()
      .describe(
        'The question that would resolve this item. Required when the state is unresolved or conflicting.',
      ),
    faces: z
      .array(z.string())
      .default([])
      .describe('Face IDs this item is about, valid only in the artifact revision below.'),
    note: z
      .string()
      .optional()
      .describe('One line of reasoning a reviewer needs when the state alone is not enough.'),
    verdict: itemVerdictSchema
      .optional()
      .describe(
        "The engineer's judgement on this line, when they have given one. Recording it is what makes a requirement agreed rather than merely proposed.",
      ),
  })
  .strict();

/** A decision as a caller supplies it. */
export const decisionInputSchema = z
  .object({
    artifact: artifactReferenceSchema,
    subject: z
      .string()
      .min(1)
      .describe(
        "What is being decided, in the engineer's words. Part of the record key: reuse the same subject to revise this decision, or a new subject starts a separate one.",
      ),
    recommendation: z
      .string()
      .min(1)
      .describe('The disposition, stated as a decision rather than a summary of the conversation.'),
    confidence: z.enum(['high', 'medium', 'low']).describe('How much weight the evidence carries.'),
    basis: z
      .array(basisItemSchema)
      .min(1)
      .describe('The requirement-checks the recommendation rests on.'),
    status: z
      .enum(['proposed', 'confirmed'])
      .default('proposed')
      .describe("Set 'confirmed' only once the engineer has accepted the disposition itself."),
    supersedes: z
      .string()
      .optional()
      .describe(
        'Revision whose decision for this subject this one replaces, when a part was revised.',
      ),
  })
  .strict();

/** Filters for recalling decisions. */
export const recallDecisionsInput = z
  .object({
    artifact: artifactReferenceSchema,
    subject: z
      .string()
      .optional()
      .describe('Only decisions whose subject contains this text, case-insensitive.'),
    status: z.enum(['proposed', 'confirmed']).optional().describe('Only decisions in this state.'),
    entity_id: z
      .string()
      .optional()
      .describe(
        'Only decisions whose basis names this face, within the supplied revision. A face ID from another revision denotes different geometry, so it is not matched.',
      ),
    limit: z.number().int().min(1).default(100).optional().describe('Max decisions. Default 100.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .optional()
      .describe('Skip N decisions for pagination.'),
  })
  .strict();

/** A decision as this server returns it, bound to the revision it was made against. */
export const decisionOutSchema = z.object({
  subject: z.string(),
  recommendation: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  status: z.enum(['proposed', 'confirmed']),
  basis: z.array(basisItemSchema),
  artifact: artifactReferenceSchema,
  revision: z.string().describe('Revision this decision is bound to, echoed for convenience.'),
  stale: z
    .boolean()
    .optional()
    .describe(
      'True when this decision was made against a different revision than the one supplied, so its face IDs no longer denote the same faces.',
    ),
  supersedes: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type RequirementSource = z.output<typeof requirementSourceSchema>;
export type CheckState = z.output<typeof checkStateSchema>;
export type BasisItem = z.output<typeof basisItemSchema>;
export type DecisionInput = z.output<typeof decisionInputSchema>;
export type DecisionRecord = z.output<typeof decisionOutSchema>;

/** A row of the `decisions` table. */
export type DecisionRow = {
  decision_key: string;
  source_file: string;
  model_revision: string;
  subject: string;
  recommendation: string;
  confidence: string;
  status: string;
  basis: string;
  entity_ids: string;
  artifact_units: string | null;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The record key: artifact, revision, subject.
 *
 * The revision is part of it because a decision is only meaningful for the
 * geometry it was made against, which is also what makes recall work when that
 * revision reappears. The subject is part of it because one part can carry several
 * live decisions — release, coating, tolerances — and they must not overwrite each
 * other.
 * @param sourceFile - canonical artifact locator.
 * @param revision - revision the decision was made against.
 * @param subject - what is being decided.
 * @returns the primary key.
 */
export function decisionKey(sourceFile: string, revision: string, subject: string): string {
  return `${sourceFile}|${revision}|${subject}`;
}

/**
 * Refuse a decision whose parts contradict each other.
 *
 * These invariants are checked here rather than in the schema so the advertised
 * JSON Schema stays a plain object; a tool client should not have to read a
 * refinement to know what shape to send.
 * @param input - validated decision input.
 * @throws a `{ code, message }` domain error naming the offending item.
 */
export function assertDecisionWellFormed(input: DecisionInput): void {
  const seen = new Set<string>();
  for (const item of input.basis) {
    if (seen.has(item.id)) {
      throw {
        code: 'duplicate_basis_item',
        message: `Basis item id '${item.id}' appears more than once; an id addresses one line.`,
      };
    }
    seen.add(item.id);
    const needsQuestion = item.state === 'unresolved' || item.state === 'conflicting';
    if (needsQuestion && (item.question === undefined || item.question.trim() === '')) {
      throw {
        code: 'missing_question',
        message: `Basis item '${item.id}' is ${item.state} but states no question. Say what would settle it, so the gap can be asked about instead of guessed.`,
      };
    }
  }
}

/**
 * Convert a stored row to the portable decision shape.
 * @param row - database row.
 * @param currentArtifact - the artifact the caller supplied to recall.
 * @param currentRevision - revision to compare against, when the caller supplied one.
 * @returns the decision, with `stale` marking a different revision.
 */
export function rowToDecision(
  row: DecisionRow,
  currentArtifact: z.output<typeof artifactReferenceSchema>,
  currentRevision?: string,
): DecisionRecord {
  const basis = JSON.parse(row.basis) as BasisItem[];
  const artifact = echoArtifact(
    { revision: row.model_revision, units: row.artifact_units },
    currentArtifact,
  );
  return {
    subject: row.subject,
    recommendation: row.recommendation,
    confidence: row.confidence as DecisionRecord['confidence'],
    status: row.status as DecisionRecord['status'],
    basis,
    artifact,
    revision: row.model_revision,
    ...(currentRevision === undefined ? {} : { stale: row.model_revision !== currentRevision }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    updatedAt: row.updated_at,
  };
}
