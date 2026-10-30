# Review MCP Server — contributor instructions

- Keep record operations usable through a generic MCP client with no CAD file
  access and no other server required.
- Preserve caller-supplied revisions, subject ID schemes, stale-record semantics,
  and the distinction between named-feature replacement and anonymous-note append.
- Keep mutations explicit, database updates atomic where required, input schemas
  strict, and structured tool results consistent with their declared schemas.
- Advertised tool schemas must be self-contained: inline `$defs`, no external
  `$ref` that a client would have to dereference.
- Keep tests isolated from user databases; use local fixtures and temporary paths.
- Use strict TypeScript, ESM imports with `.js` extensions, single quotes, and the
  existing Prettier/oxlint conventions.
- Prefer the `just` recipes and run `just check` for implementation changes.
- `.envrc` activates the flake; run `direnv allow` after changing it. Server logs
  go to stderr as pino JSON; `MCP_LOG_LEVEL` and `MCP_LOG_FORMAT` tune them.
- Keep language tooling in the project environment; do not depend on personal
  machine configuration.

See the [README](README.md) for commands and behavior.
