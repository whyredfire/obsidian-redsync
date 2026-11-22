//! Messages between devices and the server. `cargo test` exports them to plugin/src/protocol/.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
    Changes {
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
