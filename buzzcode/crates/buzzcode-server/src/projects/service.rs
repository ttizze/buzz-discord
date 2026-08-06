use std::collections::HashMap;

use openidconnect::CsrfToken;

use super::{
    domain::{
        ComputerConnection, CreatingComputer, DomainError, Project, ProjectChannel,
        ProjectComputerStatus, ProjectFile, channel_name, project_computer_status, project_input,
        project_name,
    },
    store::{self, NewProject, NewProjectChannel},
};
use crate::{
    AppState, ServerEvent,
    hosts::{
        HostProjectError, bind_project_folder, computer_recently_seen, computer_status,
        list_project_folder,
    },
};

#[derive(Debug, thiserror::Error)]
pub(super) enum ProjectError {
    #[error("authentication is required")]
    Unauthorized,
    #[error("the project request is invalid")]
    InvalidRequest,
    #[error("the project operation is forbidden")]
    Forbidden,
    #[error("the project was not found")]
    NotFound,
    #[error("the project request conflicts with current state")]
    Conflict,
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
}

impl From<HostProjectError> for ProjectError {
    fn from(error: HostProjectError) -> Self {
        match error {
            HostProjectError::InvalidRequest => Self::InvalidRequest,
            HostProjectError::Conflict => Self::Conflict,
            HostProjectError::Database(error) => Self::Database(error),
        }
    }
}

fn invalid_domain_input(_: DomainError) -> ProjectError {
    ProjectError::InvalidRequest
}

async fn require_member(
    state: &AppState,
    subject: &str,
    server_id: &str,
) -> Result<(), ProjectError> {
    if store::server_role(&state.pool, subject, server_id)
        .await?
        .is_none()
    {
        return Err(ProjectError::Unauthorized);
    }
    Ok(())
}

async fn require_manager(
    state: &AppState,
    subject: &str,
    server_id: &str,
) -> Result<(), ProjectError> {
    match store::server_role(&state.pool, subject, server_id)
        .await?
        .as_deref()
    {
        Some("owner" | "admin") => Ok(()),
        Some(_) => Err(ProjectError::Forbidden),
        None => Err(ProjectError::Unauthorized),
    }
}

fn connection_status(status: &str) -> ComputerConnection {
    match status {
        "online" => ComputerConnection::Online,
        "reconnecting" => ComputerConnection::Reconnecting,
        _ => ComputerConnection::Offline,
    }
}

pub(super) async fn list_files(
    state: &AppState,
    subject: &str,
    server_id: &str,
    project_id: &str,
) -> Result<Vec<ProjectFile>, ProjectError> {
    require_member(state, subject, server_id).await?;
    let (computer_id, folder_path) = store::project_folder(&state.pool, server_id, project_id)
        .await?
        .ok_or(ProjectError::NotFound)?;
    Ok(list_project_folder(state, &computer_id, &folder_path)
        .await?
        .into_iter()
        .map(|entry| ProjectFile {
            name: entry.name,
            kind: entry.kind,
        })
        .collect())
}

pub(super) async fn list(
    state: &AppState,
    subject: &str,
    server_id: &str,
) -> Result<Vec<Project>, ProjectError> {
    require_member(state, subject, server_id).await?;
    let mut channels_by_project: HashMap<String, Vec<ProjectChannel>> = HashMap::new();
    for channel in store::project_channels(&state.pool, server_id).await? {
        channels_by_project
            .entry(channel.project_id)
            .or_default()
            .push(ProjectChannel {
                id: channel.id,
                name: channel.name,
            });
    }
    let stored_projects = store::projects(&state.pool, server_id).await?;
    let mut projects = Vec::with_capacity(stored_projects.len());
    for stored in stored_projects {
        let connected = computer_status(state, &stored.computer_id).await;
        let recently_seen = if connected == "offline" && !stored.revoked {
            computer_recently_seen(state, &stored.computer_id).await?
        } else {
            false
        };
        projects.push(Project {
            channels: channels_by_project.remove(&stored.id).unwrap_or_default(),
            computer_status: project_computer_status(
                stored.revoked,
                connection_status(connected),
                recently_seen,
            ),
            id: stored.id,
            name: stored.name,
            computer_id: stored.computer_id,
            computer_name: stored.computer_name,
            folder_path: stored.folder_path,
        });
    }
    Ok(projects)
}

pub(super) async fn create(
    state: &AppState,
    computer: CreatingComputer,
    server_id: &str,
    folder_path: &str,
) -> Result<Project, ProjectError> {
    require_manager(state, &computer.owner_subject, server_id).await?;
    let input = project_input(server_id, folder_path).map_err(invalid_domain_input)?;
    create_on_computer(
        state,
        &input.server_id,
        &computer.owner_subject,
        computer.id,
        computer.name,
        &input.folder_path,
    )
    .await
}

async fn create_on_computer(
    state: &AppState,
    server_id: &str,
    subject: &str,
    computer_id: String,
    computer_name: String,
    folder_path: &str,
) -> Result<Project, ProjectError> {
    let (folder_path, bound_name) = bind_project_folder(state, &computer_id, folder_path).await?;
    let name = project_name(&bound_name).map_err(invalid_domain_input)?;
    let id = CsrfToken::new_random().secret().to_owned();
    let new_project = NewProject {
        id: &id,
        server_id,
        computer_id: &computer_id,
        name: &name,
        folder_path: &folder_path,
        subject,
    };
    let mut transaction = state.pool.begin().await?;
    if !store::insert_project(&mut transaction, &new_project).await? {
        return Err(ProjectError::Conflict);
    }
    store::record_project_created(&mut transaction, &new_project).await?;
    transaction.commit().await?;
    let project = Project {
        id,
        name,
        computer_id,
        computer_name,
        computer_status: ProjectComputerStatus::Online,
        folder_path,
        channels: Vec::new(),
    };
    let _ = state.changes.send(ServerEvent::ProjectsChanged {
        server_id: server_id.to_owned(),
    });
    Ok(project)
}

pub(super) async fn create_channel(
    state: &AppState,
    subject: &str,
    server_id: &str,
    project_id: &str,
    input_name: &str,
) -> Result<ProjectChannel, ProjectError> {
    require_manager(state, subject, server_id).await?;
    let name = channel_name(input_name).map_err(invalid_domain_input)?;
    let id = CsrfToken::new_random().secret().to_owned();
    let new_channel = NewProjectChannel {
        id: &id,
        server_id,
        project_id,
        name: &name,
        subject,
    };
    let mut transaction = state.pool.begin().await?;
    if !store::project_exists(&mut transaction, server_id, project_id).await? {
        return Err(ProjectError::NotFound);
    }
    if !store::insert_project_channel(&mut transaction, &new_channel).await? {
        return Err(ProjectError::Conflict);
    }
    store::record_project_channel_created(&mut transaction, &new_channel).await?;
    transaction.commit().await?;
    let channel = ProjectChannel { id, name };
    let _ = state.changes.send(ServerEvent::ProjectsChanged {
        server_id: server_id.to_owned(),
    });
    Ok(channel)
}
