# Review MCP Server

Standalone local stdio MCP server for revision-aware geometry names, notes, tags,
and decisions stored in SQLite. It works with any compatible MCP client and does
not require access to the CAD file to save or retrieve records.

## Setup and launch

Requires Node.js 24+ and npm. From this repository:

```sh
npm install
npm run build
REVIEW_MCP_DB_PATH=/absolute/path/to/review.db npm start
```

For a generic MCP client:

```json
{
  "mcpServers": {
    "review": {
      "command": "node",
      "args": ["/absolute/path/to/review-mcp-server/dist/src/index.js"],
      "env": { "REVIEW_MCP_DB_PATH": "/absolute/path/to/review.db" }
    }
  }
}
```

`REVIEW_MCP_DB_PATH` defaults to `./review-mcp.db`, relative to the server's working
directory. Parent directories are created automatically. Records persist across
server restarts; protect and back up the database as application data.

## Tools

| Tool       | Behavior                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remember` | Accepts `artifact`, `entity_id_scheme`, nonempty `entities`, and optional `name`, `note`, `tags`. A named feature replaces the existing feature at that locator/name; an anonymous note appends within the same revision, ID scheme, and entity set. Returns `replaced` so a caller can tell which happened. |
| `recall`   | Accepts `artifact` and optional `entity_id`, `search`, `tags`, `limit`, `offset`. Returns saved records and stale state based on the supplied current revision. Follow pagination for complete retrieval.                                            |
| `remember_decision` | Accepts `artifact`, `subject`, `recommendation`, `confidence`, nonempty `basis`, and optional `status`, `supersedes`. Saves the disposition reached about a revision and the requirement-checks behind it. Re-remembering the same subject on the same revision replaces it; a different subject starts a separate decision. |
| `recall_decisions`  | Accepts `artifact` and optional `subject` text, `status`, `entity_id`, `limit`, `offset`. Returns decisions newest first, each marked stale when it belongs to another revision. An `entity_id` filter matches only the supplied revision. |
| `forget`   | Accepts `artifact` and exactly one of a feature `name`, an anonymous-note `entity_id`, or a decision `subject`. Deletes matching records; repeated deletion is idempotent.                                                                                                                    |

Results provide structured content and text. Tool failures set MCP `isError`.
Writes change local records; the client controls when to request those mutations.
The server also advertises engineering-review prompts. Composed prompts may
request geometry tools from another configured server; core record operations
do not require that server to run.

## Artifact and subject semantics

An input artifact contains `revision` (`sha256:` plus 64 lowercase hex digits),
`format: "step"`, and optional URI and units:

```json
{
  "revision": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "uri": "file:///work/part.step",
  "format": "step",
  "units": "mm"
}
```

Supply the actual revision from the producer; the example digest is illustrative.
A URI groups records by locator; without a URI, the revision is the lookup key.

`uri` accepts either a URI or a plain filesystem path, because a path is what a
caller usually has in hand:

```json
{ "uri": "/work/part.step" }
```

Both spellings address the same records: a path is normalised to a `file:` URI
before anything is stored or matched against it, and a returned record echoes the
canonical URI. A relative path resolves against the server working directory. The
normalisation is a convenience for the caller — it never opens the file, so a
record can still be written for an artifact this server cannot read.

Review stores the caller's revision and compares it on recall, rather than opening
the file or computing geometry. A stale annotation is not automatically mapped
to new topology.

**An entity filter is revision-scoped; a text or tag filter is not.** An entity ID
denotes different geometry in a different revision, so `recall` and
`recall_decisions` match an `entity_id` only against records written for the revision
supplied, and match it exactly — `face:3` does not match `face:30`. Names, notes,
subjects, and tags are matched across revisions, which is how a record from an earlier
revision is found at all, and every result says whether it is `stale`.

Each returned record contains one artifact reference, its entity IDs, and the
ID scheme. Pass those together when another tool needs a geometry subject; the
entity IDs are opaque outside that scheme and revision. This API currently
supports STEP geometry annotations, not arbitrary simulation-result artifact
formats.

## Decision records

A review names or annotates geometry. A decision is the other thing a review
conversation produces: a **disposition** about a revision, and the **basis** it rests
on.

One basis item is one requirement-check, and it has to be able to answer for itself:

| field | what it carries |
| --- | --- |
| `requirement` | what has to hold, stated so it can be checked |
| `source` | where the requirement came from: `model-pmi`, `drawing`, `shop-spec`, `supplier-cert`, `standard`, `prior-decision`, `engineer-stated`, or `assistant-proposed` |
| `sourceDetail` | the clause, note number, or document a reader can follow |
| `evidence` | the value as it was reported, quoted with its provenance |
| `state` | `satisfied`, `violated`, `unresolved`, `conflicting`, or `not-applicable` |
| `question` | **required** for `unresolved` and `conflicting`: what would settle it |
| `faces` | the geometry the item is about, in this revision; always present, empty when the item is about the part rather than a feature |
| `verdict` | the engineer's `accepted` / `rejected` judgement, with a reason when they gave one |

`unresolved` and `conflicting` are first-class outcomes: a decision that carries them
is a complete record of where the work stands, not a failure to decide. A basis item
is refused when it cannot answer for itself — no `source`, or a state of
`unresolved`/`conflicting` with no `question`.

Three properties matter more than the shape:

- **A decision is bound to a revision.** The revision is part of its key, so the same
  subject at the same revision is recalled rather than reached again, and a decision
  made against a different revision comes back marked `stale: true`, still carrying
  the revision it belongs to.
- **Face IDs do not travel between revisions.** Topological naming is unsolved in
  OCCT and this API does not pretend otherwise, so an `entity_id` filter matches only
  the revision that produced the ID, and matches it exactly: `face:3` does not match
  `face:30`. A decision about `face:3` in an older revision is not a decision about
  `face:3` now.
- **Verdicts are what make a requirement agreed.** Recording a `verdict` turns a line
  the assistant proposed into one the engineer accepted or rejected, which is the
  record of how much authority the assistant actually earned.

A stored decision is the caller's own account: the requirement as stated and the
evidence as quoted. This server never measures anything, so a recalled decision is a
record of what was concluded, not a measurement cache — Geometry remains the authority
for numbers.

## Limits

Review stores authored context: names, notes, and tags bound to an artifact
revision, and decisions with the requirements they rest on. It does not store
verified measurements, a complete immutable audit history, or authoritative
approval records, and it does not compute geometry, run simulation, or decide
manufacturability. Staleness is judged from a revision the caller supplies;
Review never opens the CAD file. Multi-author merge and conflict handling are not
implemented.

There are no schema migrations. The database is a working file, and a changed table
shape means deleting it; the server reports the version mismatch rather than guessing
at a transformation.

## Development

Requires Node.js 24+ and [`just`](https://github.com/casey/just). A Nix flake and
`.envrc` provide the toolchain; run `direnv allow` after changing either.

| Recipe           | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| `just setup`     | Install dependencies.                           |
| `just dev`       | Run TypeScript over stdio.                      |
| `just build`     | Compile into `dist/`.                           |
| `just test`      | Run unit tests.                                 |
| `just lint`      | Run oxlint.                                     |
| `just fmt`       | Rewrite formatting with Prettier.               |
| `just fmt-check` | Verify formatting.                              |
| `just typecheck` | Run `tsc --noEmit`.                             |
| `just check`     | `fmt-check` + `lint` + `typecheck` + `test`.    |
| `just clean`     | Remove compiled output, retaining the database. |

Server logs go to stderr as newline-delimited pino JSON. `MCP_LOG_LEVEL`
(`debug`|`info`|`warn`|`error`), `MCP_LOG_FORMAT=human`, and `MCP_TRACE_ID` tune
them; secret-like fields are redacted.

## Packaging

`npm pack` builds first and includes compiled runtime code, package metadata, and
this README. Tests and source maps are excluded. Install the resulting tarball
to check the `review-mcp` executable with a compatible MCP client. The server
serves both protocol eras: the `2025-11-25` handshake that stock MCP hosts
negotiate, and the `2026-07-28` envelope through `server/discover`.

A project license must be selected and added before public release.
