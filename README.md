# Ottorev — Review MCP Server

The memory an engineering assistant needs. This local stdio MCP server records
**names, notes, tags, and decisions** against an exact CAD revision in SQLite, so
an assistant can pick up where it left off — remember that a face is the mating
surface, that a tolerance callout is tight, or that a review concluded *hold*
with the requirements behind it.

It never opens the CAD file: it stores the revision the caller supplies and
compares it on recall, so it works on a laptop with no CAD software and no other
server running.

## Quick start

Requires Node.js 24+ and npm. From this repository:

```sh
npm install
npm run build
REVIEW_MCP_DB_PATH=/absolute/path/to/review.db npm start
```

For any MCP client:

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

`REVIEW_MCP_DB_PATH` defaults to `./review-mcp.db`; parent directories are created
automatically. Records persist across restarts — protect and back up the database
as application data.

## Tools

| Tool       | Behavior                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remember` | Save a **named feature** (re-remember replaces) or an **anonymous note** (re-remember appends) against an entity set, with tags. Returns `replaced` so a caller can tell which happened.                                                             |
| `recall`   | Retrieve by artifact, entity, free text, or tags; marks each record **stale** against a supplied current revision. Follow pagination for complete retrieval.                                                                                         |
| `remember_decision` | Save the **disposition** reached about a revision and its **basis** — one row per requirement-check, naming the source, the evidence, the state, and the engineer's verdict. Re-remembering the same subject replaces it.                    |
| `recall_decisions`  | Return decisions newest-first, each marked stale when it belongs to another revision. An `entity_id` filter matches only the supplied revision.                                                                                             |
| `forget`   | Delete a named feature, an anonymous note by entity, or a decision by subject. Idempotent.                                                                                                                                                           |

Results provide structured content and text; tool failures set MCP `isError`.
Writes change local records; the client controls when to request those mutations.
The server also advertises engineering-review prompts that compose with a geometry
server, while the core record operations run on their own.

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
before anything is stored or matched. A relative path resolves against the server
working directory. Normalisation never opens the file, so a record can be written
for an artifact this server cannot read.

**An entity filter is revision-scoped; a text or tag filter is not.** An entity ID
denotes different geometry in a different revision, so `recall` and
`recall_decisions` match an `entity_id` only against records written for the
supplied revision, and match it exactly — `face:3` does not match `face:30`. Names,
notes, subjects, and tags are matched across revisions, which is how an earlier
record is found at all, and every result says whether it is `stale`.

Each returned record contains one artifact reference, its entity IDs, and the ID
scheme. The entity IDs are opaque outside that scheme and revision.

## Decision records

A review names or annotates geometry. A **decision** is the other thing a review
produces: a disposition about a revision, and the **basis** it rests on.

One basis item is one requirement-check, and it answers for itself:

| field | what it carries |
| --- | --- |
| `requirement` | what has to hold, stated so it can be checked |
| `source` | where the requirement came from: `model-pmi`, `drawing`, `shop-spec`, `supplier-cert`, `standard`, `prior-decision`, `engineer-stated`, or `assistant-proposed` |
| `sourceDetail` | the clause, note number, or document a reader can follow |
| `evidence` | the value as it was reported, quoted with its provenance |
| `state` | `satisfied`, `violated`, `unresolved`, `conflicting`, or `not-applicable` |
| `question` | **required** for `unresolved` and `conflicting`: what would settle it |
| `faces` | the geometry the item is about, in this revision; always present, empty when the item is about the part |
| `verdict` | the engineer's `accepted` / `rejected` judgement, with a reason when they gave one |

`unresolved` and `conflicting` are first-class outcomes: a decision that carries
them is a complete record of where the work stands, not a failure to decide. A
basis item is refused when it cannot answer for itself — no `source`, or a state of
`unresolved`/`conflicting` with no `question`.

Three properties matter more than the shape:

- **A decision is bound to a revision.** The revision is part of its key, so the
  same subject at the same revision is recalled rather than reached again, and a
  decision made against a different revision comes back marked `stale: true`,
  still carrying the revision it belongs to.
- **Face IDs do not travel between revisions.** Topological naming is unsolved in
  OCCT, and this API does not pretend otherwise: an `entity_id` filter matches only
  the revision that produced the ID.
- **Verdicts are what make a requirement agreed.** Recording a `verdict` turns a
  line the assistant proposed into one the engineer accepted or rejected — the
  record of how much authority the assistant actually earned.

A stored decision is the caller's own account: the requirement as stated and the
evidence as quoted. This server never measures anything, so a recalled decision is
a record of what was concluded, not a measurement cache — Geometry remains the
authority for numbers.

## Limits

Review stores authored context: names, notes, and tags bound to an artifact
revision, and decisions with the requirements they rest on. It does not store
verified measurements, a complete immutable audit history, or authoritative
approval records, and it does not compute geometry, run simulation, or decide
manufacturability. Staleness is judged from a revision the caller supplies; Review
never opens the CAD file.

There are no schema migrations: the database is a working file, and a changed
table shape means deleting it. The server reports the version mismatch rather than
guessing at a transformation.

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
this README. Tests and source maps are excluded. Install the tarball to check the
`review-mcp` executable with a compatible MCP client. The server serves both
protocol eras: the `2025-11-25` handshake that stock MCP hosts negotiate, and the
`2026-07-28` envelope through `server/discover`.

## License

MIT. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
