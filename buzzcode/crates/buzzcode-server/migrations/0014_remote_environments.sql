CREATE TABLE host_pairing_codes (
    token_hash TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    created_by_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX host_pairing_codes_server_idx
    ON host_pairing_codes (server_id, created_at DESC);

CREATE TABLE remote_environments (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 100),
    credential_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX remote_environments_server_idx
    ON remote_environments (server_id, created_at, id);
