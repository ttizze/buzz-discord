CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    oidc_subject TEXT NOT NULL REFERENCES users (oidc_subject) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, oidc_subject)
);

CREATE INDEX channel_members_subject_idx
    ON channel_members (oidc_subject, channel_id);

CREATE FUNCTION prevent_channel_relocation() RETURNS trigger AS $$
BEGIN
    IF NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'channel placement is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER channels_prevent_relocation
    BEFORE UPDATE OF server_id ON channels
    FOR EACH ROW EXECUTE FUNCTION prevent_channel_relocation();
