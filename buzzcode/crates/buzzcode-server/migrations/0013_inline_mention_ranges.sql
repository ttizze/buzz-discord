ALTER TABLE channel_message_mentions
    ADD COLUMN start_index INTEGER NOT NULL DEFAULT 0 CHECK (start_index >= 0),
    ADD COLUMN end_index INTEGER NOT NULL DEFAULT 0 CHECK (end_index >= start_index);

ALTER TABLE channel_message_mentions
    DROP CONSTRAINT channel_message_mentions_pkey,
    DROP CONSTRAINT channel_message_mentions_message_id_ordinal_key,
    ADD PRIMARY KEY (message_id, ordinal);
