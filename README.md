# Review MCP Server

Standalone local stdio MCP server for revision-aware geometry names, notes, and
tags stored in SQLite. It works with any compatible MCP client and does not
require access to the CAD file to save or retrieve annotations.

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
| `remember` | Accepts `artifact`, `entity_id_scheme`, nonempty `entities`, and optional `name`, `note`, `tags`. A named feature replaces the existing feature at that locator/name; an anonymous note appends within the same revision, ID scheme, and entity set. |
| `recall`   | Accepts `artifact` and optional `entity_id`, `search`, `tags`, `limit`, `offset`. Returns saved records and stale state based on the supplied current revision. Follow pagination for complete retrieval.                                            |
| `forget`   | Accepts `artifact` and a feature `name` or anonymous-note `entity_id`. Deletes matching records; repeated deletion is idempotent.                                                                                                                    |

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
Review stores the caller's revision and compares it on recall, rather than opening
the file or computing geometry. A stale annotation is not automatically mapped
to new topology.

Each returned record contains one artifact reference, its entity IDs, and the
ID scheme. Pass those together when another tool needs a geometry subject; the
entity IDs are opaque outside that scheme and revision. This API currently
supports STEP geometry annotations, not arbitrary simulation-result artifact
formats.

## Limits

Review stores authored context: names, notes, and tags bound to an artifact
revision. It does not store verified measurements, a complete immutable audit
history, or authoritative approval records, and it does not compute geometry,
run simulation, or decide manufacturability. Staleness is judged from a revision
the caller supplies; Review never opens the CAD file. Multi-author merge and
conflict handling are not implemented.

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
