# Review MCP Contributor Instructions

- Keep record operations usable through a generic MCP client with no CAD file
  access or other server required.
- Preserve caller-supplied revisions, subject ID schemes, stale-record semantics,
  and the distinction between named-feature replacement and anonymous-note append.
- Keep mutations explicit, database updates atomic where required, input schemas
  strict, and structured tool results consistent with their declared schemas.
- Keep tests isolated from user databases; use local fixtures and temporary paths.
- Use strict TypeScript, ESM imports with `.js` extensions, single quotes, and
  existing Prettier/oxlint conventions.
- Prefer the recipes in `justfile`; run `just check` for implementation changes.
- `.envrc` activates the flake; run `direnv allow` after changing it. Server logs
  go to stderr as pino JSON; `MCP_LOG_LEVEL` and `MCP_LOG_FORMAT` tune them.
- Keep language tooling in the project environment. Document actual command
  behavior in [README](README.md); do not depend on personal machine configuration.
