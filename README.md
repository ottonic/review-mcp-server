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

Returned subjects contain `type: "geometry"`, the artifact, and an entity with
authority `cad-mcp-server`, the supplied ID scheme, ID, and kind. Entity IDs are
opaque outside that scheme and revision. This API currently supports STEP
geometry annotations, not arbitrary simulation-result artifact formats.

Review stores authored context, not verified measurements, a complete immutable
audit history, or authoritative approval records. It does not compute geometry,
run simulation, or decide manufacturability.

## Development

The repository provides a Nix development shell (`nix develop`) and `just` recipes:

- `just setup`: install dependencies.
- `just dev`: run TypeScript over stdio.
- `just build`: compile into `dist/`.
- `just test`: exercise local record and result behavior.
- `just fmt`: check formatting (the current recipe does not rewrite files).
- `just lint`: TypeScript checking.
- `just check`: formatting, typecheck, and tests.
- `just clean`: remove compiled output, retaining the database.

## Package preparation

`npm pack` builds first and includes compiled runtime code, package metadata, and
this README. Tests and source maps are excluded. Install the resulting tarball
to check the `review-mcp` executable with a compatible MCP client. The server
requires protocol `2026-07-28`; legacy protocol negotiation is rejected.

A project license must be selected and added before public release.
