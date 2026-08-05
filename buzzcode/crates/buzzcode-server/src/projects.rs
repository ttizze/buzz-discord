use std::{collections::HashMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use openidconnect::CsrfToken;
use serde::{Deserialize, Serialize};

use crate::{
    ApiError, AppState, ChannelSummary, ServerEvent,
    hosts::{
        ProjectFileEntry, bind_project_folder, computer_recently_seen, computer_status,
        list_project_folder,
    },
    require_manager, require_member, require_origin, require_session, token_hash,
};

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/servers/{server_id}/projects",
            get(list_projects).post(create_project),
        )
        .route(
            "/api/servers/{server_id}/projects/{project_id}",
            get(list_project_files),
        )
        .route(
            "/api/servers/{server_id}/projects/{project_id}/channels",
            axum::routing::post(create_project_channel),
        )
        .route(
            "/api/host/projects",
            axum::routing::post(create_host_project),
        )
}

async fn list_project_files(
    State(state): State<Arc<AppState>>,
    Path((server_id, project_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProjectFileEntry>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let (computer_id, folder_path) = sqlx::query_as::<_, (String, String)>(
        "SELECT computer_id, folder_path FROM server_projects \
         WHERE server_id = $1 AND id = $2 AND visibility = 'open'",
    )
    .bind(&server_id)
    .bind(&project_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(
        list_project_folder(&state, &computer_id, &folder_path).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateProject {
    folder_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateHostProject {
    server_id: String,
    folder_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateProjectChannel {
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    id: String,
    name: String,
    computer_id: String,
    computer_name: String,
    computer_status: String,
    folder_path: String,
    visibility: &'static str,
    channels: Vec<ChannelSummary>,
}

async fn list_projects(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProjectSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let rows = sqlx::query_as::<_, (String, String, String, String, String, bool)>(
        "SELECT server_projects.id, server_projects.name, computer_id, computers.name, \
                folder_path, computers.revoked_at IS NOT NULL \
         FROM server_projects JOIN computers ON computers.id = computer_id \
         WHERE server_id = $1 AND visibility = 'open' \
         ORDER BY server_projects.created_at, server_projects.id",
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await?;
    let channel_rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT project_id, id, name FROM channels \
         WHERE server_id = $1 AND project_id IS NOT NULL \
         ORDER BY created_at, id",
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await?;
    let mut channels_by_project: HashMap<String, Vec<ChannelSummary>> = HashMap::new();
    for (project_id, id, name) in channel_rows {
        channels_by_project
            .entry(project_id)
            .or_default()
            .push(ChannelSummary {
                id,
                name,
                visibility: "open".to_owned(),
                member_subjects: Vec::new(),
            });
    }
    let mut projects = Vec::with_capacity(rows.len());
    for (id, name, computer_id, computer_name, folder_path, revoked) in rows {
        let connected_status = computer_status(&state, &computer_id).await;
        let computer_status = if revoked {
            "revoked".to_owned()
        } else if connected_status != "offline" {
            connected_status.to_owned()
        } else if computer_recently_seen(&state, &computer_id).await? {
            "reconnecting".to_owned()
        } else {
            "offline".to_owned()
        };
        projects.push(ProjectSummary {
            channels: channels_by_project.remove(&id).unwrap_or_default(),
            id,
            name,
            computer_id,
            computer_name,
            computer_status,
            folder_path,
            visibility: "open",
        });
    }
    Ok(Json(projects))
}

async fn create_project(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<CreateProject>,
) -> Result<(StatusCode, Json<ProjectSummary>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    let folder_path = input.folder_path.trim();
    if folder_path.is_empty() || folder_path.len() > 4096 {
        return Err(ApiError::InvalidRequest);
    }
    let computer_credential = headers
        .get("x-buzzcode-computer-credential")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or(ApiError::Forbidden)?;
    let (computer_id, computer_name) = sqlx::query_as::<_, (String, String)>(
        "SELECT id, name FROM computers \
         WHERE owner_subject = $1 AND credential_hash = $2 AND revoked_at IS NULL",
    )
    .bind(&subject)
    .bind(token_hash(computer_credential))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Forbidden)?;
    create_project_on_computer(
        &state,
        &server_id,
        &subject,
        computer_id,
        computer_name,
        folder_path,
    )
    .await
}

async fn create_host_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateHostProject>,
) -> Result<(StatusCode, Json<ProjectSummary>), ApiError> {
    let credential = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or(ApiError::Unauthorized)?;
    let (computer_id, subject, computer_name) = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, owner_subject, name FROM computers \
             WHERE credential_hash = $1 AND revoked_at IS NULL",
    )
    .bind(token_hash(credential))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Unauthorized)?;
    let server_id = input.server_id.trim();
    require_manager(&state.pool, &subject, server_id).await?;
    create_project_on_computer(
        &state,
        server_id,
        &subject,
        computer_id,
        computer_name,
        input.folder_path.trim(),
    )
    .await
}

async fn create_project_on_computer(
    state: &AppState,
    server_id: &str,
    subject: &str,
    computer_id: String,
    computer_name: String,
    folder_path: &str,
) -> Result<(StatusCode, Json<ProjectSummary>), ApiError> {
    if server_id.is_empty() || folder_path.is_empty() || folder_path.len() > 4096 {
        return Err(ApiError::InvalidRequest);
    }
    let (folder_path, name) = bind_project_folder(state, &computer_id, folder_path).await?;
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::InvalidRequest);
    }
    let id = CsrfToken::new_random().secret().to_owned();
    let mut transaction = state.pool.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO server_projects \
         (id, server_id, computer_id, name, folder_path, created_by_subject) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(server_id)
    .bind(&computer_id)
    .bind(&name)
    .bind(&folder_path)
    .bind(subject)
    .execute(&mut *transaction)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::Conflict);
    }
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
         VALUES ($1, $2, 'project.created', jsonb_build_object( \
             'projectId', $3::TEXT, 'computerId', $4::TEXT, \
             'folderPath', $5::TEXT, 'visibility', 'open'))",
    )
    .bind(server_id)
    .bind(subject)
    .bind(&id)
    .bind(&computer_id)
    .bind(&folder_path)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let project = ProjectSummary {
        id,
        name,
        computer_id,
        computer_name,
        computer_status: "online".to_owned(),
        folder_path,
        visibility: "open",
        channels: Vec::new(),
    };
    let _ = state.changes.send(ServerEvent::ProjectsChanged {
        server_id: server_id.to_owned(),
    });
    Ok((StatusCode::CREATED, Json(project)))
}

async fn create_project_channel(
    State(state): State<Arc<AppState>>,
    Path((server_id, project_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<CreateProjectChannel>,
) -> Result<(StatusCode, Json<ChannelSummary>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::InvalidRequest);
    }
    let id = CsrfToken::new_random().secret().to_owned();
    let mut transaction = state.pool.begin().await?;
    let project_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM server_projects \
         WHERE id = $1 AND server_id = $2 AND visibility = 'open')",
    )
    .bind(&project_id)
    .bind(&server_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !project_exists {
        return Err(ApiError::NotFound);
    }
    let inserted = sqlx::query(
        "INSERT INTO channels \
         (id, server_id, project_id, name, visibility, created_by_subject) \
         VALUES ($1, $2, $3, $4, 'open', $5) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&project_id)
    .bind(name)
    .bind(&subject)
    .execute(&mut *transaction)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::Conflict);
    }
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
         VALUES ($1, $2, 'project.channel_created', jsonb_build_object( \
             'projectId', $3::TEXT, 'channelId', $4::TEXT, 'visibility', 'open'))",
    )
    .bind(&server_id)
    .bind(&subject)
    .bind(&project_id)
    .bind(&id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let channel = ChannelSummary {
        id,
        name: name.to_owned(),
        visibility: "open".to_owned(),
        member_subjects: Vec::new(),
    };
    let _ = state
        .changes
        .send(ServerEvent::ProjectsChanged { server_id });
    Ok((StatusCode::CREATED, Json(channel)))
}
