CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 80),
    visibility TEXT NOT NULL DEFAULT 'open' CHECK (visibility IN ('open', 'private')),
    created_by_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, name),
    UNIQUE (server_id, id)
);

CREATE INDEX channels_server_idx ON channels (server_id, created_at, id);

CREATE TABLE channel_messages (
    sequence BIGSERIAL UNIQUE NOT NULL,
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    author_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    content TEXT NOT NULL CHECK (CHAR_LENGTH(content) BETWEEN 1 AND 4000),
    reply_to_message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (channel_id, id),
    FOREIGN KEY (server_id, channel_id)
        REFERENCES channels (server_id, id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id, reply_to_message_id)
        REFERENCES channel_messages (channel_id, id)
);

CREATE INDEX channel_messages_timeline_idx
    ON channel_messages (channel_id, sequence DESC);
CREATE INDEX channel_messages_server_idx ON channel_messages (server_id);
