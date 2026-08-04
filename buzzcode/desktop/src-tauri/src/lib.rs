/// Starts the Buzzcode Tauri desktop shell.
pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default().run(tauri::generate_context!())
}
