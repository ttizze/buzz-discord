use std::{collections::HashMap, env, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, State, WebSocketUpgrade, ws::Message},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointMaybeSet, EndpointNotSet,
    EndpointSet, IssuerUrl, Nonce, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Executor, PgPool, Postgres, Transaction, postgres::PgPoolOptions};
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{RwLock, broadcast},
};
use tower_http::{
    cors::{AllowHeaders, AllowMethods, CorsLayer},
    trace::TraceLayer,
};
use url::Url;

mod direct_messages;
mod hosts;
mod people;
mod projects;

const SESSION_COOKIE: &str = "buzzcode_session";

pub(crate) fn normalize_handle(value: &str) -> Option<String> {
    let handle = value.trim().strip_prefix('@').unwrap_or(value.trim());
    let handle = handle.to_ascii_lowercase();
    let valid_length = (2..=32).contains(&handle.len());
    let valid_characters = handle.bytes().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || b"._".contains(&character)
    });
    (valid_length && valid_characters && !handle.contains("..")).then_some(handle)
}

/// OIDC and browser settings required by the Buzzcode server.
#[derive(Clone)]
pub struct AuthConfig {
    issuer: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    app_url: String,
    app_origin: String,
    secure_cookie: bool,
}

impl AuthConfig {
    /// Loads authentication configuration from the process environment.
    pub fn from_environment() -> Result<Self, ServerError> {
        let required = |name: &'static str| {
            env::var(name).map_err(|_| ServerError::Configuration(format!("{name} is required")))
        };
        let issuer = required("BUZZCODE_OIDC_ISSUER")?;
        let client_id = required("BUZZCODE_OIDC_CLIENT_ID")?;
        let client_secret = required("BUZZCODE_OIDC_CLIENT_SECRET")?;
        let redirect_uri = required("BUZZCODE_OIDC_REDIRECT_URI")?;
        let app_url = required("BUZZCODE_APP_URL")?;
        let app_origin = required("BUZZCODE_APP_ORIGIN")?;
        Url::parse(&issuer).map_err(|error| ServerError::Configuration(error.to_string()))?;
        Url::parse(&redirect_uri).map_err(|error| ServerError::Configuration(error.to_string()))?;
        Url::parse(&app_url).map_err(|error| ServerError::Configuration(error.to_string()))?;
        HeaderValue::from_str(&app_origin)
            .map_err(|error| ServerError::Configuration(error.to_string()))?;
        let secure_cookie =
            env::var("BUZZCODE_SESSION_COOKIE_SECURE").map_or(true, |value| value != "false");
        Ok(Self {
            issuer,
            client_id,
            client_secret,
            redirect_uri,
            app_url,
            app_origin,
            secure_cookie,
        })
    }
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) pool: PgPool,
    changes: broadcast::Sender<ServerEvent>,
    pub(crate) direct_message_changes: broadcast::Sender<direct_messages::DirectMessageEvent>,
    host_presence: Arc<RwLock<HashMap<String, hosts::HostPresence>>>,
    host_revocations: broadcast::Sender<String>,
    host_reconnect_grace: Duration,
    oidc: CoreClient<
        EndpointSet,
        EndpointNotSet,
        EndpointNotSet,
        EndpointNotSet,
        EndpointMaybeSet,
        EndpointMaybeSet,
    >,
    http: reqwest::Client,
    pub(crate) auth: AuthConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableState {
    value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ServerEvent {
    DurableStateChanged {
        #[serde(skip)]
        server_id: String,
        state: DurableState,
    },
    MembershipChanged {
        #[serde(skip)]
        server_id: String,
    },
    ServerDeleted {
        #[serde(skip)]
        server_id: String,
    },
    ChannelCreated {
        #[serde(skip)]
        server_id: String,
        channel: ChannelSummary,
    },
    ChannelAccessChanged {
        #[serde(skip)]
        server_id: String,
    },
    MessageCreated {
        #[serde(skip)]
        server_id: String,
        message: Box<ChannelMessage>,
    },
    MessageChanged {
        #[serde(skip)]
        server_id: String,
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
    },
    RemoteEnvironmentsChanged {
        #[serde(skip)]
        server_id: String,
    },
    ProjectsChanged {
        #[serde(skip)]
        server_id: String,
    },
}

impl ServerEvent {
    fn server_id(&self) -> &str {
        match self {
            Self::DurableStateChanged { server_id, .. }
            | Self::MembershipChanged { server_id }
            | Self::ServerDeleted { server_id }
            | Self::ChannelCreated { server_id, .. }
            | Self::ChannelAccessChanged { server_id }
            | Self::MessageCreated { server_id, .. }
            | Self::MessageChanged { server_id, .. }
            | Self::RemoteEnvironmentsChanged { server_id }
            | Self::ProjectsChanged { server_id } => server_id,
        }
    }

    fn channel_id(&self) -> Option<&str> {
        match self {
            Self::ChannelCreated { channel, .. } => Some(&channel.id),
            Self::MessageCreated { message, .. } => Some(&message.channel_id),
            Self::MessageChanged { channel_id, .. } => Some(channel_id),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
struct Health {
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionUser {
    subject: String,
    email: String,
    handle: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSession {
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<SessionUser>,
}

#[derive(Debug, Deserialize)]
struct AuthCallback {
    code: String,
    state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLoginStart {
    login_url: String,
    completion_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteDesktopLogin {
    completion_token: String,
}

#[derive(Debug, Deserialize)]
struct CreateServer {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CreateInvitation {
    email: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Invitation {
    token: String,
    email: String,
}

#[derive(Debug, Deserialize)]
struct AcceptInvitation {
    token: String,
}

#[derive(Debug, Deserialize)]
struct UpdateMemberRole {
    role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferOwnership {
    new_owner_subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberSummary {
    subject: String,
    email: String,
    handle: String,
    display_name: String,
    role: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEntry {
    id: i64,
    actor_subject: String,
    action: String,
    target_subject: Option<String>,
    detail: serde_json::Value,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerSummary {
    id: String,
    name: String,
    role: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelSummary {
    id: String,
    name: String,
    visibility: String,
    member_subjects: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateChannel {
    name: String,
    visibility: Option<String>,
    #[serde(default)]
    member_subjects: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateChannel {
    visibility: Option<String>,
    member_subjects: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct SearchMessages {
    q: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMessage {
    content: String,
    reply_to_message_id: Option<String>,
    #[serde(default)]
    mentions: Vec<MentionInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditMessage {
    pub(crate) content: String,
    #[serde(default)]
    mentions: Option<Vec<MentionInput>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReactionInput {
    pub(crate) emoji: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagePageQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplyTarget {
    pub(crate) id: String,
    pub(crate) content: Option<String>,
    pub(crate) author_display_name: String,
    pub(crate) deleted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReactionSummary {
    emoji: String,
    count: i64,
    reacted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelMessage {
    id: String,
    sequence: i64,
    channel_id: String,
    content: Option<String>,
    author_subject: String,
    author_display_name: String,
    created_at: String,
    edited_at: Option<String>,
    deleted_at: Option<String>,
    reply_to: Option<ReplyTarget>,
    reactions: Vec<ReactionSummary>,
    mentions: Vec<MentionSummary>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MentionSummary {
    user_id: String,
    handle: String,
    display_name: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MentionInput {
    user_id: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMention {
    user_id: String,
    handle: String,
    display_name: String,
    start: usize,
    end: usize,
}

fn prepare_mentioned_content(
    content: &str,
    mut mentions: Vec<MentionInput>,
) -> Result<(String, Vec<MentionInput>), ApiError> {
    if content.trim().is_empty() || content.chars().count() > 4000 || mentions.len() > 20 {
        return Err(ApiError::InvalidRequest);
    }
    mentions.sort_by_key(|mention| mention.start);
    let content_length = content.chars().count();
    let mut previous_end = 0;
    for mention in &mentions {
        if mention.start < previous_end
            || mention.start >= mention.end
            || mention.end > content_length
        {
            return Err(ApiError::InvalidRequest);
        }
        previous_end = mention.end;
    }
    Ok((content.to_owned(), mentions))
}

async fn require_mentions_accessible(
    transaction: &mut Transaction<'_, Postgres>,
    server_id: &str,
    channel_id: &str,
    mentions: &[MentionInput],
) -> Result<HashMap<String, String>, ApiError> {
    if mentions.is_empty() {
        return Ok(HashMap::new());
    }
    let mentioned_subjects = mentions
        .iter()
        .map(|mention| mention.user_id.as_str())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let accessible = sqlx::query_as::<_, (String, String)>(
        "SELECT users.oidc_subject, users.display_name FROM users \
         WHERE users.oidc_subject = ANY($1) \
         AND user_can_access_channel($2, $3, users.oidc_subject) \
         AND EXISTS (SELECT 1 FROM servers \
             LEFT JOIN server_members ON server_members.server_id = servers.id \
                 AND server_members.oidc_subject = users.oidc_subject \
             WHERE servers.id = $3 AND (servers.owner_subject = users.oidc_subject \
                 OR server_members.oidc_subject IS NOT NULL))",
    )
    .bind(&mentioned_subjects)
    .bind(channel_id)
    .bind(server_id)
    .fetch_all(&mut **transaction)
    .await?;
    if accessible.len() != mentioned_subjects.len() {
        return Err(ApiError::InvalidRequest);
    }
    Ok(accessible.into_iter().collect())
}

fn canonicalize_mentioned_content(
    content: &str,
    mentions: &[MentionInput],
    display_names: &HashMap<String, String>,
) -> Result<(String, Vec<MentionInput>), ApiError> {
    let characters = content.chars().collect::<Vec<_>>();
    let mut canonical = String::new();
    let mut canonical_mentions = Vec::with_capacity(mentions.len());
    let mut cursor = 0;
    for mention in mentions {
        canonical.extend(characters[cursor..mention.start].iter());
        let start = canonical.chars().count();
        let display_name = display_names
            .get(&mention.user_id)
            .ok_or(ApiError::InvalidRequest)?;
        canonical.push('@');
        canonical.push_str(display_name);
        let end = canonical.chars().count();
        canonical_mentions.push(MentionInput {
            user_id: mention.user_id.clone(),
            start,
            end,
        });
        cursor = mention.end;
    }
    canonical.extend(characters[cursor..].iter());
    if canonical.chars().count() > 4000 {
        return Err(ApiError::InvalidRequest);
    }
    Ok((canonical, canonical_mentions))
}

async fn replace_message_mentions(
    transaction: &mut Transaction<'_, Postgres>,
    message_id: &str,
    mentions: &[MentionInput],
) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM channel_message_mentions WHERE message_id = $1")
        .bind(message_id)
        .execute(&mut **transaction)
        .await?;
    for (ordinal, mention) in mentions.iter().enumerate() {
        sqlx::query(
            "INSERT INTO channel_message_mentions \
             (message_id, mentioned_subject, ordinal, start_index, end_index) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(message_id)
        .bind(&mention.user_id)
        .bind(ordinal as i32)
        .bind(mention.start as i32)
        .bind(mention.end as i32)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessagePage {
    messages: Vec<ChannelMessage>,
    next_before: Option<i64>,
}

#[derive(Debug, Error)]
pub(crate) enum ApiError {
    #[error("authentication is required")]
    Unauthorized,
    #[error("the authentication response is invalid or has expired")]
    InvalidAuthentication,
    #[error("identity provider request failed")]
    IdentityProvider,
    #[error("the request is invalid")]
    InvalidRequest,
    #[error("the operation is forbidden")]
    Forbidden,
    #[error("the requested resource was not found")]
    NotFound,
    #[error("the request conflicts with current state")]
    Conflict,
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
}

/// Failures that can occur while starting or serving the Buzzcode API.
#[derive(Debug, Error)]
pub enum ServerError {
    /// Required configuration is missing or malformed.
    #[error("configuration error: {0}")]
    Configuration(String),
    /// PostgreSQL could not be reached or queried.
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
    /// An embedded database migration could not be applied.
    #[error("database migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),
    /// OIDC discovery or client construction failed.
    #[error("identity provider configuration failed: {0}")]
    IdentityProvider(String),
    /// The HTTP listener or server failed.
    #[error("server I/O failed")]
    Io(#[from] std::io::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Unauthorized | Self::IdentityProvider => StatusCode::UNAUTHORIZED,
            Self::InvalidAuthentication | Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if status.is_server_error() {
            tracing::error!(error = ?self, "request failed");
        } else {
            tracing::warn!(error = ?self, "authentication request rejected");
        }
        (
            status,
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
pub async fn serve(
    listener: TcpListener,
    pool: PgPool,
    auth: AuthConfig,
) -> Result<(), ServerError> {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ServerError::IdentityProvider(error.to_string()))?;
    let provider = CoreProviderMetadata::discover_async(
        IssuerUrl::new(auth.issuer.clone())
            .map_err(|error| ServerError::IdentityProvider(error.to_string()))?,
        &http,
    )
    .await
    .map_err(|error| ServerError::IdentityProvider(error.to_string()))?;
    let oidc = CoreClient::from_provider_metadata(
        provider,
        ClientId::new(auth.client_id.clone()),
        Some(ClientSecret::new(auth.client_secret.clone())),
    )
    .set_redirect_uri(
        RedirectUrl::new(auth.redirect_uri.clone())
            .map_err(|error| ServerError::IdentityProvider(error.to_string()))?,
    );
    let app_origin = HeaderValue::from_str(&auth.app_origin)
        .map_err(|error| ServerError::Configuration(error.to_string()))?;
    let (changes, _) = broadcast::channel(64);
    let (direct_message_changes, _) = broadcast::channel(64);
    let (host_revocations, _) = broadcast::channel(64);
    let host_reconnect_grace = env::var("BUZZCODE_HOST_RECONNECT_GRACE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map_or(Duration::from_secs(15), Duration::from_millis);
    let state = Arc::new(AppState {
        pool,
        changes,
        direct_message_changes,
        host_presence: Arc::new(RwLock::new(HashMap::new())),
        host_revocations,
        host_reconnect_grace,
        oidc,
        http,
        auth,
    });
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/api/auth/login", get(login))
        .route("/api/auth/desktop/start", post(start_desktop_login))
        .route("/api/auth/desktop/complete", post(complete_desktop_login))
        .route("/api/auth/callback", get(auth_callback))
        .route("/api/auth/session", get(read_session))
        .route("/api/auth/logout", post(logout))
        .route("/api/servers", get(list_servers).post(create_server))
        .route("/api/invitations/accept", post(accept_invitation))
        .route(
            "/api/servers/{server_id}",
            axum::routing::delete(delete_server),
        )
        .route(
            "/api/servers/{server_id}/invitations",
            post(create_invitation),
        )
        .route("/api/servers/{server_id}/members", get(list_members))
        .route(
            "/api/servers/{server_id}/members/{member_subject}",
            axum::routing::patch(update_member_role),
        )
        .route(
            "/api/servers/{server_id}/owner",
            axum::routing::put(transfer_ownership),
        )
        .route("/api/servers/{server_id}/audit", get(list_audit))
        .route(
            "/api/servers/{server_id}/channels",
            get(list_channels).post(create_channel),
        )
        .route(
            "/api/servers/{server_id}/channels/{channel_id}",
            axum::routing::patch(update_channel),
        )
        .route(
            "/api/servers/{server_id}/messages/search",
            get(search_messages),
        )
        .route(
            "/api/servers/{server_id}/channels/{channel_id}/messages",
            get(list_messages).post(create_message),
        )
        .route(
            "/api/servers/{server_id}/channels/{channel_id}/messages/{message_id}",
            get(get_message).patch(edit_message).delete(delete_message),
        )
        .route(
            "/api/servers/{server_id}/channels/{channel_id}/messages/{message_id}/reactions",
            post(add_reaction).delete(remove_reaction),
        )
        .route(
            "/api/servers/{server_id}/bootstrap",
            get(read_state).put(write_state),
        )
        .route("/api/servers/{server_id}/events", get(events))
        .merge(direct_messages::routes())
        .merge(hosts::routes())
        .merge(people::routes())
        .merge(projects::routes())
        .layer(
            CorsLayer::new()
                .allow_origin(app_origin)
                .allow_credentials(true)
                .allow_methods(AllowMethods::mirror_request())
                .allow_headers(AllowHeaders::mirror_request()),
        )
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

async fn create_oidc_authorization(
    state: &AppState,
    desktop_token_hash: Option<&str>,
) -> Result<String, ApiError> {
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, csrf, nonce) = state
        .oidc
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("profile".to_owned()))
        .add_scope(Scope::new("email".to_owned()))
        .set_pkce_challenge(pkce_challenge)
        .url();
    let mut transaction = state.pool.begin().await?;
    sqlx::query("DELETE FROM oidc_login_attempts WHERE expires_at <= NOW()")
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM desktop_login_attempts WHERE expires_at <= NOW()")
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "INSERT INTO oidc_login_attempts (state, nonce, pkce_verifier) VALUES ($1, $2, $3)",
    )
    .bind(csrf.secret())
    .bind(nonce.secret())
    .bind(pkce_verifier.secret())
    .execute(&mut *transaction)
    .await?;
    if let Some(token_hash) = desktop_token_hash {
        sqlx::query("INSERT INTO desktop_login_attempts (token_hash, oidc_state) VALUES ($1, $2)")
            .bind(token_hash)
            .bind(csrf.secret())
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(url.to_string())
}

async fn login(State(state): State<Arc<AppState>>) -> Result<Redirect, ApiError> {
    let url = create_oidc_authorization(&state, None).await?;
    Ok(Redirect::to(&url))
}

async fn start_desktop_login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<DesktopLoginStart>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let completion_token = CsrfToken::new_random().secret().to_owned();
    let login_url = create_oidc_authorization(&state, Some(&token_hash(&completion_token))).await?;
    Ok(Json(DesktopLoginStart {
        login_url,
        completion_token,
    }))
}

async fn auth_callback(
    State(state): State<Arc<AppState>>,
    Query(callback): Query<AuthCallback>,
) -> Result<Response, ApiError> {
    let attempt = sqlx::query_as::<_, (String, String)>(
        "DELETE FROM oidc_login_attempts WHERE state = $1 AND expires_at > NOW() \
         RETURNING nonce, pkce_verifier",
    )
    .bind(&callback.state)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::InvalidAuthentication)?;
    let response = state
        .oidc
        .exchange_code(AuthorizationCode::new(callback.code))
        .map_err(|_| ApiError::IdentityProvider)?
        .set_pkce_verifier(PkceCodeVerifier::new(attempt.1))
        .request_async(&state.http)
        .await
        .map_err(|error| {
            tracing::warn!(?error, "OIDC code exchange failed");
            ApiError::IdentityProvider
        })?;
    let id_token = response.id_token().ok_or(ApiError::InvalidAuthentication)?;
    let claims = id_token
        .claims(&state.oidc.id_token_verifier(), &Nonce::new(attempt.0))
        .map_err(|error| {
            tracing::warn!(?error, "OIDC ID token validation failed");
            ApiError::InvalidAuthentication
        })?;
    if claims.email_verified() != Some(true) {
        return Err(ApiError::InvalidAuthentication);
    }
    let email = claims
        .email()
        .map(|value| value.as_str().to_owned())
        .ok_or(ApiError::InvalidAuthentication)?;
    let claimed_display_name = claims.name().and_then(|names| {
        names
            .get(None)
            .or_else(|| names.iter().next().map(|(_, name)| name))
            .map(|name| name.as_str().trim().to_owned())
            .filter(|name| !name.is_empty())
    });
    let subject = claims.subject().to_string();
    let mut transaction = state.pool.begin().await?;
    let existing_user = sqlx::query_as::<_, (String, String)>(
        "SELECT handle, display_name FROM users WHERE oidc_subject = $1 FOR UPDATE",
    )
    .bind(&subject)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some((_, current_display_name)) = existing_user {
        let display_name = claimed_display_name.unwrap_or(current_display_name);
        sqlx::query(
            "UPDATE users SET email = $2, display_name = $3, updated_at = NOW() \
             WHERE oidc_subject = $1",
        )
        .bind(&subject)
        .bind(&email)
        .bind(&display_name)
        .execute(&mut *transaction)
        .await?;
    } else {
        let preferred_username = claims
            .preferred_username()
            .map(|value| value.as_str().to_owned())
            .ok_or(ApiError::InvalidAuthentication)?;
        let handle =
            normalize_handle(&preferred_username).ok_or(ApiError::InvalidAuthentication)?;
        let display_name = claimed_display_name.unwrap_or(preferred_username);
        let claimed =
            sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE handle = $1)")
                .bind(&handle)
                .fetch_one(&mut *transaction)
                .await?;
        if claimed {
            return Err(ApiError::Conflict);
        }
        sqlx::query(
            "INSERT INTO users (oidc_subject, email, handle, display_name) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(&subject)
        .bind(&email)
        .bind(&handle)
        .bind(&display_name)
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
    }
    transaction.commit().await?;
    let desktop_attempt = sqlx::query(
        "UPDATE desktop_login_attempts SET oidc_subject = $2 \
         WHERE oidc_state = $1 AND expires_at > NOW() AND oidc_subject IS NULL",
    )
    .bind(&callback.state)
    .bind(&subject)
    .execute(&state.pool)
    .await?;
    if desktop_attempt.rows_affected() == 1 {
        return Ok(Html(
            "<!doctype html><html><body><h1>Buzzcode sign-in complete</h1><p>You can return to Buzzcode.</p></body></html>",
        )
        .into_response());
    }
    let token = CsrfToken::new_random().secret().to_owned();
    sqlx::query("INSERT INTO sessions (token_hash, oidc_subject) VALUES ($1, $2)")
        .bind(token_hash(&token))
        .bind(subject)
        .execute(&state.pool)
        .await?;
    let mut response = Redirect::to(&state.auth.app_url).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&token, state.auth.secure_cookie))
            .map_err(|_| ApiError::InvalidAuthentication)?,
    );
    Ok(response)
}

async fn complete_desktop_login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CompleteDesktopLogin>,
) -> Result<Response, ApiError> {
    require_origin(&state.auth, &headers)?;
    let completion_hash = token_hash(input.completion_token.trim());
    let subject = sqlx::query_scalar::<_, String>(
        "DELETE FROM desktop_login_attempts \
         WHERE token_hash = $1 AND expires_at > NOW() AND oidc_subject IS NOT NULL \
         RETURNING oidc_subject",
    )
    .bind(&completion_hash)
    .fetch_optional(&state.pool)
    .await?;
    let Some(subject) = subject else {
        let pending = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM desktop_login_attempts \
             WHERE token_hash = $1 AND expires_at > NOW())",
        )
        .bind(completion_hash)
        .fetch_one(&state.pool)
        .await?;
        return if pending {
            Ok(StatusCode::ACCEPTED.into_response())
        } else {
            Err(ApiError::NotFound)
        };
    };
    let token = CsrfToken::new_random().secret().to_owned();
    sqlx::query("INSERT INTO sessions (token_hash, oidc_subject) VALUES ($1, $2)")
        .bind(token_hash(&token))
        .bind(subject)
        .execute(&state.pool)
        .await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&token, state.auth.secure_cookie))
            .map_err(|_| ApiError::InvalidAuthentication)?,
    );
    Ok(response)
}

async fn read_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<AuthSession>, ApiError> {
    let Some(token) = cookie_value(&headers, SESSION_COOKIE) else {
        return Ok(Json(AuthSession {
            authenticated: false,
            user: None,
        }));
    };
    let user = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT users.oidc_subject, users.email, users.handle, users.display_name FROM sessions \
         JOIN users ON users.oidc_subject = sessions.oidc_subject \
         WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()",
    )
    .bind(token_hash(&token))
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(AuthSession {
        authenticated: user.is_some(),
        user: user.map(|(subject, email, handle, display_name)| SessionUser {
            subject,
            email,
            handle,
            display_name,
        }),
    }))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_origin(&state.auth, &headers)?;
    if let Some(token) = cookie_value(&headers, SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash(&token))
            .execute(&state.pool)
            .await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_session_cookie(state.auth.secure_cookie))
            .map_err(|_| ApiError::InvalidAuthentication)?,
    );
    Ok(response)
}

fn token_hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.to_owned()))
}

fn session_cookie(token: &str, secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; {}; Max-Age=2592000",
        if secure {
            "SameSite=None; Secure"
        } else {
            "SameSite=Lax"
        }
    )
}

fn clear_session_cookie(secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}=; Path=/; HttpOnly; {}; Max-Age=0",
        if secure {
            "SameSite=None; Secure"
        } else {
            "SameSite=Lax"
        }
    )
}

pub(crate) fn require_origin(auth: &AuthConfig, headers: &HeaderMap) -> Result<(), ApiError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    if origin != auth.app_origin {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

pub(crate) async fn require_session(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<String, ApiError> {
    let token = cookie_value(headers, SESSION_COOKIE).ok_or(ApiError::Unauthorized)?;
    let subject = sqlx::query_scalar::<_, String>(
        "SELECT oidc_subject FROM sessions WHERE token_hash = $1 AND expires_at > NOW()",
    )
    .bind(token_hash(&token))
    .fetch_optional(pool)
    .await?
    .ok_or(ApiError::Unauthorized)?;
    Ok(subject)
}

async fn list_servers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<ServerSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT servers.id, servers.name, \
         CASE WHEN servers.owner_subject = $1 THEN 'owner' ELSE server_members.role END AS role \
         FROM servers LEFT JOIN server_members ON server_members.server_id = servers.id \
         AND server_members.oidc_subject = $1 \
         WHERE servers.owner_subject = $1 OR server_members.oidc_subject = $1 \
         ORDER BY servers.created_at, servers.id",
    )
    .bind(subject)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, name, role)| ServerSummary {
                id,
                name,
                role: match role.as_str() {
                    "owner" => "owner",
                    "admin" => "admin",
                    _ => "member",
                },
            })
            .collect(),
    ))
}

async fn server_role(
    pool: &PgPool,
    subject: &str,
    server_id: &str,
) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar(
        "SELECT CASE WHEN servers.owner_subject = $1 THEN 'owner' ELSE server_members.role END \
         FROM servers LEFT JOIN server_members ON server_members.server_id = servers.id \
         AND server_members.oidc_subject = $1 \
         WHERE servers.id = $2 \
         AND (servers.owner_subject = $1 OR server_members.oidc_subject = $1)",
    )
    .bind(subject)
    .bind(server_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

async fn require_manager(pool: &PgPool, subject: &str, server_id: &str) -> Result<(), ApiError> {
    match server_role(pool, subject, server_id).await?.as_deref() {
        Some("owner" | "admin") => Ok(()),
        Some(_) => Err(ApiError::Forbidden),
        None => Err(ApiError::Unauthorized),
    }
}

async fn require_owner(pool: &PgPool, subject: &str, server_id: &str) -> Result<(), ApiError> {
    match server_role(pool, subject, server_id).await?.as_deref() {
        Some("owner") => Ok(()),
        Some(_) => Err(ApiError::Forbidden),
        None => Err(ApiError::Unauthorized),
    }
}

async fn create_invitation(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<CreateInvitation>,
) -> Result<(StatusCode, Json<Invitation>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    let email = input.email.trim().to_lowercase();
    if email.len() > 320
        || !email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        })
    {
        return Err(ApiError::InvalidRequest);
    }
    let token = CsrfToken::new_random().secret().to_owned();
    let mut transaction = state.pool.begin().await?;
    sqlx::query("DELETE FROM server_invitations WHERE expires_at <= NOW()")
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "INSERT INTO server_invitations (token_hash, server_id, email, invited_by_subject) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(token_hash(&token))
    .bind(&server_id)
    .bind(&email)
    .bind(&subject)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
         VALUES ($1, $2, 'invitation.created', jsonb_build_object('email', $3::TEXT))",
    )
    .bind(&server_id)
    .bind(&subject)
    .bind(&email)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(Invitation { token, email })))
}

async fn accept_invitation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<AcceptInvitation>,
) -> Result<(StatusCode, Json<ServerSummary>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let email = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE oidc_subject = $1")
        .bind(&subject)
        .fetch_one(&state.pool)
        .await?;
    let mut transaction = state.pool.begin().await?;
    let invitation = sqlx::query_as::<_, (String, String)>(
        "SELECT server_id, email FROM server_invitations \
         WHERE token_hash = $1 AND expires_at > NOW() FOR UPDATE",
    )
    .bind(token_hash(input.token.trim()))
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    if !invitation.1.eq_ignore_ascii_case(&email) {
        return Err(ApiError::Forbidden);
    }
    let already_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM servers LEFT JOIN server_members \
         ON server_members.server_id = servers.id AND server_members.oidc_subject = $1 \
         WHERE servers.id = $2 AND (servers.owner_subject = $1 OR server_members.oidc_subject = $1))",
    )
    .bind(&subject)
    .bind(&invitation.0)
    .fetch_one(&mut *transaction)
    .await?;
    if already_member {
        return Err(ApiError::Conflict);
    }
    sqlx::query("DELETE FROM server_invitations WHERE token_hash = $1")
        .bind(token_hash(input.token.trim()))
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "INSERT INTO server_members (server_id, oidc_subject, role) VALUES ($1, $2, 'member')",
    )
    .bind(&invitation.0)
    .bind(&subject)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, target_subject) \
         VALUES ($1, $2, 'invitation.accepted', $2)",
    )
    .bind(&invitation.0)
    .bind(&subject)
    .execute(&mut *transaction)
    .await?;
    let server =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM servers WHERE id = $1")
            .bind(&invitation.0)
            .fetch_one(&mut *transaction)
            .await?;
    transaction.commit().await?;
    let _ = state.changes.send(ServerEvent::MembershipChanged {
        server_id: invitation.0,
    });
    Ok((
        StatusCode::CREATED,
        Json(ServerSummary {
            id: server.0,
            name: server.1,
            role: "member",
        }),
    ))
}

async fn list_members(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<MemberSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let members = sqlx::query_as::<_, (String, String, String, String, String)>(
        "SELECT users.oidc_subject, users.email, users.handle, users.display_name, 'owner' AS role \
         FROM servers JOIN users ON users.oidc_subject = servers.owner_subject \
         WHERE servers.id = $1 \
         UNION ALL \
         SELECT users.oidc_subject, users.email, users.handle, users.display_name, server_members.role \
         FROM server_members JOIN users ON users.oidc_subject = server_members.oidc_subject \
         WHERE server_members.server_id = $1 \
         ORDER BY role DESC, display_name",
    )
    .bind(server_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(subject, email, handle, display_name, role)| MemberSummary {
        subject,
        email,
        handle,
        display_name,
        role,
    })
    .collect();
    Ok(Json(members))
}

async fn update_member_role(
    State(state): State<Arc<AppState>>,
    Path((server_id, member_subject)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<UpdateMemberRole>,
) -> Result<Json<MemberSummary>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    if !matches!(input.role.as_str(), "admin" | "member") {
        return Err(ApiError::InvalidRequest);
    }
    let mut transaction = state.pool.begin().await?;
    let member = sqlx::query_as::<_, (String, String, String)>(
        "UPDATE server_members SET role = $3 \
         WHERE server_id = $1 AND oidc_subject = $2 \
         RETURNING (SELECT email FROM users WHERE oidc_subject = $2), \
         (SELECT handle FROM users WHERE oidc_subject = $2), \
         (SELECT display_name FROM users WHERE oidc_subject = $2)",
    )
    .bind(&server_id)
    .bind(&member_subject)
    .bind(&input.role)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    sqlx::query(
        "INSERT INTO server_audit_log \
         (server_id, actor_subject, action, target_subject, detail) \
         VALUES ($1, $2, 'member.role_changed', $3, jsonb_build_object('role', $4::TEXT))",
    )
    .bind(&server_id)
    .bind(&subject)
    .bind(&member_subject)
    .bind(&input.role)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let _ = state
        .changes
        .send(ServerEvent::MembershipChanged { server_id });
    Ok(Json(MemberSummary {
        subject: member_subject,
        email: member.0,
        handle: member.1,
        display_name: member.2,
        role: input.role,
    }))
}

async fn transfer_ownership(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<TransferOwnership>,
) -> Result<StatusCode, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_owner(&state.pool, &subject, &server_id).await?;
    if input.new_owner_subject == subject {
        return Err(ApiError::Conflict);
    }
    let mut transaction = state.pool.begin().await?;
    let target_role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM server_members WHERE server_id = $1 AND oidc_subject = $2 FOR UPDATE",
    )
    .bind(&server_id)
    .bind(&input.new_owner_subject)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND oidc_subject = $2")
        .bind(&server_id)
        .bind(&input.new_owner_subject)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("UPDATE servers SET owner_subject = $2 WHERE id = $1 AND owner_subject = $3")
        .bind(&server_id)
        .bind(&input.new_owner_subject)
        .bind(&subject)
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "INSERT INTO server_members (server_id, oidc_subject, role) VALUES ($1, $2, 'admin')",
    )
    .bind(&server_id)
    .bind(&subject)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO server_audit_log \
         (server_id, actor_subject, action, target_subject, detail) \
         VALUES ($1, $2, 'ownership.transferred', $3, \
         jsonb_build_object('previousRole', $4::TEXT))",
    )
    .bind(&server_id)
    .bind(&subject)
    .bind(&input.new_owner_subject)
    .bind(target_role)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let _ = state
        .changes
        .send(ServerEvent::MembershipChanged { server_id });
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_server(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_owner(&state.pool, &subject, &server_id).await?;
    sqlx::query("DELETE FROM servers WHERE id = $1 AND owner_subject = $2")
        .bind(&server_id)
        .bind(subject)
        .execute(&state.pool)
        .await?;
    let _ = state.changes.send(ServerEvent::ServerDeleted { server_id });
    Ok(StatusCode::NO_CONTENT)
}

async fn list_audit(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<AuditEntry>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let entries = sqlx::query_as::<
        _,
        (
            i64,
            String,
            String,
            Option<String>,
            serde_json::Value,
            String,
        ),
    >(
        "SELECT id, actor_subject, action, target_subject, detail, \
         TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         FROM server_audit_log WHERE server_id = $1 \
         ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .bind(server_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(
        |(id, actor_subject, action, target_subject, detail, created_at)| AuditEntry {
            id,
            actor_subject,
            action,
            target_subject,
            detail,
            created_at,
        },
    )
    .collect();
    Ok(Json(entries))
}

async fn create_server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateServer>,
) -> Result<(StatusCode, Json<ServerSummary>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::InvalidRequest);
    }
    let id = CsrfToken::new_random().secret().to_owned();
    let mut transaction = state.pool.begin().await?;
    sqlx::query("INSERT INTO servers (id, name, owner_subject) VALUES ($1, $2, $3)")
        .bind(&id)
        .bind(name)
        .bind(&subject)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("INSERT INTO server_state (server_id) VALUES ($1)")
        .bind(&id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, target_subject) \
         VALUES ($1, $2, 'server.created', $2)",
    )
    .bind(&id)
    .bind(&subject)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(ServerSummary {
            id,
            name: name.to_owned(),
            role: "owner",
        }),
    ))
}

async fn list_channels(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ChannelSummary>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let channels = sqlx::query_as::<_, (String, String, String, Vec<String>)>(
        "SELECT channel.id, channel.name, channel.visibility, \
         COALESCE(ARRAY_AGG(channel_member.oidc_subject ORDER BY channel_member.oidc_subject) \
         FILTER (WHERE channel_member.oidc_subject IS NOT NULL), ARRAY[]::TEXT[]) \
         FROM channels channel \
         LEFT JOIN channel_members channel_member ON channel_member.channel_id = channel.id \
         WHERE channel.server_id = $1 AND channel.project_id IS NULL \
         AND user_can_access_channel(channel.id, $1, $2) \
         GROUP BY channel.id, channel.name, channel.visibility, channel.created_at \
         ORDER BY channel.created_at, channel.id",
    )
    .bind(server_id)
    .bind(subject)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(id, name, visibility, member_subjects)| ChannelSummary {
        id,
        name,
        visibility,
        member_subjects,
    })
    .collect();
    Ok(Json(channels))
}

fn normalized_subjects(mut subjects: Vec<String>) -> Vec<String> {
    subjects.sort();
    subjects.dedup();
    subjects
}

async fn validate_channel_members(
    pool: &PgPool,
    server_id: &str,
    member_subjects: &[String],
) -> Result<(), ApiError> {
    let valid_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM server_members \
         WHERE server_id = $1 AND oidc_subject = ANY($2)",
    )
    .bind(server_id)
    .bind(member_subjects)
    .fetch_one(pool)
    .await?;
    if valid_count != member_subjects.len() as i64 {
        return Err(ApiError::InvalidRequest);
    }
    Ok(())
}

async fn create_channel(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<CreateChannel>,
) -> Result<(StatusCode, Json<ChannelSummary>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::InvalidRequest);
    }
    let visibility = input.visibility.as_deref().unwrap_or("open");
    if !matches!(visibility, "open" | "private") {
        return Err(ApiError::InvalidRequest);
    }
    let member_subjects = normalized_subjects(input.member_subjects);
    if visibility == "open" && !member_subjects.is_empty() {
        return Err(ApiError::InvalidRequest);
    }
    validate_channel_members(&state.pool, &server_id, &member_subjects).await?;
    let id = CsrfToken::new_random().secret().to_owned();
    let mut transaction = state.pool.begin().await?;
    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO channels (id, server_id, name, visibility, created_by_subject) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT DO NOTHING RETURNING id",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(name)
    .bind(visibility)
    .bind(&subject)
    .fetch_optional(&mut *transaction)
    .await?;
    if inserted.is_none() {
        return Err(ApiError::Conflict);
    }
    sqlx::query(
        "INSERT INTO channel_members (channel_id, oidc_subject) \
         SELECT $1, member_subject FROM UNNEST($2::TEXT[]) member_subject",
    )
    .bind(&id)
    .bind(&member_subjects)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
         VALUES ($1, $2, 'channel.created', jsonb_build_object( \
             'channelId', $3::TEXT, 'visibility', $4::TEXT, \
             'memberSubjects', TO_JSONB($5::TEXT[])))",
    )
    .bind(&server_id)
    .bind(&subject)
    .bind(&id)
    .bind(visibility)
    .bind(&member_subjects)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let channel = ChannelSummary {
        id,
        name: name.to_owned(),
        visibility: visibility.to_owned(),
        member_subjects,
    };
    let _ = state.changes.send(ServerEvent::ChannelCreated {
        server_id,
        channel: channel.clone(),
    });
    Ok((StatusCode::CREATED, Json(channel)))
}

async fn update_channel(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<UpdateChannel>,
) -> Result<Json<ChannelSummary>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_manager(&state.pool, &subject, &server_id).await?;
    if input.visibility.is_none() && input.member_subjects.is_none() {
        return Err(ApiError::InvalidRequest);
    }
    let mut transaction = state.pool.begin().await?;
    let (name, current_visibility, project_id) =
        sqlx::query_as::<_, (String, String, Option<String>)>(
            "SELECT name, visibility, project_id FROM channels \
         WHERE id = $1 AND server_id = $2 FOR UPDATE",
        )
        .bind(&channel_id)
        .bind(&server_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(ApiError::NotFound)?;
    if project_id.is_some() {
        return Err(ApiError::Conflict);
    }
    let visibility = input
        .visibility
        .unwrap_or_else(|| current_visibility.clone());
    if !matches!(visibility.as_str(), "open" | "private") {
        return Err(ApiError::InvalidRequest);
    }
    if visibility != current_visibility {
        let has_messages = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM channel_messages WHERE channel_id = $1)",
        )
        .bind(&channel_id)
        .fetch_one(&mut *transaction)
        .await?;
        if has_messages {
            return Err(ApiError::Conflict);
        }
    }
    let current_members = sqlx::query_scalar::<_, String>(
        "SELECT oidc_subject FROM channel_members \
         WHERE channel_id = $1 ORDER BY oidc_subject",
    )
    .bind(&channel_id)
    .fetch_all(&mut *transaction)
    .await?;
    let member_subjects = input
        .member_subjects
        .map(normalized_subjects)
        .unwrap_or_else(|| current_members.clone());
    if visibility == "open" && !member_subjects.is_empty() {
        return Err(ApiError::InvalidRequest);
    }
    validate_channel_members(&state.pool, &server_id, &member_subjects).await?;
    let changed = visibility != current_visibility || member_subjects != current_members;
    if changed {
        sqlx::query("UPDATE channels SET visibility = $2 WHERE id = $1")
            .bind(&channel_id)
            .bind(&visibility)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM channel_members WHERE channel_id = $1")
            .bind(&channel_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO channel_members (channel_id, oidc_subject) \
             SELECT $1, member_subject FROM UNNEST($2::TEXT[]) member_subject",
        )
        .bind(&channel_id)
        .bind(&member_subjects)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
             VALUES ($1, $2, 'channel.access_changed', jsonb_build_object( \
                 'channelId', $3::TEXT, 'visibility', $4::TEXT, \
                 'memberSubjects', TO_JSONB($5::TEXT[])))",
        )
        .bind(&server_id)
        .bind(&subject)
        .bind(&channel_id)
        .bind(&visibility)
        .bind(&member_subjects)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    if changed {
        let _ = state
            .changes
            .send(ServerEvent::ChannelAccessChanged { server_id });
    }
    Ok(Json(ChannelSummary {
        id: channel_id,
        name,
        visibility,
        member_subjects,
    }))
}

type MessageRow = (
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
    sqlx::types::Json<Vec<ReactionSummary>>,
    sqlx::types::Json<Vec<StoredMention>>,
    sqlx::types::Json<Vec<StoredMention>>,
);

fn resolve_mentioned_content(
    content: Option<String>,
    stored_mentions: &[StoredMention],
) -> (Option<String>, Vec<MentionSummary>) {
    let Some(content) = content else {
        return (None, Vec::new());
    };
    if !stored_mentions.is_empty()
        && stored_mentions
            .iter()
            .all(|mention| mention.start == 0 && mention.end == 0)
    {
        let mut resolved = content;
        let mut mentions = Vec::with_capacity(stored_mentions.len());
        for (ordinal, mention) in stored_mentions.iter().enumerate() {
            let token = format!("<@{ordinal}>");
            let Some(byte_start) = resolved.find(&token) else {
                continue;
            };
            let start = resolved[..byte_start].chars().count();
            let label = format!("@{}", mention.display_name);
            resolved.replace_range(byte_start..byte_start + token.len(), &label);
            mentions.push(MentionSummary {
                user_id: mention.user_id.clone(),
                handle: mention.handle.clone(),
                display_name: mention.display_name.clone(),
                start,
                end: start + label.chars().count(),
            });
        }
        return (Some(resolved), mentions);
    }
    let characters = content.chars().collect::<Vec<_>>();
    let mut resolved = String::new();
    let mut mentions = Vec::with_capacity(stored_mentions.len());
    let mut cursor = 0;
    for mention in stored_mentions {
        if mention.start < cursor || mention.end > characters.len() || mention.start >= mention.end
        {
            return (Some(content), Vec::new());
        }
        resolved.extend(characters[cursor..mention.start].iter());
        let start = resolved.chars().count();
        resolved.push('@');
        resolved.push_str(&mention.display_name);
        let end = resolved.chars().count();
        mentions.push(MentionSummary {
            user_id: mention.user_id.clone(),
            handle: mention.handle.clone(),
            display_name: mention.display_name.clone(),
            start,
            end,
        });
        cursor = mention.end;
    }
    resolved.extend(characters[cursor..].iter());
    (Some(resolved), mentions)
}

fn message_from_row(row: MessageRow) -> ChannelMessage {
    let (content, mentions) = resolve_mentioned_content(row.3, &row.14.0);
    let (reply_content, _) = resolve_mentioned_content(row.10, &row.15.0);
    ChannelMessage {
        id: row.0,
        sequence: row.1,
        channel_id: row.2,
        content,
        author_subject: row.4,
        author_display_name: row.5,
        created_at: row.6,
        edited_at: row.7,
        deleted_at: row.8,
        reply_to: row.9.map(|id| ReplyTarget {
            id,
            content: reply_content,
            author_display_name: row.11.unwrap_or_default(),
            deleted: row.12,
        }),
        reactions: row.13.0,
        mentions,
    }
}

const MESSAGE_SELECT: &str = "SELECT message.id, message.sequence, message.channel_id, message.content, \
     message.author_subject, author.display_name, \
     TO_CHAR(message.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
     TO_CHAR(message.edited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
     TO_CHAR(message.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
     reply.id, reply.content, reply_author.display_name, reply.deleted_at IS NOT NULL, \
     COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT( \
         'emoji', grouped.emoji, 'count', grouped.reaction_count, 'reacted', grouped.reacted) \
         ORDER BY grouped.emoji) FROM ( \
             SELECT emoji, COUNT(*) AS reaction_count, BOOL_OR(oidc_subject = $2) AS reacted \
             FROM message_reactions WHERE message_id = message.id GROUP BY emoji \
         ) grouped), '[]'::JSONB) \
     , COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT( \
         'userId', mentioned.oidc_subject, 'handle', mentioned.handle, \
         'displayName', mentioned.display_name, 'start', mention.start_index, \
         'end', mention.end_index) ORDER BY mention.ordinal) \
         FROM channel_message_mentions mention \
         JOIN users mentioned ON mentioned.oidc_subject = mention.mentioned_subject \
         WHERE mention.message_id = message.id), '[]'::JSONB) \
     , COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT( \
         'userId', mentioned.oidc_subject, 'handle', mentioned.handle, \
         'displayName', mentioned.display_name, 'start', mention.start_index, \
         'end', mention.end_index) ORDER BY mention.ordinal) \
         FROM channel_message_mentions mention \
         JOIN users mentioned ON mentioned.oidc_subject = mention.mentioned_subject \
         WHERE mention.message_id = reply.id), '[]'::JSONB) \
     FROM channel_messages message \
     JOIN users author ON author.oidc_subject = message.author_subject \
     LEFT JOIN channel_messages reply ON reply.id = message.reply_to_message_id \
     LEFT JOIN users reply_author ON reply_author.oidc_subject = reply.author_subject";

async fn can_access_channel(
    pool: &PgPool,
    subject: &str,
    server_id: &str,
    channel_id: &str,
) -> Result<bool, ApiError> {
    Ok(
        sqlx::query_scalar::<_, bool>("SELECT user_can_access_channel($1, $2, $3)")
            .bind(channel_id)
            .bind(server_id)
            .bind(subject)
            .fetch_one(pool)
            .await?,
    )
}

enum ChannelLock {
    Shared,
    Exclusive,
}

async fn lock_channel_and_require_access(
    transaction: &mut Transaction<'_, Postgres>,
    subject: &str,
    server_id: &str,
    channel_id: &str,
    lock: ChannelLock,
) -> Result<(), ApiError> {
    let query = match lock {
        ChannelLock::Shared => "SELECT id FROM channels WHERE id = $1 AND server_id = $2 FOR SHARE",
        ChannelLock::Exclusive => {
            "SELECT id FROM channels WHERE id = $1 AND server_id = $2 FOR UPDATE"
        }
    };
    let channel_exists = sqlx::query_scalar::<_, String>(query)
        .bind(channel_id)
        .bind(server_id)
        .fetch_optional(&mut **transaction)
        .await?;
    if channel_exists.is_none() {
        return Err(ApiError::NotFound);
    }
    let accessible = sqlx::query_scalar::<_, bool>("SELECT user_can_access_channel($1, $2, $3)")
        .bind(channel_id)
        .bind(server_id)
        .bind(subject)
        .fetch_one(&mut **transaction)
        .await?;
    if !accessible {
        return Err(ApiError::NotFound);
    }
    Ok(())
}

async fn load_message<'executor, E>(
    executor: E,
    subject: &str,
    channel_id: &str,
    message_id: &str,
) -> Result<ChannelMessage, ApiError>
where
    E: Executor<'executor, Database = Postgres>,
{
    let sql = format!("{MESSAGE_SELECT} WHERE message.id = $1 AND message.channel_id = $3");
    sqlx::query_as::<_, MessageRow>(&sql)
        .bind(message_id)
        .bind(subject)
        .bind(channel_id)
        .fetch_optional(executor)
        .await?
        .map(message_from_row)
        .ok_or(ApiError::NotFound)
}

fn publish_message_changed(
    state: &AppState,
    server_id: String,
    channel_id: String,
    message_id: String,
) {
    let _ = state.changes.send(ServerEvent::MessageChanged {
        server_id,
        channel_id,
        message_id,
    });
}

async fn search_messages(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Query(query): Query<SearchMessages>,
    headers: HeaderMap,
) -> Result<Json<Vec<ChannelMessage>>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let term = query.q.trim();
    if term.is_empty() || term.chars().count() > 200 {
        return Err(ApiError::InvalidRequest);
    }
    let sql = format!(
        "{MESSAGE_SELECT} JOIN channels channel ON channel.id = message.channel_id \
         WHERE message.server_id = $1 AND message.deleted_at IS NULL \
         AND message.content ILIKE $3 \
         AND user_can_access_channel(channel.id, $1, $2) \
         ORDER BY message.sequence DESC LIMIT 100"
    );
    let rows = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(&server_id)
        .bind(&subject)
        .bind(format!("%{term}%"))
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(rows.into_iter().map(message_from_row).collect()))
}

async fn list_messages(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id)): Path<(String, String)>,
    Query(query): Query<MessagePageQuery>,
    headers: HeaderMap,
) -> Result<Json<MessagePage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let mut transaction = state.pool.begin().await?;
    lock_channel_and_require_access(
        &mut transaction,
        &subject,
        &server_id,
        &channel_id,
        ChannelLock::Shared,
    )
    .await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let sql = format!(
        "{MESSAGE_SELECT} WHERE message.channel_id = $1 \
         AND ($3::BIGINT IS NULL OR message.sequence < $3) \
         ORDER BY message.sequence DESC LIMIT $4"
    );
    let mut rows = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(&channel_id)
        .bind(&subject)
        .bind(query.before)
        .bind(limit + 1)
        .fetch_all(&mut *transaction)
        .await?;
    transaction.commit().await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_before = has_more.then(|| rows.last().map(|row| row.1)).flatten();
    rows.reverse();
    Ok(Json(MessagePage {
        messages: rows.into_iter().map(message_from_row).collect(),
        next_before,
    }))
}

async fn create_message(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<CreateMessage>,
) -> Result<(StatusCode, Json<ChannelMessage>), ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let (requested_content, mentions) = prepare_mentioned_content(&input.content, input.mentions)?;
    let mut transaction = state.pool.begin().await?;
    lock_channel_and_require_access(
        &mut transaction,
        &subject,
        &server_id,
        &channel_id,
        ChannelLock::Exclusive,
    )
    .await?;
    if let Some(reply_id) = input.reply_to_message_id.as_deref() {
        let target_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM channel_messages WHERE id = $1 AND channel_id = $2)",
        )
        .bind(reply_id)
        .bind(&channel_id)
        .fetch_one(&mut *transaction)
        .await?;
        if !target_exists {
            return Err(ApiError::InvalidRequest);
        }
    }
    let display_names =
        require_mentions_accessible(&mut transaction, &server_id, &channel_id, &mentions).await?;
    let (stored_content, mentions) =
        canonicalize_mentioned_content(&requested_content, &mentions, &display_names)?;
    let id = CsrfToken::new_random().secret().to_owned();
    sqlx::query(
        "INSERT INTO channel_messages \
         (id, server_id, channel_id, author_subject, content, reply_to_message_id) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&channel_id)
    .bind(&subject)
    .bind(stored_content)
    .bind(input.reply_to_message_id)
    .execute(&mut *transaction)
    .await?;
    replace_message_mentions(&mut transaction, &id, &mentions).await?;
    transaction.commit().await?;
    let message = load_message(&state.pool, &subject, &channel_id, &id).await?;
    let _ = state.changes.send(ServerEvent::MessageCreated {
        server_id,
        message: Box::new(message.clone()),
    });
    Ok((StatusCode::CREATED, Json(message)))
}

async fn get_message(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id, message_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<ChannelMessage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let mut transaction = state.pool.begin().await?;
    lock_channel_and_require_access(
        &mut transaction,
        &subject,
        &server_id,
        &channel_id,
        ChannelLock::Shared,
    )
    .await?;
    let message = load_message(&mut *transaction, &subject, &channel_id, &message_id).await?;
    transaction.commit().await?;
    Ok(Json(message))
}

async fn edit_message(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id, message_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(input): Json<EditMessage>,
) -> Result<Json<ChannelMessage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let mut transaction = state.pool.begin().await?;
    lock_channel_and_require_access(
        &mut transaction,
        &subject,
        &server_id,
        &channel_id,
        ChannelLock::Exclusive,
    )
    .await?;
    let (author, current_stored_content) = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT author_subject, content FROM channel_messages \
         WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    if author != subject {
        return Err(ApiError::Forbidden);
    }
    let current_stored_mentions = sqlx::query_as::<_, (String, String, String, i32, i32)>(
        "SELECT mentioned.oidc_subject, mentioned.handle, mentioned.display_name, \
         mention.start_index, mention.end_index FROM channel_message_mentions mention \
         JOIN users mentioned ON mentioned.oidc_subject = mention.mentioned_subject \
         WHERE message_id = $1 ORDER BY ordinal",
    )
    .bind(&message_id)
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(
        |(user_id, handle, display_name, start, end)| StoredMention {
            user_id,
            handle,
            display_name,
            start: start as usize,
            end: end as usize,
        },
    )
    .collect::<Vec<_>>();
    let current_mentions = current_stored_mentions
        .iter()
        .map(|mention| MentionInput {
            user_id: mention.user_id.clone(),
            start: mention.start,
            end: mention.end,
        })
        .collect::<Vec<_>>();
    let (resolved_current_content, resolved_current_mentions) =
        resolve_mentioned_content(current_stored_content, &current_stored_mentions);
    let requested_mentions = match input.mentions {
        Some(mentions) => mentions,
        None if current_mentions.is_empty() => Vec::new(),
        None if resolved_current_content.as_deref() == Some(input.content.as_str()) => {
            resolved_current_mentions
                .into_iter()
                .map(|mention| MentionInput {
                    user_id: mention.user_id,
                    start: mention.start,
                    end: mention.end,
                })
                .collect()
        }
        None => return Err(ApiError::InvalidRequest),
    };
    let (requested_content, mentions) =
        prepare_mentioned_content(&input.content, requested_mentions)?;
    let mut grandfathered_counts = HashMap::<String, usize>::new();
    let mut display_names = HashMap::new();
    for mention in &current_stored_mentions {
        *grandfathered_counts
            .entry(mention.user_id.clone())
            .or_default() += 1;
        display_names.insert(mention.user_id.clone(), mention.display_name.clone());
    }
    let mentions_to_validate = mentions
        .iter()
        .filter_map(|mention| {
            let remaining = grandfathered_counts
                .entry(mention.user_id.clone())
                .or_default();
            if *remaining == 0 {
                Some(mention.clone())
            } else {
                *remaining -= 1;
                None
            }
        })
        .collect::<Vec<_>>();
    display_names.extend(
        require_mentions_accessible(
            &mut transaction,
            &server_id,
            &channel_id,
            &mentions_to_validate,
        )
        .await?,
    );
    let (stored_content, mentions) =
        canonicalize_mentioned_content(&requested_content, &mentions, &display_names)?;
    let content_changed = sqlx::query(
        "UPDATE channel_messages SET content = $3, edited_at = NOW() \
         WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL AND content IS DISTINCT FROM $3",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .bind(&stored_content)
    .execute(&mut *transaction)
    .await?
    .rows_affected()
        == 1;
    let mentions_changed = current_mentions != mentions;
    let changed = content_changed || mentions_changed;
    if changed {
        if mentions_changed && !content_changed {
            sqlx::query(
                "UPDATE channel_messages SET edited_at = NOW() \
                 WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL",
            )
            .bind(&message_id)
            .bind(&channel_id)
            .execute(&mut *transaction)
            .await?;
        }
        replace_message_mentions(&mut transaction, &message_id, &mentions).await?;
        sqlx::query(
            "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
             VALUES ($1, $2, 'message.edited', \
             jsonb_build_object('channelId', $3::TEXT, 'messageId', $4::TEXT))",
        )
        .bind(&server_id)
        .bind(&subject)
        .bind(&channel_id)
        .bind(&message_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    if changed {
        publish_message_changed(&state, server_id, channel_id.clone(), message_id.clone());
    }
    Ok(Json(
        load_message(&state.pool, &subject, &channel_id, &message_id).await?,
    ))
}

async fn delete_message(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id, message_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<ChannelMessage>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let mut transaction = state.pool.begin().await?;
    lock_channel_and_require_access(
        &mut transaction,
        &subject,
        &server_id,
        &channel_id,
        ChannelLock::Exclusive,
    )
    .await?;
    let message = sqlx::query_as::<_, (String, bool)>(
        "SELECT author_subject, deleted_at IS NOT NULL FROM channel_messages \
         WHERE id = $1 AND channel_id = $2",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(ApiError::NotFound)?;
    if message.0 != subject {
        require_manager(&state.pool, &subject, &server_id).await?;
    }
    let changed = if message.1 {
        false
    } else {
        sqlx::query(
            "UPDATE channel_messages SET content = NULL, deleted_at = NOW() \
             WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL",
        )
        .bind(&message_id)
        .bind(&channel_id)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1
    };
    if changed {
        sqlx::query("DELETE FROM message_reactions WHERE message_id = $1")
            .bind(&message_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
             VALUES ($1, $2, 'message.deleted', \
             jsonb_build_object('channelId', $3::TEXT, 'messageId', $4::TEXT))",
        )
        .bind(&server_id)
        .bind(&subject)
        .bind(&channel_id)
        .bind(&message_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    if changed {
        publish_message_changed(&state, server_id, channel_id.clone(), message_id.clone());
    }
    Ok(Json(
        load_message(&state.pool, &subject, &channel_id, &message_id).await?,
    ))
}

async fn change_reaction(
    state: &AppState,
    server_id: String,
    channel_id: String,
    message_id: String,
    headers: &HeaderMap,
    input: ReactionInput,
    add: bool,
) -> Result<Json<ChannelMessage>, ApiError> {
    require_origin(&state.auth, headers)?;
    let subject = require_session(&state.pool, headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let emoji = input.emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > 32 {
        return Err(ApiError::InvalidRequest);
    }
    let mut transaction = state.pool.begin().await?;
    lock_channel_and_require_access(
        &mut transaction,
        &subject,
        &server_id,
        &channel_id,
        ChannelLock::Exclusive,
    )
    .await?;
    let visible = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM channel_messages \
         WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL)",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !visible {
        return Err(ApiError::NotFound);
    }
    let changed = if add {
        sqlx::query(
            "INSERT INTO message_reactions (message_id, oidc_subject, emoji) \
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
            "DELETE FROM message_reactions \
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
            "INSERT INTO server_audit_log (server_id, actor_subject, action, detail) \
             VALUES ($1, $2, $3, jsonb_build_object( \
             'channelId', $4::TEXT, 'messageId', $5::TEXT, 'emoji', $6::TEXT))",
        )
        .bind(&server_id)
        .bind(&subject)
        .bind(if add {
            "reaction.added"
        } else {
            "reaction.removed"
        })
        .bind(&channel_id)
        .bind(&message_id)
        .bind(emoji)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    if changed {
        publish_message_changed(state, server_id, channel_id.clone(), message_id.clone());
    }
    Ok(Json(
        load_message(&state.pool, &subject, &channel_id, &message_id).await?,
    ))
}

async fn add_reaction(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id, message_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(input): Json<ReactionInput>,
) -> Result<Json<ChannelMessage>, ApiError> {
    change_reaction(
        &state, server_id, channel_id, message_id, &headers, input, true,
    )
    .await
}

async fn remove_reaction(
    State(state): State<Arc<AppState>>,
    Path((server_id, channel_id, message_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(input): Json<ReactionInput>,
) -> Result<Json<ChannelMessage>, ApiError> {
    change_reaction(
        &state, server_id, channel_id, message_id, &headers, input, false,
    )
    .await
}

async fn require_member(pool: &PgPool, subject: &str, server_id: &str) -> Result<(), ApiError> {
    if server_role(pool, subject, server_id).await?.is_none() {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

async fn read_state(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<DurableState>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let value =
        sqlx::query_scalar::<_, String>("SELECT value FROM server_state WHERE server_id = $1")
            .bind(server_id)
            .fetch_one(&state.pool)
            .await?;
    Ok(Json(DurableState { value }))
}

async fn write_state(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<DurableState>,
) -> Result<Json<DurableState>, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let value = input.value.trim().to_owned();
    let saved = DurableState {
        value: sqlx::query_scalar::<_, String>(
            "UPDATE server_state SET value = $2, updated_at = NOW() \
             WHERE server_id = $1 RETURNING value",
        )
        .bind(&server_id)
        .bind(value)
        .fetch_one(&state.pool)
        .await?,
    };
    let _ = state.changes.send(ServerEvent::DurableStateChanged {
        server_id,
        state: saved.clone(),
    });
    Ok(Json(saved))
}

async fn events(
    websocket: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_origin(&state.auth, &headers)?;
    let subject = require_session(&state.pool, &headers).await?;
    require_member(&state.pool, &subject, &server_id).await?;
    let mut changes = state.changes.subscribe();
    Ok(websocket.on_upgrade(move |socket| async move {
        let (mut sender, _) = socket.split();
        loop {
            match changes.recv().await {
                Ok(event) => {
                    if event.server_id() != server_id {
                        continue;
                    }
                    if matches!(event, ServerEvent::ServerDeleted { .. }) {
                        let Ok(payload) = serde_json::to_string(&event) else {
                            tracing::error!("failed to serialize server deletion event");
                            break;
                        };
                        let _ = sender.send(Message::Text(payload.into())).await;
                        break;
                    }
                    match server_role(&state.pool, &subject, &server_id).await {
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!(?error, "failed to reauthorize websocket event");
                            break;
                        }
                    }
                    if let Some(channel_id) = event.channel_id() {
                        match can_access_channel(&state.pool, &subject, &server_id, channel_id)
                            .await
                        {
                            Ok(true) => {}
                            Ok(false) => continue,
                            Err(error) => {
                                tracing::warn!(
                                    ?error,
                                    "failed to authorize websocket channel event"
                                );
                                break;
                            }
                        }
                    }
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
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_cookie_has_browser_security_attributes() {
        assert_eq!(
            session_cookie("secret", true),
            "buzzcode_session=secret; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=2592000"
        );
    }

    #[test]
    fn canonicalizes_a_selected_mention_from_its_stable_user_id() {
        let content = "👋 @Old";
        let mentions = vec![MentionInput {
            user_id: "user-1".to_owned(),
            start: 2,
            end: 6,
        }];
        let display_names = HashMap::from([("user-1".to_owned(), "New Name".to_owned())]);
        let Ok(result) = canonicalize_mentioned_content(content, &mentions, &display_names) else {
            panic!("mention canonicalization should succeed");
        };
        assert_eq!(
            result,
            (
                "👋 @New Name".to_owned(),
                vec![MentionInput {
                    user_id: "user-1".to_owned(),
                    start: 2,
                    end: 11,
                }],
            )
        );
    }

    #[test]
    fn state_event_uses_the_public_json_contract() {
        let event = ServerEvent::DurableStateChanged {
            server_id: "server-1".to_owned(),
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

    #[test]
    fn membership_event_uses_the_public_json_contract() {
        let event = ServerEvent::MembershipChanged {
            server_id: "server-1".to_owned(),
        };
        let json = serde_json::to_value(event).unwrap_or_default();
        assert_eq!(json, serde_json::json!({ "type": "membershipChanged" }));
    }

    #[test]
    fn message_changed_event_uses_the_public_json_contract() {
        let event = ServerEvent::MessageChanged {
            server_id: "server-1".to_owned(),
            channel_id: "channel-1".to_owned(),
            message_id: "message-1".to_owned(),
        };
        let json = serde_json::to_value(event).unwrap_or_default();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "messageChanged",
                "channelId": "channel-1",
                "messageId": "message-1"
            })
        );
    }
}
