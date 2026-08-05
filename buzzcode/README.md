# Buzzcode

Buzzcode is an independent Rust, PostgreSQL, Tauri, and React application. It
does not depend on Buzz crates or Nostr protocols. Authentication uses a pinned
Rauthy deployment through Authorization Code OIDC with S256 PKCE. Accounts are
created by an administrator, activated by email, and use Passkeys without a
password.

## Development environment

All supported development commands run inside the pinned Nix flake:

```bash
cd buzzcode
nix develop
just setup
cp .env.example .env
```

The flake provides Rust, Node.js, pnpm, PostgreSQL, Tauri system dependencies,
Playwright browsers, and the quality-gate tools on Apple Silicon macOS and
`aarch64` or `x86_64` Linux.

## Run the application

```bash
just dev
```

Configure and start Rauthy before `just dev`; see
`deploy/rauthy/README.md`. `just auth-smoke` checks live discovery, S256
support, and the Buzzcode-to-Rauthy redirect without completing a user login.

This starts the local PostgreSQL database, the Axum server at
`http://localhost:3100`, and the Tauri desktop. The database remains running so
state survives application restarts. Stop it explicitly with `just db-stop`.

Desktop sign-in opens Rauthy in the system browser for the Passkey ceremony.
After authentication, the browser displays a completion page and the desktop
automatically receives its one-time session; no credentials or completion token
are placed in the browser URL.

For split terminals, run `just server` and `just desktop` after `just db-start`.

## Pair a VPS Computer

Each VPS runs one outbound-only `buzzcode-host`. A signed-in user creates a
10-minute, one-time pairing code from **Server Settings → Computers**.
On that VPS, build or install the Host and pair it once:

```bash
cargo build --release -p buzzcode-host
./target/release/buzzcode-host pair \
  --api-origin https://buzzcode.example.com \
  --pairing-code '<code from Server Settings>' \
  --name 'Production VPS 1' \
  --state /var/lib/buzzcode-host/state.json
./target/release/buzzcode-host run \
  --state /var/lib/buzzcode-host/state.json
```

Run the second command under the VPS service manager with automatic restart.
The state file is created with owner-only permissions and binds that Host to the
user's Computer. It is not owned by one Server: Projects on the Computer may be
shared into multiple Servers. The Host opens an authenticated outbound
WebSocket; Buzzcode does not need the VPS SSH private key or an inbound Host
port, and it does not advertise a static repository or folder list.

To add a Project, use Buzzcode on the Computer that owns the folder and choose
that local folder. The folder may be inside or outside Git. Buzzcode records the
creating Computer automatically; it never asks the user to select a VPS or Host.
Project metadata, Channels, and chat remain available while that Computer is
Offline, while file access and Agents wait for the Computer to reconnect.

On a headless VPS, add its local folder from that VPS after pairing:

```bash
./target/release/buzzcode-host project add \
  --state /var/lib/buzzcode-host/state.json \
  --server-id '<server-id>' \
  --folder /srv/project
```

The Host credential identifies the creating Computer implicitly; the command
does not accept another Computer or Host as a destination.

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
