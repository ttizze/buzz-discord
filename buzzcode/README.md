# Buzzcode

Buzzcode is an independent Rust, PostgreSQL, Tauri, and React application. It
does not depend on Buzz crates or Nostr protocols.

## Development environment

All supported development commands run inside the pinned Nix flake:

```bash
cd buzzcode
nix develop
just setup
```

The flake provides Rust, Node.js, pnpm, PostgreSQL, Tauri system dependencies,
Playwright browsers, and the quality-gate tools on Apple Silicon macOS and
`aarch64` or `x86_64` Linux.

## Run the application

```bash
just dev
```

This starts the local PostgreSQL database, the Axum server on
`http://127.0.0.1:3100`, and the Tauri desktop. The database remains running so
state survives application restarts. Stop it explicitly with `just db-stop`.

For split terminals, run `just server` and `just desktop` after `just db-start`.

## Quality gates

```bash
just format       # apply Rust and TypeScript formatting
just lint         # Rust clippy and Biome lint
just typecheck    # Rust, Tauri, React, and E2E TypeScript
just test-focused # unit tests
just test-e2e     # PostgreSQL + HTTP + WebSocket + desktop restart test
just test         # complete Buzzcode gate
```

The E2E harness creates its own temporary PostgreSQL cluster. It does not use or
modify the development database.
