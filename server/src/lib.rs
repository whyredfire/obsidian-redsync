pub mod admin;
pub mod api;
pub mod blobs;
pub mod config;
pub mod db;
pub mod export;
pub mod protocol;
pub mod snapshots;
pub mod sync;
pub mod ws;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use object_store::ObjectStore;
use tokio::sync::{Notify, broadcast};

pub use api::router;

/// What a vault's connected devices are told about.
#[derive(Clone, Debug)]
pub enum Event {
    Change(protocol::Change),
    Revoked(String),
}

pub struct State {
    pub config: config::Config,
    pub db: db::Db,
    pub store: Arc<dyn ObjectStore>,
    /// Wakes the R2 uploader when a new blob arrives.
    pub upload: Notify,
    hubs: Mutex<HashMap<String, broadcast::Sender<Event>>>,
    touched: Mutex<HashSet<(String, String)>>,
}

pub type AppState = Arc<State>;

impl State {
    pub fn new(config: config::Config, db: db::Db, store: Arc<dyn ObjectStore>) -> AppState {
        Arc::new(Self { config, db, store, upload: Notify::new(), hubs: Mutex::default(), touched: Mutex::default() })
    }

    pub fn subscribe(&self, vault_id: &str) -> broadcast::Receiver<Event> {
        let mut hubs = self.hubs.lock().unwrap();
        hubs.entry(vault_id.to_owned()).or_insert_with(|| broadcast::channel(1024).0).subscribe()
    }

    pub fn publish(&self, vault_id: &str, event: Event) {
        if let Some(hub) = self.hubs.lock().unwrap().get(vault_id) {
            let _ = hub.send(event);
        }
    }

    /// Records a blob read; written to the database in batches so reads do not cause writes (and R2 uploads by Litestream).
    pub fn touch(&self, vault_id: &str, blob_id: &str) {
        self.touched.lock().unwrap().insert((vault_id.to_owned(), blob_id.to_owned()));
    }

    pub fn take_touched(&self) -> Vec<(String, String)> {
        self.touched.lock().unwrap().drain().collect()
    }
}

/// Starts the R2 uploader, the hourly maintenance, and the snapshots.
pub fn spawn_background(state: &AppState) {
    tokio::spawn(blobs::uploader(state.clone()));
    let maintenance_state = state.clone();
    tokio::spawn(async move {
        let mut hourly = tokio::time::interval(Duration::from_secs(3600));
        loop {
            hourly.tick().await;
            if let Err(error) = blobs::maintenance(&maintenance_state).await {
                tracing::error!("maintenance failed: {error:#}");
            }
        }
    });
    let snapshot_state = state.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(snapshot_state.config.snapshot_interval);
        timer.tick().await;
        loop {
            timer.tick().await;
            if let Err(error) = snapshots::run(&snapshot_state).await {
                tracing::error!("snapshot failed: {error:#}");
            }
        }
    });
}
