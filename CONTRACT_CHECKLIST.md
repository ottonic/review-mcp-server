# MCP Capability Contract Checklist

Use this checklist when changing Review MCP or adding another standalone engineering capability server.

## Repository Contract

- [ ] `justfile` includes real canonical targets:
  - [ ] `default`
  - [ ] `setup`
  - [ ] `dev`
  - [ ] `fmt`
  - [ ] `lint`
  - [ ] `test`
  - [ ] `check`
  - [ ] `build`
  - [ ] `clean`
- [ ] `.gitignore` covers local environment and database artifacts
- [ ] `AGENTS.md` describes repository-specific conventions
- [ ] README command examples match the real `justfile` targets

## MCP Contract

- [ ] Server runs standalone through a generic MCP host
- [ ] Legacy MCP behavior is rejected unless explicitly required
- [ ] Every tool has strict input validation
- [ ] Every structured result has an output schema
- [ ] Application failures use MCP error semantics consistently
- [ ] Mutations expose explicit side effects and approval requirements
- [ ] Long-running work uses task semantics rather than blocking tool calls
- [ ] Results include subject references, provenance, and limitations where applicable
- [ ] No tool depends on Viewer-only state
- [ ] Domain logic does not duplicate another server's source of truth

## Engineering Intelligence Contract

- [ ] Result profiles are documented when using the shared contract
- [ ] Geometry, document, or requirement subjects are revision-scoped
- [ ] Evidence can be rendered or inspected by a capable host
- [ ] Durable mutations identify affected objects and source evidence
- [ ] Viewer-specific presentation is optional, not required for server correctness

## Security And Reliability

- [ ] Local versus remote data handling is documented
- [ ] Sensitive inputs and outputs are treated as untrusted or confidential
- [ ] Failure, cancellation, and retry behavior are tested
- [ ] Contract fixtures cover representative valid and invalid results
- [ ] Database writes and audit records are atomic where required
