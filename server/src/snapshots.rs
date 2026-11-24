//! Snapshots in R2 every few hours, and rebuilding the database from them.

use std::collections::HashSet;

use anyhow::{Context, Result, bail};
use futures_util::TryStreamExt;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::config::{Config, LOG_TTL_MS};
use crate::db::{self, now_ms, random_id};
use crate::protocol::FileEntry;
use crate::sync;

/// Everything needed to rebuild one vault: the files, and the owner and devices so they keep working.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub format: u32,
    pub created_at: i64,
    pub vault: SnapshotVault,
    pub user: SnapshotUser,
    pub devices: Vec<SnapshotDevice>,
    pub files: Vec<FileEntry>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotVault {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub created_at: i64,
    pub seq: i64,
    pub encrypted: bool,
    pub kdf_salt: Option<String>,
    pub key_check: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotUser {
    pub id: String,
    pub name: String,
    pub quota_bytes: i64,
    pub created_at: i64,
    pub removed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDevice {
    pub id: String,
    pub name: String,
    /// Hex SHA-256 of the token; the token itself is never stored.
    pub token_hash: String,
    pub created_at: i64,
    pub last_seen: Option<i64>,
    pub revoked: bool,
}

fn snapshot_prefix(vault: &str) -> ObjectPath {
    ObjectPath::from(format!("vaults/{vault}/snapshots"))
}

/// Writes a snapshot of every vault that changed since its last one; returns how many were written.
pub async fn run(state: &AppState) -> Result<usize> {
    let due: Vec<String> = state
        .db
        .call(|c| {
            c.prepare(
                "SELECT v.id FROM vaults v JOIN users u ON u.id = v.user_id
                 WHERE v.head_seq > v.snapshot_seq AND u.removed_at IS NULL",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    for vault in &due {
        let now = now_ms();
        let id = vault.clone();
        let snapshot = state.db.call(move |c| read_snapshot(c, &id, now)).await?;
        let key = ObjectPath::from(format!("vaults/{vault}/snapshots/{now:013}.json"));
        state.store.put(&key, serde_json::to_vec(&snapshot)?.into()).await?;
        let (id, seq) = (vault.clone(), snapshot.vault.seq);
        state.db.call(move |c| c.execute("UPDATE vaults SET snapshot_seq = ?1 WHERE id = ?2", params![seq, id])).await?;
        prune(state.store.as_ref(), vault, now).await?;
    }
    Ok(due.len())
}

fn read_snapshot(c: &Connection, vault_id: &str, now: i64) -> Result<Snapshot> {
    let listing = sync::listing(c, vault_id)?;
    let vault = c.query_row(
        "SELECT id, user_id, name, created_at, encrypted, kdf_salt, key_check FROM vaults WHERE id = ?1",
        [vault_id],
        |r| {
            Ok(SnapshotVault {
                id: r.get(0)?,
                user_id: r.get(1)?,
                name: r.get(2)?,
                created_at: r.get(3)?,
                seq: listing.head_seq,
                encrypted: r.get(4)?,
                kdf_salt: r.get(5)?,
                key_check: r.get(6)?,
            })
        },
    )?;
    let user = c.query_row("SELECT id, name, quota_bytes, created_at, removed_at FROM users WHERE id = ?1", [&vault.user_id], |r| {
        Ok(SnapshotUser { id: r.get(0)?, name: r.get(1)?, quota_bytes: r.get(2)?, created_at: r.get(3)?, removed_at: r.get(4)? })
    })?;
    let devices = c
        .prepare("SELECT id, name, token_hash, created_at, last_seen, revoked FROM devices WHERE vault_id = ?1")?
        .query_map([vault_id], |r| {
            let hash: Vec<u8> = r.get(2)?;
            Ok(SnapshotDevice {
                id: r.get(0)?,
                name: r.get(1)?,
                token_hash: hash.iter().map(|b| format!("{b:02x}")).collect(),
                created_at: r.get(3)?,
                last_seen: r.get(4)?,
                revoked: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Snapshot { format: 1, created_at: now, vault, user, devices, files: listing.files })
}

/// Which snapshots to keep: those no older than the change log, as the blobs of older ones may be deleted, and
/// always the newest one (its blobs are all current).
pub fn snapshots_to_keep(created: &[i64], now: i64) -> HashSet<i64> {
    let mut keep: HashSet<i64> = created.iter().copied().filter(|t| now - t <= LOG_TTL_MS).collect();
    keep.extend(created.iter().max());
    keep
}

async fn prune(store: &dyn ObjectStore, vault: &str, now: i64) -> Result<()> {
    let objects: Vec<_> = store.list(Some(&snapshot_prefix(vault))).try_collect().await?;
    let created: Vec<(i64, ObjectPath)> = objects
        .into_iter()
        .filter_map(|object| {
            let stem = object.location.filename()?.strip_suffix(".json")?.parse().ok()?;
            Some((stem, object.location))
        })
        .collect();
    let keep = snapshots_to_keep(&created.iter().map(|(t, _)| *t).collect::<Vec<_>>(), now);
    for (t, location) in created {
        if !keep.contains(&t) {
            store.delete(&location).await?;
        }
    }
    Ok(())
}

/// Rebuilds a missing database from the newest snapshot of every vault in the object store. Each vault gets
/// a new epoch, so its devices compare everything with the server and upload what the snapshot lacks.
pub async fn restore(config: &Config, store: &dyn ObjectStore) -> Result<String> {
    let path = config.db_path();
    if path.exists() {
        bail!("{} already exists; move it away to restore from snapshots", path.display());
    }
    let mut connection = db::open(&path)?;
    let vaults = store.list_with_delimiter(Some(&ObjectPath::from("vaults"))).await?;
    let mut report = Vec::new();
    for prefix in vaults.common_prefixes {
        let vault_id = prefix.filename().context("vault prefix without a name")?.to_owned();
        let snapshots: Vec<_> = store.list(Some(&snapshot_prefix(&vault_id))).try_collect().await?;
        let Some(newest) = snapshots.into_iter().max_by(|a, b| a.location.as_ref().cmp(b.location.as_ref())) else {
            report.push(format!("vault {vault_id}: no snapshot, skipped"));
            continue;
        };
        let snapshot: Snapshot = serde_json::from_slice(&store.get(&newest.location).await?.bytes().await?)?;
        let blobs: Vec<_> = store.list(Some(&ObjectPath::from(format!("vaults/{vault_id}/blobs")))).try_collect().await?;
        let tx = connection.transaction()?;
        let now = now_ms();
        let user = &snapshot.user;
        tx.execute(
            "INSERT OR IGNORE INTO users(id, name, quota_bytes, created_at, removed_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![user.id, user.name, user.quota_bytes, user.created_at, user.removed_at],
        )?;
        let vault = &snapshot.vault;
        tx.execute(
            "INSERT INTO vaults(id, user_id, name, created_at, epoch, head_seq, snapshot_seq, encrypted, kdf_salt, key_check)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9)",
            params![vault.id, vault.user_id, vault.name, vault.created_at, random_id(), vault.seq, vault.encrypted, vault.kdf_salt, vault.key_check],
        )?;
        for device in &snapshot.devices {
            let hash: Vec<u8> = (0..device.token_hash.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&device.token_hash[i..i + 2], 16))
                .collect::<Result<_, _>>()?;
            tx.execute(
                "INSERT INTO devices(id, vault_id, name, token_hash, created_at, last_seen, revoked) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![device.id, vault.id, device.name, hash, device.created_at, device.last_seen, device.revoked],
            )?;
        }
        for file in &snapshot.files {
            tx.execute(
                "INSERT INTO files(vault_id, path_id, version, seq, blob_id, meta, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![vault.id, file.path_id, file.version, file.seq, file.blob_id, file.meta, now],
            )?;
        }
        for blob in &blobs {
            tx.execute(
                "INSERT INTO blobs(vault_id, blob_id, size, created_at, in_r2, cached, last_access, released_at) VALUES(?1, ?2, ?3, ?4, 1, 0, ?4, ?4)",
                params![vault.id, blob.location.filename(), blob.size as i64, now],
            )?;
        }
        tx.commit()?;
        report.push(format!(
            "vault {} ({}): {} files, {} blobs, from {}",
            vault.name,
            vault.id,
            snapshot.files.len(),
            blobs.len(),
            newest.location
        ));
    }
    Ok(report.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_are_kept_as_long_as_the_change_log() {
        let day = crate::config::DAY_MS;
        let now = 1000 * day;
        // Every 6 hours for 60 days.
        let created: Vec<i64> = (0..60 * 4).map(|i| now - i * day / 4).collect();
        let keep = snapshots_to_keep(&created, now);
        assert_eq!(keep.len(), 30 * 4 + 1);
        assert!(keep.iter().all(|t| now - t <= LOG_TTL_MS));
        assert!(snapshots_to_keep(&[now - 500 * day], now).contains(&(now - 500 * day)));
    }
}
