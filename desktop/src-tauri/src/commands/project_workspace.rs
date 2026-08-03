use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderSelection {
    path: String,
    name: String,
    computer_id: String,
    computer_name: String,
    git_repository: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerIdentity {
    computer_id: String,
    computer_name: String,
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "This computer".to_string())
}

/// Stable, non-secret installation identifier used to route project work to
/// agents running on this computer. It is separate from the user's identity.
pub(crate) fn computer_id<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<String, String> {
    static COMPUTER_ID_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = COMPUTER_ID_LOCK
        .lock()
        .map_err(|_| "Computer identity lock is unavailable".to_string())?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create app data directory: {error}"))?;
    let path = dir.join("computer-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let value = existing.trim();
        if uuid::Uuid::parse_str(value).is_ok() {
            return Ok(value.to_string());
        }
    }
    let value = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, format!("{value}\n"))
        .map_err(|error| format!("Could not persist computer identity: {error}"))?;
    Ok(value)
}

#[tauri::command]
pub async fn get_computer_identity(app: tauri::AppHandle) -> Result<ComputerIdentity, String> {
    Ok(ComputerIdentity {
        computer_id: computer_id(&app)?,
        computer_name: computer_name(),
    })
}

/// Choose the workspace hosted by this computer for a shared Buzz project.
///
/// The canonical absolute path is intentionally returned to the renderer: a
/// shared project advertises which connected computer and working directory
/// its Codex/ACP session uses. Selecting a folder does not upload it or turn it
/// into a Git repository.
#[tauri::command]
pub async fn pick_project_folder(
    app: tauri::AppHandle,
) -> Result<Option<ProjectFolderSelection>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });

    let Some(file_path) = rx.await.map_err(|_| "dialog cancelled".to_string())? else {
        return Ok(None);
    };
    let path = file_path
        .as_path()
        .ok_or_else(|| "Folder picker returned an invalid path".to_string())?
        .canonicalize()
        .map_err(|error| format!("Selected folder is not accessible: {error}"))?;
    if !path.is_dir() {
        return Err("Selected path is not a folder".to_string());
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Project")
        .to_string();
    let git_repository = path.join(".git").exists();

    Ok(Some(ProjectFolderSelection {
        path: path.to_string_lossy().into_owned(),
        name,
        computer_id: computer_id(&app)?,
        computer_name: computer_name(),
        git_repository,
    }))
}
