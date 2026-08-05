use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
};
use serde::{Deserialize, Serialize};

use super::{ApiError, AppState, can_access_channel, require_origin, require_session};

#[derive(Debug, Deserialize)]
struct PeopleQuery {
    q: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonSummary {
    user_id: String,
    handle: String,
    display_name: String,
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/users/search", get(search_people))
        .route(
            "/api/servers/{server_id}/channels/{channel_id}/mention-suggestions",
            get(search_mention_candidates),
        )
}

fn normalize_query(value: &str) -> Result<&str, ApiError> {
    let query = value.trim().trim_start_matches('@');
    if query.is_empty() || query.len() > 64 {
        return Err(ApiError::InvalidRequest);
    }
    Ok(query)
}

async fn search_people(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PeopleQuery>,
) -> Result<Json<Vec<PersonSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let search = normalize_query(&query.q)?;
    let people = sqlx::query_as::<_, (String, String, String)>(
        "WITH accessible_servers AS ( \
             SELECT servers.id FROM servers \
             LEFT JOIN server_members viewer ON viewer.server_id = servers.id \
                 AND viewer.oidc_subject = $1 \
             WHERE servers.owner_subject = $1 OR viewer.oidc_subject IS NOT NULL \
         ), eligible_users AS ( \
             SELECT servers.owner_subject AS oidc_subject FROM servers \
             JOIN accessible_servers ON accessible_servers.id = servers.id \
             UNION SELECT server_members.oidc_subject FROM server_members \
             JOIN accessible_servers ON accessible_servers.id = server_members.server_id \
             UNION SELECT CASE WHEN participant_one_subject = $1 \
                 THEN participant_two_subject ELSE participant_one_subject END \
                 FROM direct_messages \
                 WHERE $1 IN (participant_one_subject, participant_two_subject) \
             UNION SELECT oidc_subject FROM users WHERE LOWER(handle) = LOWER($2) \
         ) \
         SELECT users.oidc_subject, users.handle, users.display_name FROM users \
         JOIN eligible_users ON eligible_users.oidc_subject = users.oidc_subject \
         WHERE users.oidc_subject <> $1 AND ( \
             POSITION(LOWER($2) IN LOWER(display_name)) > 0 OR \
             POSITION(LOWER($2) IN LOWER(handle)) > 0) \
         ORDER BY CASE WHEN LOWER(handle) = LOWER($2) THEN 0 ELSE 1 END, \
             LOWER(display_name), handle LIMIT 10",
    )
    .bind(subject)
    .bind(search)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(user_id, handle, display_name)| PersonSummary {
        user_id,
        handle,
        display_name,
    })
    .collect();
    Ok(Json(people))
}

async fn search_mention_candidates(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<PeopleQuery>,
) -> Result<Json<Vec<PersonSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    if !can_access_channel(&state.pool, &subject, &server_id, &channel_id).await? {
        return Err(ApiError::NotFound);
    }
    let search = normalize_query(&query.q)?;
    let people = sqlx::query_as::<_, (String, String, String)>(
        "WITH server_users AS ( \
             SELECT owner_subject AS oidc_subject FROM servers WHERE id = $1 \
             UNION SELECT oidc_subject FROM server_members WHERE server_id = $1 \
         ) \
         SELECT users.oidc_subject, users.handle, users.display_name FROM users \
         JOIN server_users ON server_users.oidc_subject = users.oidc_subject \
         WHERE user_can_access_channel($3, $1, users.oidc_subject) AND ( \
             POSITION(LOWER($2) IN LOWER(display_name)) > 0 OR \
             POSITION(LOWER($2) IN LOWER(handle)) > 0) \
         ORDER BY CASE WHEN LOWER(handle) = LOWER($2) THEN 0 ELSE 1 END, \
             LOWER(display_name), handle LIMIT 10",
    )
    .bind(server_id)
    .bind(search)
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(user_id, handle, display_name)| PersonSummary {
        user_id,
        handle,
        display_name,
    })
    .collect();
    Ok(Json(people))
}
