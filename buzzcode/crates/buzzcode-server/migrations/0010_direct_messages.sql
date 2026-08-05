CREATE TABLE direct_messages (
    id TEXT PRIMARY KEY,
    participant_one_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    participant_two_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    created_by_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (participant_one_subject < participant_two_subject),
    UNIQUE (participant_one_subject, participant_two_subject)
);

CREATE INDEX direct_messages_participant_one_idx
    ON direct_messages (participant_one_subject, created_at, id);
CREATE INDEX direct_messages_participant_two_idx
    ON direct_messages (participant_two_subject, created_at, id);

CREATE FUNCTION user_can_access_direct_message(
    requested_direct_message_id TEXT,
    requested_subject TEXT
) RETURNS BOOLEAN AS $$
    SELECT EXISTS(
        SELECT 1 FROM direct_messages
        WHERE id = requested_direct_message_id
          AND requested_subject IN (
              participant_one_subject,
              participant_two_subject
          )
    );
$$ LANGUAGE sql STABLE;

CREATE TABLE direct_message_messages (
    sequence BIGSERIAL UNIQUE NOT NULL,
    id TEXT PRIMARY KEY,
    direct_message_id TEXT NOT NULL REFERENCES direct_messages (id) ON DELETE CASCADE,
    author_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    content TEXT,
    reply_to_message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    UNIQUE (direct_message_id, id),
    FOREIGN KEY (direct_message_id, reply_to_message_id)
        REFERENCES direct_message_messages (direct_message_id, id),
    CHECK (
        (deleted_at IS NULL AND content IS NOT NULL AND CHAR_LENGTH(content) BETWEEN 1 AND 4000)
        OR (deleted_at IS NOT NULL AND content IS NULL)
    )
);

CREATE INDEX direct_message_messages_timeline_idx
    ON direct_message_messages (direct_message_id, sequence DESC);

CREATE TABLE direct_message_reactions (
    message_id TEXT NOT NULL REFERENCES direct_message_messages (id) ON DELETE CASCADE,
    oidc_subject TEXT NOT NULL REFERENCES users (oidc_subject) ON DELETE CASCADE,
    emoji TEXT NOT NULL CHECK (CHAR_LENGTH(emoji) BETWEEN 1 AND 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, oidc_subject, emoji)
);

CREATE INDEX direct_message_reactions_message_idx
    ON direct_message_reactions (message_id, emoji, created_at);

CREATE TABLE direct_message_audit_log (
    id BIGSERIAL PRIMARY KEY,
    direct_message_id TEXT NOT NULL REFERENCES direct_messages (id) ON DELETE CASCADE,
    actor_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    action TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX direct_message_audit_log_timeline_idx
    ON direct_message_audit_log (direct_message_id, created_at DESC, id DESC);
