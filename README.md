# Review MCP Server

A standalone MCP server for durable engineering meaning. It currently stores
entity names, notes, and a review trail in SQLite. The server is useful through
any MCP host; CAD Viewer enhances it with spatial presentation, revision
context, approvals, and cross-server workflows.

## Boundary

Review MCP stores accepted meaning. It does not calculate geometry, run DFM,
interpret FEA, or decide whether a model is manufacturable. Domain servers
produce facts, findings, and evidence; a host or approved workflow may persist
the accepted result here.

## Tools

- `get_entity_metadata` - read records for exact entity IDs
- `set_entity_metadata` - create or update one name/note record
- `query_entity_metadata` - search by entity, text, or hashtag
- `clear_entity_metadata` - remove one entity record

The current metadata API is intentionally small. Its planned evolution is
revision-aware features, measurements, findings, decisions, and evidence
references. See the Viewer repository's
`ENGINEERING_INTELLIGENCE_CONTRACT.md` for portable subject and result
semantics.

## Development

- `just dev` - run the server from TypeScript
- `just build` - compile to `dist/`
- `just test` - run tests
- `just check` - run formatting, lint, and tests
