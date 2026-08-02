#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getDb } from "./db.js";
import pkg from "../package.json" with { type: "json" };

export async function runTool<T>(fn: () => Promise<T>) {
  try {
    const data = await fn();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
export const metadataSchema = z.object({
  entityId: z.string(),
  name: z.string().optional(),
  note: z.string(),
  source: metadataSource,
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

type MetadataRow = {
  entity_id: string;
  name: string | null;
  note: string;
  source: "user" | "ai" | "tool";
  created_at: string;
  updated_at: string | null;
};

function rowToMetadata(row: MetadataRow) {
  return {
    entityId: row.entity_id,
    name: row.name ?? undefined,
    note: row.note,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
        })
        .strict(),
      outputSchema: metadataListOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ entityIds }) =>
      runTool(async () => {
        const db = getDb();
        const rows = db
          .prepare(
            `SELECT entity_id, name, note, source, created_at, updated_at
        FROM entity_metadata
        WHERE entity_id IN (${entityIds.map(() => "?").join(",")})`,
          )
          .all(...entityIds) as unknown as MetadataRow[];
        return { entityMetadata: rows.map(rowToMetadata) };
      }),
  );

  server.registerTool(
    "set_entity_metadata",
    {
      description:
        "Create or update one CAD entity metadata record with an optional readable name and one note field.",
      inputSchema: z
        .object({
          entityId: z.string().min(1),
          name: z.string().nullable().optional(),
          note: z.string().optional(),
          mode: updateMode.default("replace"),
          source: metadataSource.default("user"),
          updatedBy: z.string().optional(),
        })
        .strict(),
      outputSchema: metadataOutputSchema,
      annotations: WRITE,
    },
    async ({ entityId, name, note, mode, source, updatedBy }) =>
      runTool(async () => {
        const db = getDb();
        let row: MetadataRow | undefined;
        inTransaction(db, () => {
          const existing = db
            .prepare(
              "SELECT name, note FROM entity_metadata WHERE entity_id = ?",
            )
            .get(entityId) as { name: string | null; note: string } | undefined;
          const nextNote =
            note === undefined
              ? (existing?.note ?? "")
              : mode === "append" && existing?.note.trim()
                ? `${existing.note.trim()}\n\n${note.trim()}`
                : note;
          db.prepare(
            `INSERT INTO entity_metadata (entity_id, name, note, source)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET
            name = excluded.name,
            note = excluded.note,
            source = excluded.source,
            updated_at = datetime('now')`,
          ).run(
            entityId,
            name === undefined ? (existing?.name ?? null) : name,
            nextNote,
            source,
          );
          db.prepare(
            "INSERT INTO review_trail (action, entity_id, detail, created_by) VALUES (?, ?, ?, ?)",
          ).run(
            "set_entity_metadata",
            entityId,
            JSON.stringify({ entityId, name, note, mode, source }),
            updatedBy ?? source,
          );
          row = db
            .prepare(
              `SELECT entity_id, name, note, source, created_at, updated_at
          FROM entity_metadata WHERE entity_id = ?`,
            )
            .get(entityId) as unknown as MetadataRow;
        });
        if (!row) throw new Error("Metadata row was not written");
        return { entityMetadata: rowToMetadata(row) };
      }),
  );

  server.registerTool(
    "query_entity_metadata",
    {
      description: "Search CAD entity metadata by text or hashtag.",
      inputSchema: z
        .object({
          entityIds: z.array(z.string()).min(1).max(500).optional(),
          search: z.string().optional(),
          hashtags: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(500).default(100),
          offset: z.number().int().min(0).default(0),
        })
        .strict(),
      outputSchema: metadataListOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ entityIds, search, hashtags, limit, offset }) =>
      runTool(async () => {
        const db = getDb();
        const params: (string | number)[] = [];
        const clauses: string[] = [];
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
            `SELECT entity_id, name, note, source, created_at, updated_at
        FROM entity_metadata ${where}
        ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          )
          .all(...params) as unknown as MetadataRow[];
        return { entityMetadata: rows.map(rowToMetadata) };
      }),
  );

  server.registerTool(
    "clear_entity_metadata",
    {
      description: "Clear the metadata record for one CAD entity.",
      inputSchema: z
        .object({
          entityId: z.string().min(1),
          clearedBy: z.string().optional(),
        })
        .strict(),
      outputSchema: clearOutputSchema,
      annotations: WRITE,
    },
    async ({ entityId, clearedBy }) =>
      runTool(async () => {
        const db = getDb();
        inTransaction(db, () => {
          db.prepare("DELETE FROM entity_metadata WHERE entity_id = ?").run(
            entityId,
          );
          db.prepare(
            "INSERT INTO review_trail (action, entity_id, detail, created_by) VALUES (?, ?, ?, ?)",
          ).run(
            "clear_entity_metadata",
            entityId,
            JSON.stringify({ entityId }),
            clearedBy ?? "user",
          );
        });
        return { entityId, cleared: true };
      }),
  );

  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  serveStdio(createServer, { legacy: "reject" });
}
