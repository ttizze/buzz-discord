CREATE TABLE computers (
    id TEXT PRIMARY KEY,
    owner_subject TEXT NOT NULL REFERENCES users (oidc_subject) ON DELETE CASCADE,
    installation_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 100),
    credential_hash TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX computers_owner_idx
    ON computers (owner_subject, created_at, id);

INSERT INTO computers (
    id, owner_subject, installation_id, name, credential_hash,
    created_at, last_seen_at, revoked_at
)
SELECT remote_environments.id,
       servers.owner_subject,
       remote_environments.installation_id,
       remote_environments.name,
       remote_environments.credential_hash,
       remote_environments.created_at,
       remote_environments.last_seen_at,
       remote_environments.revoked_at
FROM remote_environments
JOIN servers ON servers.id = remote_environments.server_id;

ALTER TABLE server_projects ADD COLUMN computer_id TEXT;
ALTER TABLE server_projects ADD COLUMN folder_path TEXT;

UPDATE server_projects
SET computer_id = remote_environment_id,
    folder_path = repository_path;

ALTER TABLE server_projects
    ALTER COLUMN computer_id SET NOT NULL,
    ALTER COLUMN folder_path SET NOT NULL;
ALTER TABLE server_projects
    ADD CONSTRAINT server_projects_computer_fk
    FOREIGN KEY (computer_id) REFERENCES computers (id);
ALTER TABLE server_projects
    ADD CONSTRAINT server_projects_folder_path_length
    CHECK (CHAR_LENGTH(folder_path) BETWEEN 1 AND 4096);
ALTER TABLE server_projects
    DROP CONSTRAINT server_projects_server_id_remote_environment_id_fkey;
ALTER TABLE server_projects
    DROP COLUMN remote_environment_id,
    DROP COLUMN repository_path;

ALTER TABLE host_pairing_codes ADD COLUMN owner_subject TEXT;
UPDATE host_pairing_codes SET owner_subject = created_by_subject;
ALTER TABLE host_pairing_codes ALTER COLUMN owner_subject SET NOT NULL;
ALTER TABLE host_pairing_codes
    ADD CONSTRAINT host_pairing_codes_owner_fk
    FOREIGN KEY (owner_subject) REFERENCES users (oidc_subject) ON DELETE CASCADE;
ALTER TABLE host_pairing_codes DROP COLUMN server_id;

CREATE INDEX host_pairing_codes_owner_idx
    ON host_pairing_codes (owner_subject, created_at DESC);
