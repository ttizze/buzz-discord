# AGENTS.md — Buzzcode AI Agent Contributor Guide

This guide applies to work under `buzzcode/`. Buzzcode is an independent
application that preserves the intended Buzz collaboration experience while
using a conventional application architecture. It does not use Buzz crates,
Nostr, or a relay protocol.

Before changing product behavior, read [CONTEXT.md](CONTEXT.md) and the
relevant accepted decisions under [docs/adr](docs/adr). Use the glossary's
canonical terms in specifications, tests, UI copy, and code. If the requested
behavior conflicts with an accepted ADR, surface the conflict instead of
silently implementing a different model.

## Architecture

```text
Tauri 2 + React desktop
        │
        ├── HTTP JSON API ───────────────┐
        └── server event WebSockets ─────┤
                                         ▼
                              Axum application server
                                         │
                                         ▼
                                    PostgreSQL

Tauri desktop or headless VPS
        │
        └── authenticated outbound WebSocket
                                         ▼
                                  Buzzcode Host
                                         │
                                         └── ACP v1 over agent stdio
```

PostgreSQL is the durable source of truth. WebSockets deliver typed realtime
updates and Host commands; they are not an event store or relay. The server is
a conventional Rust modular monolith and starts without Redis or event
sourcing.

Do not introduce Nostr events, kinds, tags, pubkeys, private keys, NIPs, relay
queries, relay URLs, or Nostr compatibility layers. New product operations use
ordinary authenticated HTTP endpoints and typed JSON. Realtime UI changes use
the existing server WebSocket event streams. Agent transport uses stable ACP
v1, not a proprietary message protocol.

## Repository structure

```text
crates/
  buzzcode-server/       # Axum HTTP/WebSocket server, SQLx, migrations
  buzzcode-host/         # Desktop/headless Computer service and ACP bridge
desktop/
  src/                   # React 19 + TypeScript application
  src-tauri/             # Tauri 2 native shell and embedded Host
deploy/rauthy/           # Pinned Rauthy development/deployment configuration
docs/adr/                # Accepted architecture and product decisions
tests/e2e/               # Playwright user-visible application tests
tests/config/            # Deployment/configuration contract tests
CONTEXT.md                # Canonical product glossary
justfile                  # Supported development and quality commands
```

The `projects/` module is the reference vertical slice. Other larger surfaces
still live in `direct_messages.rs`, `hosts.rs`, `people.rs`, and `lib.rs` and
should migrate only when touched or when their mixed responsibilities block a
change. Keep module boundaries aligned with product concepts, not
transport-specific abstractions copied from Buzz.

## Server module design

Organize the server as vertical product modules. Do not create top-level
horizontal `services/`, `repositories/`, `handlers/`, and `models/` folders
that force one feature change to span the whole tree. A mature product module
should converge on this shape when its behavior is large enough to justify the
files:

```text
src/
  projects/
    mod.rs       # small external interface and route composition
    domain.rs    # pure domain types, policies, validation, state decisions
    service.rs   # use-case orchestration and transaction boundaries
    store.rs     # SQLx queries, persistence rows, and row mapping
    http.rs      # Axum extractors, request/response DTOs, status mapping
  messages/
    mod.rs
    domain.rs
    service.rs
    store.rs
    http.rs
  computers/
  agents/
  auth/
```

Do not create every file preemptively for a small module. Split a module when
the separation removes real knowledge from callers or stops HTTP, SQL, and
domain rules from changing together. Migrate existing large files one product
module at a time; do not perform a big-bang tree rewrite.

Use this dependency direction:

```text
http ──► service ──► domain
           │
           ├──────► store ──► PostgreSQL
           ├──────► Host connection
           └──────► server event publisher

store ──► domain
```

The module's external interface should expose use cases and result types, not
its SQL queries or transport DTOs. Keep that interface small and put internal
seams behind it.

### Domain

Domain logic should be pure whenever it can be expressed from supplied facts.
Pure domain code must not depend on Axum, SQLx, Tokio, HTTP headers, global
state, clocks, random ID generation, filesystems, or network calls. It accepts
values and returns a decision, new value, or typed domain error.

Good domain candidates include name and content validation, role policies,
visibility and placement invariants, allowed message transitions, reply rules,
Project/Computer binding invariants, and the decision about which domain event
follows a successful change.

Do not force inherently effectful work into a fake pure function. Session
lookup, membership loading, uniqueness checks, persistence, Host availability,
filesystem access, and Agent execution belong outside the domain module.

### Service

The service module implements complete use cases. It loads the facts needed by
the domain, invokes pure decisions, owns transaction boundaries, calls the
store and Host, and publishes realtime events only after the durable change is
committed. It must not accept Axum `HeaderMap`, `Path`, `Json`, or return HTTP
`StatusCode`; the HTTP adapter translates those concerns at the outer seam.

Keep authentication extraction in HTTP/auth infrastructure, then pass an
authenticated subject into the use case. Authorization facts may come from the
store, while reusable role and state decisions stay pure in the domain.
Continue enforcing access in SQL where doing so prevents unauthorized rows
from being loaded or closes a race; purity is not a reason to weaken security.

### Store

The store module owns SQL text, SQLx row types, persistence mapping, and queries
that enforce data visibility. It must not know about Axum requests or choose
product behavior. Database constraints remain a final invariant guard even
when the same rule is expressed in pure domain code.

Do not add a repository trait merely to rename SQLx methods. PostgreSQL is the
only current persistence adapter and the E2E suite runs a real temporary
PostgreSQL cluster. Introduce a port only when a second adapter is genuinely
needed, such as a production remote dependency plus a test adapter. A concrete
Postgres store hidden inside the product module is preferable to a shallow
pass-through interface.

### Tests at each seam

- Test pure domain decisions directly with table-driven unit tests.
- Test a service through its use-case interface when orchestration needs a
  focused integration test.
- Keep Playwright E2E as the acceptance surface for user-visible behavior,
  authorization, persistence, realtime delivery, Host routing, and restarts.
- Tests should assert observable results through the module interface, not
  reach through it to private SQL or implementation state.

## Development environment

All Buzzcode commands run in the pinned Nix development shell:

```bash
cd buzzcode
nix develop
just setup
cp .env.example .env
just dev
```

`just dev` starts PostgreSQL, the Axum server on `http://localhost:3100`, and
the Tauri desktop. Rauthy must be configured separately as documented in
[deploy/rauthy/README.md](deploy/rauthy/README.md). For split terminals, use
`just db-start`, `just server`, and `just desktop`.

Before running Git or repository hooks from the parent checkout, activate its
Hermit environment:

```bash
cd ..
. ./bin/activate-hermit
```

Do not rewrite hook commands to compensate for a shell that skipped the
repository toolchain setup.

## Quality gates

```bash
just format       # apply Rust and TypeScript formatting
just lint         # clippy plus Biome lint
just typecheck    # Rust, Tauri, React, and E2E TypeScript
just test-focused # Rust unit tests plus config contract tests
just test-e2e     # build server/Host/E2E desktop and run Playwright
just test         # complete Buzzcode gate
```

Run the complete gate before calling an implementation finished:

```bash
cd buzzcode
nix develop --command just test
```

The E2E harness owns a temporary PostgreSQL cluster, fake OIDC provider,
application server, and desktop preview. It does not use or modify the local
development database. Prefer `just test-e2e` to hand-assembling these services;
it builds the E2E desktop with the correct mode before Playwright runs.

Additional code rules:

- No `unsafe` code.
- Do not add `unwrap()` or `expect()` to production paths; propagate typed
  errors or return an appropriate API error.
- Document new public Rust APIs.
- Keep request and response types explicit and use the existing camelCase JSON
  contract.
- Treat credentials, session cookies, Host state, OIDC secrets, and pairing
  codes as sensitive. Never log or commit them.

Commit with `git commit -s`. Every commit must include a `Signed-off-by`
trailer.

## TDD and live completion gate

For implementation work, test through the highest user-visible seam defined by
the ticket. Normally this is a Playwright test under `tests/e2e/` exercising
the React application against the real Axum server and PostgreSQL database.

1. Add or change a behavioral test for the exact acceptance slice.
2. Observe it fail for the intended reason.
3. Make the smallest product change that makes it pass.
4. Run focused checks while iterating, then `nix develop --command just test`.
5. Start or restart the affected development services and verify the behavior
   in the running Tauri application.

Automated tests alone are not a completion claim. For reconnection, restart,
offline, or other transient behavior, deliberately exercise the transition in
the running app. Record what was exercised and what was visibly observed. If
the Tauri UI cannot be inspected, state that limitation.

## Product and security boundaries

### Authentication and browser requests

Buzzcode uses Rauthy through Authorization Code OIDC with S256 PKCE. Desktop
authentication opens the system browser and completes through a one-time
desktop login flow. Do not put credentials or completion tokens in browser
URLs.

Preserve the existing session, Origin, membership, and role checks on every API
path. Access control must be enforced by the server and SQL queries, not only
by hidden React controls. When adding a read or mutation, test unauthenticated,
non-member, and insufficient-role access where applicable.

### Servers, Channels, and Messages

A Server is the collaboration boundary. Direct server Channels are open or
private; Project Channels inherit their parent Project's visibility. Channel
placement is immutable. Messages belong to Channels or one-to-one Direct
Messages, not to Projects themselves. Replies remain in the flat channel
timeline and reference their immediate target.

Do not reintroduce Nostr-inspired event modeling for these concepts. Persist
relational rows and broadcast typed server events after authorized database
changes.

### Projects, Computers, and Hosts

A Project is created from one Project Folder on the Computer performing the
creation. Its display name is the folder basename. Project creation must not
ask for or accept a different Computer, VPS, Host, repository, or manually
entered Project name.

The Project's Computer and folder binding are immutable. A user computer and a
VPS use the same Computer model, and one Computer may back Projects in multiple
Servers. Project metadata, Channels, and human messaging remain available
while the Computer is Offline; file access and Agents do not.

All filesystem and Agent work must route through the stored Computer and
Project Folder. A Project Folder may be inside or outside Git and is a starting
context, not a filesystem sandbox. Keep Host command and response queues
bounded, cap filesystem results, and move blocking filesystem work off Tokio's
async command loop.

### Agents and ACP

Agents are independent execution endpoints, not users, Members, Projects, or a
shared actor type. Only Project Channels have the Project context required for
an Agent Mention. The parent Project determines the Computer, working folder,
permissions, and knowledge boundary.

The service-to-Host connection is an authenticated outbound WebSocket. Carry
ACP v1 JSON-RPC over it and bridge to the agent's standard ACP stdio transport.
Keep Host pairing and transport authentication outside ACP. Agent cancellation
and child-process cleanup are control-plane operations and must not be dropped
behind ordinary bounded work queues.

### Database changes

SQL migrations live in `crates/buzzcode-server/migrations/` and run when the
server starts. Add a new ordered migration for schema changes; do not hide
schema mutation in application startup code. Keep persistence and access
checks transactional when one operation changes related rows.

### Desktop boundary

React and TypeScript live under `desktop/src`; native OS behavior and embedded
Host startup live under `desktop/src-tauri`. Keep ordinary product state and
API orchestration in React. Use Tauri commands only for capabilities that
require the local OS, such as selecting a Project Folder, storing Computer
registration, opening the system browser, or running the embedded Host.

## Issue and domain workflow

Buzzcode issues and PRDs are tracked in `ttizze/buzz-discord` GitHub Issues.
Always pass `--repo ttizze/buzz-discord` to `gh`; this checkout also has an
upstream remote and inference can select the wrong repository. See
[../docs/agents/issue-tracker.md](../docs/agents/issue-tracker.md).

Use the standard triage labels documented in
[../docs/agents/triage-labels.md](../docs/agents/triage-labels.md). Before
implementing a ticket, read its comments and acceptance decisions together
with [CONTEXT.md](CONTEXT.md) and the relevant ADRs. Later accepted ADRs and
explicit ticket decisions take precedence over older proposals.

The repository-wide domain-documentation routing rules are in
[../docs/agents/domain.md](../docs/agents/domain.md).
