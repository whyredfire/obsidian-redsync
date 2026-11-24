//! End-to-end tests of the server, against an in-memory object store.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use object_store::{ObjectStore, ObjectStoreExt};
use object_store::memory::InMemory;
use object_store::path::Path as ObjectPath;
use redsync_server::config::Config;
use redsync_server::protocol::{ClientMessage, CommitOp, CommitResult, Joined, Listing, PROTOCOL_VERSION, ServerMessage};
use redsync_server::{AppState, State, admin, blobs, db, router, snapshots, sync};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;

struct Bench {
    state: AppState,
    app: Router,
    store: Arc<InMemory>,
    dir: TempDir,
}

fn config(dir: &std::path::Path) -> Config {
    Config { data_dir: dir.into(), cache_max_bytes: 1 << 30, max_file_bytes: 1 << 20, snapshot_interval: Duration::from_secs(3600) }
}

async fn bench() -> Bench {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(InMemory::new());
    let state = State::new(config(dir.path()), db::Db::open(&dir.path().join("redsync.db")).unwrap(), store.clone());
    Bench { app: router(state.clone()), state, store, dir }
}

impl Bench {
    async fn admin(&self, args: &[&str]) -> String {
        let args: Vec<String> = args.iter().map(ToString::to_string).collect();
        self.state.db.call(move |c| admin::run(c, &args.iter().map(String::as_str).collect::<Vec<_>>())).await.unwrap()
    }

    async fn invite(&self, user: &str) -> String {
        let output = self.admin(&["user", "add", user]).await;
        output.split_whitespace().find(|w| w.len() == 19 && w.matches('-').count() == 3).unwrap().to_owned()
    }

    async fn call(&self, method: Method, uri: &str, token: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(uri).header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let body = body.map_or(Body::empty(), |b| Body::from(b.to_string()));
        let response = self.app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn new_vault(&self, user: &str) -> Joined {
        let invite = self.invite(user).await;
        let body = json!({ "invite": invite, "name": "Notes", "deviceName": "Laptop", "encrypted": false });
        let (status, joined) = self.call(Method::POST, "/v1/vaults", None, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{joined}");
        serde_json::from_value(joined).unwrap()
    }

    async fn join(&self, owner: &Joined, device: &str) -> Joined {
        let vault = &owner.vault.id;
        let (_, enrolment) = self.call(Method::POST, &format!("/v1/vaults/{vault}/enrolments"), Some(&owner.token), None).await;
        let body = json!({ "code": enrolment["code"], "deviceName": device });
        let (status, joined) = self.call(Method::POST, &format!("/v1/vaults/{vault}/devices"), None, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{joined}");
        serde_json::from_value(joined).unwrap()
    }

    async fn put_blob(&self, device: &Joined, blob: &str, bytes: &[u8]) -> StatusCode {
        let request = Request::put(format!("/v1/vaults/{}/blobs/{blob}", device.vault.id))
            .header("authorization", format!("Bearer {}", device.token))
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        self.app.clone().oneshot(request).await.unwrap().status()
    }

    async fn get_blob(&self, device: &Joined, blob: &str) -> (StatusCode, Vec<u8>) {
        let request = Request::get(format!("/v1/vaults/{}/blobs/{blob}", device.vault.id))
            .header("authorization", format!("Bearer {}", device.token))
            .body(Body::empty())
            .unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        (response.status(), to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec())
    }

    async fn commit(&self, device: &Joined, req: &str, ops: Vec<CommitOp>) -> Vec<CommitResult> {
        let (vault, id, req) = (device.vault.id.clone(), device.device_id.clone(), req.to_owned());
        self.state.db.call(move |c| sync::commit(c, &vault, &id, &req, &ops)).await.unwrap().0
    }

    async fn listing(&self, device: &Joined) -> Listing {
        let (status, listing) = self.call(Method::GET, &format!("/v1/vaults/{}/files", device.vault.id), Some(&device.token), None).await;
        assert_eq!(status, StatusCode::OK);
        serde_json::from_value(listing).unwrap()
    }
}

fn op(path: &str, base: i64, blob: Option<&str>) -> CommitOp {
    CommitOp { path_id: path.into(), base_version: base, blob_id: blob.map(Into::into), meta: "meta".into() }
}

#[tokio::test]
async fn health_answers_ok() {
    let bench = bench().await;
    let (status, body) = bench.call(Method::GET, "/health", None, None).await;
    assert_eq!((status, body["status"].as_str()), (StatusCode::OK, Some("ok")));
}

#[tokio::test]
async fn invites_and_enrolments_are_single_use() {
    let bench = bench().await;
    let invite = bench.invite("mum").await;
    let body = json!({ "invite": invite, "name": "Notes", "deviceName": "Phone", "encrypted": false });
    let (status, _) = bench.call(Method::POST, "/v1/vaults", None, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = bench.call(Method::POST, "/v1/vaults", None, Some(body)).await;
    assert_eq!((status, error["error"].as_str()), (StatusCode::FORBIDDEN, Some("invalidCode")));

    let owner = bench.new_vault("dad").await;
    let vault = &owner.vault.id;
    let (_, enrolment) = bench.call(Method::POST, &format!("/v1/vaults/{vault}/enrolments"), Some(&owner.token), None).await;
    let join = json!({ "code": enrolment["code"].as_str().unwrap().to_lowercase(), "deviceName": "Tablet" });
    let (status, _) = bench.call(Method::POST, &format!("/v1/vaults/{vault}/devices"), None, Some(join.clone())).await;
    assert_eq!(status, StatusCode::OK, "codes are accepted in lower case");
    let (status, _) = bench.call(Method::POST, &format!("/v1/vaults/{vault}/devices"), None, Some(join)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // What the inviting device seals for the new one is handed over once, then forgotten.
    let body = json!({ "sealed": "opaque" });
    let (_, enrolment) = bench.call(Method::POST, &format!("/v1/vaults/{vault}/enrolments"), Some(&owner.token), Some(body)).await;
    let join = json!({ "code": enrolment["code"], "deviceName": "Phone" });
    let (_, joined) = bench.call(Method::POST, &format!("/v1/vaults/{vault}/devices"), None, Some(join)).await;
    assert_eq!(joined["sealed"], "opaque");
    let left: Option<String> = bench.state.db.call(|c| c.query_row("SELECT MAX(sealed) FROM enrolments", [], |r| r.get(0))).await.unwrap();
    assert_eq!(left, None);

    let (status, devices) = bench.call(Method::GET, &format!("/v1/vaults/{vault}/devices"), Some(&owner.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(devices.as_array().unwrap().len(), 3);
    let (status, _) = bench.call(Method::GET, &format!("/v1/vaults/{vault}/devices"), None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn users_cannot_reach_each_others_vaults() {
    let bench = bench().await;
    let mum = bench.new_vault("mum").await;
    let dad = bench.new_vault("dad").await;
    let (status, _) = bench.call(Method::GET, &format!("/v1/vaults/{}/files", dad.vault.id), Some(&mum.token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(bench.put_blob(&dad, "secret", b"dad's").await, StatusCode::CREATED);
    let request = Request::get(format!("/v1/vaults/{}/blobs/secret", dad.vault.id))
        .header("authorization", format!("Bearer {}", mum.token))
        .body(Body::empty())
        .unwrap();
    assert_eq!(bench.app.clone().oneshot(request).await.unwrap().status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn commits_follow_the_rules() {
    let bench = bench().await;
    let laptop = bench.new_vault("me").await;
    let phone = bench.join(&laptop, "Phone").await;
    assert_eq!(bench.put_blob(&laptop, "a", b"first").await, StatusCode::CREATED);
    assert_eq!(bench.put_blob(&phone, "a", b"first").await, StatusCode::OK, "known blobs are not stored twice");
    assert_eq!(bench.put_blob(&phone, "b", b"second").await, StatusCode::CREATED);

    let first = bench.commit(&laptop, "r1", vec![op("note.md", 0, Some("a"))]).await;
    assert_eq!(first, vec![CommitResult::Ok { version: 1, seq: 1 }]);
    assert_eq!(bench.commit(&laptop, "r1", vec![op("note.md", 0, Some("a"))]).await, first, "a retried request gets the same answer");

    // The phone did not see version 1 yet.
    let stale = bench.commit(&phone, "p1", vec![op("note.md", 0, Some("b"))]).await;
    assert_eq!(stale, vec![CommitResult::Conflict { version: 1, blob_id: Some("a".into()), meta: "meta".into() }]);
    let same = bench.commit(&phone, "p2", vec![op("note.md", 0, Some("a"))]).await;
    assert_eq!(same, vec![CommitResult::Ok { version: 1, seq: 1 }], "the same content is not a conflict");
    let missing = bench.commit(&phone, "p3", vec![op("other.md", 0, Some("nowhere"))]).await;
    assert_eq!(missing, vec![CommitResult::MissingBlob]);

    // A rename: deletion and creation with the same blob, in one commit.
    let rename = bench.commit(&phone, "p4", vec![op("note.md", 1, None), op("renamed.md", 0, Some("a"))]).await;
    assert_eq!(rename, vec![CommitResult::Ok { version: 2, seq: 2 }, CommitResult::Ok { version: 1, seq: 3 }]);

    let listing = bench.listing(&laptop).await;
    assert_eq!(listing.head_seq, 3);
    let paths: Vec<_> = listing.files.iter().map(|f| (f.path_id.as_str(), f.blob_id.as_deref())).collect();
    assert_eq!(paths, vec![("note.md", None), ("renamed.md", Some("a"))]);

    let (status, history) =
        bench.call(Method::GET, &format!("/v1/vaults/{}/versions?path=note.md", laptop.vault.id), Some(&laptop.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history.as_array().unwrap().len(), 2);
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(address: &str, device: &Joined, epoch: Option<&str>, since: i64) -> Socket {
    let (mut socket, _) = connect_async(format!("ws://{address}/v1/ws")).await.unwrap();
    let hello = ClientMessage::Hello {
        vault: device.vault.id.clone(),
        token: device.token.clone(),
        epoch: epoch.map(Into::into),
        since,
        protocol: PROTOCOL_VERSION,
    };
    socket.send(Message::Text(serde_json::to_string(&hello).unwrap().into())).await.unwrap();
    socket
}

/// The next message from the server: Ok(message) or Err(close code).
async fn next(socket: &mut Socket) -> Result<ServerMessage, u16> {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.expect("no message within 5 s");
        match message.unwrap().unwrap() {
            Message::Text(text) => return Ok(serde_json::from_str(&text).unwrap()),
            Message::Close(frame) => return Err(frame.map_or(0, |f| f.code.into())),
            _ => {}
        }
    }
}

#[tokio::test]
async fn devices_see_each_others_changes_live_and_after_reconnecting() {
    let bench = bench().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let app = bench.app.clone();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let laptop = bench.new_vault("me").await;
    let phone = bench.join(&laptop, "Phone").await;
    let mut a = connect(&address, &laptop, None, 0).await;
    let mut b = connect(&address, &phone, None, 0).await;
    let Ok(ServerMessage::Welcome { epoch, head_seq: 0, .. }) = next(&mut a).await else { panic!("no welcome") };
    assert!(matches!(next(&mut b).await, Ok(ServerMessage::Welcome { .. })));

    bench.put_blob(&laptop, "a", b"hello").await;
    let commit = ClientMessage::Commit { req: "r1".into(), ops: vec![op("note.md", 0, Some("a"))] };
    a.send(Message::Text(serde_json::to_string(&commit).unwrap().into())).await.unwrap();

    let Ok(ServerMessage::Changes { items, up_to: 1, .. }) = next(&mut b).await else { panic!("the phone got no change") };
    assert_eq!((items[0].path_id.as_str(), items[0].device_id.as_str()), ("note.md", laptop.device_id.as_str()));
    let mut laptop_saw = Vec::new();
    for _ in 0..2 {
        laptop_saw.push(next(&mut a).await.unwrap());
    }
    assert!(laptop_saw.iter().any(|m| matches!(m, ServerMessage::Result { req, .. } if req == "r1")));
    assert!(laptop_saw.iter().any(|m| matches!(m, ServerMessage::Changes { up_to: 1, .. })), "its own change comes back too");

    a.send(Message::Text(serde_json::to_string(&ClientMessage::Ping).unwrap().into())).await.unwrap();
    assert_eq!(next(&mut a).await, Ok(ServerMessage::Pong));

    // Reconnecting from the start replays the log; another epoch means reconcile.
    let mut again = connect(&address, &phone, Some(&epoch), 0).await;
    next(&mut again).await.unwrap();
    assert!(matches!(next(&mut again).await, Ok(ServerMessage::Changes { up_to: 1, .. })));
    let mut other = connect(&address, &phone, Some("another-epoch"), 1).await;
    next(&mut other).await.unwrap();
    assert!(matches!(next(&mut other).await, Ok(ServerMessage::Reset { .. })));

    // Revoking the phone closes its connections.
    let revoke = format!("/v1/vaults/{}/devices/{}", laptop.vault.id, phone.device_id);
    assert_eq!(bench.call(Method::DELETE, &revoke, Some(&laptop.token), None).await, (StatusCode::OK, json!({ "revoked": true })));
    assert_eq!(next(&mut b).await.unwrap_err(), 4003);
    let mut refused = connect(&address, &phone, None, 0).await;
    assert_eq!(next(&mut refused).await.unwrap_err(), 4001);
}

#[tokio::test]
async fn blobs_go_to_the_store_and_come_back_after_eviction() {
    let bench = bench().await;
    let laptop = bench.new_vault("me").await;
    bench.put_blob(&laptop, "old", b"an old version").await;
    assert_eq!(blobs::upload_pending(&bench.state).await.unwrap(), 1);
    let stored = bench.store.get(&blobs::object_path(&laptop.vault.id, "old")).await.unwrap().bytes().await.unwrap();
    assert_eq!(&stored[..], b"an old version");

    // Not a current version, and unread for longer than the history limit.
    let vault = laptop.vault.id.clone();
    bench.state.db.call(move |c| c.execute("UPDATE blobs SET last_access = 0 WHERE vault_id = ?1", [vault])).await.unwrap();
    assert_eq!(blobs::evict(&bench.state).await.unwrap(), 1);
    assert!(!blobs::cache_path(&bench.state, &laptop.vault.id, "old").exists());
    assert_eq!(bench.get_blob(&laptop, "old").await, (StatusCode::OK, b"an old version".to_vec()));
    assert!(blobs::cache_path(&bench.state, &laptop.vault.id, "old").exists());
}

#[tokio::test]
async fn stored_blobs_are_served_under_a_lowered_limit_and_lost_ones_are_not_found() {
    let bench = bench().await;
    let laptop = bench.new_vault("me").await;
    let vault = laptop.vault.id.clone();
    bench.put_blob(&laptop, "large", &[1; 2000]).await;
    bench.put_blob(&laptop, "lost", b"lost").await;
    blobs::upload_pending(&bench.state).await.unwrap();
    for blob in ["large", "lost"] {
        std::fs::remove_file(blobs::cache_path(&bench.state, &vault, blob)).unwrap();
    }
    bench.store.delete(&blobs::object_path(&vault, "lost")).await.unwrap();

    // The same data, served with a limit lowered after the upload.
    let state = State::new(
        Config { max_file_bytes: 1000, ..config(bench.dir.path()) },
        db::Db::open(&bench.dir.path().join("redsync.db")).unwrap(),
        bench.store.clone(),
    );
    let lowered = Bench { app: router(state.clone()), state, store: bench.store.clone(), dir: tempfile::tempdir().unwrap() };
    assert_eq!(lowered.get_blob(&laptop, "large").await, (StatusCode::OK, vec![1; 2000]));
    assert_eq!(lowered.get_blob(&laptop, "lost").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unused_blobs_are_deleted_unless_a_snapshot_names_them() {
    let bench = bench().await;
    let laptop = bench.new_vault("me").await;
    let vault = laptop.vault.id.clone();
    for blob in ["snapshotted", "typed", "current", "unused"] {
        bench.put_blob(&laptop, blob, blob.as_bytes()).await;
    }
    bench.commit(&laptop, "r1", vec![op("note.md", 0, Some("snapshotted"))]).await;
    snapshots::run(&bench.state).await.unwrap();
    bench.commit(&laptop, "r2", vec![op("note.md", 1, Some("typed"))]).await;
    bench.commit(&laptop, "r3", vec![op("note.md", 2, Some("current"))]).await;
    blobs::upload_pending(&bench.state).await.unwrap();

    let (hour, day) = (3_600_000, 86_400_000);
    let now = db::now_ms();
    assert_eq!(blobs::collect_garbage(&bench.state, now + 2 * hour).await.unwrap(), 1, "only the unused one: the history names the others");
    assert_eq!(bench.state.db.call(move |c| sync::thin_history(c, now + hour)).await.unwrap(), 2);
    assert_eq!(blobs::collect_garbage(&bench.state, now + 2 * hour).await.unwrap(), 1, "the typed one; the snapshot names the other");
    assert_eq!(bench.get_blob(&laptop, "typed").await.0, StatusCode::NOT_FOUND);
    assert!(bench.store.get(&blobs::object_path(&vault, "typed")).await.is_err());
    assert!(!blobs::cache_path(&bench.state, &vault, "unused").exists());
    assert_eq!(blobs::collect_garbage(&bench.state, now + 31 * day).await.unwrap(), 1, "the snapshot is gone by then");
    assert_eq!(bench.get_blob(&laptop, "current").await, (StatusCode::OK, b"current".to_vec()));
}

#[tokio::test]
async fn old_history_keeps_one_version_per_device_and_ten_minutes() {
    let bench = bench().await;
    let laptop = bench.new_vault("me").await;
    let phone = bench.join(&laptop, "Phone").await;
    for blob in ["a", "b", "c", "d", "e", "f"] {
        bench.put_blob(&laptop, blob, blob.as_bytes()).await;
    }
    let edits = [
        (&laptop, "a", 0),  // seq 1: typed over in the same ten minutes
        (&laptop, "b", 1),  // seq 2: the phone last saw this one
        (&laptop, "c", 2),  // seq 3: the last of its ten minutes
        (&laptop, "d", 11), // seq 4: typed over
        (&laptop, "e", 12), // seq 5: before the phone's edit
        (&phone, "f", 13),  // seq 6: current
    ];
    for (i, (device, blob, _)) in edits.iter().enumerate() {
        bench.commit(device, &format!("n{i}"), vec![op("note.md", i as i64, Some(blob))]).await;
    }
    let edits_then_delete = [(&laptop, Some("a"), 7), (&laptop, None, 7)];
    for (i, (device, blob, _)) in edits_then_delete.iter().enumerate() {
        bench.commit(device, &format!("g{i}"), vec![op("gone.md", i as i64, *blob)]).await;
    }

    // Two hours ago, at these minutes; the phone was last connected at seq 2.
    let minute = 60_000;
    let start = (db::now_ms() - 2 * 3_600_000) / (10 * minute) * (10 * minute);
    let minutes: Vec<i64> = edits.iter().map(|e| e.2).chain(edits_then_delete.iter().map(|e| e.2)).collect();
    let phone_id = phone.device_id.clone();
    let remaining: Vec<i64> = bench
        .state
        .db
        .call(move |c| -> anyhow::Result<Vec<i64>> {
            for (i, at) in minutes.iter().enumerate() {
                c.execute("UPDATE versions SET created_at = ?1 WHERE seq = ?2", [start + at * minute, i as i64 + 1])?;
            }
            c.execute("UPDATE devices SET cursor_seq = 2 WHERE id = ?1", [&phone_id])?;
            sync::thin_history(c, db::now_ms() - 3_600_000)?;
            Ok(c.prepare("SELECT seq FROM versions ORDER BY seq")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(remaining, vec![2, 3, 5, 6, 7, 8]);

    // A device that last saw seq 1 catches up from the rest, without being made to compare everything.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let app = bench.app.clone();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let epoch = laptop.vault.epoch.clone();
    let mut socket = connect(&address, &phone, Some(&epoch), 1).await;
    assert!(matches!(next(&mut socket).await, Ok(ServerMessage::Welcome { .. })));
    let Ok(ServerMessage::Changes { after: 1, up_to: 8, items, .. }) = next(&mut socket).await else { panic!("no catch-up") };
    assert_eq!(items.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![2, 3, 5, 6, 7, 8]);
}

#[test]
fn eviction_keeps_pinned_and_unsaved_blobs() {
    use redsync_server::blobs::{CachedBlob, choose_victims};
    let day = 86_400_000;
    let blob = |id: &str, size, age_days, in_r2, current| CachedBlob {
        vault_id: "v".into(),
        blob_id: id.into(),
        size,
        last_access: 100 * day - age_days * day,
        in_r2,
        current,
    };
    let blobs = vec![
        blob("note", 1000, 90, true, true),            // current and small: pinned
        blob("unsaved", 1000, 90, false, false),       // not in R2 yet
        blob("history", 1000, 8, true, false),         // past 7 days
        blob("recent-history", 1000, 2, true, false),  // within 7 days
        blob("photo", 5 << 20, 15, true, true),        // current but large, past 14 days
        blob("big-recent", 5 << 20, 1, true, true),
    ];
    let mut victims: Vec<_> = choose_victims(blobs.clone(), 100 * day, 1 << 30).into_iter().map(|(_, b)| b).collect();
    victims.sort();
    assert_eq!(victims, vec!["history", "photo"]);
    // Over the cap: the least recently read go next, pinned ones never.
    let tight: Vec<_> = choose_victims(blobs, 100 * day, 3000).into_iter().map(|(_, b)| b).collect();
    assert!(tight.contains(&"big-recent".to_owned()) && tight.contains(&"recent-history".to_owned()));
    assert!(!tight.contains(&"note".to_owned()) && !tight.contains(&"unsaved".to_owned()));
}

#[tokio::test]
async fn uploads_respect_quota_and_size_limits() {
    let bench = bench().await;
    let laptop = bench.new_vault("me").await;
    bench.admin(&["user", "quota", "me", "10"]).await;
    assert_eq!(bench.put_blob(&laptop, "big", &[0; 20]).await, StatusCode::INSUFFICIENT_STORAGE);
    assert!(!blobs::cache_path(&bench.state, &laptop.vault.id, "big").exists());
    bench.admin(&["user", "quota", "me", "10GB"]).await;
    assert_eq!(bench.put_blob(&laptop, "huge", &vec![0; (1 << 20) + 1]).await, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(bench.put_blob(&laptop, "../escape", b"x").await, StatusCode::NOT_FOUND, "rejected by routing");
}

#[tokio::test]
async fn a_lost_database_is_rebuilt_from_snapshots() {
    let bench = bench().await;
    let laptop = bench.new_vault("me").await;
    bench.put_blob(&laptop, "a", b"hello").await;
    bench.commit(&laptop, "r1", vec![op("note.md", 0, Some("a")), op("gone.md", 0, Some("a"))]).await;
    bench.commit(&laptop, "r2", vec![op("gone.md", 1, None)]).await;
    blobs::upload_pending(&bench.state).await.unwrap();
    assert_eq!(snapshots::run(&bench.state).await.unwrap(), 1);
    assert_eq!(snapshots::run(&bench.state).await.unwrap(), 0, "unchanged vaults are not written again");
    let snapshots_written = bench.store.list_with_delimiter(Some(&ObjectPath::from(format!("vaults/{}/snapshots", laptop.vault.id)))).await.unwrap();
    assert_eq!(snapshots_written.objects.len(), 1);

    // A new server with an empty disk and the same object store.
    let new_disk = tempfile::tempdir().unwrap();
    let report = snapshots::restore(&config(new_disk.path()), bench.store.as_ref()).await.unwrap();
    assert!(report.contains("2 files, 1 blobs"), "{report}");
    let state = State::new(config(new_disk.path()), db::Db::open(&new_disk.path().join("redsync.db")).unwrap(), bench.store.clone());
    let restored = Bench { app: router(state.clone()), state, store: bench.store.clone(), dir: new_disk };

    let before = bench.listing(&laptop).await;
    let after = restored.listing(&laptop).await;
    assert_eq!(after.files, before.files, "the old device token still works");
    assert_ne!(after.epoch, before.epoch);
    assert_eq!(restored.get_blob(&laptop, "a").await, (StatusCode::OK, b"hello".to_vec()));
    let _ = &bench.dir;
}
