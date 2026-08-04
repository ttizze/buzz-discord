CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 100),
    owner_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE server_members (
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    oidc_subject TEXT NOT NULL REFERENCES users (oidc_subject) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, oidc_subject)
);

CREATE INDEX servers_owner_idx ON servers (owner_subject);
CREATE INDEX server_members_subject_idx ON server_members (oidc_subject);

CREATE TABLE server_state (
    server_id TEXT PRIMARY KEY REFERENCES servers (id) ON DELETE CASCADE,
    value TEXT NOT NULL DEFAULT 'Buzzcode is ready',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
