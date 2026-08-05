//! Buzzcode Host runtime shared by the headless binary and the Tauri desktop app.

#![allow(dead_code)]

include!("main.rs");

/// Runs an already-registered Computer as a reconnecting Buzzcode Host.
pub async fn run_embedded(
    api_origin: String,
    computer_id: String,
    credential: String,
) -> anyhow::Result<()> {
    let state = HostState {
        computer_id,
        api_origin,
        credential,
        installation_id: "embedded-desktop".to_owned(),
        name: "Buzzcode Desktop".to_owned(),
    };
    let codex_command =
        std::env::var("BUZZCODE_CODEX_ACP_COMMAND").unwrap_or_else(|_| "codex-acp".to_owned());
    loop {
        match connect(&state, &codex_command).await {
            Ok(ConnectionEnd::Revoked) => return Ok(()),
            Ok(ConnectionEnd::Disconnected) | Err(_) => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}
