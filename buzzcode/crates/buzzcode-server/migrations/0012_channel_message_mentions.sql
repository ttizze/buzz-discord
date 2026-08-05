CREATE TABLE channel_message_mentions (
    message_id TEXT NOT NULL REFERENCES channel_messages (id) ON DELETE CASCADE,
    mentioned_subject TEXT NOT NULL REFERENCES users (oidc_subject) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (message_id, mentioned_subject),
    UNIQUE (message_id, ordinal)
);

CREATE INDEX channel_message_mentions_subject_idx
    ON channel_message_mentions (mentioned_subject, message_id);
