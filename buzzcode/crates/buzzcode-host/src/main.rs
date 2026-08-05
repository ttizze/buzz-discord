use std::{
    collections::HashSet,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use tracing_subscriber::EnvFilter;
use url::Url;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostState {
    remote_environment_id: String,
    server_id: String,
    api_origin: String,
    credential: String,
    installation_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    id: String,
    server_id: String,
    credential: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    pairing_code: &'a str,
    installation_id: &'a str,
    name: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct HostRepository {
    name: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HostMessage<'a> {
    Ready { repositories: &'a [HostRepository] },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let Some(command) = arguments.first().map(String::as_str) else {
        bail!(usage());
    };
    match command {
        "pair" => pair(parse_pair_arguments(&arguments[1..])?).await,
        "run" => run(parse_run_arguments(&arguments[1..])?).await,
        _ => bail!(usage()),
    }
}

fn usage() -> &'static str {
    "usage: buzzcode-host pair --api-origin URL --pairing-code CODE --name NAME --state PATH\n       buzzcode-host run --state PATH [--repository PATH ...]"
}

fn option(arguments: &[String], name: &str) -> anyhow::Result<String> {
    let position = arguments
        .iter()
        .position(|argument| argument == name)
        .with_context(|| format!("{name} is required"))?;
    arguments
        .get(position + 1)
        .filter(|value| !value.starts_with("--"))
        .cloned()
        .with_context(|| format!("{name} requires a value"))
}

struct PairArguments {
    api_origin: String,
    pairing_code: String,
    name: String,
    state_path: PathBuf,
}

fn parse_pair_arguments(arguments: &[String]) -> anyhow::Result<PairArguments> {
    Ok(PairArguments {
        api_origin: option(arguments, "--api-origin")?,
        pairing_code: option(arguments, "--pairing-code")?,
        name: option(arguments, "--name")?,
        state_path: option(arguments, "--state")?.into(),
    })
}

struct RunArguments {
    state_path: PathBuf,
    repository_paths: Vec<PathBuf>,
}

fn parse_run_arguments(arguments: &[String]) -> anyhow::Result<RunArguments> {
    let repository_paths = arguments
        .windows(2)
        .filter(|pair| pair[0] == "--repository")
        .map(|pair| PathBuf::from(&pair[1]))
        .collect();
    Ok(RunArguments {
        state_path: option(arguments, "--state")?.into(),
        repository_paths,
    })
}

async fn pair(arguments: PairArguments) -> anyhow::Result<()> {
    if arguments.state_path.exists() {
        bail!(
            "{} already exists; this Host is already paired",
            arguments.state_path.display()
        );
    }
    Url::parse(&arguments.api_origin).context("--api-origin must be a valid URL")?;
    let installation_id = format!("host-{:032x}", rand::random::<u128>());
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/hosts/pair",
            arguments.api_origin.trim_end_matches('/')
        ))
        .json(&PairRequest {
            pairing_code: &arguments.pairing_code,
            installation_id: &installation_id,
            name: &arguments.name,
        })
        .send()
        .await
        .context("pairing request failed")?
        .error_for_status()
        .context("pairing was rejected")?
        .json::<PairResponse>()
        .await
        .context("pairing response was invalid")?;
    let state = HostState {
        remote_environment_id: response.id,
        server_id: response.server_id,
        api_origin: arguments.api_origin,
        credential: response.credential,
        installation_id,
        name: arguments.name,
    };
    write_private_state(&arguments.state_path, &state)?;
    println!("paired {}", state.remote_environment_id);
    Ok(())
}

fn write_private_state(path: &Path, state: &HostState) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    let encoded = serde_json::to_vec_pretty(state).context("failed to encode Host state")?;
    file.write_all(&encoded)
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

async fn run(arguments: RunArguments) -> anyhow::Result<()> {
    let contents = std::fs::read(&arguments.state_path)
        .with_context(|| format!("failed to read {}", arguments.state_path.display()))?;
    let state: HostState = serde_json::from_slice(&contents).context("Host state is invalid")?;
    let repositories = discover_repositories(&arguments.repository_paths);
    loop {
        match connect(&state, &repositories).await {
            Ok(ConnectionEnd::Revoked) => {
                tracing::warn!("Host access was revoked");
                return Ok(());
            }
            Ok(ConnectionEnd::Disconnected) => {
                tracing::warn!("Host connection closed; reconnecting");
            }
            Err(error) => tracing::warn!(?error, "Host connection failed; reconnecting"),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn discover_repositories(paths: &[PathBuf]) -> Vec<HostRepository> {
    let mut seen = HashSet::new();
    paths
        .iter()
        .filter_map(|path| {
            let output = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(["rev-parse", "--show-toplevel"])
                .output()
                .ok()?;
            if !output.status.success() {
                tracing::warn!(path = %path.display(), "ignoring a non-Git repository path");
                return None;
            }
            let root = String::from_utf8(output.stdout).ok()?;
            let root = root.trim();
            let canonical = std::fs::canonicalize(root).ok()?;
            let canonical = canonical.to_string_lossy().into_owned();
            if !seen.insert(canonical.clone()) {
                return None;
            }
            let name = Path::new(&canonical)
                .file_name()
                .and_then(|value| value.to_str())?
                .to_owned();
            Some(HostRepository {
                name,
                path: canonical,
            })
        })
        .collect()
}

enum ConnectionEnd {
    Disconnected,
    Revoked,
}

async fn connect(
    state: &HostState,
    repositories: &[HostRepository],
) -> anyhow::Result<ConnectionEnd> {
    let mut url = Url::parse(&state.api_origin).context("apiOrigin is invalid")?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| anyhow::anyhow!("apiOrigin scheme cannot be used for WebSocket"))?;
    url.set_path("/api/hosts/connect");
    url.set_query(None);
    let mut request = url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", state.credential).parse()?,
    );
    let (mut socket, _) = connect_async(request).await?;
    socket
        .send(Message::Text(
            serde_json::to_string(&HostMessage::Ready { repositories })?.into(),
        ))
        .await?;
    tracing::info!(environment_id = %state.remote_environment_id, "Host connected");
    while let Some(message) = socket.next().await {
        if let Message::Close(frame) = message? {
            return Ok(if frame.is_some_and(|frame| frame.reason == "revoked") {
                ConnectionEnd::Revoked
            } else {
                ConnectionEnd::Disconnected
            });
        }
    }
    Ok(ConnectionEnd::Disconnected)
}
