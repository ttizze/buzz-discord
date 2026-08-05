use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State, WebSocketUpgrade, ws::Message},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use openidconnect::CsrfToken;
use serde::{Deserialize, Serialize};
use sqlx::types::Json as SqlJson;

use super::{
    ApiError, AppState, EditMessage, ReactionInput, ReactionSummary, ReplyTarget, normalize_handle,
    require_origin, require_session,
};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum DirectMessageEvent {
    DirectMessageChanged {
        #[serde(rename = "directMessageId")]
        direct_message_id: String,
    },
    MessageCreated {
        #[serde(rename = "directMessageId")]
        direct_message_id: String,
        message: Box<DirectMessageMessage>,
    },
    MessageChanged {
        #[serde(rename = "directMessageId")]
        direct_message_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
    },
}

impl DirectMessageEvent {
    fn direct_message_id(&self) -> &str {
        match self {
            Self::DirectMessageChanged { direct_message_id }
            | Self::MessageCreated {
                direct_message_id, ..
            }
            | Self::MessageChanged {
                direct_message_id, ..
            } => direct_message_id,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StartDirectMessage {
    peer_user_id: String,
    peer_handle: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectMessageSummary {
    id: String,
    peer_user_id: String,
    peer_handle: String,
    peer_display_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDirectMessageMessage {
    content: String,
    reply_to_message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagePageQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectMessageMessage {
    id: String,
    sequence: i64,
    direct_message_id: String,
    content: Option<String>,
    author_subject: String,
    author_display_name: String,
    created_at: String,
    edited_at: Option<String>,
    deleted_at: Option<String>,
    reply_to: Option<ReplyTarget>,
    reactions: Vec<ReactionSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectMessagePage {
    messages: Vec<DirectMessageMessage>,
    next_before: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectMessageAuditEntry {
    id: i64,
    actor_subject: String,
    action: String,
    detail: serde_json::Value,
    created_at: String,
}

type DirectMessageRow = (
    String,
    i64,
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    SqlJson<Vec<ReactionSummary>>,
);

const MESSAGE_SELECT: &str = "SELECT message.id, message.sequence, message.direct_message_id, \
     message.content, message.author_subject, author.display_name, \
     TO_CHAR(message.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
     TO_CHAR(message.edited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
     TO_CHAR(message.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
     reply.id, reply.content, reply_author.display_name, reply.deleted_at IS NOT NULL, \
     COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT( \
         'emoji', grouped.emoji, 'count', grouped.reaction_count, 'reacted', grouped.reacted) \
         ORDER BY grouped.emoji) FROM ( \
             SELECT emoji, COUNT(*) AS reaction_count, BOOL_OR(oidc_subject = $2) AS reacted \
             FROM direct_message_reactions WHERE message_id = message.id GROUP BY emoji \
         ) grouped), '[]'::JSONB) \
     FROM direct_message_messages message \
     JOIN users author ON author.oidc_subject = message.author_subject \
     LEFT JOIN direct_message_messages reply ON reply.id = message.reply_to_message_id \
     LEFT JOIN users reply_author ON reply_author.oidc_subject = reply.author_subject";

fn message_from_row(row: DirectMessageRow) -> DirectMessageMessage {
    DirectMessageMessage {
        id: row.0,
        sequence: row.1,
        direct_message_id: row.2,
        content: row.3,
        author_subject: row.4,
        author_display_name: row.5,
        created_at: row.6,
        edited_at: row.7,
        deleted_at: row.8,
        reply_to: row.9.map(|id| ReplyTarget {
            id,
            content: row.10,
            author_display_name: row.11.unwrap_or_default(),
            deleted: row.12,
        }),
        reactions: row.13.0,
    }
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/direct-messages", get(list).post(start))
        .route("/api/direct-messages/events", get(events))
        .route(
            "/api/direct-messages/{direct_message_id}/messages",
            get(list_messages).post(create_message),
        )
        .route(
            "/api/direct-messages/{direct_message_id}/messages/{message_id}",
            get(get_message).patch(edit_message).delete(delete_message),
        )
        .route(
            "/api/direct-messages/{direct_message_id}/messages/{message_id}/reactions",
            post(add_reaction).delete(remove_reaction),
        )
        .route(
            "/api/direct-messages/{direct_message_id}/search",
            get(search_messages),
        )
        .route(
            "/api/direct-messages/{direct_message_id}/audit",
            get(list_audit),
        )
}

async fn list_audit(
    State(state): State<Arc<AppState>>,
    Path(direct_message_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<DirectMessageAuditEntry>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_access(&state, &subject, &direct_message_id).await?;
    let entries = sqlx::query_as::<_, (i64, String, String, serde_json::Value, String)>(
        "SELECT id, actor_subject, action, detail, \
         TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         FROM direct_message_audit_log WHERE direct_message_id = $1 \
         ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .bind(direct_message_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(
        |(id, actor_subject, action, detail, created_at)| DirectMessageAuditEntry {
            id,
            actor_subject,
            action,
            detail,
            created_at,
        },
    )
    .collect();
    Ok(Json(entries))
}

async fn can_access(
    state: &AppState,
    subject: &str,
    direct_message_id: &str,
) -> Result<bool, ApiError> {
    Ok(
        sqlx::query_scalar::<_, bool>("SELECT user_can_access_direct_message($1, $2)")
            .bind(direct_message_id)
            .bind(subject)
            .fetch_one(&state.pool)
            .await?,
    )
}

async fn require_access(
    state: &AppState,
    subject: &str,
    direct_message_id: &str,
) -> Result<(), ApiError> {
    if !can_access(state, subject, direct_message_id).await? {
        return Err(ApiError::NotFound);
    }
    Ok(())
}

async fn summary(
    state: &AppState,
    subject: &str,
    direct_message_id: &str,
) -> Result<DirectMessageSummary, ApiError> {
    sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT direct_message.id, peer.oidc_subject, peer.handle, peer.display_name \
         FROM direct_messages direct_message \
         JOIN users peer ON peer.oidc_subject = CASE \
             WHEN direct_message.participant_one_subject = $1 \
             THEN direct_message.participant_two_subject \
             ELSE direct_message.participant_one_subject END \
         WHERE direct_message.id = $2 AND $1 IN ( \
             direct_message.participant_one_subject, direct_message.participant_two_subject)",
    )
    .bind(subject)
    .bind(direct_message_id)
    .fetch_optional(&state.pool)
    .await?
    .map(
        |(id, peer_user_id, peer_handle, peer_display_name)| DirectMessageSummary {
            id,
            peer_user_id,
            peer_handle,
            peer_display_name,
        },
    )
    .ok_or(ApiError::NotFound)
}

async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<DirectMessageSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT direct_message.id, peer.oidc_subject, peer.handle, peer.display_name \
         FROM direct_messages direct_message \
         JOIN users peer ON peer.oidc_subject = CASE \
             WHEN direct_message.participant_one_subject = $1 \
             THEN direct_message.participant_two_subject \
             ELSE direct_message.participant_one_subject END \
         WHERE $1 IN (direct_message.participant_one_subject, direct_message.participant_two_subject) \
         ORDER BY direct_message.created_at, direct_message.id",
    )
    .bind(subject)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(
                |(id, peer_user_id, peer_handle, peer_display_name)| DirectMessageSummary {
                    id,
                    peer_user_id,
                    peer_handle,
                    peer_display_name,
                },
            )
            .collect(),
    ))
}

async fn start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<StartDirectMessage>,
) -> Result<Json<DirectMessageSummary>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let peer_handle = normalize_handle(&input.peer_handle).ok_or(ApiError::InvalidRequest)?;
    let peer_subject = sqlx::query_scalar::<_, String>(
        "SELECT oidc_subject FROM users WHERE oidc_subject = $1 AND handle = $2",
    )
    .bind(input.peer_user_id)
    .bind(peer_handle)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    if peer_subject == subject {
        return Err(ApiError::InvalidRequest);
    }
    let mut participants = [subject.clone(), peer_subject];
    participants.sort();
    let proposed_id = CsrfToken::new_random().secret().to_owned();
    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO direct_messages \
         (id, participant_one_subject, participant_two_subject, created_by_subject) \
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id",
    )
    .bind(&proposed_id)
    .bind(&participants[0])
    .bind(&participants[1])
    .bind(&subject)
    .fetch_optional(&state.pool)
    .await?;
    let direct_message_id = if let Some(id) = inserted {
        let _ = state
            .direct_message_changes
            .send(DirectMessageEvent::DirectMessageChanged {
                direct_message_id: id.clone(),
            });
        id
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT id FROM direct_messages \
             WHERE participant_one_subject = $1 AND participant_two_subject = $2",
        )
        .bind(&participants[0])
        .bind(&participants[1])
        .fetch_one(&state.pool)
        .await?
    };
    Ok(Json(summary(&state, &subject, &direct_message_id).await?))
}

async fn load_message(
    state: &AppState,
    subject: &str,
    direct_message_id: &str,
    message_id: &str,
) -> Result<DirectMessageMessage, ApiError> {
    let sql = format!("{MESSAGE_SELECT} WHERE message.id = $1 AND message.direct_message_id = $3");
    sqlx::query_as::<_, DirectMessageRow>(&sql)
        .bind(message_id)
        .bind(subject)
        .bind(direct_message_id)
        .fetch_optional(&state.pool)
        .await?
        .map(message_from_row)
        .ok_or(ApiError::NotFound)
}

async fn list_messages(
    State(state): State<Arc<AppState>>,
    Path(direct_message_id): Path<String>,
    Query(query): Query<MessagePageQuery>,
    headers: HeaderMap,
) -> Result<Json<DirectMessagePage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_access(&state, &subject, &direct_message_id).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let sql = format!(
        "{MESSAGE_SELECT} WHERE message.direct_message_id = $1 \
         AND ($3::BIGINT IS NULL OR message.sequence < $3) \
         ORDER BY message.sequence DESC LIMIT $4"
    );
    let mut rows = sqlx::query_as::<_, DirectMessageRow>(&sql)
        .bind(&direct_message_id)
        .bind(&subject)
        .bind(query.before)
        .bind(limit + 1)
        .fetch_all(&state.pool)
        .await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_before = has_more.then(|| rows.last().map(|row| row.1)).flatten();
    rows.reverse();
    Ok(Json(DirectMessagePage {
        messages: rows.into_iter().map(message_from_row).collect(),
        next_before,
    }))
}

async fn create_message(
    State(state): State<Arc<AppState>>,
    Path(direct_message_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<CreateDirectMessageMessage>,
) -> Result<(StatusCode, Json<DirectMessageMessage>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_access(&state, &subject, &direct_message_id).await?;
    let content = input.content.trim();
    if content.is_empty() || content.chars().count() > 4000 {
        return Err(ApiError::InvalidRequest);
    }
    if let Some(reply_id) = input.reply_to_message_id.as_deref() {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM direct_message_messages \
             WHERE id = $1 AND direct_message_id = $2)",
        )
        .bind(reply_id)
        .bind(&direct_message_id)
        .fetch_one(&state.pool)
        .await?;
        if !exists {
            return Err(ApiError::InvalidRequest);
        }
    }
    let id = CsrfToken::new_random().secret().to_owned();
    sqlx::query(
        "INSERT INTO direct_message_messages \
         (id, direct_message_id, author_subject, content, reply_to_message_id) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(&direct_message_id)
    .bind(&subject)
    .bind(content)
    .bind(input.reply_to_message_id)
    .execute(&state.pool)
    .await?;
    let message = load_message(&state, &subject, &direct_message_id, &id).await?;
    let _ = state
        .direct_message_changes
        .send(DirectMessageEvent::MessageCreated {
            direct_message_id,
            message: Box::new(message.clone()),
        });
    Ok((StatusCode::CREATED, Json(message)))
}

async fn get_message(
    State(state): State<Arc<AppState>>,
    Path((direct_message_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<DirectMessageMessage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_access(&state, &subject, &direct_message_id).await?;
    Ok(Json(
        load_message(&state, &subject, &direct_message_id, &message_id).await?,
    ))
}

fn publish_changed(state: &AppState, direct_message_id: String, message_id: String) {
    let _ = state
        .direct_message_changes
        .send(DirectMessageEvent::MessageChanged {
            direct_message_id,
            message_id,
        });
}

async fn edit_message(
    State(state): State<Arc<AppState>>,
    Path((direct_message_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<EditMessage>,
) -> Result<Json<DirectMessageMessage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_access(&state, &subject, &direct_message_id).await?;
    let content = input.content.trim();
    if content.is_empty() || content.chars().count() > 4000 {
        return Err(ApiError::InvalidRequest);
    }
    let mut transaction = state.pool.begin().await?;
    let author = sqlx::query_scalar::<_, String>(
        "SELECT author_subject FROM direct_message_messages \
         WHERE id = $1 AND direct_message_id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(&message_id)
    .bind(&direct_message_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    if author != subject {
        return Err(ApiError::Forbidden);
    }
    let changed = sqlx::query(
        "UPDATE direct_message_messages SET content = $3, edited_at = NOW() \
         WHERE id = $1 AND direct_message_id = $2 AND content IS DISTINCT FROM $3",
    )
    .bind(&message_id)
    .bind(&direct_message_id)
    .bind(content)
    .execute(&mut *transaction)
    .await?
    .rows_affected()
        == 1;
    if changed {
        sqlx::query(
            "INSERT INTO direct_message_audit_log \
             (direct_message_id, actor_subject, action, detail) \
             VALUES ($1, $2, 'message.edited', \
             jsonb_build_object('messageId', $3::TEXT))",
        )
        .bind(&direct_message_id)
        .bind(&subject)
        .bind(&message_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    if changed {
        publish_changed(&state, direct_message_id.clone(), message_id.clone());
    }
    Ok(Json(
        load_message(&state, &subject, &direct_message_id, &message_id).await?,
    ))
}

async fn delete_message(
    State(state): State<Arc<AppState>>,
    Path((direct_message_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<DirectMessageMessage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_access(&state, &subject, &direct_message_id).await?;
    let mut transaction = state.pool.begin().await?;
    let message = sqlx::query_as::<_, (String, bool)>(
        "SELECT author_subject, deleted_at IS NOT NULL FROM direct_message_messages \
         WHERE id = $1 AND direct_message_id = $2 FOR UPDATE",
    )
    .bind(&message_id)
    .bind(&direct_message_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    if message.0 != subject {
        return Err(ApiError::Forbidden);
    }
    let changed = if message.1 {
        false
    } else {
        sqlx::query(
            "UPDATE direct_message_messages SET content = NULL, deleted_at = NOW() \
             WHERE id = $1 AND direct_message_id = $2 AND deleted_at IS NULL",
        )
        .bind(&message_id)
        .bind(&direct_message_id)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1
    };
    if changed {
        sqlx::query("DELETE FROM direct_message_reactions WHERE message_id = $1")
            .bind(&message_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO direct_message_audit_log \
             (direct_message_id, actor_subject, action, detail) \
             VALUES ($1, $2, 'message.deleted', \
             jsonb_build_object('messageId', $3::TEXT))",
        )
        .bind(&direct_message_id)
        .bind(&subject)
        .bind(&message_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    if changed {
        publish_changed(&state, direct_message_id.clone(), message_id.clone());
    }
    Ok(Json(
        load_message(&state, &subject, &direct_message_id, &message_id).await?,
    ))
}

async fn change_reaction(
    state: &AppState,
    direct_message_id: String,
    message_id: String,
    headers: &HeaderMap,
    input: ReactionInput,
    add: bool,
) -> Result<Json<DirectMessageMessage>, ApiError> {
    require_origin(&state.auth, headers)?;
    let subject = require_session(&state.pool, headers).await?;
    require_access(state, &subject, &direct_message_id).await?;
    let emoji = input.emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > 32 {
        return Err(ApiError::InvalidRequest);
    }
    let mut transaction = state.pool.begin().await?;
    let visible = sqlx::query_scalar::<_, String>(
        "SELECT id FROM direct_message_messages \
         WHERE id = $1 AND direct_message_id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(&message_id)
    .bind(&direct_message_id)
    .fetch_optional(&mut *transaction)
    .await?;
    if visible.is_none() {
        return Err(ApiError::NotFound);
    }
    let changed = if add {
        sqlx::query(
            "INSERT INTO direct_message_reactions (message_id, oidc_subject, emoji) \
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(&message_id)
        .bind(&subject)
        .bind(emoji)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1
    } else {
        sqlx::query(
            "DELETE FROM direct_message_reactions \
             WHERE message_id = $1 AND oidc_subject = $2 AND emoji = $3",
        )
        .bind(&message_id)
        .bind(&subject)
        .bind(emoji)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1
    };
    if changed {
        sqlx::query(
            "INSERT INTO direct_message_audit_log \
             (direct_message_id, actor_subject, action, detail) \
             VALUES ($1, $2, $3, jsonb_build_object( \
             'messageId', $4::TEXT, 'emoji', $5::TEXT))",
        )
        .bind(&direct_message_id)
        .bind(&subject)
        .bind(if add {
            "reaction.added"
        } else {
            "reaction.removed"
        })
        .bind(&message_id)
        .bind(emoji)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    if changed {
        publish_changed(state, direct_message_id.clone(), message_id.clone());
    }
    Ok(Json(
        load_message(state, &subject, &direct_message_id, &message_id).await?,
    ))
}

async fn add_reaction(
    State(state): State<Arc<AppState>>,
    Path((direct_message_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<ReactionInput>,
) -> Result<Json<DirectMessageMessage>, ApiError> {
    change_reaction(&state, direct_message_id, message_id, &headers, input, true).await
}

async fn remove_reaction(
    State(state): State<Arc<AppState>>,
    Path((direct_message_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<ReactionInput>,
) -> Result<Json<DirectMessageMessage>, ApiError> {
    change_reaction(
        &state,
        direct_message_id,
        message_id,
        &headers,
        input,
        false,
    )
    .await
}

async fn search_messages(
    State(state): State<Arc<AppState>>,
    Path(direct_message_id): Path<String>,
    Query(query): Query<SearchQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<DirectMessageMessage>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_access(&state, &subject, &direct_message_id).await?;
    let term = query.q.trim();
    if term.is_empty() || term.chars().count() > 200 {
        return Err(ApiError::InvalidRequest);
    }
    let sql = format!(
        "{MESSAGE_SELECT} WHERE message.direct_message_id = $1 \
         AND message.deleted_at IS NULL AND message.content ILIKE $3 \
         ORDER BY message.sequence DESC LIMIT 100"
    );
    let rows = sqlx::query_as::<_, DirectMessageRow>(&sql)
        .bind(&direct_message_id)
        .bind(&subject)
        .bind(format!("%{term}%"))
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(rows.into_iter().map(message_from_row).collect()))
}

async fn events(
    websocket: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let mut changes = state.direct_message_changes.subscribe();
    Ok(websocket.on_upgrade(move |socket| async move {
        let (mut sender, mut receiver) = socket.split();
        loop {
            let event = tokio::select! {
                event = changes.recv() => event,
                message = receiver.next() => match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                }
            };
            match event {
                Ok(event) => match can_access(&state, &subject, event.direct_message_id()).await {
                    Ok(true) => {
                        let Ok(payload) = serde_json::to_string(&event) else {
                            tracing::error!("failed to serialize Direct Message event");
                            continue;
                        };
                        if sender.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(false) => continue,
                    Err(error) => {
                        tracing::warn!(?error, "failed to authorize Direct Message event");
                        break;
                    }
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "Direct Message client lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }))
}
