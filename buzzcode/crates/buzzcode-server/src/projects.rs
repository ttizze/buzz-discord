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
    hosts::{computer_recently_seen, computer_status},
    require_manager, require_member, require_origin, require_session,
};

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/servers/{server_id}/projects",
            get(list_projects).post(create_project),
        )
        .route(
            "/api/servers/{server_id}/projects/{project_id}/channels",
            axum::routing::post(create_project_channel),
        )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateProject {
    name: String,
    computer_id: String,
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
            "online".to_owned()
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
    let name = input.name.trim();
    let computer_id = input.computer_id.trim();
    let folder_path = input.folder_path.trim();
    if name.is_empty()
        || name.chars().count() > 100
        || computer_id.is_empty()
        || folder_path.is_empty()
        || folder_path.len() > 4096
    {
        return Err(ApiError::InvalidRequest);
    }
    let computer_name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM computers \
         WHERE id = $1 AND owner_subject = $2 AND revoked_at IS NULL",
    )
    .bind(computer_id)
    .bind(&subject)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    if !computer_recently_seen(&state, computer_id).await? {
        return Err(ApiError::Conflict);
    }
    let id = CsrfToken::new_random().secret().to_owned();
    let mut transaction = state.pool.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO server_projects \
         (id, server_id, computer_id, name, folder_path, created_by_subject) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(computer_id)
    .bind(name)
    .bind(folder_path)
    .bind(&subject)
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
    .bind(&server_id)
    .bind(&subject)
    .bind(&id)
    .bind(computer_id)
    .bind(folder_path)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let project = ProjectSummary {
        id,
        name: name.to_owned(),
        computer_id: computer_id.to_owned(),
        computer_name,
        computer_status: "online".to_owned(),
        folder_path: folder_path.to_owned(),
        visibility: "open",
        channels: Vec::new(),
    };
    let _ = state
        .changes
        .send(ServerEvent::ProjectsChanged { server_id });
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
