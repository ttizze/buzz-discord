ALTER TABLE channel_messages
    ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'user'
        CHECK (author_kind IN ('user', 'agent')),
    ADD COLUMN author_agent_id TEXT,
    ADD COLUMN requested_by_subject TEXT REFERENCES users (oidc_subject);

ALTER TABLE channel_messages
    ADD CONSTRAINT channel_messages_agent_author_check CHECK (
        (author_kind = 'user' AND author_agent_id IS NULL AND requested_by_subject IS NULL)
        OR
        (author_kind = 'agent' AND author_agent_id IS NOT NULL AND requested_by_subject IS NOT NULL)
    );

CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES server_projects (id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    computer_id TEXT NOT NULL REFERENCES computers (id),
    agent_id TEXT NOT NULL,
    requested_by_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    request_message_id TEXT NOT NULL REFERENCES channel_messages (id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX agent_runs_channel_idx ON agent_runs (channel_id, created_at, id);
