CREATE FUNCTION user_can_access_channel(
    requested_channel_id TEXT,
    requested_server_id TEXT,
    requested_subject TEXT
) RETURNS BOOLEAN AS $$
    SELECT EXISTS(
        SELECT 1 FROM channels channel
        WHERE channel.id = requested_channel_id
          AND channel.server_id = requested_server_id
          AND (
              channel.visibility = 'open'
              OR EXISTS(
                  SELECT 1 FROM servers
                  WHERE id = requested_server_id
                    AND owner_subject = requested_subject
              )
              OR EXISTS(
                  SELECT 1 FROM server_members
                  WHERE server_id = requested_server_id
                    AND oidc_subject = requested_subject
                    AND role = 'admin'
              )
              OR EXISTS(
                  SELECT 1 FROM channel_members
                  WHERE channel_id = requested_channel_id
                    AND oidc_subject = requested_subject
              )
          )
    );
$$ LANGUAGE sql STABLE;
