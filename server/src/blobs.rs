//! The blob cache on disk, the R2 uploader, and the hourly maintenance.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use futures_util::{StreamExt, TryStreamExt};
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStoreExt, PutPayload};
use rusqlite::params;
use tokio::io::AsyncWriteExt;

use crate::AppState;
use crate::api::{ApiError, ApiResult};
use crate::config::{
    HISTORY_TTL_MS, LARGE_TTL_MS, LOG_TTL_MS, PIN_MAX_BYTES, REMOVED_USER_GRACE_MS, REQUEST_TTL_MS, TOMBSTONE_TTL_MS,
};
use crate::db::{now_ms, random_id};

pub fn cache_path(state: &AppState, vault: &str, blob: &str) -> PathBuf {
    state.config.data_dir.join("blobs").join(vault).join(&blob[..blob.len().min(2)]).join(blob)
}

pub fn object_path(vault: &str, blob: &str) -> ObjectPath {
    ObjectPath::from(format!("vaults/{vault}/blobs/{blob}"))
}

pub async fn exists(state: &AppState, vault: &str, blob: &str) -> Result<bool> {
    let (vault, blob) = (vault.to_owned(), blob.to_owned());
    let found = state
        .db
        .call(move |c| {
            c.query_row("SELECT EXISTS(SELECT 1 FROM blobs WHERE vault_id = ?1 AND blob_id = ?2)", params![vault, blob], |r| r.get(0))
        })
        .await?;
    Ok(found)
}

/// Writes `bytes` to `target` through a temporary file, so a crash never leaves half a blob.
async fn write_atomically(
    state: &AppState,
    target: &PathBuf,
    mut chunks: impl futures_util::Stream<Item = ApiResult<bytes::Bytes>> + Unpin,
    limit: i64,
) -> ApiResult<i64> {
    let temporary = state.config.data_dir.join("tmp").join(random_id());
    let result = async {
        tokio::fs::create_dir_all(temporary.parent().unwrap()).await?;
        let mut file = tokio::fs::File::create(&temporary).await?;
        let mut size: i64 = 0;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            size += chunk.len() as i64;
            if size > limit {
                return Err(ApiError::TooLarge);
            }
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        tokio::fs::create_dir_all(target.parent().unwrap()).await?;
        tokio::fs::rename(&temporary, target).await?;
        Ok(size)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

/// Streams an upload into the cache and returns its size.
pub async fn receive(state: &AppState, vault: &str, blob: &str, body: Body) -> ApiResult<i64> {
    let chunks = body.into_data_stream().map_err(|error| ApiError::Internal(error.into()));
    write_atomically(state, &cache_path(state, vault, blob), chunks, state.config.max_file_bytes).await
}

/// Removes a received blob that was refused, unless another upload of it was accepted meanwhile.
pub async fn discard(state: &AppState, vault: &str, blob: &str) {
    if let Ok(false) = exists(state, vault, blob).await {
        let _ = tokio::fs::remove_file(cache_path(state, vault, blob)).await;
    }
}

/// The cached file of a blob, fetched from the object store first when it is not cached.
pub async fn ensure_cached(state: &AppState, vault: &str, blob: &str) -> ApiResult<PathBuf> {
    let path = cache_path(state, vault, blob);
    if tokio::fs::try_exists(&path).await? {
        return Ok(path);
    }
    let stream = match state.store.get(&object_path(vault, blob)).await {
        Ok(object) => object.into_stream().map_err(|error| ApiError::Internal(error.into())),
        Err(object_store::Error::NotFound { .. }) => {
            tracing::error!("blob {blob} of vault {vault} is in neither the cache nor the object store");
            return Err(ApiError::NotFound);
        }
        Err(error) => return Err(error.into()),
    };
    // No size limit: it was checked on upload, and a limit lowered since must not hide what is stored.
    write_atomically(state, &path, stream, i64::MAX).await?;
    let (vault, blob) = (vault.to_owned(), blob.to_owned());
    state
        .db
        .call(move |c| {
            c.execute("UPDATE blobs SET cached = 1, last_access = ?1 WHERE vault_id = ?2 AND blob_id = ?3", params![now_ms(), vault, blob])
        })
        .await?;
    Ok(path)
}

/// Copies new blobs to the object store, forever.
pub async fn uploader(state: AppState) {
    let mut failures = 0u32;
    loop {
        match upload_pending(&state).await {
            Ok(0) => {
                failures = 0;
                tokio::select! {
                    _ = state.upload.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                }
            }
            Ok(_) => failures = 0,
            Err(error) => {
                failures += 1;
                let wait = 2u64.pow(failures.min(8)).min(300);
                tracing::error!("upload to the object store failed, retrying in {wait} s: {error:#}");
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
        }
    }
}

/// Uploads up to 50 waiting blobs; returns how many were uploaded.
pub async fn upload_pending(state: &AppState) -> Result<usize> {
    let pending: Vec<(String, String)> = state
        .db
        .call(|c| {
            c.prepare("SELECT vault_id, blob_id FROM blobs WHERE in_r2 = 0 ORDER BY created_at LIMIT 50")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    let mut uploaded = 0;
    for (vault, blob) in pending {
        let path = cache_path(state, &vault, &blob);
        // shortcut: reads the whole blob into memory (at most REDSYNC_MAX_FILE); use multipart uploads if that limit grows a lot.
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tracing::error!("blob {blob} of vault {vault} is missing from the cache and was never uploaded");
                continue;
            }
            Err(error) => return Err(error).context("reading a cached blob"),
        };
        state.store.put(&object_path(&vault, &blob), PutPayload::from(bytes)).await?;
        state
            .db
            .call(move |c| c.execute("UPDATE blobs SET in_r2 = 1 WHERE vault_id = ?1 AND blob_id = ?2", params![vault, blob]))
            .await?;
        uploaded += 1;
    }
    Ok(uploaded)
}

#[derive(Clone, Debug)]
pub struct CachedBlob {
    pub vault_id: String,
    pub blob_id: String,
    pub size: i64,
    pub last_access: i64,
    pub in_r2: bool,
    /// The current version of some path.
    pub current: bool,
}

/// The blobs to remove from the cache: those past their time limit, then the least recently read until
/// the cache fits `cap`. Never a blob not yet in R2, nor a current version up to PIN_MAX_BYTES.
pub fn choose_victims(mut blobs: Vec<CachedBlob>, now: i64, cap: i64) -> Vec<(String, String)> {
    let mut total: i64 = blobs.iter().map(|blob| blob.size).sum();
    blobs.retain(|blob| blob.in_r2 && !(blob.current && blob.size <= PIN_MAX_BYTES));
    blobs.sort_by_key(|blob| blob.last_access);
    let mut victims = Vec::new();
    for blob in blobs {
        let ttl = if blob.current { LARGE_TTL_MS } else { HISTORY_TTL_MS };
        if now - blob.last_access > ttl || total > cap {
            total -= blob.size;
            victims.push((blob.vault_id, blob.blob_id));
        }
    }
    victims
}

/// Hourly: record reads, trim the cache, prune the log and expired codes, and delete removed users.
pub async fn maintenance(state: &AppState) -> Result<()> {
    flush_touched(state).await?;
    evict(state).await?;
    let now = now_ms();
    state
        .db
        .call(move |c| -> rusqlite::Result<()> {
            c.execute("DELETE FROM versions WHERE created_at < ?1", [now - LOG_TTL_MS])?;
            c.execute("DELETE FROM files WHERE blob_id IS NULL AND updated_at < ?1", [now - TOMBSTONE_TTL_MS])?;
            c.execute("DELETE FROM requests WHERE created_at < ?1", [now - REQUEST_TTL_MS])?;
            c.execute("DELETE FROM invites WHERE used = 1 OR expires_at < ?1", [now])?;
            c.execute("DELETE FROM enrolments WHERE used = 1 OR expires_at < ?1", [now])?;
            Ok(())
        })
        .await?;
    purge_removed_users(state, now).await
}

pub async fn flush_touched(state: &AppState) -> Result<()> {
    let touched = state.take_touched();
    if touched.is_empty() {
        return Ok(());
    }
    let now = now_ms();
    state
        .db
        .call(move |c| -> rusqlite::Result<()> {
            let tx = c.transaction()?;
            for (vault, blob) in touched {
                tx.execute("UPDATE blobs SET last_access = ?1 WHERE vault_id = ?2 AND blob_id = ?3", params![now, vault, blob])?;
            }
            tx.commit()
        })
        .await?;
    Ok(())
}

pub async fn evict(state: &AppState) -> Result<usize> {
    let (now, cap) = (now_ms(), state.config.cache_max_bytes);
    let victims = state
        .db
        .call(move |c| -> rusqlite::Result<_> {
            let blobs = c
                .prepare(
                    "SELECT b.vault_id, b.blob_id, b.size, b.last_access, b.in_r2,
                       EXISTS(SELECT 1 FROM files f WHERE f.vault_id = b.vault_id AND f.blob_id = b.blob_id)
                     FROM blobs b WHERE b.cached = 1",
                )?
                .query_map([], |r| {
                    Ok(CachedBlob {
                        vault_id: r.get(0)?,
                        blob_id: r.get(1)?,
                        size: r.get(2)?,
                        last_access: r.get(3)?,
                        in_r2: r.get(4)?,
                        current: r.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(choose_victims(blobs, now, cap))
        })
        .await?;
    for (vault, blob) in &victims {
        match tokio::fs::remove_file(cache_path(state, vault, blob)).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    let count = victims.len();
    state
        .db
        .call(move |c| -> rusqlite::Result<()> {
            let tx = c.transaction()?;
            for (vault, blob) in victims {
                tx.execute("UPDATE blobs SET cached = 0 WHERE vault_id = ?1 AND blob_id = ?2", params![vault, blob])?;
            }
            tx.commit()
        })
        .await?;
    Ok(count)
}

/// Deletes everything of users removed more than REMOVED_USER_GRACE_MS ago: R2 first, so a failure is retried.
async fn purge_removed_users(state: &AppState, now: i64) -> Result<()> {
    let cutoff = now - REMOVED_USER_GRACE_MS;
    let vaults: Vec<String> = state
        .db
        .call(move |c| {
            c.prepare("SELECT v.id FROM vaults v JOIN users u ON u.id = v.user_id WHERE u.removed_at < ?1")?
                .query_map([cutoff], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    for vault in vaults {
        let prefix = ObjectPath::from(format!("vaults/{vault}"));
        let objects: Vec<_> = state.store.list(Some(&prefix)).try_collect().await?;
        for object in objects {
            state.store.delete(&object.location).await?;
        }
        let _ = tokio::fs::remove_dir_all(state.config.data_dir.join("blobs").join(&vault)).await;
        state
            .db
            .call(move |c| -> rusqlite::Result<()> {
                let tx = c.transaction()?;
                for table in ["versions", "files", "blobs", "devices", "enrolments"] {
                    tx.execute(&format!("DELETE FROM {table} WHERE vault_id = ?1"), [&vault])?;
                }
                tx.execute("DELETE FROM vaults WHERE id = ?1", [&vault])?;
                tx.commit()
            })
            .await?;
    }
    state
        .db
        .call(move |c| -> rusqlite::Result<()> {
            c.execute("DELETE FROM invites WHERE user_id IN (SELECT id FROM users WHERE removed_at < ?1)", [cutoff])?;
            c.execute("DELETE FROM users WHERE removed_at < ?1 AND id NOT IN (SELECT user_id FROM vaults)", [cutoff])?;
            Ok(())
        })
        .await?;
    Ok(())
}
