use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use super::{
    domain::{CreatingComputer, Project, ProjectChannel, ProjectFile},
    service::{self, ProjectError},
};
use crate::{
    ApiError, AppState, ChannelSummary,
    hosts::{authenticate_host_computer, authenticate_owned_computer},
    require_origin, require_session,
};

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
    computer_status: &'static str,
    folder_path: String,
    visibility: &'static str,
    channels: Vec<ChannelSummary>,
}

#[derive(Debug, Serialize)]
struct ProjectFileSummary {
    name: String,
    kind: String,
}

impl From<ProjectFile> for ProjectFileSummary {
    fn from(file: ProjectFile) -> Self {
        Self {
            name: file.name,
            kind: file.kind,
        }
    }
}

impl From<ProjectError> for ApiError {
    fn from(error: ProjectError) -> Self {
        match error {
            ProjectError::Unauthorized => Self::Unauthorized,
            ProjectError::InvalidRequest => Self::InvalidRequest,
            ProjectError::Forbidden => Self::Forbidden,
            ProjectError::NotFound => Self::NotFound,
            ProjectError::Conflict => Self::Conflict,
            ProjectError::Database(error) => Self::Database(error),
        }
    }
}

impl From<ProjectChannel> for ChannelSummary {
    fn from(channel: ProjectChannel) -> Self {
        Self {
            id: channel.id,
            name: channel.name,
            visibility: "open".to_owned(),
            member_subjects: Vec::new(),
        }
    }
}

impl From<Project> for ProjectSummary {
    fn from(project: Project) -> Self {
        Self {
            id: project.id,
            name: project.name,
            computer_id: project.computer_id,
            computer_name: project.computer_name,
            computer_status: project.computer_status.as_str(),
            folder_path: project.folder_path,
            visibility: "open",
            channels: project.channels.into_iter().map(Into::into).collect(),
        }
    }
}

pub(super) fn routes() -> Router<Arc<AppState>> {
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
            post(create_project_channel),
        )
        .route("/api/host/projects", post(create_host_project))
}

async fn list_project_files(
    State(state): State<Arc<AppState>>,
    Path((server_id, project_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProjectFileSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    Ok(Json(
        service::list_files(&state, &subject, &server_id, &project_id)
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    ))
}

async fn list_projects(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProjectSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    Ok(Json(
        service::list(&state, &subject, &server_id)
            .await?
            .into_iter()
            .map(Into::into)
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
    let computer_credential = headers
        .get("x-buzzcode-computer-credential")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or(ApiError::Forbidden)?;
    let computer = authenticate_owned_computer(&state.pool, &subject, computer_credential).await?;
    let project = service::create(
        &state,
        CreatingComputer {
            id: computer.id,
            owner_subject: computer.owner_subject,
            name: computer.name,
        },
        &server_id,
        &input.folder_path,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(project.into())))
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
    let computer = authenticate_host_computer(&state.pool, credential).await?;
    let project = service::create(
        &state,
        CreatingComputer {
            id: computer.id,
            owner_subject: computer.owner_subject,
            name: computer.name,
        },
        &input.server_id,
        &input.folder_path,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(project.into())))
}

async fn create_project_channel(
    State(state): State<Arc<AppState>>,
    Path((server_id, project_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<CreateProjectChannel>,
) -> Result<(StatusCode, Json<ChannelSummary>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let channel =
        service::create_channel(&state, &subject, &server_id, &project_id, &input.name).await?;
    Ok((StatusCode::CREATED, Json(channel.into())))
}
