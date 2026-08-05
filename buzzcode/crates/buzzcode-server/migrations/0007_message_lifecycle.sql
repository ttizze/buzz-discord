ALTER TABLE channel_messages DROP CONSTRAINT channel_messages_content_check;
ALTER TABLE channel_messages ALTER COLUMN content DROP NOT NULL;
ALTER TABLE channel_messages ADD COLUMN edited_at TIMESTAMPTZ;
ALTER TABLE channel_messages ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE channel_messages ADD CONSTRAINT channel_messages_visible_content_check CHECK (
    (deleted_at IS NULL AND content IS NOT NULL AND CHAR_LENGTH(content) BETWEEN 1 AND 4000)
    OR (deleted_at IS NOT NULL AND content IS NULL)
);

CREATE TABLE message_reactions (
    message_id TEXT NOT NULL REFERENCES channel_messages (id) ON DELETE CASCADE,
    oidc_subject TEXT NOT NULL REFERENCES users (oidc_subject) ON DELETE CASCADE,
    emoji TEXT NOT NULL CHECK (CHAR_LENGTH(emoji) BETWEEN 1 AND 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, oidc_subject, emoji)
);

CREATE INDEX message_reactions_message_idx
    ON message_reactions (message_id, emoji, created_at);
