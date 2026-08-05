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
use futures_util::StreamExt;
use openidconnect::CsrfToken;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::{ApiError, AppState, ServerEvent, require_origin, require_session, token_hash};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostStatus {
    Online,
    Reconnecting,
}

#[derive(Debug, Clone)]
pub(crate) struct HostPresence {
    pub(crate) status: HostStatus,
    connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HostMessage {
    Ready,
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
) -> Result<(StatusCode, Json<ComputerSummary>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let installation_id = input.installation_id.trim();
    let name = input.name.trim();
    if !validate_identity(installation_id, name) {
        return Err(ApiError::InvalidRequest);
    }
    let id = format!("computer-{}", CsrfToken::new_random().secret());
    let row = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        "INSERT INTO computers (id, owner_subject, installation_id, name, last_seen_at) \
         VALUES ($1, $2, $3, $4, NOW()) \
         ON CONFLICT (installation_id) DO UPDATE \
         SET name = EXCLUDED.name, last_seen_at = NOW() \
         WHERE computers.owner_subject = EXCLUDED.owner_subject \
               AND computers.revoked_at IS NULL \
         RETURNING id, created_at::TEXT, name, last_seen_at::TEXT",
    )
    .bind(id)
    .bind(subject)
    .bind(installation_id)
    .bind(name)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Conflict)?;
    Ok((
        StatusCode::OK,
        Json(ComputerSummary {
            id: row.0,
            created_at: row.1,
            name: row.2,
            last_seen_at: row.3,
            status: "online".to_owned(),
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
                            None if recently_seen => "online",
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
        loop {
            tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(Message::Text(payload))) => {
                        if !matches!(serde_json::from_str::<HostMessage>(&payload), Ok(HostMessage::Ready)) {
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1008,
                                reason: "invalid Host ready message".into(),
                            }))).await;
                            return;
                        }
                        break;
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
        }
        state.host_presence.write().await.insert(
            computer_id.clone(),
            HostPresence {
                status: HostStatus::Online,
                connection_id: connection_id.clone(),
            },
        );
        notify_project_servers(&state, &computer_id).await;
        let revoked = loop {
            tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break false,
                    Some(Ok(_)) => {}
                },
                revocation = revocations.recv() => match revocation {
                    Ok(revoked_id) if revoked_id == computer_id => {
                        let _ = socket.send(Message::Close(Some(CloseFrame {
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
