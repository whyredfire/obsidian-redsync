//! Accepting changes and reading the change log.

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};

use crate::db::{now_ms, valid_blob_id};
use crate::protocol::{Change, CommitOp, CommitResult, FileEntry, Listing};

const MAX_OPS: usize = 1000;
const MAX_PATH_ID: usize = 4096;
const MAX_META: usize = 64 * 1024;

/// Applies a commit in one transaction. Returns the result of each operation and the accepted changes,
/// which the caller sends to the vault's devices. A repeated request ID returns the stored results.
pub fn commit(
    connection: &mut Connection,
    vault_id: &str,
    device_id: &str,
    req: &str,
    ops: &[CommitOp],
) -> Result<(Vec<CommitResult>, Vec<Change>)> {
    if req.is_empty() || req.len() > 128 {
        bail!("invalid request ID");
    }
    if ops.len() > MAX_OPS {
        bail!("more than {MAX_OPS} operations in one commit");
    }
    for op in ops {
        if op.path_id.is_empty() || op.path_id.len() > MAX_PATH_ID || op.meta.len() > MAX_META {
            bail!("invalid path ID or meta");
        }
        if op.blob_id.as_deref().is_some_and(|id| !valid_blob_id(id)) {
            bail!("invalid blob ID");
        }
    }

    let tx = connection.transaction()?;
    let stored: Option<String> = tx
        .query_row("SELECT results FROM requests WHERE device_id = ?1 AND req = ?2", params![device_id, req], |r| r.get(0))
        .optional()?;
    if let Some(stored) = stored {
        return Ok((serde_json::from_str(&stored)?, Vec::new()));
    }

    let now = now_ms();
    let mut head: i64 = tx.query_row("SELECT head_seq FROM vaults WHERE id = ?1", [vault_id], |r| r.get(0))?;
    let mut results = Vec::with_capacity(ops.len());
    let mut changes = Vec::new();

    for op in ops {
        let current: Option<(i64, i64, Option<String>, String)> = tx
            .query_row(
                "SELECT version, seq, blob_id, meta FROM files WHERE vault_id = ?1 AND path_id = ?2",
                params![vault_id, op.path_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let (version, seq, blob_id, meta) = current.clone().unwrap_or((0, head, None, String::new()));

        // Already in the requested state: a retry, or two devices making the same change.
        if blob_id == op.blob_id {
            results.push(CommitResult::Ok { version, seq });
            continue;
        }
        if op.base_version != version {
            results.push(CommitResult::Conflict { version, blob_id, meta });
            continue;
        }
        if let Some(blob) = &op.blob_id {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM blobs WHERE vault_id = ?1 AND blob_id = ?2)",
                params![vault_id, blob],
                |r| r.get(0),
            )?;
            if !exists {
                results.push(CommitResult::MissingBlob);
                continue;
            }
        }

        head += 1;
        let version = version + 1;
        tx.execute(
            "INSERT INTO versions(vault_id, seq, path_id, version, blob_id, meta, device_id, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![vault_id, head, op.path_id, version, op.blob_id, op.meta, device_id, now],
        )?;
        tx.execute(
            "INSERT INTO files(vault_id, path_id, version, seq, blob_id, meta, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(vault_id, path_id) DO UPDATE SET
               version = excluded.version, seq = excluded.seq, blob_id = excluded.blob_id,
               meta = excluded.meta, updated_at = excluded.updated_at",
            params![vault_id, op.path_id, version, head, op.blob_id, op.meta, now],
        )?;
        if let Some(released) = &blob_id {
            tx.execute(
                "UPDATE blobs SET released_at = ?1 WHERE vault_id = ?2 AND blob_id = ?3",
                params![now, vault_id, released],
            )?;
        }
        results.push(CommitResult::Ok { version, seq: head });
        changes.push(Change {
            seq: head,
            path_id: op.path_id.clone(),
            version,
            blob_id: op.blob_id.clone(),
            meta: op.meta.clone(),
            device_id: device_id.to_owned(),
        });
    }

    tx.execute("UPDATE vaults SET head_seq = ?1 WHERE id = ?2", params![head, vault_id])?;
    tx.execute(
        "INSERT INTO requests(device_id, req, results, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![device_id, req, serde_json::to_string(&results)?, now],
    )?;
    tx.commit()?;
    Ok((results, changes))
}

/// Up to `limit` changes after `since`, oldest first.
pub fn changes_since(connection: &Connection, vault_id: &str, since: i64, limit: i64) -> Result<Vec<Change>> {
    let mut statement = connection.prepare_cached(
        "SELECT seq, path_id, version, blob_id, meta, device_id FROM versions
         WHERE vault_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
    )?;
    let rows = statement.query_map(params![vault_id, since, limit], |r| {
        Ok(Change { seq: r.get(0)?, path_id: r.get(1)?, version: r.get(2)?, blob_id: r.get(3)?, meta: r.get(4)?, device_id: r.get(5)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The vault's epoch and head, and whether a device at (`epoch`, `since`) must reconcile from the
/// listing instead of catching up from the change log.
pub fn catch_up_state(connection: &Connection, vault_id: &str, epoch: Option<&str>, since: i64) -> Result<(String, i64, bool)> {
    let (vault_epoch, head): (String, i64) =
        connection.query_row("SELECT epoch, head_seq FROM vaults WHERE id = ?1", [vault_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let oldest: Option<i64> = connection.query_row("SELECT MIN(seq) FROM versions WHERE vault_id = ?1", [vault_id], |r| r.get(0))?;
    let other_history = epoch.is_some_and(|e| e != vault_epoch);
    let ahead = since > head || since < 0;
    let log_pruned = since < head && oldest.is_none_or(|oldest| oldest > since + 1);
    Ok((vault_epoch, head, other_history || ahead || log_pruned))
}

pub fn listing(connection: &Connection, vault_id: &str) -> Result<Listing> {
    let (epoch, head_seq): (String, i64) =
        connection.query_row("SELECT epoch, head_seq FROM vaults WHERE id = ?1", [vault_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut statement =
        connection.prepare_cached("SELECT path_id, version, seq, blob_id, meta FROM files WHERE vault_id = ?1 ORDER BY path_id")?;
    let files = statement
        .query_map([vault_id], |r| {
            Ok(FileEntry { path_id: r.get(0)?, version: r.get(1)?, seq: r.get(2)?, blob_id: r.get(3)?, meta: r.get(4)? })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Listing { epoch, head_seq, files })
}
