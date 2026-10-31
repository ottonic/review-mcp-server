# Security

## Posture

Record content is sensitive engineering IP: names, notes, and decision records
reveal design intent. The server is local-first and stores everything in one SQLite
file; it is not a filesystem sandbox. Hosted deployment requires an external
isolation boundary.

## Current local mode

Assumptions:

- The operator chooses the database path (`REVIEW_MCP_DB_PATH`, default
  `./review-mcp.db`) and runs the server on their own machine or a controlled
  environment.
- The server persists caller-supplied records. It never reads a CAD file, and it
  needs no other server.
- No network access is required by any operation.

Guardrails already implemented:

- **No CAD file access.** Records address geometry by caller-supplied subject and
  revision; the server never opens a STEP file.
- **Strict input schemas.** Every tool validates its arguments with a Zod schema,
  and the mutating tools reject unknown fields rather than ignoring them
  (`.strict()`, `src/tools.ts`).
- **Crash-safe writes.** The database runs in WAL journal mode
  (`PRAGMA journal_mode=WAL`), so an interrupted process cannot corrupt the file.
- **No shell, no arbitrary code.** No child processes, no `eval`, no SQL built from
  unvalidated input.
- **Secrets.** No credentials are read or logged, and `.env` is not auto-loaded.
  Structured logs go to stderr as pino JSON.

Local precautions:

- The database is the record of truth: back it up, and keep it out of version
  control (`.gitignore` covers `review-mcp.db`).
- Treat record contents as design IP; do not paste them into third-party services.

## Hosted or composed mode

If the server is hosted, or a remote capability receives its records:

- put the database on a volume with the same access controls as the source CAD;
- scope one database per project or tenant, and never share a path across tenants;
- authenticate and authorize every caller before the server is reachable;
- keep the file outside any public webroot.

A domain server must not infer consent from being connected through an MCP host;
the host must show users which capabilities receive their data and whether
processing is local or remote.

## Sensitive outputs

Even structured outputs can reveal design information: feature names, entity
identifiers, tolerances, and the decisions taken about them. For hosted use, treat
records and generated reports with the same access controls as the source CAD.

## Report language

Records are what the engineer authored, against which revision, and when. They are
not manufacturing approval or compliance.
