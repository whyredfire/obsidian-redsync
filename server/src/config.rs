//! Settings from environment variables, and the fixed limits of the design.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use object_store::ObjectStore;
use object_store::aws::AmazonS3Builder;
use object_store::local::LocalFileSystem;
use object_store::prefix::PrefixStore;
use url::Url;

pub const DAY_MS: i64 = 86_400_000;
/// Current versions up to this size stay in the cache whatever their age.
pub const PIN_MAX_BYTES: i64 = 1 << 20;
/// Older versions leave the cache after this long unread.
pub const HISTORY_TTL_MS: i64 = 7 * DAY_MS;
/// Current versions above PIN_MAX_BYTES leave the cache after this long unread.
pub const LARGE_TTL_MS: i64 = 14 * DAY_MS;
pub const LOG_TTL_MS: i64 = 30 * DAY_MS;
/// History younger than this keeps every version…
pub const HISTORY_DETAIL_MS: i64 = 3_600_000;
/// …older history one per device and file in each step of this length.
pub const HISTORY_STEP_MS: i64 = 10 * 60_000;
pub const TOMBSTONE_TTL_MS: i64 = 365 * DAY_MS;
pub const REMOVED_USER_GRACE_MS: i64 = 30 * DAY_MS;
pub const REQUEST_TTL_MS: i64 = DAY_MS;
pub const INVITE_TTL_MS: i64 = 7 * DAY_MS;
pub const ENROLMENT_TTL_MS: i64 = 15 * 60_000;
pub const DEFAULT_QUOTA: &str = "10GB";

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: PathBuf,
    pub cache_max_bytes: i64,
    pub max_file_bytes: i64,
    pub snapshot_interval: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let hours: u64 = env_or("REDSYNC_SNAPSHOT_HOURS", "6").parse().context("REDSYNC_SNAPSHOT_HOURS")?;
        Ok(Self {
            data_dir: env_or("REDSYNC_DATA", "/data").into(),
            cache_max_bytes: parse_size(&env_or("REDSYNC_CACHE_MAX", "2GB"))?,
            max_file_bytes: parse_size(&env_or("REDSYNC_MAX_FILE", "100MB"))?,
            snapshot_interval: Duration::from_secs(hours.max(1) * 3600),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("redsync.db")
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

/// The object store named by REDSYNC_STORE: `s3://bucket/prefix` (credentials and endpoint from the
/// standard AWS_* variables) or `file:///path` for local testing.
pub fn store_from_env() -> Result<Arc<dyn ObjectStore>> {
    let raw = std::env::var("REDSYNC_STORE").context("REDSYNC_STORE is not set (s3://bucket/prefix or file:///path)")?;
    let url = Url::parse(&raw).context("REDSYNC_STORE is not a URL")?;
    match url.scheme() {
        "file" => {
            std::fs::create_dir_all(url.path())?;
            Ok(Arc::new(LocalFileSystem::new_with_prefix(url.path())?))
        }
        "s3" => {
            let bucket = url.host_str().context("REDSYNC_STORE has no bucket")?;
            let store: Arc<dyn ObjectStore> = Arc::new(AmazonS3Builder::from_env().with_bucket_name(bucket).build()?);
            let prefix = url.path().trim_matches('/');
            Ok(if prefix.is_empty() { store } else { Arc::new(PrefixStore::new(store, prefix)) })
        }
        other => bail!("REDSYNC_STORE: unsupported scheme {other}"),
    }
}

/// "10GB", "200 MB", "1.5gb", "512" (bytes).
pub fn parse_size(text: &str) -> Result<i64> {
    let upper = text.trim().to_ascii_uppercase();
    let (number, multiplier) = [("TB", 1i64 << 40), ("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10), ("B", 1)]
        .iter()
        .find_map(|(suffix, multiplier)| upper.strip_suffix(suffix).map(|n| (n.to_owned(), *multiplier)))
        .unwrap_or((upper.clone(), 1));
    let value: f64 = number.trim().parse().with_context(|| format!("not a size: {text}"))?;
    if !value.is_finite() || value < 0.0 {
        bail!("not a size: {text}");
    }
    Ok((value * multiplier as f64) as i64)
}

pub fn format_size(bytes: i64) -> String {
    let units = [("GB", 1i64 << 30), ("MB", 1 << 20), ("KB", 1 << 10)];
    for (unit, size) in units {
        if bytes >= size {
            return format!("{:.1} {unit}", bytes as f64 / size as f64);
        }
    }
    format!("{bytes} B")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(parse_size("10GB").unwrap(), 10 << 30);
        assert_eq!(parse_size("1.5 mb").unwrap(), 3 << 19);
        assert_eq!(parse_size("512").unwrap(), 512);
        assert!(parse_size("lots").is_err());
        assert_eq!(format_size(3 << 29), "1.5 GB");
    }
}
