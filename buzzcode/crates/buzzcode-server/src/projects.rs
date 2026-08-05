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
    ApiError, AppState, ChannelSummary, ServerEvent, hosts::repositories_for_online_host,
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
    remote_environment_id: String,
    repository_path: String,
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
    remote_environment_id: String,
    repository_path: String,
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
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, name, remote_environment_id, repository_path \
         FROM server_projects WHERE server_id = $1 AND visibility = 'open' \
         ORDER BY created_at, id",
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
    Ok(Json(
        rows.into_iter()
            .map(
                |(id, name, remote_environment_id, repository_path)| ProjectSummary {
                    channels: channels_by_project.remove(&id).unwrap_or_default(),
                    id,
                    name,
                    remote_environment_id,
                    repository_path,
                    visibility: "open",
                },
            )
            .collect(),
    ))
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
    let repository_path = input.repository_path.trim();
    if name.is_empty()
        || name.chars().count() > 100
        || input.remote_environment_id.trim().is_empty()
        || repository_path.is_empty()
        || repository_path.len() > 4096
    {
        return Err(ApiError::InvalidRequest);
    }
    let repositories =
        repositories_for_online_host(&state, &server_id, input.remote_environment_id.trim())
            .await?;
    if !repositories
        .iter()
        .any(|repository| repository.path == repository_path)
    {
        return Err(ApiError::InvalidRequest);
    }
    let id = CsrfToken::new_random().secret().to_owned();
    let mut transaction = state.pool.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO server_projects \
         (id, server_id, remote_environment_id, name, repository_path, created_by_subject) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(input.remote_environment_id.trim())
    .bind(name)
    .bind(repository_path)
    .bind(&subject)
    .execute(&mut *transaction)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::Conflict);
    }
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
         VALUES ($1, $2, 'project.created', jsonb_build_object( \
             'projectId', $3::TEXT, 'remoteEnvironmentId', $4::TEXT, \
             'repositoryPath', $5::TEXT, 'visibility', 'open'))",
    )
    .bind(&server_id)
    .bind(&subject)
    .bind(&id)
    .bind(input.remote_environment_id.trim())
    .bind(repository_path)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let project = ProjectSummary {
        id,
        name: name.to_owned(),
        remote_environment_id: input.remote_environment_id.trim().to_owned(),
        repository_path: repository_path.to_owned(),
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
