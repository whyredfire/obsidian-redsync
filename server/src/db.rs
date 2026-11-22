//! The SQLite database: schema, one shared connection, and small helpers for IDs and hashes.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, quota_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL, removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS invites(
  code_hash BLOB PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vaults(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  epoch TEXT NOT NULL, head_seq INTEGER NOT NULL DEFAULT 0, snapshot_seq INTEGER NOT NULL DEFAULT 0,
  encrypted INTEGER NOT NULL, kdf_salt TEXT, key_check TEXT
);
CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, name TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enrolments(
  code_hash BLOB PRIMARY KEY, vault_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  sealed TEXT
);
CREATE TABLE IF NOT EXISTS versions(
  vault_id TEXT NOT NULL, seq INTEGER NOT NULL, path_id TEXT NOT NULL, version INTEGER NOT NULL,
  blob_id TEXT, meta TEXT NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(vault_id, seq)
);
CREATE INDEX IF NOT EXISTS versions_by_path ON versions(vault_id, path_id, version);
CREATE TABLE IF NOT EXISTS files(
  vault_id TEXT NOT NULL, path_id TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL,
  blob_id TEXT, meta TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(vault_id, path_id)
);
CREATE INDEX IF NOT EXISTS files_by_blob ON files(vault_id, blob_id);
CREATE TABLE IF NOT EXISTS blobs(
  vault_id TEXT NOT NULL, blob_id TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
  in_r2 INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 1, last_access INTEGER NOT NULL,
  PRIMARY KEY(vault_id, blob_id)
);
CREATE TABLE IF NOT EXISTS requests(
  device_id TEXT NOT NULL, req TEXT NOT NULL, results TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, req)
);
";

/// shortcut: one connection serialises every read and write; add a read pool if requests ever queue.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self(Arc::new(Mutex::new(open(path)?))))
    }

    /// Runs `work` on the connection without blocking the async runtime.
    pub async fn call<T, E>(&self, work: impl FnOnce(&mut Connection) -> Result<T, E> + Send + 'static) -> Result<T, E>
    where
        T: Send + 'static,
        E: Send + 'static,
    {
        let connection = self.0.clone();
        let task = tokio::task::spawn_blocking(move || work(&mut connection.lock().unwrap_or_else(|e| e.into_inner())));
        match task.await {
            Ok(result) => result,
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }
}

/// Opens (and if needed creates) the database; also used directly by the admin commands.
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(SCHEMA)?;
    migrate(&connection)?;
    Ok(connection)
}

/// Columns added after 0.1.0, for databases created before them.
fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let has_sealed: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('enrolments') WHERE name = 'sealed')", [], |r| r.get(0))?;
    if !has_sealed {
        connection.execute_batch("ALTER TABLE enrolments ADD COLUMN sealed TEXT")?;
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system random number generator failed");
    bytes
}

/// 128-bit lowercase hex: vault, device, user, and epoch IDs.
pub fn random_id() -> String {
    random_bytes::<16>().iter().map(|b| format!("{b:02x}")).collect()
}

/// 256-bit device token.
pub fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// An 80-bit code people type: "K7QD-3MPA-9XRT-WV2B".
pub fn human_code() -> String {
    let characters: Vec<char> = random_bytes::<16>().iter().map(|b| CODE_ALPHABET[(b % 32) as usize] as char).collect();
    characters.chunks(4).map(|chunk| chunk.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

/// Hash of a human code, ignoring case, dashes, spaces, and the letters people confuse with digits.
pub fn code_hash(code: &str) -> Vec<u8> {
    let normalised: String = code
        .chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    sha256(normalised.as_bytes())
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

/// Blob and path IDs that are safe as file names and object keys.
pub fn valid_blob_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_survive_retyping() {
        let code = human_code();
        assert_eq!(code.len(), 19);
        assert_eq!(code_hash(&code), code_hash(&code.to_lowercase().replace('-', " ")));
        assert_eq!(code_hash("O0IL-1"), code_hash("0011-1"));
    }

    #[test]
    fn blob_ids_cannot_escape_the_cache() {
        assert!(valid_blob_id("abc_DEF-123"));
        assert!(!valid_blob_id("../etc"));
        assert!(!valid_blob_id("a/b"));
        assert!(!valid_blob_id(""));
    }
}
