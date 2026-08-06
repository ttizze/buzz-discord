use sqlx::{PgPool, Postgres, Transaction};

pub(super) struct StoredProject {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) computer_id: String,
    pub(super) computer_name: String,
    pub(super) folder_path: String,
    pub(super) revoked: bool,
}

pub(super) struct StoredProjectChannel {
    pub(super) project_id: String,
    pub(super) id: String,
    pub(super) name: String,
}

pub(super) struct NewProject<'a> {
    pub(super) id: &'a str,
    pub(super) server_id: &'a str,
    pub(super) computer_id: &'a str,
    pub(super) name: &'a str,
    pub(super) folder_path: &'a str,
    pub(super) subject: &'a str,
}

pub(super) struct NewProjectChannel<'a> {
    pub(super) id: &'a str,
    pub(super) server_id: &'a str,
    pub(super) project_id: &'a str,
    pub(super) name: &'a str,
    pub(super) subject: &'a str,
}

pub(super) async fn project_folder(
    pool: &PgPool,
    server_id: &str,
    project_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT computer_id, folder_path FROM server_projects \
         WHERE server_id = $1 AND id = $2 AND visibility = 'open'",
    )
    .bind(server_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await
}

pub(super) async fn projects(
    pool: &PgPool,
    server_id: &str,
) -> Result<Vec<StoredProject>, sqlx::Error> {
    Ok(
        sqlx::query_as::<_, (String, String, String, String, String, bool)>(
            "SELECT server_projects.id, server_projects.name, computer_id, computers.name, \
                    folder_path, computers.revoked_at IS NOT NULL \
             FROM server_projects JOIN computers ON computers.id = computer_id \
             WHERE server_id = $1 AND visibility = 'open' \
             ORDER BY server_projects.created_at, server_projects.id",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(
            |(id, name, computer_id, computer_name, folder_path, revoked)| StoredProject {
                id,
                name,
                computer_id,
                computer_name,
                folder_path,
                revoked,
            },
        )
        .collect(),
    )
}

pub(super) async fn project_channels(
    pool: &PgPool,
    server_id: &str,
) -> Result<Vec<StoredProjectChannel>, sqlx::Error> {
    Ok(sqlx::query_as::<_, (String, String, String)>(
        "SELECT project_id, id, name FROM channels \
         WHERE server_id = $1 AND project_id IS NOT NULL \
         ORDER BY created_at, id",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(project_id, id, name)| StoredProjectChannel {
        project_id,
        id,
        name,
    })
    .collect())
}

pub(super) async fn server_role(
    pool: &PgPool,
    subject: &str,
    server_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT CASE WHEN servers.owner_subject = $1 THEN 'owner' ELSE server_members.role END \
         FROM servers LEFT JOIN server_members ON server_members.server_id = servers.id \
         AND server_members.oidc_subject = $1 \
         WHERE servers.id = $2 \
         AND (servers.owner_subject = $1 OR server_members.oidc_subject = $1)",
    )
    .bind(subject)
    .bind(server_id)
    .fetch_optional(pool)
    .await
}

pub(super) async fn insert_project(
    transaction: &mut Transaction<'_, Postgres>,
    project: &NewProject<'_>,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query(
        "INSERT INTO server_projects \
         (id, server_id, computer_id, name, folder_path, created_by_subject) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
    )
    .bind(project.id)
    .bind(project.server_id)
    .bind(project.computer_id)
    .bind(project.name)
    .bind(project.folder_path)
    .bind(project.subject)
    .execute(&mut **transaction)
    .await?
    .rows_affected()
        > 0)
}

pub(super) async fn record_project_created(
    transaction: &mut Transaction<'_, Postgres>,
    project: &NewProject<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
         VALUES ($1, $2, 'project.created', jsonb_build_object( \
             'projectId', $3::TEXT, 'computerId', $4::TEXT, \
             'folderPath', $5::TEXT, 'visibility', 'open'))",
    )
    .bind(project.server_id)
    .bind(project.subject)
    .bind(project.id)
    .bind(project.computer_id)
    .bind(project.folder_path)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub(super) async fn project_exists(
    transaction: &mut Transaction<'_, Postgres>,
    server_id: &str,
    project_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM server_projects \
         WHERE id = $1 AND server_id = $2 AND visibility = 'open')",
    )
    .bind(project_id)
    .bind(server_id)
    .fetch_one(&mut **transaction)
    .await
}

pub(super) async fn insert_project_channel(
    transaction: &mut Transaction<'_, Postgres>,
    channel: &NewProjectChannel<'_>,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query(
        "INSERT INTO channels \
         (id, server_id, project_id, name, visibility, created_by_subject) \
         VALUES ($1, $2, $3, $4, 'open', $5) ON CONFLICT DO NOTHING",
    )
    .bind(channel.id)
    .bind(channel.server_id)
    .bind(channel.project_id)
    .bind(channel.name)
    .bind(channel.subject)
    .execute(&mut **transaction)
    .await?
    .rows_affected()
        > 0)
}

pub(super) async fn record_project_channel_created(
    transaction: &mut Transaction<'_, Postgres>,
    channel: &NewProjectChannel<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
         VALUES ($1, $2, 'project.channel_created', jsonb_build_object( \
             'projectId', $3::TEXT, 'channelId', $4::TEXT, 'visibility', 'open'))",
    )
    .bind(channel.server_id)
    .bind(channel.subject)
    .bind(channel.project_id)
    .bind(channel.id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
