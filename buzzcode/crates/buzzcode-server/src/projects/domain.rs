#[derive(Debug, PartialEq, Eq)]
pub(super) struct ProjectInput {
    pub(super) server_id: String,
    pub(super) folder_path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DomainError {
    InvalidInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ComputerConnection {
    Online,
    Reconnecting,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProjectComputerStatus {
    Online,
    Reconnecting,
    Offline,
    Revoked,
}

impl ProjectComputerStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Reconnecting => "reconnecting",
            Self::Offline => "offline",
            Self::Revoked => "revoked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ProjectChannel {
    pub(super) id: String,
    pub(super) name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ProjectFile {
    pub(super) name: String,
    pub(super) kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CreatingComputer {
    pub(super) id: String,
    pub(super) owner_subject: String,
    pub(super) name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Project {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) computer_id: String,
    pub(super) computer_name: String,
    pub(super) computer_status: ProjectComputerStatus,
    pub(super) folder_path: String,
    pub(super) channels: Vec<ProjectChannel>,
}

pub(super) fn project_input(
    server_id: &str,
    folder_path: &str,
) -> Result<ProjectInput, DomainError> {
    let server_id = server_id.trim();
    let folder_path = folder_path.trim();
    if server_id.is_empty() || folder_path.is_empty() || folder_path.len() > 4_096 {
        return Err(DomainError::InvalidInput);
    }
    Ok(ProjectInput {
        server_id: server_id.to_owned(),
        folder_path: folder_path.to_owned(),
    })
}

pub(super) fn channel_name(name: &str) -> Result<String, DomainError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(DomainError::InvalidInput);
    }
    Ok(name.to_owned())
}

pub(super) fn project_name(name: &str) -> Result<String, DomainError> {
    if name.is_empty() || name.chars().count() > 100 {
        return Err(DomainError::InvalidInput);
    }
    Ok(name.to_owned())
}

pub(super) fn project_computer_status(
    revoked: bool,
    connection: ComputerConnection,
    recently_seen: bool,
) -> ProjectComputerStatus {
    if revoked {
        return ProjectComputerStatus::Revoked;
    }
    match connection {
        ComputerConnection::Online => ProjectComputerStatus::Online,
        ComputerConnection::Reconnecting => ProjectComputerStatus::Reconnecting,
        ComputerConnection::Offline if recently_seen => ProjectComputerStatus::Reconnecting,
        ComputerConnection::Offline => ProjectComputerStatus::Offline,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ComputerConnection, DomainError, ProjectComputerStatus, ProjectInput, channel_name,
        project_computer_status, project_input, project_name,
    };

    #[test]
    fn project_input_trims_the_server_and_project_folder() {
        assert_eq!(
            project_input(" server-1 ", " /srv/project "),
            Ok(ProjectInput {
                server_id: "server-1".to_owned(),
                folder_path: "/srv/project".to_owned(),
            })
        );
    }

    #[test]
    fn project_input_rejects_missing_or_oversized_locations() {
        let oversized = "x".repeat(4_097);
        for (server_id, folder_path) in [
            ("", "/srv/project"),
            ("server-1", "  "),
            ("server-1", oversized.as_str()),
        ] {
            assert_eq!(
                project_input(server_id, folder_path),
                Err(DomainError::InvalidInput)
            );
        }
    }

    #[test]
    fn channel_name_is_trimmed_and_bounded() {
        assert_eq!(channel_name(" general "), Ok("general".to_owned()));
        let oversized = "x".repeat(81);
        for input in ["  ", oversized.as_str()] {
            assert_eq!(channel_name(input), Err(DomainError::InvalidInput));
        }
    }

    #[test]
    fn project_name_preserves_the_bound_folder_basename_and_limits_length() {
        assert_eq!(project_name("my project"), Ok("my project".to_owned()));
        let oversized = "x".repeat(101);
        for input in ["", oversized.as_str()] {
            assert_eq!(project_name(input), Err(DomainError::InvalidInput));
        }
    }

    #[test]
    fn project_computer_status_preserves_connection_and_revocation_priority() {
        for (revoked, connection, recently_seen, expected) in [
            (
                false,
                ComputerConnection::Online,
                false,
                ProjectComputerStatus::Online,
            ),
            (
                false,
                ComputerConnection::Reconnecting,
                false,
                ProjectComputerStatus::Reconnecting,
            ),
            (
                false,
                ComputerConnection::Offline,
                true,
                ProjectComputerStatus::Reconnecting,
            ),
            (
                false,
                ComputerConnection::Offline,
                false,
                ProjectComputerStatus::Offline,
            ),
            (
                true,
                ComputerConnection::Online,
                true,
                ProjectComputerStatus::Revoked,
            ),
        ] {
            assert_eq!(
                project_computer_status(revoked, connection, recently_seen),
                expected
            );
        }
    }
}
