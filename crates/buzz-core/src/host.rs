//! Shared wire types for headless Buzz computers.
//!
//! Pairing uses NIP-AB `custom` payloads. Runtime filesystem discovery uses
//! NIP-44 encrypted, p-gated ephemeral events so paths never appear in public
//! event content or tags.

use serde::{Deserialize, Serialize};

/// Current headless-host bootstrap protocol version.
pub const HOST_PROTOCOL_VERSION: u32 = 1;

/// Descriptor sent by a headless host to the owner's Desktop during pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPairingOffer {
    /// Wire protocol version.
    pub version: u32,
    /// Stable, non-secret installation UUID.
    pub computer_id: String,
    /// Human-readable hostname.
    pub computer_name: String,
    /// Persistent Nostr public key used by the host and its ACP harness.
    pub host_pubkey: String,
    /// Host operating-system identifier.
    pub platform: String,
    /// Capabilities available on the host.
    pub capabilities: Vec<String>,
    /// Initial directory shown by the remote folder browser.
    pub default_path: String,
}

/// Owner configuration returned to a host over the paired encrypted session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPairingConfig {
    /// Wire protocol version.
    pub version: u32,
    /// Community Relay WebSocket URL.
    pub relay_url: String,
    /// Owner public key.
    pub owner_pubkey: String,
    /// NIP-OA attestation signed by the owner for `host_pubkey`.
    pub auth_tag: String,
}

/// Public owner-authored projection of a paired computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerRegistration {
    /// Stable host installation UUID.
    pub computer_id: String,
    /// Human-readable hostname.
    pub computer_name: String,
    /// Nostr public key used by the host's agent.
    pub agent_pubkey: String,
    /// Host operating-system identifier.
    pub platform: String,
    /// Public capability labels.
    pub capabilities: Vec<String>,
    /// Initial path for the encrypted folder browser.
    pub default_path: String,
}

/// Encrypted request sent by an owner to a paired host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRpcRequest {
    /// Wire protocol version.
    pub version: u32,
    /// Caller-generated UUID echoed by the response.
    pub request_id: String,
    /// Requested host operation.
    pub action: HostRpcAction,
}

/// Operations supported by the headless host RPC surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostRpcAction {
    /// List immediate child directories of an absolute path.
    ListDirectory {
        /// Absolute path. Empty means the host's configured default path.
        path: String,
    },
}

/// Encrypted response returned by a paired host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRpcResponse {
    /// Wire protocol version.
    pub version: u32,
    /// Request UUID.
    pub request_id: String,
    /// Successful directory result, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<HostDirectoryListing>,
    /// Safe human-readable failure message, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One directory returned by the remote folder browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDirectoryEntry {
    /// File name only.
    pub name: String,
    /// Canonical absolute path.
    pub path: String,
}

/// Canonical directory state returned by a headless host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDirectoryListing {
    /// Canonical absolute path being viewed.
    pub path: String,
    /// Last path component used as the project default name.
    pub name: String,
    /// Canonical parent path, absent at a filesystem root.
    pub parent: Option<String>,
    /// Whether this directory contains `.git`.
    pub git_repository: bool,
    /// Immediate child directories.
    pub directories: Vec<HostDirectoryEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_request_uses_stable_tagged_shape() {
        let request = HostRpcRequest {
            version: HOST_PROTOCOL_VERSION,
            request_id: "request".into(),
            action: HostRpcAction::ListDirectory {
                path: "/srv".into(),
            },
        };
        let value = serde_json::to_value(request).expect("serialize");
        assert_eq!(value["action"]["type"], "list-directory");
        assert_eq!(value["action"]["path"], "/srv");
    }
}
