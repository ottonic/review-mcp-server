# Project Template

This template defines the baseline project contract.

## Required Files
- `.envrc` (loads the project flake)
- `flake.nix` (defines `devShells.default`)
- `.nvim.lua` (maps project tools to Neovim integrations)
- `justfile` (canonical task interface)
- `.gitignore`
- `AGENTS.md`

## Canonical Commands
- `just setup` - bootstrap dependencies and local setup
- `just dev` - run the main local development workflow
- `just fmt` - run formatting
- `just lint` - run static checks
- `just test` - run tests
- `just check` - run `fmt`, `lint`, and `test`
- `just build` - produce a build artifact
- `just clean` - clean generated outputs

Projects can add extra commands, but these canonical aliases should exist.

## Neovim Tooling Contract

- Put project language tools in `flake.nix` so `direnv` exposes them on `$PATH`.
- Use `.nvim.lua` only to map those tools to editor integrations.
- Keep global Neovim language-agnostic: it provides LSP, formatting, linting, and UI infrastructure, but projects choose actual tools.
