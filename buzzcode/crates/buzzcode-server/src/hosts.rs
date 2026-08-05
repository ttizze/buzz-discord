use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{CloseFrame, Message},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use openidconnect::CsrfToken;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{broadcast, mpsc},
    time::{Duration, timeout},
};

use crate::{ApiError, AppState, ServerEvent, require_origin, require_session, token_hash};

const HOST_COMMAND_QUEUE_CAPACITY: usize = 64;
const HOST_CONTROL_QUEUE_CAPACITY: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostStatus {
    Online,
    Reconnecting,
}

#[derive(Debug, Clone)]
pub(crate) struct HostPresence {
    pub(crate) status: HostStatus,
    connection_id: String,
    commands: mpsc::Sender<ServerHostMessage>,
    control_commands: mpsc::Sender<ServerHostMessage>,
    inbound: broadcast::Sender<ClientHostMessage>,
    pub(crate) agents: Vec<AgentDescriptor>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDescriptor {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFileEntry {
    pub(crate) name: String,
    pub(crate) kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientHostMessage {
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
        message: serde_json::Value,
    },
    Error {
        request_id: Option<String>,
        run_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerHostMessage {
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
        message: serde_json::Value,
    },
    CloseAgent {
        run_id: String,
    },
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/computers", get(list_computers))
        .route("/api/computers/register", post(register_computer))
        .route(
            "/api/computers/{computer_id}",
            axum::routing::delete(revoke_computer),
        )
        .route("/api/host-pairing-codes", post(create_pairing_code))
        .route("/api/hosts/pair", post(pair_host))
        .route("/api/hosts/connect", get(connect_host))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingCode {
    code: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegisterComputer {
    installation_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PairHost {
    pairing_code: String,
    installation_id: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedHost {
    computer_id: String,
    credential: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredComputer {
    #[serde(flatten)]
    computer: ComputerSummary,
    credential: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerSummary {
    pub(crate) id: String,
    name: String,
    status: String,
    created_at: String,
    last_seen_at: Option<String>,
}

fn validate_identity(installation_id: &str, name: &str) -> bool {
    !installation_id.is_empty()
        && installation_id.len() <= 200
        && !name.is_empty()
        && name.chars().count() <= 100
}

async fn register_computer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<RegisterComputer>,
) -> Result<(StatusCode, Json<RegisteredComputer>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let installation_id = input.installation_id.trim();
    let name = input.name.trim();
    if !validate_identity(installation_id, name) {
        return Err(ApiError::InvalidRequest);
    }
    let id = format!("computer-{}", CsrfToken::new_random().secret());
    let credential = CsrfToken::new_random().secret().to_owned();
    let row = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        "INSERT INTO computers (id, owner_subject, installation_id, name, credential_hash, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, NOW()) \
         ON CONFLICT (installation_id) DO UPDATE \
         SET name = EXCLUDED.name, credential_hash = EXCLUDED.credential_hash, last_seen_at = NOW() \
         WHERE computers.owner_subject = EXCLUDED.owner_subject \
               AND computers.revoked_at IS NULL \
         RETURNING id, created_at::TEXT, name, last_seen_at::TEXT",
    )
    .bind(id)
    .bind(subject)
    .bind(installation_id)
    .bind(name)
    .bind(token_hash(&credential))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Conflict)?;
    Ok((
        StatusCode::OK,
        Json(RegisteredComputer {
            computer: ComputerSummary {
                id: row.0,
                created_at: row.1,
                name: row.2,
                last_seen_at: row.3,
                status: "reconnecting".to_owned(),
            },
            credential,
        }),
    ))
}

async fn create_pairing_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<PairingCode>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let code = CsrfToken::new_random().secret().to_owned();
    let expires_at = sqlx::query_scalar::<_, String>(
        "INSERT INTO host_pairing_codes (token_hash, created_by_subject, owner_subject) \
         VALUES ($1, $2, $2) RETURNING expires_at::TEXT",
    )
    .bind(token_hash(&code))
    .bind(subject)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(PairingCode { code, expires_at })))
}

async fn pair_host(
    State(state): State<Arc<AppState>>,
    Json(input): Json<PairHost>,
) -> Result<(StatusCode, Json<PairedHost>), ApiError> {
    let pairing_code = input.pairing_code.trim();
    let installation_id = input.installation_id.trim();
    let name = input.name.trim();
    if pairing_code.is_empty() || !validate_identity(installation_id, name) {
        return Err(ApiError::InvalidRequest);
    }
    let credential = CsrfToken::new_random().secret().to_owned();
    let id = format!("computer-{}", CsrfToken::new_random().secret());
    let mut transaction = state.pool.begin().await?;
    sqlx::query("DELETE FROM host_pairing_codes WHERE expires_at <= NOW()")
        .execute(&mut *transaction)
        .await?;
    let owner_subject = sqlx::query_scalar::<_, String>(
        "DELETE FROM host_pairing_codes WHERE token_hash = $1 AND expires_at > NOW() \
         RETURNING owner_subject",
    )
    .bind(token_hash(pairing_code))
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    sqlx::query(
        "INSERT INTO computers \
         (id, owner_subject, installation_id, name, credential_hash) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(owner_subject)
    .bind(installation_id)
    .bind(name)
    .bind(token_hash(&credential))
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
        {
            ApiError::Conflict
        } else {
            ApiError::Database(error)
        }
    })?;
    transaction.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(PairedHost {
            computer_id: id,
            credential,
        }),
    ))
}

async fn list_computers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<ComputerSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>, bool, bool)>(
        "SELECT id, name, created_at::TEXT, last_seen_at::TEXT, revoked_at IS NOT NULL, \
                COALESCE(last_seen_at > NOW() - ($2 * INTERVAL '1 millisecond'), FALSE) \
         FROM computers WHERE owner_subject = $1 ORDER BY created_at, id",
    )
    .bind(subject)
    .bind(state.computer_online_timeout.as_millis() as i64)
    .fetch_all(&state.pool)
    .await?;
    let presence = state.host_presence.read().await;
    Ok(Json(
        rows.into_iter()
            .map(
                |(id, name, created_at, last_seen_at, revoked, recently_seen)| {
                    let status = if revoked {
                        "revoked"
                    } else {
                        match presence.get(&id).map(|value| value.status) {
                            Some(HostStatus::Online) => "online",
                            Some(HostStatus::Reconnecting) => "reconnecting",
                            None if recently_seen => "reconnecting",
                            None => "offline",
                        }
                    };
                    ComputerSummary {
                        id,
                        name,
                        status: status.to_owned(),
                        created_at,
                        last_seen_at,
                    }
                },
            )
            .collect(),
    ))
}

async fn connect_host(
    websocket: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let credential = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or(ApiError::Unauthorized)?;
    let computer_id = sqlx::query_scalar::<_, String>(
        "UPDATE computers SET last_seen_at = NOW() \
         WHERE credential_hash = $1 AND revoked_at IS NULL RETURNING id",
    )
    .bind(token_hash(credential))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Unauthorized)?;
    let connection_id = CsrfToken::new_random().secret().to_owned();
    Ok(websocket.on_upgrade(move |mut socket| async move {
        let mut revocations = state.host_revocations.subscribe();
        let agents = loop {
            tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(Message::Text(payload))) => {
                        match serde_json::from_str::<ClientHostMessage>(&payload) {
                            Ok(ClientHostMessage::Ready { agents }) if !agents.is_empty() => break agents,
                            _ => {
                                let _ = socket.send(Message::Close(Some(CloseFrame {
                                    code: 1008,
                                    reason: "invalid Host ready message".into(),
                                }))).await;
                                return;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                },
                revocation = revocations.recv() => match revocation {
                    Ok(revoked_id) if revoked_id == computer_id => return,
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        };
        let (commands, mut command_rx) = mpsc::channel(HOST_COMMAND_QUEUE_CAPACITY);
        let (control_commands, mut control_command_rx) =
            mpsc::channel(HOST_CONTROL_QUEUE_CAPACITY);
        let (inbound, _) = broadcast::channel(128);
        state.host_presence.write().await.insert(
            computer_id.clone(),
            HostPresence {
                status: HostStatus::Online,
                connection_id: connection_id.clone(),
                commands,
                control_commands,
                inbound: inbound.clone(),
                agents,
            },
        );
        notify_project_servers(&state, &computer_id).await;
        let (mut socket_tx, mut socket_rx) = socket.split();
        let revoked = loop {
            tokio::select! {
                biased;
                command = control_command_rx.recv() => match command {
                    Some(command) => {
                        let Ok(payload) = serde_json::to_string(&command) else { break false };
                        if socket_tx.send(Message::Text(payload.into())).await.is_err() {
                            break false;
                        }
                    }
                    None => break false,
                },
                message = socket_rx.next() => match message {
                    Some(Ok(Message::Text(payload))) => {
                        match serde_json::from_str::<ClientHostMessage>(&payload) {
                            Ok(message) => {
                                tracing::debug!(?message, %computer_id, "received Host message");
                                let _ = inbound.send(message);
                            }
                            Err(error) => tracing::warn!(?error, %payload, "invalid Host message"),
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break false,
                    Some(Ok(_)) => {}
                },
                command = command_rx.recv() => match command {
                    Some(command) => {
                        let Ok(payload) = serde_json::to_string(&command) else { break false };
                        if socket_tx.send(Message::Text(payload.into())).await.is_err() {
                            break false;
                        }
                    }
                    None => break false,
                },
                revocation = revocations.recv() => match revocation {
                    Ok(revoked_id) if revoked_id == computer_id => {
                        let _ = socket_tx.send(Message::Close(Some(CloseFrame {
                            code: 1008,
                            reason: "revoked".into(),
                        }))).await;
                        break true;
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break false,
                }
            }
        };
        let mut presence = state.host_presence.write().await;
        if !presence
            .get(&computer_id)
            .is_some_and(|value| value.connection_id == connection_id)
        {
            return;
        }
        if revoked {
            presence.remove(&computer_id);
            return;
        }
        presence.insert(
            computer_id.clone(),
            HostPresence {
                status: HostStatus::Reconnecting,
                connection_id: connection_id.clone(),
                commands: mpsc::channel(1).0,
                control_commands: mpsc::channel(1).0,
                inbound: broadcast::channel(1).0,
                agents: Vec::new(),
            },
        );
        drop(presence);
        notify_project_servers(&state, &computer_id).await;
        let presence = Arc::clone(&state.host_presence);
        let state_for_notification = Arc::clone(&state);
        let grace = state.host_reconnect_grace;
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let mut presence = presence.write().await;
            let still_reconnecting = presence.get(&computer_id).is_some_and(|value| {
                value.connection_id == connection_id && value.status == HostStatus::Reconnecting
            });
            if still_reconnecting {
                presence.remove(&computer_id);
                drop(presence);
                notify_project_servers(&state_for_notification, &computer_id).await;
            }
        });
    }))
}

async fn connected_host(state: &AppState, computer_id: &str) -> Result<HostPresence, ApiError> {
    state
        .host_presence
        .read()
        .await
        .get(computer_id)
        .filter(|host| host.status == HostStatus::Online)
        .cloned()
        .ok_or(ApiError::Conflict)
}

pub(crate) async fn bind_project_folder(
    state: &AppState,
    computer_id: &str,
    path: &str,
) -> Result<(String, String), ApiError> {
    let host = connected_host(state, computer_id).await?;
    let request_id = CsrfToken::new_random().secret().to_owned();
    let mut inbound = host.inbound.subscribe();
    host.commands
        .try_send(ServerHostMessage::BindFolder {
            request_id: request_id.clone(),
            path: path.to_owned(),
        })
        .map_err(|_| ApiError::Conflict)?;
    timeout(Duration::from_secs(10), async move {
        loop {
            match inbound.recv().await {
                Ok(ClientHostMessage::FolderBound {
                    request_id: response_id,
                    path,
                    name,
                }) if response_id == request_id => return Ok((path, name)),
                Ok(ClientHostMessage::Error {
                    request_id: Some(response_id),
                    ..
                }) if response_id == request_id => return Err(ApiError::InvalidRequest),
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return Err(ApiError::Conflict),
            }
        }
    })
    .await
    .map_err(|_| ApiError::Conflict)?
}

pub(crate) async fn list_project_folder(
    state: &AppState,
    computer_id: &str,
    path: &str,
) -> Result<Vec<ProjectFileEntry>, ApiError> {
    let host = connected_host(state, computer_id).await?;
    let request_id = CsrfToken::new_random().secret().to_owned();
    let mut inbound = host.inbound.subscribe();
    host.commands
        .try_send(ServerHostMessage::ListFolder {
            request_id: request_id.clone(),
            path: path.to_owned(),
        })
        .map_err(|_| ApiError::Conflict)?;
    timeout(Duration::from_secs(10), async move {
        loop {
            match inbound.recv().await {
                Ok(ClientHostMessage::FolderListed {
                    request_id: response_id,
                    entries,
                }) if response_id == request_id => return Ok(entries),
                Ok(ClientHostMessage::Error {
                    request_id: Some(response_id),
                    ..
                }) if response_id == request_id => return Err(ApiError::InvalidRequest),
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return Err(ApiError::Conflict),
            }
        }
    })
    .await
    .map_err(|_| ApiError::Conflict)?
}

async fn wait_for_run_message(
    inbound: &mut broadcast::Receiver<ClientHostMessage>,
    run_id: &str,
    predicate: impl Fn(&ClientHostMessage) -> bool,
) -> Result<ClientHostMessage, String> {
    timeout(Duration::from_secs(120), async {
        loop {
            match inbound.recv().await {
                Ok(message) => match &message {
                    ClientHostMessage::Error {
                        run_id: Some(error_run_id),
                        message,
                        ..
                    } if error_run_id == run_id => return Err(message.clone()),
                    _ if predicate(&message) => return Ok(message),
                    _ => {}
                },
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => {
                    return Err("Computer disconnected".to_owned());
                }
            }
        }
    })
    .await
    .map_err(|_| "Agent timed out".to_owned())?
}

fn acp_request(id: i64, method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

pub(crate) async fn run_acp_prompt(
    state: &AppState,
    computer_id: &str,
    folder_path: &str,
    agent_id: &str,
    prompt: &str,
) -> Result<String, String> {
    let host = connected_host(state, computer_id)
        .await
        .map_err(|_| "Computer is offline".to_owned())?;
    if !host.agents.iter().any(|agent| agent.id == agent_id) {
        return Err("Agent is not available on this Computer".to_owned());
    }
    let run_id = CsrfToken::new_random().secret().to_owned();
    let mut inbound = host.inbound.subscribe();
    host.commands
        .try_send(ServerHostMessage::OpenAgent {
            run_id: run_id.clone(),
            agent_id: agent_id.to_owned(),
            cwd: folder_path.to_owned(),
        })
        .map_err(|_| "Computer disconnected".to_owned())?;
    let result = async {
        wait_for_run_message(&mut inbound, &run_id, |message| {
            matches!(message, ClientHostMessage::AgentOpened { run_id: id } if id == &run_id)
        })
        .await?;
        host.commands
            .try_send(ServerHostMessage::Acp {
                run_id: run_id.clone(),
                message: acp_request(
                    1,
                    "initialize",
                    serde_json::json!({
                        "protocolVersion": 1,
                        "clientCapabilities": {},
                        "clientInfo": {"name": "buzzcode", "title": "Buzzcode", "version": env!("CARGO_PKG_VERSION")}
                    }),
                ),
            })
            .map_err(|_| "Computer disconnected".to_owned())?;
        let initialized = wait_for_run_message(&mut inbound, &run_id, |message| {
            matches!(message, ClientHostMessage::Acp { run_id: id, message } if id == &run_id && message.get("id") == Some(&serde_json::json!(1)))
        })
        .await?;
        let ClientHostMessage::Acp { message, .. } = initialized else {
            return Err("Agent initialization failed".to_owned());
        };
        if message.pointer("/result/protocolVersion") != Some(&serde_json::json!(1)) {
            return Err("Agent does not support ACP v1".to_owned());
        }
        host.commands
            .try_send(ServerHostMessage::Acp {
                run_id: run_id.clone(),
                message: acp_request(
                    2,
                    "session/new",
                    serde_json::json!({"cwd": folder_path, "mcpServers": []}),
                ),
            })
            .map_err(|_| "Computer disconnected".to_owned())?;
        let session = wait_for_run_message(&mut inbound, &run_id, |message| {
            matches!(message, ClientHostMessage::Acp { run_id: id, message } if id == &run_id && message.get("id") == Some(&serde_json::json!(2)))
        })
        .await?;
        let ClientHostMessage::Acp { message, .. } = session else {
            return Err("Agent session creation failed".to_owned());
        };
        let session_id = message
            .pointer("/result/sessionId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Agent session creation failed".to_owned())?;
        host.commands
            .try_send(ServerHostMessage::Acp {
                run_id: run_id.clone(),
                message: acp_request(
                    3,
                    "session/prompt",
                    serde_json::json!({
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": prompt}]
                    }),
                ),
            })
            .map_err(|_| "Computer disconnected".to_owned())?;
        let mut output = String::new();
        loop {
            let message = wait_for_run_message(&mut inbound, &run_id, |message| {
                matches!(message, ClientHostMessage::Acp { run_id: id, .. } if id == &run_id)
            })
            .await?;
            let ClientHostMessage::Acp { message, .. } = message else {
                continue;
            };
            if message.get("id") == Some(&serde_json::json!(3)) {
                if message.get("error").is_some() {
                    return Err("Agent prompt failed".to_owned());
                }
                break;
            }
            if message.get("method") == Some(&serde_json::json!("session/update"))
                && message.pointer("/params/update/sessionUpdate")
                    == Some(&serde_json::json!("agent_message_chunk"))
                && message.pointer("/params/update/content/type")
                    == Some(&serde_json::json!("text"))
                && let Some(text) = message
                    .pointer("/params/update/content/text")
                    .and_then(serde_json::Value::as_str)
            {
                output.push_str(text);
            }
        }
        if output.trim().is_empty() {
            Err("Agent returned no message".to_owned())
        } else {
            Ok(output)
        }
    }
    .await;
    let _ = host
        .control_commands
        .send(ServerHostMessage::CloseAgent { run_id })
        .await;
    result
}

async fn notify_project_servers(state: &AppState, computer_id: &str) {
    let Ok(server_ids) = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT server_id FROM server_projects WHERE computer_id = $1",
    )
    .bind(computer_id)
    .fetch_all(&state.pool)
    .await
    else {
        return;
    };
    for server_id in server_ids {
        let _ = state
            .changes
            .send(ServerEvent::ProjectsChanged { server_id });
    }
}

async fn revoke_computer(
    State(state): State<Arc<AppState>>,
    Path(computer_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let changed = sqlx::query(
        "UPDATE computers SET revoked_at = NOW() \
         WHERE id = $1 AND owner_subject = $2 AND revoked_at IS NULL",
    )
    .bind(&computer_id)
    .bind(subject)
    .execute(&state.pool)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    state.host_presence.write().await.remove(&computer_id);
    let _ = state.host_revocations.send(computer_id.clone());
    notify_project_servers(&state, &computer_id).await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn computer_status(state: &AppState, computer_id: &str) -> &'static str {
    match state.host_presence.read().await.get(computer_id) {
        Some(HostPresence {
            status: HostStatus::Online,
            ..
        }) => "online",
        Some(HostPresence {
            status: HostStatus::Reconnecting,
            ..
        }) => "reconnecting",
        None => "offline",
    }
}

pub(crate) async fn computer_recently_seen(
    state: &AppState,
    computer_id: &str,
) -> Result<bool, ApiError> {
    let recent = sqlx::query_scalar::<_, bool>(
        "SELECT revoked_at IS NULL \
                AND last_seen_at > NOW() - ($2 * INTERVAL '1 millisecond') \
         FROM computers WHERE id = $1",
    )
    .bind(computer_id)
    .bind(state.computer_online_timeout.as_millis() as i64)
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or(false);
    Ok(recent || computer_status(state, computer_id).await != "offline")
}
