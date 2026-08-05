ALTER TABLE users ADD COLUMN handle TEXT;

DO $$
DECLARE
    account RECORD;
    base_handle TEXT;
    candidate TEXT;
BEGIN
    FOR account IN
        SELECT oidc_subject, display_name FROM users ORDER BY created_at, oidc_subject
    LOOP
        base_handle := LOWER(REGEXP_REPLACE(account.display_name, '[^a-zA-Z0-9._]', '', 'g'));
        IF CHAR_LENGTH(base_handle) < 2 OR CHAR_LENGTH(base_handle) > 32
            OR base_handle LIKE '%..%'
        THEN
            base_handle := 'user_' || SUBSTRING(MD5(account.oidc_subject), 1, 12);
        END IF;
        candidate := base_handle;
        IF EXISTS(SELECT 1 FROM users WHERE handle = candidate) THEN
            candidate := LEFT(base_handle, 23) || '_' || SUBSTRING(MD5(account.oidc_subject), 1, 8);
        END IF;
        WHILE EXISTS(SELECT 1 FROM users WHERE handle = candidate) LOOP
            candidate := 'user_' || SUBSTRING(MD5(account.oidc_subject || candidate), 1, 12);
        END LOOP;
        UPDATE users SET handle = candidate WHERE oidc_subject = account.oidc_subject;
    END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN handle SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_handle_format CHECK (
    handle = LOWER(handle)
    AND handle ~ '^[a-z0-9._]{2,32}$'
    AND handle NOT LIKE '%..%'
);
ALTER TABLE users ADD CONSTRAINT users_handle_unique UNIQUE (handle);
