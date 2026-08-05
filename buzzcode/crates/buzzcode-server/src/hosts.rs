use std::{collections::HashSet, sync::Arc};

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

use crate::{
    ApiError, AppState, ServerEvent, require_manager, require_member, require_origin,
    require_session, token_hash,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostStatus {
    Online,
    Reconnecting,
}

#[derive(Debug, Clone)]
pub(crate) struct HostPresence {
    status: HostStatus,
    connection_id: String,
    repositories: Vec<HostRepository>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct HostRepository {
    pub(crate) name: String,
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HostMessage {
    Ready { repositories: Vec<HostRepository> },
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/hosts/pair", post(pair_host))
        .route("/api/hosts/connect", get(connect_host))
        .route(
            "/api/servers/{server_id}/host-pairing-codes",
            post(create_pairing_code),
        )
        .route(
            "/api/servers/{server_id}/remote-environments",
            get(list_remote_environments),
        )
        .route(
            "/api/servers/{server_id}/remote-environments/{environment_id}",
            axum::routing::delete(revoke_remote_environment),
        )
        .route(
            "/api/servers/{server_id}/remote-environments/{environment_id}/repositories",
            get(list_host_repositories),
        )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingCode {
    code: String,
    expires_at: String,
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
    id: String,
    server_id: String,
    credential: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEnvironment {
    id: String,
    server_id: String,
    name: String,
    status: String,
    created_at: String,
    last_seen_at: Option<String>,
}

async fn create_pairing_code(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<PairingCode>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;

    let code = CsrfToken::new_random().secret().to_owned();
    let expires_at = sqlx::query_scalar::<_, String>(
        "INSERT INTO host_pairing_codes (token_hash, server_id, created_by_subject) \
         VALUES ($1, $2, $3) RETURNING expires_at::TEXT",
    )
    .bind(token_hash(&code))
    .bind(server_id)
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
    if pairing_code.is_empty()
        || installation_id.is_empty()
        || installation_id.len() > 200
        || name.is_empty()
        || name.chars().count() > 100
    {
        return Err(ApiError::InvalidRequest);
    }

    let credential = CsrfToken::new_random().secret().to_owned();
    let id = format!("host-{}", CsrfToken::new_random().secret());
    let mut transaction = state.pool.begin().await?;
    sqlx::query("DELETE FROM host_pairing_codes WHERE expires_at <= NOW()")
        .execute(&mut *transaction)
        .await?;
    let server_id = sqlx::query_scalar::<_, String>(
        "DELETE FROM host_pairing_codes WHERE token_hash = $1 AND expires_at > NOW() \
         RETURNING server_id",
    )
    .bind(token_hash(pairing_code))
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    sqlx::query(
        "INSERT INTO remote_environments \
         (id, server_id, installation_id, name, credential_hash) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(&server_id)
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
    let _ = state.changes.send(ServerEvent::RemoteEnvironmentsChanged {
        server_id: server_id.clone(),
    });
    Ok((
        StatusCode::CREATED,
        Json(PairedHost {
            id,
            server_id,
            credential,
        }),
    ))
}

async fn list_remote_environments(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<RemoteEnvironment>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, bool)>(
        "SELECT id, server_id, name, created_at::TEXT, last_seen_at::TEXT, revoked_at IS NOT NULL \
         FROM remote_environments WHERE server_id = $1 ORDER BY created_at, id",
    )
    .bind(server_id)
    .fetch_all(&state.pool)
    .await?;
    let presence = state.host_presence.read().await;
    Ok(Json(
        rows.into_iter()
            .map(|(id, server_id, name, created_at, last_seen_at, revoked)| {
                let status = if revoked {
                    "revoked"
                } else {
                    match presence.get(&id).map(|value| value.status) {
                        Some(HostStatus::Online) => "online",
                        Some(HostStatus::Reconnecting) => "reconnecting",
                        None => "offline",
                    }
                }
                .to_owned();
                RemoteEnvironment {
                    id,
                    server_id,
                    name,
                    status,
                    created_at,
                    last_seen_at,
                }
            })
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
    let (environment_id, server_id) = sqlx::query_as::<_, (String, String)>(
        "UPDATE remote_environments SET last_seen_at = NOW() \
         WHERE credential_hash = $1 AND revoked_at IS NULL RETURNING id, server_id",
    )
    .bind(token_hash(credential))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::Unauthorized)?;
    let connection_id = CsrfToken::new_random().secret().to_owned();
    Ok(websocket.on_upgrade(move |mut socket| async move {
        let mut revocations = state.host_revocations.subscribe();
        let repositories = loop {
            tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(Message::Text(payload))) => {
                        let Ok(HostMessage::Ready { repositories }) =
                            serde_json::from_str::<HostMessage>(&payload)
                        else {
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1008,
                                reason: "invalid Host ready message".into(),
                            }))).await;
                            return;
                        };
                        let mut paths = HashSet::new();
                        let valid = repositories.len() <= 100
                            && repositories.iter().all(|repository| {
                                !repository.name.trim().is_empty()
                                    && repository.name.chars().count() <= 200
                                    && repository.path.starts_with('/')
                                    && repository.path.len() <= 4096
                                    && paths.insert(repository.path.clone())
                            });
                        if !valid {
                            let _ = socket.send(Message::Close(Some(CloseFrame {
                                code: 1008,
                                reason: "invalid Host repositories".into(),
                            }))).await;
                            return;
                        }
                        break repositories;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                },
                revocation = revocations.recv() => match revocation {
                    Ok(revoked_id) if revoked_id == environment_id => {
                        let _ = socket.send(Message::Close(Some(CloseFrame {
                            code: 1008,
                            reason: "revoked".into(),
                        }))).await;
                        return;
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        };
        state.host_presence.write().await.insert(
            environment_id.clone(),
            HostPresence {
                status: HostStatus::Online,
                connection_id: connection_id.clone(),
                repositories,
            },
        );
        let _ = state.changes.send(ServerEvent::RemoteEnvironmentsChanged {
            server_id: server_id.clone(),
        });
        let revoked = loop {
            tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break false,
                    Some(Ok(_)) => {}
                },
                revocation = revocations.recv() => match revocation {
                    Ok(revoked_id) if revoked_id == environment_id => {
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
        let current = presence
            .get(&environment_id)
            .is_some_and(|value| value.connection_id == connection_id);
        if !current {
            return;
        }
        if revoked {
            presence.remove(&environment_id);
            return;
        }
        let repositories = presence
            .get(&environment_id)
            .map(|value| value.repositories.clone())
            .unwrap_or_default();
        presence.insert(
            environment_id.clone(),
            HostPresence {
                status: HostStatus::Reconnecting,
                connection_id: connection_id.clone(),
                repositories,
            },
        );
        drop(presence);
        let _ = state.changes.send(ServerEvent::RemoteEnvironmentsChanged {
            server_id: server_id.clone(),
        });
        let presence = Arc::clone(&state.host_presence);
        let changes = state.changes.clone();
        let grace = state.host_reconnect_grace;
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let mut presence = presence.write().await;
            let still_reconnecting = presence.get(&environment_id).is_some_and(|value| {
                value.connection_id == connection_id && value.status == HostStatus::Reconnecting
            });
            if still_reconnecting {
                presence.remove(&environment_id);
                let _ = changes.send(ServerEvent::RemoteEnvironmentsChanged { server_id });
            }
        });
    }))
}

pub(crate) async fn repositories_for_online_host(
    state: &AppState,
    server_id: &str,
    environment_id: &str,
) -> Result<Vec<HostRepository>, ApiError> {
    let belongs_to_server = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM remote_environments \
         WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL)",
    )
    .bind(environment_id)
    .bind(server_id)
    .fetch_one(&state.pool)
    .await?;
    if !belongs_to_server {
        return Err(ApiError::NotFound);
    }
    let presence = state.host_presence.read().await;
    match presence.get(environment_id) {
        Some(HostPresence {
            status: HostStatus::Online,
            repositories,
            ..
        }) => Ok(repositories.clone()),
        _ => Err(ApiError::Conflict),
    }
}

async fn list_host_repositories(
    State(state): State<Arc<AppState>>,
    Path((server_id, environment_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<HostRepository>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    Ok(Json(
        repositories_for_online_host(&state, &server_id, &environment_id).await?,
    ))
}

async fn revoke_remote_environment(
    State(state): State<Arc<AppState>>,
    Path((server_id, environment_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    let changed = sqlx::query(
        "UPDATE remote_environments SET revoked_at = NOW() \
         WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL",
    )
    .bind(&environment_id)
    .bind(&server_id)
    .execute(&state.pool)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    state.host_presence.write().await.remove(&environment_id);
    let _ = state.host_revocations.send(environment_id);
    let _ = state
        .changes
        .send(ServerEvent::RemoteEnvironmentsChanged { server_id });
    Ok(StatusCode::NO_CONTENT)
}
