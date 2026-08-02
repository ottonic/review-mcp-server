#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getDb } from "./db.js";
import pkg from "../package.json" with { type: "json" };
import { logEvent } from "./logging.js";

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
    logEvent("tool.failed", { tool, durationMs: Date.now() - startedAt, error: message });
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
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;
const metadataSource = z.enum(["user", "ai", "tool"]);
const updateMode = z.enum(["replace", "append"]);
const modelRevision = z.string().min(1);
const evidenceIds = z.array(z.string().min(1)).default([]);
export const metadataSchema = z.object({
  entityId: z.string(),
  modelRevision,
  name: z.string().optional(),
  note: z.string(),
  source: metadataSource,
  evidenceIds,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export const metadataListOutputSchema = z.object({
  entityMetadata: z.array(metadataSchema),
});
export const metadataOutputSchema = z.object({
  entityMetadata: metadataSchema,
});
export const clearOutputSchema = z.object({
  entityId: z.string(),
  cleared: z.literal(true),
});

const REVIEW_CAPABILITY_MANIFEST = {
  capabilityId: "review-memory",
  version: pkg.version,
  title: "Review Memory",
  domain: "engineering-memory",
  workflows: ["annotate", "recall", "search"],
  subjects: ["geometry", "review"],
  resultKinds: ["facts"],
  requiredInputs: ["subjectReference"],
  sideEffects: ["review_write"],
  dataHandling: { processing: "local", persistence: "sqlite" },
};

type MetadataRow = {
  subject_key: string;
  entity_id: string;
  model_revision: string;
  name: string | null;
  note: string;
  source: "user" | "ai" | "tool";
  evidence_ids: string;
  created_at: string;
  updated_at: string | null;
};

function rowToMetadata(row: MetadataRow) {
  return {
    entityId: row.entity_id,
    modelRevision: row.model_revision,
    name: row.name ?? undefined,
    note: row.note,
    source: row.source,
    evidenceIds: JSON.parse(row.evidence_ids) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subjectKey(entityId: string, revision: string): string {
  return `${revision}::${entityId}`;
}

export function inTransaction<T>(
  db: ReturnType<typeof getDb>,
  action: () => T,
): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createServer() {
  const server = new McpServer(
    { name: "review-mcp", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "get_entity_metadata",
    {
      description: "Get name/note metadata records for exact CAD entity IDs.",
      inputSchema: z
        .object({
          entityIds: z.array(z.string()).min(1).max(500),
          modelRevision,
        })
        .strict(),
      outputSchema: metadataListOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ entityIds, modelRevision }) =>
      runTool(async () => {
        const db = getDb();
        const rows = db
          .prepare(
            `SELECT subject_key, entity_id, model_revision, name, note, source, evidence_ids, created_at, updated_at
        FROM entity_metadata
        WHERE model_revision = ? AND entity_id IN (${entityIds.map(() => "?").join(",")})`,
          )
          .all(modelRevision, ...entityIds) as unknown as MetadataRow[];
        return { entityMetadata: rows.map(rowToMetadata) };
      }, "get_entity_metadata"),
  );

  server.registerTool(
    "set_entity_metadata",
    {
      description:
        "Create or update one CAD entity metadata record with an optional readable name and one note field.",
      inputSchema: z
        .object({
          entityId: z.string().min(1),
          modelRevision,
          name: z.string().nullable().optional(),
          note: z.string().optional(),
          mode: updateMode.default("replace"),
          source: metadataSource.default("user"),
          evidenceIds,
          updatedBy: z.string().optional(),
        })
        .strict(),
      outputSchema: metadataOutputSchema,
      annotations: WRITE,
    },
    async ({ entityId, modelRevision, name, note, mode, source, evidenceIds, updatedBy }) =>
      runTool(async () => {
        const db = getDb();
        let row: MetadataRow | undefined;
        inTransaction(db, () => {
          const existing = db
            .prepare(
              "SELECT name, note FROM entity_metadata WHERE subject_key = ?",
            )
            .get(subjectKey(entityId, modelRevision)) as { name: string | null; note: string } | undefined;
          const nextNote =
            note === undefined
              ? (existing?.note ?? "")
              : mode === "append" && existing?.note.trim()
                ? `${existing.note.trim()}\n\n${note.trim()}`
                : note;
          db.prepare(
            `INSERT INTO entity_metadata (subject_key, entity_id, model_revision, name, note, source, evidence_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(subject_key) DO UPDATE SET
            name = excluded.name,
            note = excluded.note,
            source = excluded.source,
            evidence_ids = excluded.evidence_ids,
            updated_at = datetime('now')`,
          ).run(
            subjectKey(entityId, modelRevision),
            entityId,
            modelRevision,
            name === undefined ? (existing?.name ?? null) : name,
            nextNote,
            source,
            JSON.stringify(evidenceIds),
          );
          db.prepare(
            "INSERT INTO review_trail (action, entity_id, detail, created_by, model_revision, evidence_ids) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(
            "set_entity_metadata",
            entityId,
            JSON.stringify({ entityId, modelRevision, name, note, mode, source, evidenceIds }),
            updatedBy ?? source,
            modelRevision,
            JSON.stringify(evidenceIds),
          );
          row = db
            .prepare(
              `SELECT subject_key, entity_id, model_revision, name, note, source, evidence_ids, created_at, updated_at
          FROM entity_metadata WHERE subject_key = ?`,
            )
            .get(subjectKey(entityId, modelRevision)) as unknown as MetadataRow;
        });
        if (!row) throw new Error("Metadata row was not written");
        return { entityMetadata: rowToMetadata(row) };
      }, "set_entity_metadata"),
  );

  server.registerTool(
    "query_entity_metadata",
    {
      description: "Search CAD entity metadata by text or hashtag.",
      inputSchema: z
        .object({
          entityIds: z.array(z.string()).min(1).max(500).optional(),
          modelRevision,
          search: z.string().optional(),
          hashtags: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(500).default(100),
          offset: z.number().int().min(0).default(0),
        })
        .strict(),
      outputSchema: metadataListOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ entityIds, modelRevision, search, hashtags, limit, offset }) =>
      runTool(async () => {
        const db = getDb();
        const params: (string | number)[] = [];
        const clauses: string[] = [];
        clauses.push("model_revision = ?");
        params.push(modelRevision);
        if (entityIds?.length) {
          clauses.push(`entity_id IN (${entityIds.map(() => "?").join(",")})`);
          params.push(...entityIds);
        }
        if (search?.trim()) {
          clauses.push("(entity_id LIKE ? OR name LIKE ? OR note LIKE ?)");
          const term = `%${search.trim()}%`;
          params.push(term, term, term);
        }
        for (const hashtag of hashtags ?? []) {
          clauses.push("note LIKE ?");
          params.push(`%#${hashtag.replace(/^#/, "")}%`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit, offset);
        const rows = db
          .prepare(
            `SELECT subject_key, entity_id, model_revision, name, note, source, evidence_ids, created_at, updated_at
        FROM entity_metadata ${where}
        ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          )
          .all(...params) as unknown as MetadataRow[];
        return { entityMetadata: rows.map(rowToMetadata) };
      }, "query_entity_metadata"),
  );

  server.registerTool(
    "clear_entity_metadata",
    {
      description: "Clear the metadata record for one CAD entity.",
      inputSchema: z
        .object({
          entityId: z.string().min(1),
          modelRevision,
          clearedBy: z.string().optional(),
        })
        .strict(),
      outputSchema: clearOutputSchema,
      annotations: WRITE,
    },
    async ({ entityId, modelRevision, clearedBy }) =>
      runTool(async () => {
        const db = getDb();
        inTransaction(db, () => {
          db.prepare("DELETE FROM entity_metadata WHERE subject_key = ?").run(
            subjectKey(entityId, modelRevision),
          );
          db.prepare(
            "INSERT INTO review_trail (action, entity_id, detail, created_by, model_revision, evidence_ids) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(
            "clear_entity_metadata",
            entityId,
            JSON.stringify({ entityId, modelRevision }),
            clearedBy ?? "user",
            modelRevision,
            "[]",
          );
        });
        return { entityId, cleared: true };
      }, "clear_entity_metadata"),
  );

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
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  serveStdio(createServer, { legacy: "reject" });
}
