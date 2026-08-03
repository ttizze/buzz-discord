use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use buzz_core_pkg::host::{
    ComputerRegistration, HostDirectoryListing, HostPairingConfig, HostPairingOffer, HostRpcAction,
    HostRpcRequest, HostRpcResponse, HOST_PROTOCOL_VERSION,
};
use buzz_core_pkg::kind::{
    KIND_COMPUTER_REGISTRATION, KIND_HOST_RPC_REQUEST, KIND_HOST_RPC_RESPONSE, KIND_MANAGED_AGENT,
    KIND_PRESENCE_UPDATE,
};
use buzz_core_pkg::pairing::qr::decode_qr;
use buzz_core_pkg::pairing::session::{PairingSession, SessionState};
use buzz_core_pkg::pairing::types::{AbortReason, PayloadType};
use buzz_ws_client_pkg::{NostrWsConnection, RelayMessage, WsClientError};
use futures_util::{SinkExt, StreamExt};
use nostr::nips::nip44;
use nostr::{EventBuilder, Kind, PublicKey, Tag};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::app_state::AppState;
use crate::relay::{query_relay, relay_ws_url_with_override, submit_event};

const HOST_PAIR_SUBSCRIPTION: &str = "buzz-host-pair";
const HOST_RPC_SUBSCRIPTION: &str = "buzz-host-rpc-response";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedComputer {
    pub computer_id: String,
    pub computer_name: String,
    pub agent_pubkey: String,
    pub platform: String,
    pub capabilities: Vec<String>,
    pub default_path: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPairingSasPayload {
    sas: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPairingCompletePayload {
    computer: PairedComputer,
}

#[derive(Debug, Clone, Serialize)]
struct HostPairingErrorPayload {
    message: String,
}

pub struct HostPairingHandle {
    session: Arc<tokio::sync::Mutex<Option<PairingSession>>>,
    generation: Arc<AtomicU64>,
    cancel: std::sync::Mutex<Option<CancellationToken>>,
    outbound_tx: std::sync::Mutex<Option<mpsc::Sender<String>>>,
}

impl HostPairingHandle {
    pub fn new() -> Self {
        Self {
            session: Arc::new(tokio::sync::Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            cancel: std::sync::Mutex::new(None),
            outbound_tx: std::sync::Mutex::new(None),
        }
    }

    fn clear_transport(&self) {
        *self
            .cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .outbound_tx
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
}

#[tauri::command]
pub async fn list_paired_computers(
    state: State<'_, AppState>,
) -> Result<Vec<PairedComputer>, String> {
    let owner = state.signing_keys()?.public_key().to_hex();
    let registrations = query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [KIND_COMPUTER_REGISTRATION],
            "authors": [owner],
            "limit": 500
        })],
    )
    .await?;
    let mut computers = registrations
        .into_iter()
        .filter_map(|event| {
            let registration: ComputerRegistration = serde_json::from_str(&event.content).ok()?;
            let d_tag = event.tags.iter().find_map(|tag| {
                let parts = tag.as_slice();
                (parts.first().is_some_and(|part| part == "d"))
                    .then(|| parts.get(1).cloned())
                    .flatten()
            })?;
            if d_tag != registration.computer_id
                || uuid::Uuid::parse_str(&registration.computer_id).is_err()
                || PublicKey::from_hex(&registration.agent_pubkey).is_err()
            {
                return None;
            }
            Some(PairedComputer {
                online: false,
                computer_id: registration.computer_id,
                computer_name: registration.computer_name,
                agent_pubkey: registration.agent_pubkey,
                platform: registration.platform,
                capabilities: registration.capabilities,
                default_path: registration.default_path,
            })
        })
        .collect::<Vec<_>>();
    let agent_pubkeys = computers
        .iter()
        .map(|computer| computer.agent_pubkey.clone())
        .collect::<Vec<_>>();
    let presence = if agent_pubkeys.is_empty() {
        Vec::new()
    } else {
        query_relay(
            &state,
            &[serde_json::json!({
                "kinds": [KIND_PRESENCE_UPDATE],
                "authors": agent_pubkeys,
            })],
        )
        .await
        .unwrap_or_default()
    };
    let online = presence
        .into_iter()
        .filter_map(|event| {
            matches!(event.content.trim(), "online" | "away").then(|| {
                event
                    .tags
                    .iter()
                    .find_map(|tag| {
                        let parts = tag.as_slice();
                        (parts.first().is_some_and(|part| part == "p"))
                            .then(|| parts.get(1).cloned())
                            .flatten()
                    })
                    .unwrap_or_else(|| event.pubkey.to_hex())
            })
        })
        .collect::<std::collections::HashSet<_>>();
    for computer in &mut computers {
        computer.online = online.contains(&computer.agent_pubkey);
    }
    computers.sort_by(|left, right| left.computer_name.cmp(&right.computer_name));
    Ok(computers)
}

#[tauri::command]
pub async fn start_host_pairing(
    app: AppHandle,
    pairing_code: String,
    pairing: State<'_, HostPairingHandle>,
) -> Result<(), String> {
    let qr = decode_qr(pairing_code.trim()).map_err(|error| error.to_string())?;
    let relay_url = qr
        .relays
        .first()
        .cloned()
        .ok_or_else(|| "pairing code has no Relay URL".to_string())?;
    let (session, offer) = PairingSession::new_target(&qr).map_err(|error| error.to_string())?;
    let generation = pairing
        .generation
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    if let Some(cancel) = pairing
        .cancel
        .lock()
        .map_err(|error| error.to_string())?
        .take()
    {
        cancel.cancel();
    }
    pairing.clear_transport();
    *pairing.session.lock().await = Some(session);

    let (outbound_tx, outbound_rx) = mpsc::channel(16);
    let cancel = CancellationToken::new();
    *pairing
        .outbound_tx
        .lock()
        .map_err(|error| error.to_string())? = Some(outbound_tx);
    *pairing.cancel.lock().map_err(|error| error.to_string())? = Some(cancel.clone());

    let session = Arc::clone(&pairing.session);
    let active_generation = Arc::clone(&pairing.generation);
    tauri::async_runtime::spawn(async move {
        let result = host_pairing_task(
            &app,
            &relay_url,
            session,
            active_generation.clone(),
            generation,
            cancel,
            outbound_rx,
            offer,
        )
        .await;
        if let Err(message) = result {
            if active_generation.load(Ordering::SeqCst) == generation {
                let _ = app.emit("host-pairing-error", HostPairingErrorPayload { message });
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn confirm_host_pairing_sas(pairing: State<'_, HostPairingHandle>) -> Result<(), String> {
    let mut guard = pairing.session.lock().await;
    guard
        .as_mut()
        .ok_or_else(|| "no active host pairing session".to_string())?
        .confirm_target_sas()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cancel_host_pairing(pairing: State<'_, HostPairingHandle>) -> Result<(), String> {
    pairing.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(cancel) = pairing
        .cancel
        .lock()
        .map_err(|error| error.to_string())?
        .take()
    {
        cancel.cancel();
    }
    let tx = {
        pairing
            .outbound_tx
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
    };
    if let Some(tx) = tx {
        let abort = {
            let mut guard = pairing.session.lock().await;
            guard
                .as_mut()
                .and_then(|session| session.abort(AbortReason::UserDenied).ok().flatten())
        };
        if let Some(event) = abort {
            let _ = tx.send(super::pairing::event_to_relay_json(&event)).await;
        }
    }
    pairing.clear_transport();
    *pairing.session.lock().await = None;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn host_pairing_task(
    app: &AppHandle,
    relay_url: &str,
    session: Arc<tokio::sync::Mutex<Option<PairingSession>>>,
    active_generation: Arc<AtomicU64>,
    generation: u64,
    cancel: CancellationToken,
    mut outbound_rx: mpsc::Receiver<String>,
    offer: nostr::Event,
) -> Result<(), String> {
    let (socket, _) = connect_async(relay_url)
        .await
        .map_err(|error| format!("Pairing Relay connection failed: {error}"))?;
    let (mut write, mut read) = socket.split();
    super::pairing::handle_nip42_auth(&mut read, &mut write, &session, relay_url).await?;
    let our_pubkey = session
        .lock()
        .await
        .as_ref()
        .ok_or_else(|| "pairing session ended".to_string())?
        .pubkey()
        .to_hex();
    write
        .send(Message::Text(
            serde_json::json!(["REQ", HOST_PAIR_SUBSCRIPTION, {
                "kinds": [buzz_core_pkg::kind::KIND_PAIRING],
                "#p": [our_pubkey]
            }])
            .to_string()
            .into(),
        ))
        .await
        .map_err(|error| format!("pairing subscription failed: {error}"))?;
    super::pairing::wait_for_eose(&mut read, HOST_PAIR_SUBSCRIPTION, Duration::from_secs(10))
        .await?;
    write
        .send(Message::Text(
            super::pairing::event_to_relay_json(&offer).into(),
        ))
        .await
        .map_err(|error| format!("pairing offer failed: {error}"))?;

    let deadline = tokio::time::sleep(Duration::from_secs(130));
    tokio::pin!(deadline);
    let retry_pending = tokio::time::interval(Duration::from_millis(100));
    tokio::pin!(retry_pending);
    let mut pending_payload: Option<nostr::Event> = None;
    let mut completed = false;

    loop {
        if active_generation.load(Ordering::SeqCst) != generation || completed {
            break;
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = &mut deadline => return Err("Host pairing timed out".into()),
            _ = retry_pending.tick(), if pending_payload.is_some() => {
                let ready = session.lock().await.as_ref().is_some_and(|value| value.state() == SessionState::Transferring);
                if ready {
                    let event = pending_payload.take().expect("pending payload checked");
                    complete_host_pairing(app, &session, &mut write, &event).await?;
                    completed = true;
                }
            }
            Some(outbound) = outbound_rx.recv() => {
                write.send(Message::Text(outbound.into())).await.map_err(|error| error.to_string())?;
            }
            message = read.next() => {
                let Some(message) = message else { return Err("Pairing Relay closed".into()) };
                let message = message.map_err(|error| format!("Pairing Relay read failed: {error}"))?;
                let Message::Text(text) = message else { continue };
                let Some(event) = super::pairing::parse_relay_event(text.as_str(), HOST_PAIR_SUBSCRIPTION) else { continue };
                let mut guard = session.lock().await;
                let Some(active) = guard.as_mut() else { break };
                if let Ok(sas) = active.handle_sas_confirm(&event) {
                    let _ = app.emit("host-pairing-sas-received", HostPairingSasPayload { sas });
                    continue;
                }
                if active.state() == SessionState::Transferring {
                    drop(guard);
                    complete_host_pairing(app, &session, &mut write, &event).await?;
                    completed = true;
                } else if active.state() == SessionState::AwaitingConfirmation {
                    pending_payload = Some(event);
                }
            }
        }
    }
    *session.lock().await = None;
    Ok(())
}

async fn complete_host_pairing<W>(
    app: &AppHandle,
    session: &Arc<tokio::sync::Mutex<Option<PairingSession>>>,
    write: &mut W,
    payload_event: &nostr::Event,
) -> Result<(), String>
where
    W: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let (offer, source_pubkey) = {
        let mut guard = session.lock().await;
        let active = guard
            .as_mut()
            .ok_or_else(|| "pairing session ended".to_string())?;
        let (payload_type, payload) = active
            .handle_payload(payload_event)
            .map_err(|error| error.to_string())?;
        if payload_type != PayloadType::Custom {
            return Err("Host sent an unsupported pairing payload".into());
        }
        let offer: HostPairingOffer =
            serde_json::from_str(&payload).map_err(|_| "Host pairing payload is invalid")?;
        let source = active
            .peer_pubkey()
            .ok_or_else(|| "Host pairing source is missing".to_string())?;
        (offer, source)
    };
    validate_host_offer(&offer, &source_pubkey)?;

    let state = app.state::<AppState>();
    let owner_keys = state.signing_keys()?;
    let auth_tag = buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_keys, &source_pubkey, "")
        .map_err(|error| format!("Could not authorize host: {error}"))?;
    let config = HostPairingConfig {
        version: HOST_PROTOCOL_VERSION,
        relay_url: relay_ws_url_with_override(&state),
        owner_pubkey: owner_keys.public_key().to_hex(),
        auth_tag,
    };
    let (response_event, complete_event) = {
        let mut guard = session.lock().await;
        let active = guard
            .as_mut()
            .ok_or_else(|| "pairing session ended".to_string())?;
        let response = active
            .send_response_payload(
                PayloadType::Custom,
                Zeroizing::new(
                    serde_json::to_string(&config)
                        .map_err(|error| format!("Could not encode host configuration: {error}"))?,
                ),
            )
            .map_err(|error| error.to_string())?;
        let complete = active.send_complete().map_err(|error| error.to_string())?;
        (response, complete)
    };
    write
        .send(Message::Text(
            super::pairing::event_to_relay_json(&response_event).into(),
        ))
        .await
        .map_err(|error| format!("Could not send host configuration: {error}"))?;

    publish_computer_registration(&state, &offer).await?;
    write
        .send(Message::Text(
            super::pairing::event_to_relay_json(&complete_event).into(),
        ))
        .await
        .map_err(|error| format!("Could not finish host pairing: {error}"))?;
    let computer = paired_computer_from_offer(offer, false);
    app.emit(
        "host-pairing-complete",
        HostPairingCompletePayload { computer },
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_host_offer(offer: &HostPairingOffer, source: &PublicKey) -> Result<(), String> {
    if offer.version != HOST_PROTOCOL_VERSION {
        return Err("This host requires a newer version of Buzz".into());
    }
    if uuid::Uuid::parse_str(&offer.computer_id).is_err() {
        return Err("Host computer ID is invalid".into());
    }
    if offer.host_pubkey != source.to_hex() {
        return Err("Host identity does not match the pairing code".into());
    }
    if !std::path::Path::new(&offer.default_path).is_absolute() {
        return Err("Host default path must be absolute".into());
    }
    if offer.computer_name.trim().is_empty() || offer.computer_name.len() > 128 {
        return Err("Host name is invalid".into());
    }
    Ok(())
}

async fn publish_computer_registration(
    state: &AppState,
    offer: &HostPairingOffer,
) -> Result<(), String> {
    let registration = ComputerRegistration {
        computer_id: offer.computer_id.clone(),
        computer_name: offer.computer_name.clone(),
        agent_pubkey: offer.host_pubkey.clone(),
        platform: offer.platform.clone(),
        capabilities: offer.capabilities.clone(),
        default_path: offer.default_path.clone(),
    };
    let registration_content = serde_json::to_string(&registration)
        .map_err(|error| format!("Could not encode computer registration: {error}"))?;
    submit_event(
        EventBuilder::new(
            Kind::Custom(KIND_COMPUTER_REGISTRATION as u16),
            registration_content,
        )
        .tags([Tag::parse(["d", offer.computer_id.as_str()])
            .map_err(|error| format!("Invalid computer ID tag: {error}"))?]),
        state,
    )
    .await?;

    let binding = serde_json::json!({
        "name": offer.computer_name,
        "computer_id": offer.computer_id,
        "parallelism": 1,
        "respond_to": "owner-only"
    });
    submit_event(
        EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), binding.to_string())
            .tags([Tag::parse(["d", offer.host_pubkey.as_str()])
                .map_err(|error| format!("Invalid host key tag: {error}"))?]),
        state,
    )
    .await?;
    Ok(())
}

fn paired_computer_from_offer(offer: HostPairingOffer, online: bool) -> PairedComputer {
    PairedComputer {
        computer_id: offer.computer_id,
        computer_name: offer.computer_name,
        agent_pubkey: offer.host_pubkey,
        platform: offer.platform,
        capabilities: offer.capabilities,
        default_path: offer.default_path,
        online,
    }
}

#[tauri::command]
pub async fn list_remote_host_directory(
    state: State<'_, AppState>,
    agent_pubkey: String,
    path: String,
) -> Result<HostDirectoryListing, String> {
    let host_pubkey = PublicKey::from_hex(agent_pubkey.trim())
        .map_err(|_| "Paired computer identity is invalid".to_string())?;
    let registered = list_paired_computers(state.clone()).await?;
    if !registered
        .iter()
        .any(|computer| computer.agent_pubkey == host_pubkey.to_hex())
    {
        return Err("Computer is not paired with this identity".into());
    }
    let owner_keys = state.signing_keys()?;
    let owner_pubkey = owner_keys.public_key();
    let relay_url = relay_ws_url_with_override(&state);
    let mut connection = NostrWsConnection::connect_authenticated(&relay_url, &owner_keys, None)
        .await
        .map_err(|error| format!("Could not connect to computer: {error}"))?;
    connection
        .send_raw(&serde_json::json!(["REQ", HOST_RPC_SUBSCRIPTION, {
            "kinds": [KIND_HOST_RPC_RESPONSE],
            "authors": [host_pubkey.to_hex()],
            "#p": [owner_pubkey.to_hex()],
            "limit": 0
        }]))
        .await
        .map_err(|error| format!("Could not listen for computer response: {error}"))?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let request = HostRpcRequest {
        version: HOST_PROTOCOL_VERSION,
        request_id: request_id.clone(),
        action: HostRpcAction::ListDirectory { path },
    };
    let plaintext = serde_json::to_string(&request)
        .map_err(|error| format!("Could not encode folder request: {error}"))?;
    let ciphertext = nip44::encrypt(
        owner_keys.secret_key(),
        &host_pubkey,
        plaintext,
        nip44::Version::V2,
    )
    .map_err(|error| format!("Could not encrypt folder request: {error}"))?;
    let request_event = EventBuilder::new(Kind::Custom(KIND_HOST_RPC_REQUEST as u16), ciphertext)
        .tags([Tag::public_key(host_pubkey)])
        .sign_with_keys(&owner_keys)
        .map_err(|error| format!("Could not sign folder request: {error}"))?;
    let request_event_id = request_event.id;
    let accepted = connection
        .send_event(request_event)
        .await
        .map_err(|error| format!("Could not send folder request: {error}"))?;
    if !accepted.accepted {
        return Err(format!(
            "Relay rejected folder request: {}",
            accepted.message
        ));
    }

    let response = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match connection.next_event(Duration::from_secs(20)).await {
                Ok(RelayMessage::Event {
                    subscription_id,
                    event,
                }) if subscription_id == HOST_RPC_SUBSCRIPTION
                    && event.pubkey == host_pubkey
                    && event.tags.iter().any(|tag| {
                        let parts = tag.as_slice();
                        parts.first().is_some_and(|part| part == "e")
                            && parts
                                .get(1)
                                .is_some_and(|value| value == &request_event_id.to_hex())
                    }) =>
                {
                    let plaintext =
                        nip44::decrypt(owner_keys.secret_key(), &host_pubkey, &event.content)
                            .map_err(|error| {
                                format!("Could not decrypt computer response: {error}")
                            })?;
                    let response: HostRpcResponse = serde_json::from_str(&plaintext)
                        .map_err(|_| "Computer returned an invalid response".to_string())?;
                    if response.request_id != request_id {
                        continue;
                    }
                    if let Some(error) = response.error {
                        return Err(error);
                    }
                    return response
                        .directory
                        .ok_or_else(|| "Computer returned no folder listing".to_string());
                }
                Ok(_) => continue,
                Err(WsClientError::Timeout) => {
                    return Err("Computer did not respond. Make sure buzz-host is running.".into())
                }
                Err(error) => return Err(format!("Computer connection failed: {error}")),
            }
        }
    })
    .await
    .map_err(|_| "Computer did not respond. Make sure buzz-host is running.".to_string())??;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_offer_must_match_pairing_source() {
        let source = nostr::Keys::generate();
        let other = nostr::Keys::generate();
        let offer = HostPairingOffer {
            version: HOST_PROTOCOL_VERSION,
            computer_id: uuid::Uuid::new_v4().to_string(),
            computer_name: "vps".into(),
            host_pubkey: other.public_key().to_hex(),
            platform: "linux".into(),
            capabilities: vec!["files".into()],
            default_path: "/srv".into(),
        };
        assert!(validate_host_offer(&offer, &source.public_key()).is_err());
    }
}
