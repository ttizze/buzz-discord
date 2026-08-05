use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Semaphore, mpsc},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use tracing_subscriber::EnvFilter;
use url::Url;

const MAX_CONCURRENT_FOLDER_LISTINGS: usize = 4;
const MAX_PROJECT_FOLDER_ENTRIES: usize = 1_000;
const HOST_OUTBOUND_QUEUE_CAPACITY: usize = 64;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostState {
    #[serde(alias = "remoteEnvironmentId")]
    computer_id: String,
    api_origin: String,
    credential: String,
    installation_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    computer_id: String,
    credential: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    pairing_code: &'a str,
    installation_id: &'a str,
    name: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRequest<'a> {
    server_id: &'a str,
    folder_path: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDescriptor {
    id: &'static str,
    name: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFileEntry {
    name: String,
    kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HostMessage {
    Ready {
        agents: Vec<AgentDescriptor>,
    },
    FolderBound {
        request_id: String,
        path: String,
        name: String,
    },
    FolderListed {
        request_id: String,
        entries: Vec<ProjectFileEntry>,
    },
    AgentOpened {
        run_id: String,
    },
    Acp {
        run_id: String,
        message: Value,
    },
    Error {
        request_id: Option<String>,
        run_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    BindFolder {
        request_id: String,
        path: String,
    },
    ListFolder {
        request_id: String,
        path: String,
    },
    OpenAgent {
        run_id: String,
        agent_id: String,
        cwd: String,
    },
    Acp {
        run_id: String,
        message: Value,
    },
    CloseAgent {
        run_id: String,
    },
}

fn list_project_folder(path: &str) -> anyhow::Result<Vec<ProjectFileEntry>> {
    let canonical = std::fs::canonicalize(path).with_context(|| format!("cannot access {path}"))?;
    anyhow::ensure!(canonical.is_dir(), "Project Folder is not a directory");
    let mut entries = std::fs::read_dir(canonical)
        .context("cannot list Project Folder")?
        .take(MAX_PROJECT_FOLDER_ENTRIES + 1)
        .map(|entry| {
            let entry = entry.context("cannot read Project entry")?;
            let kind = if entry
                .file_type()
                .context("cannot inspect Project entry")?
                .is_dir()
            {
                "directory"
            } else {
                "file"
            };
            Ok(ProjectFileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                kind,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        entries.len() <= MAX_PROJECT_FOLDER_ENTRIES,
        "Project Folder has too many entries"
    );
    entries.sort_by(|left, right| {
        (left.kind, left.name.to_ascii_lowercase())
            .cmp(&(right.kind, right.name.to_ascii_lowercase()))
    });
    Ok(entries)
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
        "project" if arguments.get(1).map(String::as_str) == Some("add") => {
            add_project(parse_project_arguments(&arguments[2..])?).await
        }
        "run" => run(parse_run_arguments(&arguments[1..])?).await,
        _ => bail!(usage()),
    }
}

fn usage() -> &'static str {
    "usage: buzzcode-host pair --api-origin URL --pairing-code CODE --name NAME --state PATH\n       buzzcode-host project add --state PATH --server-id ID --folder PATH\n       buzzcode-host run --state PATH"
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
    codex_command: String,
}

struct ProjectArguments {
    state_path: PathBuf,
    server_id: String,
    folder_path: String,
}

fn parse_project_arguments(arguments: &[String]) -> anyhow::Result<ProjectArguments> {
    Ok(ProjectArguments {
        state_path: option(arguments, "--state")?.into(),
        server_id: option(arguments, "--server-id")?,
        folder_path: option(arguments, "--folder")?,
    })
}

fn parse_run_arguments(arguments: &[String]) -> anyhow::Result<RunArguments> {
    Ok(RunArguments {
        state_path: option(arguments, "--state")?.into(),
        codex_command: option(arguments, "--codex-command")
            .ok()
            .or_else(|| std::env::var("BUZZCODE_CODEX_ACP_COMMAND").ok())
            .unwrap_or_else(|| "codex-acp".to_owned()),
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
        computer_id: response.computer_id,
        api_origin: arguments.api_origin,
        credential: response.credential,
        installation_id,
        name: arguments.name,
    };
    write_private_state(&arguments.state_path, &state)?;
    println!("paired {}", state.computer_id);
    Ok(())
}

async fn add_project(arguments: ProjectArguments) -> anyhow::Result<()> {
    let contents = std::fs::read(&arguments.state_path)
        .with_context(|| format!("failed to read {}", arguments.state_path.display()))?;
    let state: HostState = serde_json::from_slice(&contents).context("Host state is invalid")?;
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/host/projects",
            state.api_origin.trim_end_matches('/')
        ))
        .bearer_auth(&state.credential)
        .json(&ProjectRequest {
            server_id: &arguments.server_id,
            folder_path: &arguments.folder_path,
        })
        .send()
        .await
        .context("Project request failed")?
        .error_for_status()
        .context("Project creation was rejected")?;
    println!("{}", response.text().await?);
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
    loop {
        match connect(&state, &arguments.codex_command).await {
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

enum ConnectionEnd {
    Disconnected,
    Revoked,
}

struct AgentProcess {
    stdin: ChildStdin,
    child: Child,
}

async fn connect(state: &HostState, codex_command: &str) -> anyhow::Result<ConnectionEnd> {
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
    let (socket, _) = connect_async(request).await?;
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<HostMessage>(HOST_OUTBOUND_QUEUE_CAPACITY);
    outbound_tx
        .send(HostMessage::Ready {
            agents: vec![AgentDescriptor {
                id: "codex",
                name: "Codex",
            }],
        })
        .await?;
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            socket_tx
                .send(Message::Text(serde_json::to_string(&message)?.into()))
                .await?;
        }
        anyhow::Ok(())
    });
    tracing::info!(computer_id = %state.computer_id, "Host connected");
    let mut agents = HashMap::<String, AgentProcess>::new();
    let folder_listing_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_FOLDER_LISTINGS));
    let mut connection_end = ConnectionEnd::Disconnected;
    while let Some(message) = socket_rx.next().await {
        match message? {
            Message::Close(frame) => {
                if frame.is_some_and(|frame| frame.reason == "revoked") {
                    connection_end = ConnectionEnd::Revoked;
                }
                break;
            }
            Message::Text(payload) => {
                let command = match serde_json::from_str::<ServerMessage>(&payload) {
                    Ok(command) => command,
                    Err(error) => {
                        outbound_tx
                            .send(HostMessage::Error {
                                request_id: None,
                                run_id: None,
                                message: format!("invalid Host command: {error}"),
                            })
                            .await?;
                        continue;
                    }
                };
                match command {
                    ServerMessage::BindFolder { request_id, path } => {
                        let result = std::fs::canonicalize(&path)
                            .with_context(|| format!("cannot access {path}"))
                            .and_then(|canonical| {
                                canonical
                                    .is_dir()
                                    .then_some(canonical)
                                    .context("Project Folder is not a directory")
                            })
                            .and_then(|canonical| {
                                let name = canonical
                                    .file_name()
                                    .filter(|name| !name.is_empty())
                                    .context("Project Folder has no name")?
                                    .to_string_lossy()
                                    .into_owned();
                                anyhow::ensure!(
                                    name.chars().count() <= 100,
                                    "Project Folder name is too long"
                                );
                                Ok((canonical, name))
                            });
                        match result {
                            Ok((path, name)) => {
                                outbound_tx
                                    .send(HostMessage::FolderBound {
                                        request_id,
                                        path: path.to_string_lossy().into_owned(),
                                        name,
                                    })
                                    .await?
                            }
                            Err(error) => {
                                outbound_tx
                                    .send(HostMessage::Error {
                                        request_id: Some(request_id),
                                        run_id: None,
                                        message: error.to_string(),
                                    })
                                    .await?
                            }
                        }
                    }
                    ServerMessage::ListFolder { request_id, path } => {
                        let Ok(permit) = Arc::clone(&folder_listing_slots).try_acquire_owned()
                        else {
                            outbound_tx
                                .send(HostMessage::Error {
                                    request_id: Some(request_id),
                                    run_id: None,
                                    message: "too many Project Folder listings".to_owned(),
                                })
                                .await?;
                            continue;
                        };
                        let outbound_tx = outbound_tx.clone();
                        tokio::task::spawn_blocking(move || {
                            let _permit = permit;
                            let message = match list_project_folder(&path) {
                                Ok(entries) => HostMessage::FolderListed {
                                    request_id,
                                    entries,
                                },
                                Err(error) => HostMessage::Error {
                                    request_id: Some(request_id),
                                    run_id: None,
                                    message: error.to_string(),
                                },
                            };
                            if outbound_tx.blocking_send(message).is_err() {
                                tracing::debug!(
                                    "Host disconnected before folder listing completed"
                                );
                            }
                        });
                    }
                    ServerMessage::OpenAgent {
                        run_id,
                        agent_id,
                        cwd,
                    } => {
                        tracing::info!(%run_id, %agent_id, %cwd, "opening ACP Agent");
                        if agent_id != "codex" {
                            outbound_tx
                                .send(HostMessage::Error {
                                    request_id: None,
                                    run_id: Some(run_id),
                                    message: "Agent is not available on this Computer".to_owned(),
                                })
                                .await?;
                            continue;
                        }
                        let child = Command::new(codex_command)
                            .current_dir(&cwd)
                            .stdin(Stdio::piped())
                            .stdout(Stdio::piped())
                            .stderr(Stdio::inherit())
                            .spawn();
                        let mut child = match child {
                            Ok(child) => child,
                            Err(error) => {
                                outbound_tx
                                    .send(HostMessage::Error {
                                        request_id: None,
                                        run_id: Some(run_id),
                                        message: format!(
                                            "failed to start {codex_command}: {error}"
                                        ),
                                    })
                                    .await?;
                                continue;
                            }
                        };
                        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take())
                        else {
                            outbound_tx
                                .send(HostMessage::Error {
                                    request_id: None,
                                    run_id: Some(run_id),
                                    message: "Agent stdio is unavailable".to_owned(),
                                })
                                .await?;
                            let _ = child.kill().await;
                            continue;
                        };
                        let tx = outbound_tx.clone();
                        let output_run_id = run_id.clone();
                        tokio::spawn(async move {
                            let mut lines = BufReader::new(stdout).lines();
                            while let Ok(Some(line)) = lines.next_line().await {
                                match serde_json::from_str::<Value>(&line) {
                                    Ok(message) => {
                                        if tx
                                            .send(HostMessage::Acp {
                                                run_id: output_run_id.clone(),
                                                message,
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Err(error) => {
                                        if tx
                                            .send(HostMessage::Error {
                                                request_id: None,
                                                run_id: Some(output_run_id.clone()),
                                                message: format!(
                                                    "Agent emitted invalid ACP: {error}"
                                                ),
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                }
                            }
                        });
                        agents.insert(run_id.clone(), AgentProcess { stdin, child });
                        outbound_tx
                            .send(HostMessage::AgentOpened { run_id })
                            .await?;
                    }
                    ServerMessage::Acp { run_id, message } => {
                        tracing::debug!(%run_id, ?message, "forwarding ACP message");
                        let Some(agent) = agents.get_mut(&run_id) else {
                            outbound_tx
                                .send(HostMessage::Error {
                                    request_id: None,
                                    run_id: Some(run_id),
                                    message: "Agent Run is not open".to_owned(),
                                })
                                .await?;
                            continue;
                        };
                        let mut encoded = serde_json::to_vec(&message)?;
                        encoded.push(b'\n');
                        agent.stdin.write_all(&encoded).await?;
                        agent.stdin.flush().await?;
                    }
                    ServerMessage::CloseAgent { run_id } => {
                        if let Some(mut agent) = agents.remove(&run_id) {
                            let _ = agent.child.kill().await;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for (_, mut agent) in agents {
        let _ = agent.child.kill().await;
    }
    drop(outbound_tx);
    let _ = writer.await;
    Ok(connection_end)
}
