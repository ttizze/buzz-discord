use std::fs;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputerIdentity {
    installation_id: String,
    name: String,
}

#[tauri::command]
fn computer_identity(app: tauri::AppHandle) -> Result<ComputerIdentity, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("computer-id");
    let installation_id = match fs::read_to_string(&path) {
        Ok(value) if !value.trim().is_empty() => value.trim().to_owned(),
        Ok(_) | Err(_) => {
            let value = format!("desktop-{:032x}", rand::random::<u128>());
            fs::write(path, &value).map_err(|error| error.to_string())?;
            value
        }
    };
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "This Computer".to_owned());
    Ok(ComputerIdentity {
        installation_id,
        name,
    })
}

#[tauri::command]
async fn select_project_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned())
}

#[tauri::command]
fn start_computer_host(api_origin: String, computer_id: String, credential: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = buzzcode_host::run_embedded(api_origin, computer_id, credential).await {
            eprintln!("Buzzcode Host stopped: {error}");
        }
    });
}

/// Starts the Buzzcode Tauri desktop shell.
pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            computer_identity,
            select_project_folder,
            start_computer_host
        ])
        .run(tauri::generate_context!())
}
