#![deny(unsafe_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use buzz_core::host::{
    HostDirectoryEntry, HostDirectoryListing, HostPairingConfig, HostPairingOffer, HostRpcAction,
    HostRpcRequest, HostRpcResponse, HOST_PROTOCOL_VERSION,
};
use buzz_core::kind::{
    KIND_AGENT_PROFILE, KIND_HOST_RPC_REQUEST, KIND_HOST_RPC_RESPONSE, KIND_PROFILE,
};
use buzz_core::pairing::qr::encode_qr;
use buzz_core::pairing::session::PairingSession;
use buzz_core::pairing::types::PayloadType;
use buzz_ws_client::{NostrWsConnection, RelayMessage};
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use nostr::nips::nip44;
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, ToBech32};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::process::{Child, Command};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use zeroize::Zeroizing;

const PAIR_SUBSCRIPTION: &str = "buzz-host-pair";
const RPC_SUBSCRIPTION: &str = "buzz-host-rpc";

#[derive(Parser)]
#[command(name = "buzz-host", about = "Run a Buzz computer without a desktop UI")]
struct Cli {
    /// Directory containing the stable host identity and owner configuration.
    #[arg(long, env = "BUZZ_HOST_STATE_DIR")]
    state_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: HostCommand,
}

#[derive(Subcommand)]
enum HostCommand {
    /// Pair this computer with Buzz Desktop.
    Pair {
        /// Community Relay WebSocket URL. Pairing sidecar discovery uses NIP-11.
        #[arg(long, env = "BUZZ_RELAY_URL")]
        relay: String,
        /// Override the NIP-AB pairing Relay URL.
        #[arg(long)]
        pairing_relay: Option<String>,
        /// Name shown in Buzz. Defaults to the machine hostname.
        #[arg(long)]
        name: Option<String>,
        /// First directory shown by the remote folder browser.
        #[arg(long)]
        default_path: Option<PathBuf>,
    },
    /// Run folder RPC and the ACP agent using the paired configuration.
    Run {
        /// ACP harness executable.
        #[arg(long, env = "BUZZ_HOST_ACP_COMMAND", default_value = "buzz-acp")]
        acp_command: String,
        /// Serve the computer without spawning an ACP harness.
        #[arg(long)]
        no_agent: bool,
    },
    /// Print non-secret status for service diagnostics.
    Status,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostState {
    computer_id: String,
    computer_name: String,
    private_key_nsec: String,
    platform: String,
    capabilities: Vec<String>,
    default_path: String,
    #[serde(default)]
    relay_url: Option<String>,
    #[serde(default)]
    owner_pubkey: Option<String>,
    #[serde(default)]
    auth_tag: Option<String>,
}

impl HostState {
    fn keys(&self) -> Result<Keys> {
        Keys::parse(&self.private_key_nsec).context("stored host key is invalid")
    }

    fn configured(&self) -> Result<(&str, &str, &str)> {
        Ok((
            self.relay_url
                .as_deref()
                .ok_or_else(|| anyhow!("host is not paired: run `buzz-host pair` first"))?,
            self.owner_pubkey
                .as_deref()
                .ok_or_else(|| anyhow!("host is missing its owner binding"))?,
            self.auth_tag
                .as_deref()
                .ok_or_else(|| anyhow!("host is missing its owner attestation"))?,
        ))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "buzz_host=info".into()),
        )
        .init();

    let cli = Cli::parse();
    let state_dir = cli.state_dir.unwrap_or_else(default_state_dir);
    match cli.command {
        HostCommand::Pair {
            relay,
            pairing_relay,
            name,
            default_path,
        } => pair_host(&state_dir, &relay, pairing_relay, name, default_path).await,
        HostCommand::Run {
            acp_command,
            no_agent,
        } => run_host(&state_dir, &acp_command, no_agent).await,
        HostCommand::Status => print_status(&state_dir),
    }
}

fn default_state_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(path).join("buzz-host");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local/state/buzz-host")
}

fn state_path(state_dir: &Path) -> PathBuf {
    state_dir.join("host.json")
}

fn load_state(state_dir: &Path) -> Result<HostState> {
    let bytes = std::fs::read(state_path(state_dir)).with_context(|| {
        format!(
            "could not read {}; pair this host first",
            state_path(state_dir).display()
        )
    })?;
    serde_json::from_slice(&bytes).context("host state is invalid")
}

fn save_state(state_dir: &Path, state: &HostState) -> Result<()> {
    std::fs::create_dir_all(state_dir)
        .with_context(|| format!("create {}", state_dir.display()))?;
    let path = state_path(state_dir);
    let temp = state_dir.join("host.json.tmp");
    let bytes = serde_json::to_vec_pretty(state)?;
    std::fs::write(&temp, bytes).with_context(|| format!("write {}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temp, &path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

fn computer_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "Buzz VPS".to_string())
}

fn default_workspace_path() -> PathBuf {
    std::env::var_os("BUZZ_HOST_DEFAULT_PATH")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn initial_state(name: Option<String>, default_path: Option<PathBuf>) -> Result<HostState> {
    let keys = Keys::generate();
    let private_key_nsec = keys.secret_key().to_bech32().context("encode host key")?;
    let default_path = default_path.unwrap_or_else(default_workspace_path);
    let default_path = default_path
        .canonicalize()
        .with_context(|| format!("default path is not accessible: {}", default_path.display()))?;
    if !default_path.is_dir() {
        bail!(
            "default path is not a directory: {}",
            default_path.display()
        );
    }
    let computer_name = name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(computer_name);
    if computer_name.len() > 128 {
        bail!("computer name must not exceed 128 bytes");
    }
    Ok(HostState {
        computer_id: uuid::Uuid::new_v4().to_string(),
        computer_name,
        private_key_nsec,
        platform: std::env::consts::OS.to_string(),
        capabilities: vec![
            "files".into(),
            "shell".into(),
            "git".into(),
            "browser".into(),
        ],
        default_path: default_path.to_string_lossy().into_owned(),
        relay_url: None,
        owner_pubkey: None,
        auth_tag: None,
    })
}

fn load_or_create_pairing_state(
    state_dir: &Path,
    name: Option<String>,
    default_path: Option<PathBuf>,
) -> Result<HostState> {
    let path = state_path(state_dir);
    let mut state = if path.exists() {
        load_state(state_dir)?
    } else {
        initial_state(None, None)?
    };
    if let Some(name) = name.filter(|value| !value.trim().is_empty()) {
        if name.len() > 128 {
            bail!("computer name must not exceed 128 bytes");
        }
        state.computer_name = name;
    }
    if let Some(path) = default_path {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("default path is not accessible: {}", path.display()))?;
        if !canonical.is_dir() {
            bail!("default path is not a directory: {}", canonical.display());
        }
        state.default_path = canonical.to_string_lossy().into_owned();
    }
    Ok(state)
}

async fn pair_host(
    state_dir: &Path,
    relay: &str,
    pairing_relay: Option<String>,
    name: Option<String>,
    default_path: Option<PathBuf>,
) -> Result<()> {
    let mut state = load_or_create_pairing_state(state_dir, name, default_path)?;
    save_state(state_dir, &state)?;
    let keys = state.keys()?;
    let pairing_relay = match pairing_relay {
        Some(url) => url,
        None => resolve_pairing_relay(relay).await,
    };
    let (mut session, qr) =
        PairingSession::new_source_with_keys(pairing_relay.clone(), keys.clone());
    let uri = encode_qr(&qr);

    let (socket, _) = connect_async(&pairing_relay)
        .await
        .with_context(|| format!("connect pairing relay {pairing_relay}"))?;
    let (mut write, mut read) = socket.split();
    authenticate_pairing_socket(&mut read, &mut write, &session, &pairing_relay).await?;
    write
        .send(Message::Text(
            json!(["REQ", PAIR_SUBSCRIPTION, {"kinds":[buzz_core::kind::KIND_PAIRING], "#p":[keys.public_key().to_hex()]}])
                .to_string()
                .into(),
        ))
        .await?;

    println!("\nPaste this code into Buzz Desktop → Settings → Computers → Add computer:\n");
    println!("{uri}\n");
    println!("Waiting for Buzz Desktop…");

    let offer = wait_for_pair_event(&mut read, Duration::from_secs(120), |event| {
        session.handle_offer(event).ok()
    })
    .await?;
    println!("\nVerification code: {offer}");
    println!("Confirm the same code in Buzz Desktop, then type yes here:");
    if !read_yes().await? {
        bail!("pairing cancelled");
    }

    send_pair_event(&mut write, session.confirm_sas()?).await?;
    let descriptor = HostPairingOffer {
        version: HOST_PROTOCOL_VERSION,
        computer_id: state.computer_id.clone(),
        computer_name: state.computer_name.clone(),
        host_pubkey: keys.public_key().to_hex(),
        platform: state.platform.clone(),
        capabilities: state.capabilities.clone(),
        default_path: state.default_path.clone(),
    };
    send_pair_event(
        &mut write,
        session.send_payload(
            PayloadType::Custom,
            Zeroizing::new(serde_json::to_string(&descriptor)?),
        )?,
    )
    .await?;

    let config = wait_for_pair_event(&mut read, Duration::from_secs(120), |event| {
        let (payload_type, payload) = session.handle_response_payload(event).ok()?;
        (payload_type == PayloadType::Custom)
            .then(|| serde_json::from_str::<HostPairingConfig>(&payload).ok())
            .flatten()
    })
    .await?;
    validate_pairing_config(&config, &keys.public_key())?;
    let requested_relay = url::Url::parse(relay).context("invalid requested Relay URL")?;
    let configured_relay =
        url::Url::parse(&config.relay_url).context("invalid paired Relay URL")?;
    if requested_relay != configured_relay {
        bail!(
            "Buzz Desktop is connected to {configured_relay}, but this host was started for {requested_relay}"
        );
    }
    state.relay_url = Some(config.relay_url);
    state.owner_pubkey = Some(config.owner_pubkey);
    state.auth_tag = Some(config.auth_tag);
    save_state(state_dir, &state)?;

    wait_for_pair_event(&mut read, Duration::from_secs(30), |event| {
        session.handle_complete(event).ok().map(|_| ())
    })
    .await?;
    println!("\nPaired successfully. Start the service with: buzz-host run");
    Ok(())
}

fn validate_pairing_config(config: &HostPairingConfig, host_pubkey: &PublicKey) -> Result<()> {
    if config.version != HOST_PROTOCOL_VERSION {
        bail!("unsupported host configuration version {}", config.version);
    }
    let parsed = url::Url::parse(&config.relay_url).context("invalid Relay URL")?;
    if !matches!(parsed.scheme(), "ws" | "wss") {
        bail!("Relay URL must use ws or wss");
    }
    let owner = buzz_sdk::nip_oa::verify_auth_tag(&config.auth_tag, host_pubkey)
        .context("owner attestation is invalid")?;
    if owner.to_hex() != config.owner_pubkey.to_ascii_lowercase() {
        bail!("owner attestation does not match the paired owner");
    }
    Ok(())
}

async fn read_yes() -> Result<bool> {
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        Ok::<_, std::io::Error>(matches!(
            line.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ))
    })
    .await
    .context("pairing confirmation input failed")?
    .map_err(Into::into)
}

async fn run_host(state_dir: &Path, acp_command: &str, no_agent: bool) -> Result<()> {
    let state = load_state(state_dir)?;
    let (relay_url, owner_pubkey, auth_tag_json) = state.configured()?;
    validate_pairing_config(
        &HostPairingConfig {
            version: HOST_PROTOCOL_VERSION,
            relay_url: relay_url.to_string(),
            owner_pubkey: owner_pubkey.to_string(),
            auth_tag: auth_tag_json.to_string(),
        },
        &state.keys()?.public_key(),
    )?;

    let rpc_state = state.clone();
    let rpc_task = tokio::spawn(async move {
        loop {
            if let Err(error) = serve_rpc_once(&rpc_state).await {
                tracing::warn!(%error, "host RPC disconnected; retrying");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });

    let mut child = if no_agent {
        None
    } else {
        Some(spawn_acp(&state, acp_command)?)
    };
    tracing::info!(computer_id = %state.computer_id, "Buzz Host is running");

    if let Some(ref mut child) = child {
        tokio::select! {
            status = child.wait() => {
                rpc_task.abort();
                bail!("ACP harness exited: {}", status?);
            }
            _ = tokio::signal::ctrl_c() => {}
        }
        let _ = child.kill().await;
    } else {
        tokio::signal::ctrl_c().await?;
    }
    rpc_task.abort();
    Ok(())
}

fn spawn_acp(state: &HostState, executable: &str) -> Result<Child> {
    let (relay_url, owner_pubkey, auth_tag) = state.configured()?;
    Command::new(executable)
        .env("BUZZ_PRIVATE_KEY", &state.private_key_nsec)
        .env("NOSTR_PRIVATE_KEY", &state.private_key_nsec)
        .env("BUZZ_RELAY_URL", relay_url)
        .env("BUZZ_AUTH_TAG", auth_tag)
        .env("BUZZ_ACP_AGENT_OWNER", owner_pubkey)
        .env("BUZZ_COMPUTER_ID", &state.computer_id)
        .env("BUZZ_ACP_RESPOND_TO", "owner-only")
        .current_dir(&state.default_path)
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("start ACP harness `{executable}`"))
}

async fn serve_rpc_once(state: &HostState) -> Result<()> {
    let keys = state.keys()?;
    let (relay_url, owner_hex, auth_tag_json) = state.configured()?;
    let owner = PublicKey::from_hex(owner_hex).context("stored owner pubkey is invalid")?;
    let auth_tag = buzz_sdk::nip_oa::parse_auth_tag(auth_tag_json)
        .context("stored owner auth tag is invalid")?;
    let mut connection =
        NostrWsConnection::connect_authenticated(relay_url, &keys, Some(&auth_tag)).await?;
    publish_host_profiles(&mut connection, state, &keys, &auth_tag).await?;
    connection
        .send_raw(&json!(["REQ", RPC_SUBSCRIPTION, {
            "kinds": [KIND_HOST_RPC_REQUEST],
            "#p": [keys.public_key().to_hex()],
            "limit": 0
        }]))
        .await?;

    loop {
        let message = connection.next_event(Duration::from_secs(60)).await;
        let message = match message {
            Ok(message) => message,
            Err(buzz_ws_client::WsClientError::Timeout) => continue,
            Err(error) => return Err(error.into()),
        };
        let RelayMessage::Event {
            subscription_id,
            event,
        } = message
        else {
            continue;
        };
        if subscription_id != RPC_SUBSCRIPTION
            || event.kind.as_u16() as u32 != KIND_HOST_RPC_REQUEST
            || event.pubkey != owner
        {
            continue;
        }
        let response = handle_rpc_event(state, &keys, &owner, &event);
        let response_event = build_rpc_response_event(&keys, &owner, &event, response)?;
        let accepted = connection.send_event(response_event).await?;
        if !accepted.accepted {
            tracing::warn!(message = %accepted.message, "Relay rejected host RPC response");
        }
    }
}

async fn publish_host_profiles(
    connection: &mut NostrWsConnection,
    state: &HostState,
    keys: &Keys,
    auth_tag: &Tag,
) -> Result<()> {
    let profile = EventBuilder::new(
        Kind::Custom(KIND_PROFILE as u16),
        json!({
            "name": state.computer_name,
            "display_name": state.computer_name,
            "about": "Headless Buzz computer",
            "bot": true,
            "agent": true
        })
        .to_string(),
    )
    .tags([auth_tag.clone()])
    .sign_with_keys(keys)?;
    let result = connection.send_event(profile).await?;
    if !result.accepted {
        bail!("Relay rejected host owner profile: {}", result.message);
    }

    let agent = EventBuilder::new(
        Kind::Custom(KIND_AGENT_PROFILE as u16),
        json!({
            "name": state.computer_name,
            "display_name": state.computer_name,
            "agent_type": "headless-host",
            "channels": [],
            "channel_ids": [],
            "capabilities": state.capabilities,
            "status": "online"
        })
        .to_string(),
    )
    .sign_with_keys(keys)?;
    let result = connection.send_event(agent).await?;
    if !result.accepted {
        bail!("Relay rejected host agent profile: {}", result.message);
    }
    Ok(())
}

fn handle_rpc_event(
    state: &HostState,
    keys: &Keys,
    owner: &PublicKey,
    event: &Event,
) -> HostRpcResponse {
    let decrypted = nip44::decrypt(keys.secret_key(), owner, &event.content)
        .context("request decryption failed")
        .and_then(|plaintext| {
            serde_json::from_str::<HostRpcRequest>(&plaintext).context("request is invalid")
        });
    let request_id = decrypted
        .as_ref()
        .map(|request| request.request_id.clone())
        .unwrap_or_else(|_| event.id.to_hex());
    let result = decrypted.and_then(|request| {
        if request.version != HOST_PROTOCOL_VERSION {
            bail!("unsupported request version");
        }
        uuid::Uuid::parse_str(&request.request_id).context("request id is invalid")?;
        match request.action {
            HostRpcAction::ListDirectory { path } => list_directory(if path.trim().is_empty() {
                &state.default_path
            } else {
                &path
            }),
        }
    });

    match result {
        Ok(directory) => HostRpcResponse {
            version: HOST_PROTOCOL_VERSION,
            request_id,
            directory: Some(directory),
            error: None,
        },
        Err(error) => HostRpcResponse {
            version: HOST_PROTOCOL_VERSION,
            request_id,
            directory: None,
            error: Some(error.to_string()),
        },
    }
}

fn list_directory(raw_path: &str) -> Result<HostDirectoryListing> {
    let requested = PathBuf::from(raw_path);
    if !requested.is_absolute() {
        bail!("path must be absolute");
    }
    let path = requested
        .canonicalize()
        .with_context(|| format!("cannot access {raw_path}"))?;
    if !path.is_dir() {
        bail!("path is not a directory");
    }
    let mut directories = Vec::new();
    for entry in std::fs::read_dir(&path).with_context(|| format!("cannot list {raw_path}"))? {
        let Ok(entry) = entry else { continue };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        let Ok(canonical) = entry.path().canonicalize() else {
            continue;
        };
        if !canonical.is_dir() {
            continue;
        }
        directories.push(HostDirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: canonical.to_string_lossy().into_owned(),
        });
        if directories.len() >= 2_000 {
            break;
        }
    }
    directories.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("/")
        .to_string();
    Ok(HostDirectoryListing {
        path: path.to_string_lossy().into_owned(),
        name,
        parent: path
            .parent()
            .map(|value| value.to_string_lossy().into_owned()),
        git_repository: path.join(".git").exists(),
        directories,
    })
}

fn build_rpc_response_event(
    keys: &Keys,
    owner: &PublicKey,
    request_event: &Event,
    response: HostRpcResponse,
) -> Result<Event> {
    let plaintext = serde_json::to_string(&response)?;
    let content = nip44::encrypt(keys.secret_key(), owner, plaintext, nip44::Version::V2)?;
    EventBuilder::new(Kind::Custom(KIND_HOST_RPC_RESPONSE as u16), content)
        .tags([Tag::public_key(*owner), Tag::event(request_event.id)])
        .sign_with_keys(keys)
        .map_err(Into::into)
}

fn print_status(state_dir: &Path) -> Result<()> {
    let state = load_state(state_dir)?;
    println!("computer_id={}", state.computer_id);
    println!("computer_name={}", state.computer_name);
    println!("paired={}", state.relay_url.is_some());
    println!("default_path={}", state.default_path);
    Ok(())
}

async fn send_pair_event<W>(write: &mut W, event: Event) -> Result<()>
where
    W: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    write
        .send(Message::Text(
            format!("[\"EVENT\",{}]", event.as_json()).into(),
        ))
        .await?;
    Ok(())
}

async fn wait_for_pair_event<R, T, F>(read: &mut R, timeout: Duration, mut accept: F) -> Result<T>
where
    R: StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    F: FnMut(&Event) -> Option<T>,
{
    tokio::time::timeout(timeout, async {
        while let Some(message) = read.next().await {
            let message = message?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: serde_json::Value = match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some(parts) = value.as_array() else {
                continue;
            };
            if parts.first().and_then(|value| value.as_str()) != Some("EVENT")
                || parts.get(1).and_then(|value| value.as_str()) != Some(PAIR_SUBSCRIPTION)
            {
                continue;
            }
            let Some(raw_event) = parts.get(2) else {
                continue;
            };
            let Ok(event) = serde_json::from_value::<Event>(raw_event.clone()) else {
                continue;
            };
            if let Some(result) = accept(&event) {
                return Ok(result);
            }
        }
        Err(anyhow!("pairing relay closed"))
    })
    .await
    .map_err(|_| anyhow!("pairing timed out"))?
}

async fn authenticate_pairing_socket<R, W>(
    read: &mut R,
    write: &mut W,
    session: &PairingSession,
    relay_url: &str,
) -> Result<()>
where
    R: StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    W: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let challenge = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(message) = read.next().await {
            let Message::Text(text) = message? else {
                continue;
            };
            let value: serde_json::Value = serde_json::from_str(&text)?;
            if value.get(0).and_then(|value| value.as_str()) == Some("AUTH") {
                return Ok::<_, anyhow::Error>(
                    value
                        .get(1)
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                );
            }
        }
        Err(anyhow!("pairing relay closed during auth"))
    })
    .await;
    let Ok(challenge) = challenge else {
        return Ok(());
    };
    let challenge = challenge?;
    let relay = nostr::RelayUrl::parse(relay_url)?;
    let event = session.sign_event(EventBuilder::auth(challenge, relay))?;
    write
        .send(Message::Text(
            format!("[\"AUTH\",{}]", event.as_json()).into(),
        ))
        .await?;
    Ok(())
}

async fn resolve_pairing_relay(relay_url: &str) -> String {
    let http = if let Some(rest) = relay_url.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = relay_url.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        return relay_url.to_string();
    };
    let response = match reqwest::Client::new()
        .get(&http)
        .header("Accept", "application/nostr+json")
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return relay_url.to_string(),
    };
    let value: serde_json::Value = match response.json().await {
        Ok(value) => value,
        Err(_) => return relay_url.to_string(),
    };
    if let Some(url) = value
        .get("buzz")
        .and_then(|value| value.get("pairing_relay"))
        .and_then(|value| value.as_str())
        .or_else(|| value.get("pairing_relay").and_then(|value| value.as_str()))
    {
        return url.to_string();
    }
    if value
        .get("supported_nips")
        .and_then(|value| value.as_array())
        .is_some_and(|values| values.iter().any(|value| value.as_u64() == Some(43)))
    {
        return format!("{}/pair", relay_url.trim_end_matches('/'));
    }
    relay_url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_listing_is_canonical_and_directory_only() {
        let temp = std::env::temp_dir().join(format!("buzz-host-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("project/.git")).expect("create fixture");
        std::fs::write(temp.join("file.txt"), "ignored").expect("write fixture");
        let listing = list_directory(temp.to_str().expect("utf8 path")).expect("list");
        assert_eq!(listing.directories.len(), 1);
        assert_eq!(listing.directories[0].name, "project");
        std::fs::remove_dir_all(temp).expect("cleanup fixture");
    }

    #[test]
    fn state_json_never_exposes_owner_private_key_field() {
        let state =
            initial_state(Some("host".into()), Some(std::env::temp_dir())).expect("initial state");
        let value = serde_json::to_value(state).expect("serialize");
        assert!(value.get("ownerPrivateKey").is_none());
        assert!(value.get("privateKeyNsec").is_some());
    }

    #[test]
    fn corrupt_existing_state_is_not_silently_replaced() {
        let temp =
            std::env::temp_dir().join(format!("buzz-host-corrupt-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).expect("create state directory");
        std::fs::write(state_path(&temp), b"not-json").expect("write corrupt state");

        assert!(load_or_create_pairing_state(&temp, None, None).is_err());
        assert_eq!(
            std::fs::read(state_path(&temp)).expect("state remains"),
            b"not-json"
        );
        std::fs::remove_dir_all(temp).expect("cleanup fixture");
    }
}
