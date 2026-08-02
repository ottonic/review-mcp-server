import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, afterEach } from "node:test";
import {
  createServer,
  clearOutputSchema,
  metadataListOutputSchema,
  metadataOutputSchema,
  runTool,
} from "../src/index.js";
import { getDb, resetDb } from "../src/db.js";

type RegisteredServer = ReturnType<typeof createServer> & {
  _registeredTools: Record<
    string,
    {
      handler: (args: Record<string, unknown>) => Promise<unknown>;
      outputSchemaJson: unknown;
    }
  >;
};

let directory: string;
let server: RegisteredServer;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "review-mcp-"));
  process.env.REVIEW_MCP_DB_PATH = join(directory, "review.db");
  resetDb();
  server = createServer() as RegisteredServer;
});

afterEach(async () => {
  resetDb();
  delete process.env.REVIEW_MCP_DB_PATH;
  await rm(directory, { recursive: true, force: true });
});

function tool(name: string) {
  return async (args: Record<string, unknown>) => {
    const normalized =
      name === "set_entity_metadata"
        ? { modelRevision: "test-revision", mode: "replace", source: "user", evidenceIds: [], ...args }
        : name === "query_entity_metadata"
          ? { modelRevision: "test-revision", limit: 100, offset: 0, ...args }
          : name === "get_entity_metadata"
            ? { modelRevision: "test-revision", ...args }
            : name === "clear_entity_metadata"
              ? { modelRevision: "test-revision", ...args }
              : args;
    return server._registeredTools[name].handler(normalized);
  };
}

test("registered tools expose output schemas and structured output matches them", async () => {
  assert.ok(server._registeredTools.get_entity_metadata.outputSchemaJson);
  assert.ok(server._registeredTools.set_entity_metadata.outputSchemaJson);
  assert.ok(server._registeredTools.query_entity_metadata.outputSchemaJson);
  assert.ok(server._registeredTools.clear_entity_metadata.outputSchemaJson);

  const result = await tool("set_entity_metadata")({
    entityId: "part-1",
    note: "first",
  });
  const structured = (result as { structuredContent: unknown })
    .structuredContent;
  const serialized = JSON.parse(JSON.stringify(structured));
  metadataOutputSchema.parse(structured);
  assert.deepEqual(
    JSON.parse((result as { content: [{ text: string }] }).content[0].text),
    serialized,
  );
  const listed = (
    (await tool("get_entity_metadata")({ entityIds: ["part-1"] })) as {
      structuredContent: unknown;
    }
  ).structuredContent;
  metadataListOutputSchema.parse(listed);
  assert.equal((listed as any).entityMetadata[0].note, "first");
});

test("replace and append preserve omitted names", async () => {
  await tool("set_entity_metadata")({
    entityId: "part-1",
    name: "Bracket",
    note: "first",
  });
  const replaced = await tool("set_entity_metadata")({
    entityId: "part-1",
    note: "second",
  });
  assert.equal(
    (replaced as any).structuredContent.entityMetadata.name,
    "Bracket",
  );
  assert.equal(
    (replaced as any).structuredContent.entityMetadata.note,
    "second",
  );

  const appended = await tool("set_entity_metadata")({
    entityId: "part-1",
    note: "third",
    mode: "append",
  });
  assert.equal(
    (appended as any).structuredContent.entityMetadata.name,
    "Bracket",
  );
  assert.equal(
    (appended as any).structuredContent.entityMetadata.note,
    "second\n\nthird",
  );

  const clearedName = await tool("set_entity_metadata")({
    entityId: "part-1",
    name: null,
  });
  assert.equal(
    (clearedName as any).structuredContent.entityMetadata.name,
    undefined,
  );
  assert.equal(
    (clearedName as any).structuredContent.entityMetadata.note,
    "second\n\nthird",
  );
});

test("metadata is isolated by model revision and preserves evidence references", async () => {
  await tool("set_entity_metadata")({
    entityId: "part-1",
    modelRevision: "revision-a",
    note: "old volume",
    evidenceIds: ["evidence-old"],
  });
  await tool("set_entity_metadata")({
    entityId: "part-1",
    modelRevision: "revision-b",
    note: "new volume",
    evidenceIds: ["evidence-new"],
  });

  const oldRecord = await tool("get_entity_metadata")({
    entityIds: ["part-1"],
    modelRevision: "revision-a",
  });
  const newRecord = await tool("get_entity_metadata")({
    entityIds: ["part-1"],
    modelRevision: "revision-b",
  });
  assert.equal((oldRecord as any).structuredContent.entityMetadata[0].note, "old volume");
  assert.deepEqual((oldRecord as any).structuredContent.entityMetadata[0].evidenceIds, ["evidence-old"]);
  assert.equal((newRecord as any).structuredContent.entityMetadata[0].note, "new volume");
  assert.deepEqual((newRecord as any).structuredContent.entityMetadata[0].evidenceIds, ["evidence-new"]);
});

test("clear removes metadata and records an audit trail atomically", async () => {
  await tool("set_entity_metadata")({ entityId: "part-1", note: "to clear" });
  const result = await tool("clear_entity_metadata")({
    entityId: "part-1",
    clearedBy: "reviewer",
  });
  assert.deepEqual(clearOutputSchema.parse((result as any).structuredContent), {
    entityId: "part-1",
    cleared: true,
  });
  assert.deepEqual(
    ((await tool("get_entity_metadata")({ entityIds: ["part-1"] })) as any)
      .structuredContent,
    { entityMetadata: [] },
  );
  assert.equal(
    getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM review_trail WHERE action = ? AND created_by = ?",
      )
      .get("clear_entity_metadata", "reviewer").count,
    1,
  );

  assert.throws(() => {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare(
          "INSERT INTO entity_metadata (subject_key, entity_id, model_revision, note, source) VALUES (?, ?, ?, ?, ?)",
        ).run("test-revision::rollback", "rollback", "test-revision", "temporary", "user");
      throw new Error("force rollback");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }, /force rollback/);
  assert.equal(
    getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM entity_metadata WHERE entity_id = ?",
      )
      .get("rollback").count,
    0,
  );
});

test("database reset isolates paths", async () => {
  await tool("set_entity_metadata")({ entityId: "only-a", note: "A" });
  resetDb();
  process.env.REVIEW_MCP_DB_PATH = join(directory, "other.db");
  const other = createServer() as RegisteredServer;
  assert.deepEqual(
    (
      (await other._registeredTools.get_entity_metadata.handler({
        entityIds: ["only-a"],
        modelRevision: "test-revision",
      })) as any
    ).structuredContent,
    { entityMetadata: [] },
  );
});

test("runTool returns MCP text and structured output, and errors remain errors", async () => {
  const result = await runTool(async () => ({ ok: true }));
  assert.deepEqual(result.structuredContent, { ok: true });
  assert.equal(result.content[0].text, '{\n  "ok": true\n}');
  assert.equal(
    (
      await runTool(async () => {
        throw new Error("bad");
      })
    ).isError,
    true,
  );
});
