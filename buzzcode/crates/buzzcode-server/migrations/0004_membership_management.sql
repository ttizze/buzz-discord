CREATE TABLE server_invitations (
    token_hash TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    invited_by_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX server_invitations_server_idx ON server_invitations (server_id);
CREATE INDEX server_invitations_email_idx ON server_invitations (LOWER(email));

CREATE TABLE server_audit_log (
    id BIGSERIAL PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    actor_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    action TEXT NOT NULL,
    target_subject TEXT,
    detail JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX server_audit_log_server_idx
    ON server_audit_log (server_id, created_at DESC, id DESC);
