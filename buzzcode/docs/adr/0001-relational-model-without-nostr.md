# Use a relational application model without Nostr

Buzzcode will use ordinary relational records as its source of truth, exposed through HTTP APIs and delivered in real time over WebSocket. It will not retain Nostr's signed universal event format, `kind`-based dispatch, or client-owned event identifiers; an append-only log remains only where auditability requires it. This makes the application model explicit and easier to evolve, at the cost of Nostr interoperability and client-verifiable authorship.
