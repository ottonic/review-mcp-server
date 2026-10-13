#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { getDb } from "./db.js";
import pkg from "../package.json" with { type: "json" };
import { logEvent } from "./logging.js";
import { PROMPTS } from "./prompts.js";
import {
  artifactAliases,
  artifactKey,
  artifactReferenceSchema,
  subjectReference,
  subjectReferenceSchema,
} from "./revision.js";

export async function runTool<T>(fn: () => Promise<T>, tool = "unknown") {
  const startedAt = Date.now();
  logEvent("tool.started", { tool });
  try {
    const data = await fn();
    logEvent("tool.completed", { tool, durationMs: Date.now() - startedAt });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("tool.failed", {
      tool,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const DELETE_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const REVIEW_CAPABILITY_MANIFEST = {
  capabilityId: "review-memory",
  version: pkg.version,
  title: "Review Memory",
  domain: "engineering-memory",
  workflows: ["remember", "recall", "forget"],
  subjects: ["geometry"],
  resultKinds: ["reviews"],
  requiredInputs: ["artifact"],
  sideEffects: ["review_write"],
  dataHandling: { processing: "local", persistence: "sqlite" },
  // This server also carries 8 engineering workflow prompts (analyze_part,
  // resume_part_context, check_thickness, check_moldability, draft_audit,
  // measure_clearance, compare_iterations, design_review). Each prompt reads
  // geometry facts from the companion cad-mcp server and, when run with
  // note_mode=save, writes review records through this server's remember tool.
  prompts: [
    "analyze_part",
    "resume_part_context",
    "check_thickness",
    "check_moldability",
    "draft_audit",
    "measure_clearance",
    "compare_iterations",
    "design_review",
  ],
  crossServer: {
    reads: ["cad-mcp: inspect, find_entities, measure, diff"],
    writes: ["review_write on note_mode=save"],
  },
};

type ReviewRow = {
  review_key: string;
  source_file: string;
  name: string | null;
  entity_ids: string;
  note: string;
  tags: string;
  author: string;
  model_revision: string;
  entity_id_scheme: string;
  created_at: string;
  updated_at: string;
};

// A named review is a FEATURE keyed by (source_file, name). An unnamed review
// is a NOTE anchored to an entity set, keyed by a stable JSON of sorted ids.
export function namedKey(sourceFile: string, name: string): string {
  return sourceFile + "|" + name;
}
export function anonymousKey(
  sourceFile: string,
  revision: string,
  idScheme: string,
  entityIds: string[],
): string {
  const sorted = [...entityIds].sort();
  return (
    sourceFile + "|@" + revision + "|" + idScheme + "|" + JSON.stringify(sorted)
  );
}
function normalizeTags(tags: string[] | undefined): string[] {
  return [
    ...new Set(
      (tags ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => t.replace(/^#/, "")),
    ),
  ];
}
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// Shared output schema: one revision-aware "review" block.
const reviewOut = z.object({
  kind: z.enum(["feature", "note"]),
  name: z.string().optional(),
  entities: z.array(z.string()),
  subjects: z.array(subjectReferenceSchema).default([]),
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
  const artifact = { ...currentArtifact, revision: row.model_revision };
  return {
    kind: row.name ? "feature" : "note",
    name: row.name ?? undefined,
    entities: ids,
    artifact,
    entity_id_scheme: row.entity_id_scheme,
    subjects: ids.map((id) =>
      subjectReference(artifact, id, row.entity_id_scheme),
    ),
    note: row.note || undefined,
    tags,
    revision: row.model_revision,
    stale: currentRevision ? row.model_revision !== currentRevision : undefined,
    updatedAt: row.updated_at,
  };
}

export function createServer() {
  const server = new McpServer(
    { name: "review-mcp", version: pkg.version },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.registerTool(
    "remember",
    {
      title: "Remember a Review",
      description:
        "Save a durable review about geometry: a semantic feature (give it a name, e.g. 'mounting holes') or a plain note (no name). " +
        "Re-remembering a named feature REPLACES it (use this to correct the AI). Re-remembering the same entities without a name APPENDS facts. " +
        "The more you save, the more the system understands the part across sessions.",
      inputSchema: z
        .object({
          artifact: artifactReferenceSchema,
          entity_id_scheme: z.string().min(1),
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
              "Prose about the geometry. What does it do, what did we decide, what should we remember?",
            ),
          tags: z
            .array(z.string())
            .optional()
            .describe("Searchable tags (without '#'), e.g. ['holes','mount']."),
        })
        .strict(),
      outputSchema: z.object({ review: reviewOut, created: z.literal(true) }),
      annotations: WRITE,
    },
    async ({ artifact, entity_id_scheme, entities, name, note, tags }) =>
      runTool(async () => {
        const db = getDb();
        const source = artifactKey(artifact);
        if (
          entities.some(
            (id) =>
              !subjectReferenceSchema.safeParse(
                subjectReference(artifact, id, entity_id_scheme),
              ).success,
          )
        )
          throw new Error("invalid_subject");
        const tagList = normalizeTags(tags);
        const isNamed = !!name && name.trim().length > 0;
        const key = isNamed
          ? namedKey(source, name!.trim())
          : anonymousKey(source, artifact.revision, entity_id_scheme, entities);
        // For a named feature: replace. For an anonymous note: append to an existing note on the same entity set.
        let noteText = note ?? "";
        if (!isNamed) {
          const existing = db
            .prepare("SELECT note, tags FROM reviews WHERE review_key = ?")
            .get(key) as { note: string; tags: string } | undefined;
          if (existing && note) {
            const prior = existing.note.trim();
            noteText = prior ? prior + "\n\n" + note.trim() : note.trim();
          }
          if (existing) {
            const existingTags = JSON.parse(existing.tags) as string[];
            const merged = dedupe([...existingTags, ...tagList]);
            const fn = JSON.stringify(merged);
            db.prepare(
              "UPDATE reviews SET note = ?, tags = ?, model_revision = ?, entity_id_scheme = ?, updated_at = datetime('now') WHERE review_key = ?",
            ).run(noteText, fn, artifact.revision, entity_id_scheme, key);
            return {
              review: rowToReview(
                db
                  .prepare("SELECT * FROM reviews WHERE review_key = ?")
                  .get(key) as ReviewRow,
                artifact,
              ),
              created: true,
            };
          }
        }
        db.prepare(
          "INSERT OR REPLACE INTO reviews (review_key, source_file, name, entity_ids, note, tags, author, model_revision, entity_id_scheme) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          key,
          source,
          isNamed ? name!.trim() : null,
          JSON.stringify(entities),
          noteText,
          JSON.stringify(tagList),
          "ai",
          artifact.revision,
          entity_id_scheme,
        );
        const row = db
          .prepare("SELECT * FROM reviews WHERE review_key = ?")
          .get(key) as ReviewRow;
        return { review: rowToReview(row, artifact), created: true };
      }, "remember"),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall Reviews",
      description:
        "Retrieve saved reviews for a STEP file, optionally filtered by an entity, free-text search, or tags. " +
        "Pass the current ArtifactRef from Geometry inspect; its revision is used to mark each returned record stale or current. Returns subjects and artifact refs with authored review data. " +
        "Use early in a conversation to restore persistent context about a part. " +
        "Uses the supplied artifact revision to mark saved records stale; it does not open the artifact or require shared filesystem access.",
      inputSchema: z
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
            .describe(
              "Free-text match across feature names and note bodies (case-insensitive).",
            ),
          tags: z
            .array(z.string())
            .optional()
            .describe(
              "Only return reviews carrying all these tags (without '#').",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .default(100)
            .optional()
            .describe("Max reviews. Default 100."),
          offset: z
            .number()
            .int()
            .min(0)
            .default(0)
            .optional()
            .describe("Skip N reviews for pagination."),
        })
        .strict(),
      outputSchema: z.object({
        reviews: z.array(reviewOut).default([]),
        current_revision: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ artifact, entity_id, search, tags, limit, offset }) =>
      runTool(async () => {
        const db = getDb();
        const params: (string | number)[] = [];
        const aliases = artifactAliases(artifact);
        const clauses: string[] = [
          `source_file IN (${aliases.map(() => "?").join(",")})`,
        ];
        params.push(...aliases);
        if (entity_id) {
          clauses.push("entity_ids LIKE ?");
          params.push("%" + entity_id + "%");
        }
        if (search && search.trim()) {
          clauses.push("(COALESCE(name,'') LIKE ? OR note LIKE ?)");
          const term = "%" + search.trim() + "%";
          params.push(term, term);
        }
        const tagList = normalizeTags(tags);
        for (const tag of tagList) {
          clauses.push("tags LIKE ?");
          params.push('%"' + tag + '"%');
        }
        const where = "WHERE " + clauses.join(" AND ");
        params.push(limit ?? 100, offset ?? 0);
        const currentRevision = artifact.revision;
        const rows = db
          .prepare(
            "SELECT review_key, source_file, name, entity_ids, note, tags, author, model_revision, entity_id_scheme, created_at, updated_at " +
              "FROM reviews " +
              where +
              " ORDER BY updated_at DESC LIMIT ? OFFSET ?",
          )
          .all(...params) as unknown as ReviewRow[];
        return {
          reviews: rows.map((row) =>
            rowToReview(row, artifact, currentRevision),
          ),
          current_revision: currentRevision,
        };
      }, "recall"),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget a Review",
      description:
        "Delete a saved review. Pass the feature name to remove a named feature, or an entity id to remove anonymous notes attached to that entity. Idempotent. Use only when the user explicitly asks to remove it.",
      inputSchema: z
        .object({
          artifact: artifactReferenceSchema,
          name: z
            .string()
            .optional()
            .describe("Feature name to remove (when a named feature)."),
          entity_id: z
            .string()
            .optional()
            .describe(
              "Entity whose anonymous notes to remove (when not named).",
            ),
        })
        .strict(),
      outputSchema: z.object({
        deleted: z.literal(true),
        name: z.string().optional(),
        entity_id: z.string().optional(),
      }),
      annotations: DELETE_WRITE,
    },
    async ({ artifact, name, entity_id }) =>
      runTool(async () => {
        const db = getDb();
        const aliases = artifactAliases(artifact);
        if (name) {
          db.prepare(
            `DELETE FROM reviews WHERE source_file IN (${aliases.map(() => "?").join(",")}) AND name = ?`,
          ).run(...aliases, name);
        } else if (entity_id) {
          // Delete anonymous reviews containing this entity (note: entity_ids is a JSON array in the DB).
          db.prepare(
            `DELETE FROM reviews WHERE source_file IN (${aliases.map(() => "?").join(",")}) AND name IS NULL AND entity_ids LIKE ?`,
          ).run(...aliases, "%" + entity_id + "%");
        }
        return { deleted: true, name, entity_id };
      }, "forget"),
  );

  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: prompt.argsSchema,
      },
      (args: any) => prompt.handler(args),
    );
  }

  server.registerResource(
    "review-memory-capability",
    "mcp-capability://review-memory",
    {
      title: "Review Memory Capability",
      description: "Capability manifest for durable engineering meaning.",
      mimeType: "application/json",
      annotations: { audience: ["user", "assistant"], priority: 0.8 },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(REVIEW_CAPABILITY_MANIFEST),
        },
      ],
    }),
  );

  logEvent("server.ready", { server: "review-mcp", protocol: "2026-07-28" });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  serveStdio(createServer, { legacy: "reject" });
}
