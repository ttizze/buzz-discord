use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{State, WebSocketUpgrade, ws::Message},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, postgres::PgPoolOptions};
use thiserror::Error;
use tokio::{net::TcpListener, sync::broadcast};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

const DURABLE_VALUE_KEY: &str = "durable-value";

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    changes: broadcast::Sender<ServerEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableState {
    value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerEvent {
    DurableStateChanged { state: DurableState },
}

#[derive(Debug, Serialize)]
struct Health {
    status: &'static str,
}

#[derive(Debug, Error)]
enum ApiError {
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
}

/// Failures that can occur while starting or serving the Buzzcode API.
#[derive(Debug, Error)]
pub enum ServerError {
    /// PostgreSQL could not be reached or queried.
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
    /// An embedded database migration could not be applied.
    #[error("database migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),
    /// The HTTP listener or server failed.
    #[error("server I/O failed")]
    Io(#[from] std::io::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        tracing::error!(error = ?self, "request failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": self.to_string() })),
        )
            .into_response()
    }
}

/// Connects to PostgreSQL and applies all embedded Buzzcode migrations.
pub async fn connect_database(database_url: &str) -> Result<PgPool, ServerError> {
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

/// Serves the Buzzcode HTTP and WebSocket API until the task is cancelled.
pub async fn serve(listener: TcpListener, pool: PgPool) -> Result<(), ServerError> {
    let (changes, _) = broadcast::channel(64);
    let state = Arc::new(AppState { pool, changes });
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/api/bootstrap", get(read_state).put(write_state))
        .route("/api/events", get(events))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    axum::serve(listener, app).await?;
    Ok(())
}

async fn live() -> Json<Health> {
    Json(Health { status: "ok" })
}

async fn ready(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(Health { status: "ready" })),
        Err(error) => {
            tracing::warn!(?error, "readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(Health {
                    status: "unavailable",
                }),
            )
        }
    }
}

async fn read_state(State(state): State<Arc<AppState>>) -> Result<Json<DurableState>, ApiError> {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM bootstrap_state WHERE key = $1")
        .bind(DURABLE_VALUE_KEY)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(DurableState { value }))
}

async fn write_state(
    State(state): State<Arc<AppState>>,
    Json(input): Json<DurableState>,
) -> Result<Json<DurableState>, ApiError> {
    let value = input.value.trim().to_owned();
    let saved = DurableState {
        value: sqlx::query_scalar::<_, String>(
            "INSERT INTO bootstrap_state (key, value) VALUES ($1, $2) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() \
             RETURNING value",
        )
        .bind(DURABLE_VALUE_KEY)
        .bind(value)
        .fetch_one(&state.pool)
        .await?,
    };

    let _ = state.changes.send(ServerEvent::DurableStateChanged {
        state: saved.clone(),
    });
    Ok(Json(saved))
}

async fn events(
    websocket: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    websocket.on_upgrade(move |socket| async move {
        let (mut sender, _) = socket.split();
        let mut changes = state.changes.subscribe();

        loop {
            match changes.recv().await {
                Ok(event) => {
                    let Ok(payload) = serde_json::to_string(&event) else {
                        tracing::error!("failed to serialize server event");
                        continue;
                    };
                    if sender.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "websocket client lagged");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_event_uses_the_public_json_contract() {
        let event = ServerEvent::DurableStateChanged {
            state: DurableState {
                value: "saved".to_owned(),
            },
        };

        let json = serde_json::to_value(event).unwrap_or_default();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "durableStateChanged",
                "state": { "value": "saved" }
            })
        );
    }
}
