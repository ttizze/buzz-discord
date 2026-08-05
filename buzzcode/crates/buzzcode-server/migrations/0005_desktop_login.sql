CREATE TABLE desktop_login_attempts (
    token_hash TEXT PRIMARY KEY,
    oidc_state TEXT NOT NULL UNIQUE,
    oidc_subject TEXT REFERENCES users (oidc_subject) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX desktop_login_attempts_expiry_idx
    ON desktop_login_attempts (expires_at);
