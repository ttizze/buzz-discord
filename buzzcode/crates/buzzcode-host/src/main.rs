use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use tracing_subscriber::EnvFilter;
use url::Url;

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
struct AgentDescriptor {
    id: &'static str,
    name: &'static str,
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
    "usage: buzzcode-host pair --api-origin URL --pairing-code CODE --name NAME --state PATH\n       buzzcode-host run --state PATH"
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
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<HostMessage>();
    outbound_tx.send(HostMessage::Ready {
        agents: vec![AgentDescriptor {
            id: "codex",
            name: "Codex",
        }],
    })?;
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
                        outbound_tx.send(HostMessage::Error {
                            request_id: None,
                            run_id: None,
                            message: format!("invalid Host command: {error}"),
                        })?;
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
                            });
                        match result {
                            Ok(path) => outbound_tx.send(HostMessage::FolderBound {
                                request_id,
                                path: path.to_string_lossy().into_owned(),
                            })?,
                            Err(error) => outbound_tx.send(HostMessage::Error {
                                request_id: Some(request_id),
                                run_id: None,
                                message: error.to_string(),
                            })?,
                        }
                    }
                    ServerMessage::OpenAgent {
                        run_id,
                        agent_id,
                        cwd,
                    } => {
                        tracing::info!(%run_id, %agent_id, %cwd, "opening ACP Agent");
                        if agent_id != "codex" {
                            outbound_tx.send(HostMessage::Error {
                                request_id: None,
                                run_id: Some(run_id),
                                message: "Agent is not available on this Computer".to_owned(),
                            })?;
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
                                outbound_tx.send(HostMessage::Error {
                                    request_id: None,
                                    run_id: Some(run_id),
                                    message: format!("failed to start {codex_command}: {error}"),
                                })?;
                                continue;
                            }
                        };
                        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take())
                        else {
                            outbound_tx.send(HostMessage::Error {
                                request_id: None,
                                run_id: Some(run_id),
                                message: "Agent stdio is unavailable".to_owned(),
                            })?;
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
                                        let _ = tx.send(HostMessage::Acp {
                                            run_id: output_run_id.clone(),
                                            message,
                                        });
                                    }
                                    Err(error) => {
                                        let _ = tx.send(HostMessage::Error {
                                            request_id: None,
                                            run_id: Some(output_run_id.clone()),
                                            message: format!("Agent emitted invalid ACP: {error}"),
                                        });
                                    }
                                }
                            }
                        });
                        agents.insert(run_id.clone(), AgentProcess { stdin, child });
                        outbound_tx.send(HostMessage::AgentOpened { run_id })?;
                    }
                    ServerMessage::Acp { run_id, message } => {
                        tracing::debug!(%run_id, ?message, "forwarding ACP message");
                        let Some(agent) = agents.get_mut(&run_id) else {
                            outbound_tx.send(HostMessage::Error {
                                request_id: None,
                                run_id: Some(run_id),
                                message: "Agent Run is not open".to_owned(),
                            })?;
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
