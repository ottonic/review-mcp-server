import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, afterEach } from "node:test";
import { createServer, runTool } from "../src/index.js";
import { getDb, resetDb } from "../src/db.js";
import { pathToFileURL } from "node:url";
import {
  artifactReferenceSchema,
  subjectReferenceSchema,
} from "../src/revision.js";

type AnyServer = ReturnType<typeof createServer> & {
  _registeredTools: Record<
    string,
    {
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    }
  >;
};

let dir: string;
let file: string;
let revision: string;
let server: AnyServer;
const scheme = "occt-topology-v1";
function artifact(uri = pathToFileURL(file).href, rev = revision) {
  return { uri, revision: rev, format: "step", units: "mm" };
}

async function writeFixture(
  text = "ISO-10303-21; HEADER; DATA; END-ISO-10303-21;",
) {
  await writeFile(file, text);
  revision = `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function hashFile(path: string) {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}

function handler(name: string) {
  return (args: Record<string, unknown>) =>
    server._registeredTools[name].handler(args);
}

function resultData(result: unknown): any {
  return (result as { structuredContent: unknown }).structuredContent;
}

function remember(filePath: string) {
  return (args: Record<string, unknown>) =>
    handler("remember")({
      artifact: artifact(pathToFileURL(filePath).href),
      entity_id_scheme: scheme,
      entities: ["face:0"],
      ...args,
    });
}
function recall(filePath: string) {
  return (args: Record<string, unknown>) =>
    handler("recall")({
      artifact: artifact(pathToFileURL(filePath).href),
      ...args,
    });
}
function forget(filePath: string) {
  return (args: Record<string, unknown>) =>
    handler("forget")({
      artifact: artifact(pathToFileURL(filePath).href),
      ...args,
    });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "review-mcp-"));
  process.env.REVIEW_MCP_DB_PATH = join(dir, "review.db");
  resetDb();
  file = join(dir, "part.step");
  await writeFixture();
  server = createServer() as AnyServer;
});

afterEach(async () => {
  resetDb();
  delete process.env.REVIEW_MCP_DB_PATH;
  await rm(dir, { recursive: true, force: true });
});

test("remember saves a named feature; re-remember REPLACES it", async () => {
  const a = await remember(file)({
    name: "mounting holes",
    note: "4x M4",
    tags: ["holes"],
  });
  const revA = resultData(a).review;
  assert.equal(revA.kind, "feature");
  assert.equal(revA.name, "mounting holes");
  assert.equal(revA.note, "4x M4");
  assert.deepEqual(revA.tags, ["holes"]);
  assert.equal(revA.revision, revision);

  const b = await remember(file)({
    name: "mounting holes",
    note: "5x M4",
    tags: ["holes"],
  });
  const revB = resultData(b).review;
  assert.equal(revB.note, "5x M4");
  assert.deepEqual(revB.tags, ["holes"]);
});

test("remember anonymous note APPENDS to the same entity-set", async () => {
  const note = (text: string) =>
    remember(file)({ entities: ["face:1", "face:2"], note: text });
  const first = resultData(await note("thin here")).review;
  assert.equal(first.kind, "note");
  assert.equal(first.name, undefined);

  const second = resultData(await note("and draft issues")).review;
  assert.equal(second.note, "thin here\n\nand draft issues");
});

test("recall filters by entity, search, and tags; returns current_revision", async () => {
  await remember(file)({
    name: "bolt holes",
    entities: ["face:3", "face:4"],
    note: "six M6",
    tags: ["mount"],
  });
  await remember(file)({ entities: ["face:3"], note: "recessed" });

  const all = resultData(await recall(file)({}));
  assert.equal(all.reviews.length, 2);
  assert.equal(all.current_revision, revision);

  const byEntity = resultData(await recall(file)({ entity_id: "face:4" }));
  assert.equal(byEntity.reviews.length, 1);
  assert.equal(byEntity.reviews[0].name, "bolt holes");

  const bySearch = resultData(await recall(file)({ search: "six m6" }));
  assert.equal(bySearch.reviews.length, 1);
  assert.equal(bySearch.reviews[0].name, "bolt holes");
});

test("recall does not require the artifact file to be locally accessible", async () => {
  const missing = join(dir, "does-not-exist.step");
  const result = await recall(missing)({});
  assert.equal(result.isError, undefined);
  assert.equal(resultData(result).reviews.length, 0);
});

test("forget removes a named feature by name and an anonymous note by entity", async () => {
  await remember(file)({ name: "bolt holes", entities: ["face:3"] });
  await remember(file)({ entities: ["face:7"], note: "some note" });

  const delNamed = resultData(await forget(file)({ name: "bolt holes" }));
  assert.equal(delNamed.deleted, true);

  let afterNamed = resultData(await recall(file)({}));
  assert.equal(afterNamed.reviews.length, 1);

  const delNote = resultData(await forget(file)({ entity_id: "face:7" }));
  assert.equal(delNote.deleted, true);
  let afterNote = resultData(await recall(file)({}));
  assert.equal(afterNote.reviews.length, 0);
});

test("revision changes mark stale reviews", async () => {
  const revision1 = revision;
  await remember(file)({ name: "old volume", note: "v1" });
  await writeFixture("ISO-10303-21; DATA; DIFFERENT;");
  const revision2 = await hashFile(file);

  const result = resultData(
    await handler("recall")({
      artifact: artifact(pathToFileURL(file).href, revision2),
    }),
  );
  assert.equal(result.current_revision, revision2);
  assert.equal(result.reviews[0].stale, true);
  assert.equal(result.reviews[0].artifact.revision, revision1);
  assert.equal(result.reviews[0].subjects[0].artifact.revision, revision1);
});

test("anonymous notes remain scoped to artifact revision and ID scheme", async () => {
  const old = resultData(
    await remember(file)({ entities: ["face:0"], note: "old revision fact" }),
  ).review;
  const nextRevision = `sha256:${"f".repeat(64)}`;
  const next = resultData(
    await handler("remember")({
      artifact: artifact(pathToFileURL(file).href, nextRevision),
      entity_id_scheme: scheme,
      entities: ["face:0"],
      note: "new revision fact",
    }),
  ).review;
  assert.equal(old.note, "old revision fact");
  assert.equal(next.note, "new revision fact");
  const recalled = resultData(
    await handler("recall")({
      artifact: artifact(pathToFileURL(file).href, nextRevision),
    }),
  );
  assert.equal(recalled.reviews.length, 2);
  assert.equal(
    recalled.reviews.find((review: any) => review.note === "old revision fact")
      .stale,
    true,
  );
});

test("runTool returns text + structured output and surfaces errors", async () => {
  const ok = await runTool(async () => ({ ok: true }), "t");
  assert.deepEqual(ok.structuredContent, { ok: true });
  assert.equal(ok.content[0].text, '{\n  "ok": true\n}');
  const bad = await runTool(async () => {
    throw new Error("boom");
  }, "t");
  assert.equal(bad.isError, true);
});

test("accepts local ArtifactRef and SubjectRef examples", () => {
  const artifactFixture = {
    revision: `sha256:${"a".repeat(64)}`,
    uri: "file:///work/part.step",
    format: "step",
    units: "mm",
  };
  const subjectFixture = {
    type: "geometry",
    artifact: artifactFixture,
    entity: {
      authority: "cad-mcp-server",
      idScheme: "occt-topology-v1",
      id: "face:0",
      kind: "face",
    },
  };
  assert.equal(
    artifactReferenceSchema.safeParse(artifactFixture).success,
    true,
  );
  assert.equal(subjectReferenceSchema.safeParse(subjectFixture).success, true);
});
