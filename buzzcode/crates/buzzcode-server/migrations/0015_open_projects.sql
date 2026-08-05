ALTER TABLE remote_environments
    ADD CONSTRAINT remote_environments_server_id_id_key UNIQUE (server_id, id);

CREATE TABLE server_projects (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    remote_environment_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 100),
    repository_path TEXT NOT NULL CHECK (CHAR_LENGTH(repository_path) BETWEEN 1 AND 4096),
    visibility TEXT NOT NULL DEFAULT 'open' CHECK (visibility = 'open'),
    created_by_subject TEXT NOT NULL REFERENCES users (oidc_subject),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, id),
    UNIQUE (server_id, name),
    FOREIGN KEY (server_id, remote_environment_id)
        REFERENCES remote_environments (server_id, id)
);

CREATE INDEX server_projects_server_idx
    ON server_projects (server_id, created_at, id);

ALTER TABLE channels ADD COLUMN project_id TEXT;
ALTER TABLE channels DROP CONSTRAINT channels_server_id_name_key;
ALTER TABLE channels ADD CONSTRAINT channels_project_server_fk
    FOREIGN KEY (server_id, project_id)
    REFERENCES server_projects (server_id, id) ON DELETE CASCADE;

CREATE UNIQUE INDEX channels_direct_server_name_key
    ON channels (server_id, name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX channels_project_name_key
    ON channels (project_id, name) WHERE project_id IS NOT NULL;
CREATE INDEX channels_project_idx
    ON channels (project_id, created_at, id) WHERE project_id IS NOT NULL;
