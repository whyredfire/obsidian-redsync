//! `redsync-server export`: a vault's newest snapshot from the object store as plain files, decrypted with the
//! passphrase. Needs no running server and no database: only REDSYNC_STORE.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::TryStreamExt;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt};
use sha2::Sha256;

use crate::blobs::object_path;
use crate::snapshots::Snapshot;

const ITERATIONS: u32 = 600_000;
const KEY_CHECK: &[u8] = b"red-sync key check";

/// The plug-in's content key: PBKDF2-SHA256, then HKDF-SHA256 with the info "red-sync encrypt" (see plugin/src/crypto.ts).
pub struct VaultKey(Aes256Gcm);

impl VaultKey {
    pub fn derive(passphrase: &str, kdf_salt: &str, key_check: &str) -> Result<Self> {
        let salt = STANDARD.decode(kdf_salt)?;
        let mut master = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), &salt, ITERATIONS, &mut master);
        let mut key = [0u8; 32];
        hkdf::Hkdf::<Sha256>::new(Some(&[]), &master)
            .expand(b"red-sync encrypt", &mut key)
            .map_err(|_| anyhow::anyhow!("key derivation failed"))?;
        let vault_key = Self(Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow::anyhow!("bad key length"))?);
        match vault_key.open(&STANDARD.decode(key_check)?) {
            Ok(check) if check == KEY_CHECK => Ok(vault_key),
            _ => bail!("the passphrase is wrong"),
        }
    }

    /// 12-byte nonce, then the AES-GCM ciphertext and tag.
    pub fn open(&self, data: &[u8]) -> Result<Vec<u8>> {
        if data.len() < 12 + 16 {
            bail!("encrypted data is too short");
        }
        let nonce = Nonce::try_from(&data[..12]).map_err(|_| anyhow::anyhow!("bad nonce"))?;
        self.0.decrypt(&nonce, &data[12..]).map_err(|_| anyhow::anyhow!("decryption failed: wrong passphrase or damaged data"))
    }
}

#[derive(serde::Deserialize)]
struct Meta {
    path: String,
    mtime: i64,
}

/// A vault path as a path under `out`; refuses anything that could escape it.
fn target(out: &Path, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        bail!("refusing unsafe path {path:?}");
    }
    Ok(out.join(relative))
}

pub async fn export(store: &dyn ObjectStore, vault: &str, out: &Path, passphrase: Option<&str>) -> Result<String> {
    let snapshots: Vec<_> = store.list(Some(&ObjectPath::from(format!("vaults/{vault}/snapshots")))).try_collect().await?;
    let newest = snapshots
        .into_iter()
        .max_by(|a, b| a.location.as_ref().cmp(b.location.as_ref()))
        .with_context(|| format!("no snapshot of vault {vault}"))?;
    let snapshot: Snapshot = serde_json::from_slice(&store.get(&newest.location).await?.bytes().await?)?;
    let key = if snapshot.vault.encrypted {
        let passphrase = passphrase.context("the vault is encrypted: set REDSYNC_PASSPHRASE")?;
        let (salt, check) = (snapshot.vault.kdf_salt.as_deref(), snapshot.vault.key_check.as_deref());
        Some(VaultKey::derive(passphrase, salt.context("no kdfSalt")?, check.context("no keyCheck")?)?)
    } else {
        None
    };
    let mut written = 0;
    for file in &snapshot.files {
        let Some(blob) = &file.blob_id else { continue };
        let meta: Meta = match &key {
            Some(key) => serde_json::from_slice(&key.open(&STANDARD.decode(&file.meta)?)?)?,
            None => serde_json::from_str(&file.meta)?,
        };
        let path = target(out, &meta.path)?;
        // A folder: its path ends in "/", and it has no content.
        if meta.path.ends_with('/') {
            std::fs::create_dir_all(&path)?;
            continue;
        }
        let data = store.get(&object_path(vault, blob)).await?.bytes().await?;
        let content = match &key {
            Some(key) => key.open(&data)?,
            None => data.to_vec(),
        };
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, content)?;
        if let Ok(mtime) = u64::try_from(meta.mtime) {
            let _ = std::fs::File::options().write(true).open(&path)?.set_modified(UNIX_EPOCH + Duration::from_millis(mtime));
        }
        written += 1;
    }
    Ok(format!("Wrote {written} files of vault '{}' to {} (snapshot {}).", snapshot.vault.name, out.display(), newest.location))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encrypted by the plug-in's own code (plugin/scripts/fixture.ts).
    #[test]
    fn decrypts_what_the_plugin_encrypts() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/encrypted.json")).unwrap();
        let text = |key: &str| fixture[key].as_str().unwrap().to_owned();
        let key = VaultKey::derive(&text("passphrase"), &text("kdfSalt"), &text("keyCheck")).unwrap();
        let meta: Meta = serde_json::from_slice(&key.open(&STANDARD.decode(text("meta")).unwrap()).unwrap()).unwrap();
        assert_eq!(meta.path, "Folder/Note.md");
        assert_eq!(key.open(&STANDARD.decode(text("blob")).unwrap()).unwrap(), b"Hello from the plug-in.\n");
        assert!(VaultKey::derive("wrong", &text("kdfSalt"), &text("keyCheck")).is_err());
    }

    #[tokio::test]
    async fn exports_files_and_empty_folders() {
        use crate::protocol::FileEntry;
        use crate::snapshots::{SnapshotUser, SnapshotVault};
        let store = object_store::memory::InMemory::new();
        let entry = |path: &str, blob: &str| FileEntry {
            path_id: path.into(),
            version: 1,
            seq: 1,
            blob_id: Some(blob.into()),
            meta: serde_json::json!({ "path": path, "mtime": 0, "size": 0 }).to_string(),
        };
        let snapshot = Snapshot {
            format: 1,
            created_at: 0,
            vault: SnapshotVault { id: "v".into(), user_id: "u".into(), name: "Notes".into(), created_at: 0, seq: 1, encrypted: false, kdf_salt: None, key_check: None },
            user: SnapshotUser { id: "u".into(), name: "me".into(), quota_bytes: 0, created_at: 0, removed_at: None },
            devices: vec![],
            // The folder after the note in it, and an empty one.
            files: vec![entry("Folder/Note.md", "note"), entry("Folder/", "empty"), entry("Empty/", "empty")],
        };
        store.put(&ObjectPath::from("vaults/v/snapshots/0000000000001.json"), serde_json::to_vec(&snapshot).unwrap().into()).await.unwrap();
        store.put(&object_path("v", "note"), b"Hello".to_vec().into()).await.unwrap();
        store.put(&object_path("v", "empty"), Vec::new().into()).await.unwrap();
        let out = tempfile::tempdir().unwrap();
        export(&store, "v", out.path(), None).await.unwrap();
        assert_eq!(std::fs::read(out.path().join("Folder/Note.md")).unwrap(), b"Hello");
        assert!(out.path().join("Empty").is_dir());
    }

    #[test]
    fn paths_cannot_escape_the_folder() {
        let out = Path::new("/tmp/out");
        assert_eq!(target(out, "Folder/Note.md").unwrap(), Path::new("/tmp/out/Folder/Note.md"));
        assert!(target(out, "../escape.md").is_err());
        assert!(target(out, "/etc/passwd").is_err());
    }
}
