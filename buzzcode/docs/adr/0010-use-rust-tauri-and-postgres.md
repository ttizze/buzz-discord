# Use Rust, Tauri, and PostgreSQL without Buzz dependencies

Buzzcode will be an independent application under `buzzcode/`, using Rust with Axum and SQLx for the backend, PostgreSQL for persistence, WebSocket for realtime delivery, Tauri 2 with React and TypeScript for the desktop client, and Rust for Buzzcode Hosts. It will begin as a single backend process without Redis and exchange ordinary typed JSON. Buzz crates and Nostr types, signatures, kinds, and relay protocols will not be dependencies, even though the proven language and desktop stack are retained.
