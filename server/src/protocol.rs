//! Messages between devices and the server. `cargo test` exports them to plugin/src/protocol/.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 2: folders are entries of their own, their path ending in "/"; devices speaking 1 would take them for files.
/// 3: the change log skips seqs once history is thinned, so Changes says which seq it follows.
pub const PROTOCOL_VERSION: u32 = 3;

/// A message from a device over the WebSocket.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ClientMessage {
    Hello {
        vault: String,
        token: String,
        /// None on the first connection of a device.
        epoch: Option<String>,
        #[ts(type = "number")]
        since: i64,
        protocol: u32,
    },
    Commit {
        req: String,
        ops: Vec<CommitOp>,
    },
    /// Browsers cannot see WebSocket pings, so devices check the connection with this; answered by Pong.
    Ping,
}

/// A message from the server over the WebSocket.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ServerMessage {
    Welcome {
        epoch: String,
        #[ts(type = "number")]
        head_seq: i64,
        device_id: String,
    },
    /// Every change after `after` up to `up_to`; the seqs in between may skip.
    Changes {
        #[ts(type = "number")]
        after: i64,
        items: Vec<Change>,
        #[ts(type = "number")]
        up_to: i64,
        more: bool,
    },
    /// The device must reconcile against the full listing.
    Reset { epoch: String },
    Result {
        req: String,
        results: Vec<CommitResult>,
    },
    Pong,
}

/// One accepted change.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Change {
    #[ts(type = "number")]
    pub seq: i64,
    pub path_id: String,
    #[ts(type = "number")]
    pub version: i64,
    /// None for a deletion.
    pub blob_id: Option<String>,
    /// Base64; encrypted when the vault is.
    pub meta: String,
    pub device_id: String,
}

/// One proposed change to one path.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommitOp {
    pub path_id: String,
    /// 0 for a new file.
    #[ts(type = "number")]
    pub base_version: i64,
    /// None to delete.
    pub blob_id: Option<String>,
    pub meta: String,
}

/// The outcome of one CommitOp.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum CommitResult {
    Ok {
        #[ts(type = "number")]
        version: i64,
        #[ts(type = "number")]
        seq: i64,
    },
    /// The device was not on the latest version; this is the current one.
    Conflict {
        #[ts(type = "number")]
        version: i64,
        blob_id: Option<String>,
        meta: String,
    },
    MissingBlob,
}

// HTTP request and response bodies.

/// POST /v1/vaults: creates a vault with an invite code from the server owner.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateVaultRequest {
    pub invite: String,
    pub name: String,
    pub device_name: String,
    pub encrypted: bool,
    pub kdf_salt: Option<String>,
    pub key_check: Option<String>,
}

/// POST /v1/vaults/{vault}/devices: joins with an enrolment code from a device of the vault.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JoinRequest {
    pub code: String,
    pub device_name: String,
}

/// The answer to creating or joining a vault.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Joined {
    pub vault: VaultInfo,
    pub device_id: String,
    pub token: String,
    /// What the inviting device left for the new one (the encrypted passphrase), handed over once.
    pub sealed: Option<String>,
}

/// POST /v1/vaults/{vault}/enrolments
#[derive(Serialize, Deserialize, TS, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateEnrolment {
    /// Encrypted with a key that only the setup link holds; the server cannot read it.
    pub sealed: Option<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultInfo {
    pub id: String,
    pub name: String,
    pub epoch: String,
    pub encrypted: bool,
    pub kdf_salt: Option<String>,
    pub key_check: Option<String>,
    /// Storage used by all vaults of the owner, history included.
    #[ts(type = "number")]
    pub used_bytes: i64,
    #[ts(type = "number")]
    pub quota_bytes: i64,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Enrolment {
    pub code: String,
    #[ts(type = "number")]
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub last_seen: Option<i64>,
    pub this_device: bool,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RenameDevice {
    pub name: String,
}

/// The current state of one path.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileEntry {
    pub path_id: String,
    #[ts(type = "number")]
    pub version: i64,
    #[ts(type = "number")]
    pub seq: i64,
    /// None for a deletion.
    pub blob_id: Option<String>,
    pub meta: String,
}

/// GET /v1/vaults/{vault}/files: every path, deletions included, as of `headSeq`.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Listing {
    pub epoch: String,
    #[ts(type = "number")]
    pub head_seq: i64,
    pub files: Vec<FileEntry>,
}

/// GET /v1/vaults/{vault}/versions?path=…: history of one path, newest first.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VersionEntry {
    #[ts(type = "number")]
    pub version: i64,
    #[ts(type = "number")]
    pub seq: i64,
    pub blob_id: Option<String>,
    pub meta: String,
    pub device_id: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// The body of every HTTP error.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct ApiErrorBody {
    /// Machine-readable: badRequest, unauthorized, invalidCode, notFound, tooLarge, quotaExceeded, internal.
    pub error: String,
    pub message: String,
}
