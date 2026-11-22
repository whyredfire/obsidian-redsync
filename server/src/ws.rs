//! The WebSocket each device keeps open: catch-up, commits, and live changes.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use rusqlite::params;
use tokio::sync::broadcast::error::RecvError;

use crate::db::now_ms;
use crate::protocol::{ClientMessage, CommitResult, PROTOCOL_VERSION, ServerMessage};
use crate::{AppState, Event, api, sync};

const PAGE: i64 = 500;
const CLOSE_UNSUPPORTED: u16 = 4000;
const CLOSE_UNAUTHORIZED: u16 = 4001;
const CLOSE_REVOKED: u16 = 4003;

type Sender = SplitSink<WebSocket, Message>;

pub async fn upgrade(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.max_message_size(16 << 20).on_upgrade(move |socket| async move {
        if let Err(error) = session(state, socket).await {
            tracing::debug!("connection ended: {error:#}");
        }
    })
}

async fn send(sender: &mut Sender, message: &ServerMessage) -> Result<()> {
    sender.send(Message::Text(serde_json::to_string(message)?.into())).await?;
    Ok(())
}

async fn close(sender: &mut Sender, code: u16, reason: &'static str) -> Result<()> {
    sender.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await?;
    Ok(())
}

async fn session(state: AppState, socket: WebSocket) -> Result<()> {
    let (mut sender, mut receiver) = socket.split();

    let first = tokio::time::timeout(Duration::from_secs(10), receiver.next()).await.context("no hello within 10 s")?;
    let Some(Ok(Message::Text(text))) = first else { bail!("expected hello") };
    let ClientMessage::Hello { vault, token, epoch, since, protocol } = serde_json::from_str(&text)? else {
        bail!("expected hello");
    };
    if protocol != PROTOCOL_VERSION {
        tracing::warn!("device refused: protocol {protocol}, this server speaks {PROTOCOL_VERSION}");
        return close(&mut sender, CLOSE_UNSUPPORTED, "unsupported protocol version").await;
    }
    let auth = match api::authenticate(&state, &token).await? {
        Some(auth) if auth.vault_id == vault => auth,
        _ => {
            tracing::warn!("device refused for vault {vault}: unknown or revoked token");
            return close(&mut sender, CLOSE_UNAUTHORIZED, "unauthorized").await;
        }
    };
    let device_id = auth.device_id;
    tracing::info!("device {device_id} connected to vault {vault} from seq {since}");
    let result = connected(&state, sender, receiver, &vault, &device_id, epoch, since).await;
    tracing::info!("device {device_id} disconnected{}", result.as_ref().err().map(|e| format!(": {e:#}")).unwrap_or_default());
    result
}

async fn connected(
    state: &AppState,
    mut sender: Sender,
    mut receiver: futures_util::stream::SplitStream<WebSocket>,
    vault: &str,
    device_id: &str,
    epoch: Option<String>,
    since: i64,
) -> Result<()> {
    let (vault, device_id) = (vault.to_owned(), device_id.to_owned());

    // Subscribe before reading the log, so no change falls between the two.
    let mut events = state.subscribe(&vault);
    let (vault_id, device) = (vault.clone(), device_id.clone());
    let (vault_epoch, head, reset) = state
        .db
        .call(move |c| -> Result<_> {
            c.execute("UPDATE devices SET last_seen = ?1 WHERE id = ?2", params![now_ms(), device])?;
            sync::catch_up_state(c, &vault_id, epoch.as_deref(), since)
        })
        .await?;
    send(&mut sender, &ServerMessage::Welcome { epoch: vault_epoch.clone(), head_seq: head, device_id: device_id.clone() }).await?;
    let mut cursor = if reset {
        send(&mut sender, &ServerMessage::Reset { epoch: vault_epoch }).await?;
        head
    } else {
        since
    };
    cursor = backfill(state, &mut sender, &vault, cursor).await?;

    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;
    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Text(text))) => match serde_json::from_str(&text)? {
                    ClientMessage::Commit { req, ops } => {
                        let (vault_id, device, request) = (vault.clone(), device_id.clone(), req.clone());
                        let count = ops.len();
                        let (results, changes) = state.db.call(move |c| sync::commit(c, &vault_id, &device, &request, &ops)).await?;
                        let conflicts = results.iter().filter(|r| matches!(r, CommitResult::Conflict { .. })).count();
                        let missing = results.iter().filter(|r| matches!(r, CommitResult::MissingBlob)).count();
                        tracing::info!("device {device_id}: {count} changes sent, {} accepted, {conflicts} conflicts, {missing} awaiting content", changes.len());
                        for change in changes {
                            state.publish(&vault, Event::Change(change));
                        }
                        send(&mut sender, &ServerMessage::Result { req, results }).await?;
                    }
                    ClientMessage::Ping => send(&mut sender, &ServerMessage::Pong).await?,
                    ClientMessage::Hello { .. } => bail!("hello sent twice"),
                },
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.into()),
            },
            event = events.recv() => match event {
                Ok(Event::Change(change)) if change.seq == cursor + 1 => {
                    cursor = change.seq;
                    send(&mut sender, &ServerMessage::Changes { up_to: cursor, items: vec![change], more: false }).await?;
                }
                // A gap (or a missed message): read the log instead.
                Ok(Event::Change(change)) if change.seq > cursor => cursor = backfill(state, &mut sender, &vault, cursor).await?,
                Ok(Event::Revoked(id)) if id == device_id => return close(&mut sender, CLOSE_REVOKED, "revoked").await,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => cursor = backfill(state, &mut sender, &vault, cursor).await?,
                Err(RecvError::Closed) => return Ok(()),
            },
            _ = ping.tick() => {
                sender.send(Message::Ping(Default::default())).await?;
                // Also catches revocations made with the admin command, which cannot reach this process.
                let device = device_id.clone();
                let active: bool = state
                    .db
                    .call(move |c| c.query_row("SELECT revoked = 0 FROM devices WHERE id = ?1", [device], |r| r.get(0)))
                    .await?;
                if !active {
                    return close(&mut sender, CLOSE_REVOKED, "revoked").await;
                }
            }
        }
    }
}

/// Sends every logged change after `cursor` in pages; returns the new cursor.
async fn backfill(state: &AppState, sender: &mut Sender, vault: &str, mut cursor: i64) -> Result<i64> {
    loop {
        let (vault_id, from) = (vault.to_owned(), cursor);
        let mut items = state.db.call(move |c| sync::changes_since(c, &vault_id, from, PAGE + 1)).await?;
        if items.is_empty() {
            return Ok(cursor);
        }
        let more = items.len() as i64 > PAGE;
        items.truncate(PAGE as usize);
        cursor = items.last().map_or(cursor, |change| change.seq);
        send(sender, &ServerMessage::Changes { items, up_to: cursor, more }).await?;
        if !more {
            return Ok(cursor);
        }
    }
}
