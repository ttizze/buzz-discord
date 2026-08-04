use std::{env, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, Query, State, WebSocketUpgrade, ws::Message},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
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
use sqlx::{PgPool, postgres::PgPoolOptions};
use thiserror::Error;
use tokio::{net::TcpListener, sync::broadcast};
use tower_http::{
    cors::{AllowHeaders, AllowMethods, CorsLayer},
    trace::TraceLayer,
};
use url::Url;

const SESSION_COOKIE: &str = "buzzcode_session";

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
struct AppState {
    pool: PgPool,
    changes: broadcast::Sender<ServerEvent>,
    oidc: CoreClient<
        EndpointSet,
        EndpointNotSet,
        EndpointNotSet,
        EndpointNotSet,
        EndpointMaybeSet,
        EndpointMaybeSet,
    >,
    http: reqwest::Client,
    auth: AuthConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableState {
    value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerEvent {
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
}

impl ServerEvent {
    fn server_id(&self) -> &str {
        match self {
            Self::DurableStateChanged { server_id, .. }
            | Self::MembershipChanged { server_id }
            | Self::ServerDeleted { server_id } => server_id,
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
    email: String,
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

#[derive(Debug, Error)]
enum ApiError {
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
    let state = Arc::new(AppState {
        pool,
        changes,
        oidc,
        http,
        auth,
    });
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/api/auth/login", get(login))
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
            "/api/servers/{server_id}/bootstrap",
            get(read_state).put(write_state),
        )
        .route("/api/servers/{server_id}/events", get(events))
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

async fn login(State(state): State<Arc<AppState>>) -> Result<Redirect, ApiError> {
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
    sqlx::query(
        "WITH expired AS (DELETE FROM oidc_login_attempts WHERE expires_at <= NOW()) \
         INSERT INTO oidc_login_attempts (state, nonce, pkce_verifier) VALUES ($1, $2, $3)",
    )
    .bind(csrf.secret())
    .bind(nonce.secret())
    .bind(pkce_verifier.secret())
    .execute(&state.pool)
    .await?;
    Ok(Redirect::to(url.as_str()))
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
    let display_name = claims
        .preferred_username()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| email.clone());
    let subject = claims.subject().to_string();
    sqlx::query(
        "INSERT INTO users (oidc_subject, email, display_name) VALUES ($1, $2, $3) \
         ON CONFLICT (oidc_subject) DO UPDATE SET email = EXCLUDED.email, \
         display_name = EXCLUDED.display_name, updated_at = NOW()",
    )
    .bind(&subject)
    .bind(&email)
    .bind(&display_name)
    .execute(&state.pool)
    .await?;
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
    let user = sqlx::query_as::<_, (String, String)>(
        "SELECT users.email, users.display_name FROM sessions \
         JOIN users ON users.oidc_subject = sessions.oidc_subject \
         WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()",
    )
    .bind(token_hash(&token))
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(AuthSession {
        authenticated: user.is_some(),
        user: user.map(|(email, display_name)| SessionUser {
            email,
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

fn require_origin(auth: &AuthConfig, headers: &HeaderMap) -> Result<(), ApiError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    if origin != auth.app_origin {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

async fn require_session(pool: &PgPool, headers: &HeaderMap) -> Result<String, ApiError> {
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
    let members = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT users.oidc_subject, users.email, users.display_name, 'owner' AS role \
         FROM servers JOIN users ON users.oidc_subject = servers.owner_subject \
         WHERE servers.id = $1 \
         UNION ALL \
         SELECT users.oidc_subject, users.email, users.display_name, server_members.role \
         FROM server_members JOIN users ON users.oidc_subject = server_members.oidc_subject \
         WHERE server_members.server_id = $1 \
         ORDER BY role DESC, display_name",
    )
    .bind(server_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(subject, email, display_name, role)| MemberSummary {
        subject,
        email,
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
    let member = sqlx::query_as::<_, (String, String)>(
        "UPDATE server_members SET role = $3 \
         WHERE server_id = $1 AND oidc_subject = $2 \
         RETURNING (SELECT email FROM users WHERE oidc_subject = $2), \
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
        display_name: member.1,
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
                    match server_role(&state.pool, &subject, &server_id).await {
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!(?error, "failed to reauthorize websocket event");
                            break;
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
}
