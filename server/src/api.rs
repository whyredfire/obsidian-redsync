//! HTTP routes: vaults, devices, blobs, listings, and history.

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, State};
use axum::http::{StatusCode, header, request::Parts};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::json;
use tokio_util::io::ReaderStream;

use crate::config::{ENROLMENT_TTL_MS, format_size};
use crate::db::{code_hash, human_code, now_ms, random_id, random_token, sha256, valid_blob_id};
use crate::protocol::{
    ApiErrorBody, CreateEnrolment, CreateVaultRequest, DeviceInfo, Enrolment, JoinRequest, Joined, Listing, RenameDevice, VaultInfo, VersionEntry,
};
use crate::{AppState, Event, blobs, sync, ws};

/** The release version the image was built for, or Cargo.toml's for local builds. */
pub const VERSION: &str = match option_env!("REDSYNC_VERSION") {
    Some(version) if !version.is_empty() => version,
    _ => env!("CARGO_PKG_VERSION"),
};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/vaults", post(create_vault))
        .route("/v1/vaults/{vault}", get(get_vault_info))
        .route("/v1/vaults/{vault}/enrolments", post(create_enrolment))
        .route("/v1/vaults/{vault}/devices", get(list_devices).post(join_vault))
        .route("/v1/vaults/{vault}/devices/{device}", patch(rename_device).delete(revoke_device))
        .route(
            "/v1/vaults/{vault}/blobs/{blob}",
            put(put_blob).get(get_blob).head(head_blob).layer(DefaultBodyLimit::disable()),
        )
        .route("/v1/vaults/{vault}/files", get(list_files))
        .route("/v1/vaults/{vault}/versions", get(file_versions))
        .route("/v1/ws", get(ws::upgrade))
        .layer(axum::middleware::from_fn(log_request))
        .with_state(state)
}

/** One line per request: method, path (never the query or headers, which may hold tokens), status, time taken. */
async fn log_request(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let (method, path) = (request.method().clone(), request.uri().path().to_owned());
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    let status = response.status();
    let took = started.elapsed().as_millis();
    if path == "/health" {
        tracing::debug!("{method} {path} {} {took} ms", status.as_u16());
    } else if status.is_server_error() {
        tracing::error!("{method} {path} {} {took} ms", status.as_u16());
    } else if status.is_client_error() {
        tracing::warn!("{method} {path} {} {took} ms", status.as_u16());
    } else {
        tracing::info!("{method} {path} {} {took} ms", status.as_u16());
    }
    response
}

#[derive(Debug)]
pub enum ApiError {
    BadRequest(&'static str),
    Unauthorized,
    InvalidCode,
    NotFound,
    TooLarge,
    QuotaExceeded,
    Internal(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(error: E) -> Self {
        Self::Internal(error.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "badRequest", message),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", "The device token is not valid."),
            Self::InvalidCode => (StatusCode::FORBIDDEN, "invalidCode", "The code is not valid or has expired."),
            Self::NotFound => (StatusCode::NOT_FOUND, "notFound", "Not found."),
            Self::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "tooLarge", "The file is larger than the server allows."),
            Self::QuotaExceeded => (StatusCode::INSUFFICIENT_STORAGE, "quotaExceeded", "Storage on the server is full."),
            Self::Internal(error) => {
                tracing::error!("request failed: {error:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal", "The server failed; see its log.")
            }
        };
        (status, Json(ApiErrorBody { error: error.into(), message: message.into() })).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// The device behind the request's bearer token.
#[derive(Clone, Debug)]
pub struct Auth {
    pub device_id: String,
    pub vault_id: String,
}

impl Auth {
    fn check(&self, vault_id: &str) -> ApiResult<()> {
        if self.vault_id == vault_id { Ok(()) } else { Err(ApiError::NotFound) }
    }
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        authenticate(state, token).await?.ok_or(ApiError::Unauthorized)
    }
}

/// A device that is not revoked and whose owner is not removed.
pub async fn authenticate(state: &AppState, token: &str) -> anyhow::Result<Option<Auth>> {
    let token_hash = sha256(token.as_bytes());
    state
        .db
        .call(move |c| {
            c.query_row(
                "SELECT d.id, d.vault_id FROM devices d
                 JOIN vaults v ON v.id = d.vault_id JOIN users u ON u.id = v.user_id
                 WHERE d.token_hash = ?1 AND d.revoked = 0 AND u.removed_at IS NULL",
                [token_hash],
                |r| Ok(Auth { device_id: r.get(0)?, vault_id: r.get(1)? }),
            )
            .optional()
        })
        .await
        .map_err(Into::into)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": VERSION }))
}

fn check_name(name: &str) -> ApiResult<()> {
    let length = name.trim().chars().count();
    if (1..=100).contains(&length) { Ok(()) } else { Err(ApiError::BadRequest("Names must have 1 to 100 characters.")) }
}

pub fn vault_info(connection: &Connection, vault_id: &str) -> rusqlite::Result<VaultInfo> {
    connection.query_row(
        "SELECT v.id, v.name, v.epoch, v.encrypted, v.kdf_salt, v.key_check, u.quota_bytes,
           (SELECT COALESCE(SUM(b.size), 0) FROM blobs b JOIN vaults o ON o.id = b.vault_id WHERE o.user_id = v.user_id)
         FROM vaults v JOIN users u ON u.id = v.user_id WHERE v.id = ?1",
        [vault_id],
        |r| {
            Ok(VaultInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                epoch: r.get(2)?,
                encrypted: r.get(3)?,
                kdf_salt: r.get(4)?,
                key_check: r.get(5)?,
                quota_bytes: r.get(6)?,
                used_bytes: r.get(7)?,
            })
        },
    )
}

fn add_device(tx: &Transaction, vault_id: &str, name: &str) -> rusqlite::Result<Joined> {
    let device_id = random_id();
    let token = random_token();
    tx.execute(
        "INSERT INTO devices(id, vault_id, name, token_hash, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![device_id, vault_id, name.trim(), sha256(token.as_bytes()), now_ms()],
    )?;
    Ok(Joined { vault: vault_info(tx, vault_id)?, device_id, token, sealed: None })
}

async fn create_vault(State(state): State<AppState>, Json(request): Json<CreateVaultRequest>) -> ApiResult<Json<Joined>> {
    check_name(&request.name)?;
    check_name(&request.device_name)?;
    let key_material = [&request.kdf_salt, &request.key_check];
    if request.encrypted && key_material.iter().any(|value| value.is_none()) {
        return Err(ApiError::BadRequest("An encrypted vault needs kdfSalt and keyCheck."));
    }
    if key_material.iter().any(|value| value.as_ref().is_some_and(|v| v.len() > 1024)) {
        return Err(ApiError::BadRequest("kdfSalt and keyCheck must be shorter than 1024 characters."));
    }
    let invite_hash = code_hash(&request.invite);
    let joined = state
        .db
        .call(move |c| -> ApiResult<Joined> {
            let tx = c.transaction()?;
            let now = now_ms();
            let user_id: String = tx
                .query_row(
                    "SELECT i.user_id FROM invites i JOIN users u ON u.id = i.user_id
                     WHERE i.code_hash = ?1 AND i.used = 0 AND i.expires_at > ?2 AND u.removed_at IS NULL",
                    params![invite_hash, now],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(ApiError::InvalidCode)?;
            tx.execute("UPDATE invites SET used = 1 WHERE code_hash = ?1", [&invite_hash])?;
            let vault_id = random_id();
            tx.execute(
                "INSERT INTO vaults(id, user_id, name, created_at, epoch, encrypted, kdf_salt, key_check)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    vault_id,
                    user_id,
                    request.name.trim(),
                    now,
                    random_id(),
                    request.encrypted,
                    request.kdf_salt,
                    request.key_check
                ],
            )?;
            let joined = add_device(&tx, &vault_id, &request.device_name)?;
            tx.commit()?;
            Ok(joined)
        })
        .await?;
    Ok(Json(joined))
}

async fn get_vault_info(State(state): State<AppState>, auth: Auth, Path(vault): Path<String>) -> ApiResult<Json<VaultInfo>> {
    auth.check(&vault)?;
    Ok(Json(state.db.call(move |c| vault_info(c, &vault)).await?))
}

async fn create_enrolment(
    State(state): State<AppState>,
    auth: Auth,
    Path(vault): Path<String>,
    body: axum::body::Bytes,
) -> ApiResult<Json<Enrolment>> {
    auth.check(&vault)?;
    // An empty body is allowed: plug-in 0.1.0 sends none.
    let request: CreateEnrolment = if body.is_empty() {
        CreateEnrolment::default()
    } else {
        serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest("The body is not a valid enrolment request."))?
    };
    let sealed = request.sealed;
    if sealed.as_ref().is_some_and(|s| s.len() > 4096) {
        return Err(ApiError::BadRequest("sealed must be shorter than 4096 characters."));
    }
    let code = human_code();
    let expires_at = now_ms() + ENROLMENT_TTL_MS;
    let hash = code_hash(&code);
    state
        .db
        .call(move |c| {
            c.execute(
                "INSERT INTO enrolments(code_hash, vault_id, expires_at, sealed) VALUES(?1, ?2, ?3, ?4)",
                params![hash, vault, expires_at, sealed],
            )
        })
        .await?;
    Ok(Json(Enrolment { code, expires_at }))
}

async fn join_vault(State(state): State<AppState>, Path(vault): Path<String>, Json(request): Json<JoinRequest>) -> ApiResult<Json<Joined>> {
    check_name(&request.device_name)?;
    let hash = code_hash(&request.code);
    let joined = state
        .db
        .call(move |c| -> ApiResult<Joined> {
            let tx = c.transaction()?;
            let sealed: Option<String> = tx
                .query_row(
                    "SELECT sealed FROM enrolments
                     WHERE code_hash = ?1 AND vault_id = ?2 AND used = 0 AND expires_at > ?3
                       AND vault_id IN (SELECT v.id FROM vaults v JOIN users u ON u.id = v.user_id WHERE u.removed_at IS NULL)",
                    params![hash, vault, now_ms()],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(ApiError::InvalidCode)?;
            // Handed over once: forgotten as soon as it is used.
            tx.execute("UPDATE enrolments SET used = 1, sealed = NULL WHERE code_hash = ?1", [&hash])?;
            let mut joined = add_device(&tx, &vault, &request.device_name)?;
            joined.sealed = sealed;
            tx.commit()?;
            Ok(joined)
        })
        .await?;
    Ok(Json(joined))
}

async fn list_devices(State(state): State<AppState>, auth: Auth, Path(vault): Path<String>) -> ApiResult<Json<Vec<DeviceInfo>>> {
    auth.check(&vault)?;
    let devices = state
        .db
        .call(move |c| {
            c.prepare("SELECT id, name, created_at, last_seen FROM devices WHERE vault_id = ?1 AND revoked = 0 ORDER BY created_at")?
                .query_map([&vault], |r| {
                    let id: String = r.get(0)?;
                    Ok(DeviceInfo {
                        this_device: id == auth.device_id,
                        id,
                        name: r.get(1)?,
                        created_at: r.get(2)?,
                        last_seen: r.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(devices))
}

async fn rename_device(
    State(state): State<AppState>,
    auth: Auth,
    Path((vault, device)): Path<(String, String)>,
    Json(request): Json<RenameDevice>,
) -> ApiResult<Json<serde_json::Value>> {
    auth.check(&vault)?;
    check_name(&request.name)?;
    let updated = state
        .db
        .call(move |c| {
            c.execute(
                "UPDATE devices SET name = ?1 WHERE id = ?2 AND vault_id = ?3 AND revoked = 0",
                params![request.name.trim(), device, vault],
            )
        })
        .await?;
    if updated == 0 { Err(ApiError::NotFound) } else { Ok(Json(json!({ "renamed": true }))) }
}

async fn revoke_device(State(state): State<AppState>, auth: Auth, Path((vault, device)): Path<(String, String)>) -> ApiResult<Json<serde_json::Value>> {
    auth.check(&vault)?;
    let device_id = device.clone();
    let vault_id = vault.clone();
    let updated = state
        .db
        .call(move |c| c.execute("UPDATE devices SET revoked = 1 WHERE id = ?1 AND vault_id = ?2 AND revoked = 0", params![device_id, vault_id]))
        .await?;
    if updated == 0 {
        return Err(ApiError::NotFound);
    }
    state.publish(&vault, Event::Revoked(device));
    Ok(Json(json!({ "revoked": true })))
}

// Every answer has a body: Obsidian's HTTP client on Android fails on empty ones ("Stream closed").
async fn put_blob(
    State(state): State<AppState>,
    auth: Auth,
    Path((vault, blob)): Path<(String, String)>,
    body: Body,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    auth.check(&vault)?;
    if !valid_blob_id(&blob) {
        return Err(ApiError::BadRequest("Invalid blob ID."));
    }
    if blobs::exists(&state, &vault, &blob).await? {
        return Ok((StatusCode::OK, Json(json!({ "stored": true }))));
    }
    let size = blobs::receive(&state, &vault, &blob, body).await?;
    let (vault_id, blob_id) = (vault.clone(), blob.clone());
    let stored = state
        .db
        .call(move |c| -> ApiResult<()> {
            let tx = c.transaction()?;
            let info = vault_info(&tx, &vault_id)?;
            let known: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM blobs WHERE vault_id = ?1 AND blob_id = ?2)",
                params![vault_id, blob_id],
                |r| r.get(0),
            )?;
            if known {
                return Ok(());
            }
            if info.used_bytes + size > info.quota_bytes {
                tracing::warn!("vault {vault_id}: upload refused, quota of {} reached", format_size(info.quota_bytes));
                return Err(ApiError::QuotaExceeded);
            }
            let now = now_ms();
            tx.execute(
                "INSERT INTO blobs(vault_id, blob_id, size, created_at, last_access, released_at) VALUES(?1, ?2, ?3, ?4, ?4, ?4)",
                params![vault_id, blob_id, size, now],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await;
    if let Err(ApiError::QuotaExceeded) = stored {
        blobs::discard(&state, &vault, &blob).await;
    }
    stored?;
    state.upload.notify_one();
    Ok((StatusCode::CREATED, Json(json!({ "stored": true }))))
}

async fn head_blob(State(state): State<AppState>, auth: Auth, Path((vault, blob)): Path<(String, String)>) -> ApiResult<StatusCode> {
    auth.check(&vault)?;
    if valid_blob_id(&blob) && blobs::exists(&state, &vault, &blob).await? { Ok(StatusCode::OK) } else { Err(ApiError::NotFound) }
}

async fn get_blob(State(state): State<AppState>, auth: Auth, Path((vault, blob)): Path<(String, String)>) -> ApiResult<Response> {
    auth.check(&vault)?;
    if !valid_blob_id(&blob) || !blobs::exists(&state, &vault, &blob).await? {
        return Err(ApiError::NotFound);
    }
    let path = blobs::ensure_cached(&state, &vault, &blob).await?;
    let file = tokio::fs::File::open(&path).await?;
    let length = file.metadata().await?.len();
    state.touch(&vault, &blob);
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream".to_owned()), (header::CONTENT_LENGTH, length.to_string())],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response())
}

async fn list_files(State(state): State<AppState>, auth: Auth, Path(vault): Path<String>) -> ApiResult<Json<Listing>> {
    auth.check(&vault)?;
    Ok(Json(state.db.call(move |c| sync::listing(c, &vault)).await?))
}

#[derive(Deserialize)]
struct VersionsQuery {
    path: String,
}

async fn file_versions(
    State(state): State<AppState>,
    auth: Auth,
    Path(vault): Path<String>,
    Query(query): Query<VersionsQuery>,
) -> ApiResult<Json<Vec<VersionEntry>>> {
    auth.check(&vault)?;
    let versions = state
        .db
        .call(move |c| {
            c.prepare(
                "SELECT version, seq, blob_id, meta, device_id, created_at FROM versions
                 WHERE vault_id = ?1 AND path_id = ?2 ORDER BY version DESC",
            )?
            .query_map(params![vault, query.path], |r| {
                Ok(VersionEntry {
                    version: r.get(0)?,
                    seq: r.get(1)?,
                    blob_id: r.get(2)?,
                    meta: r.get(3)?,
                    device_id: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(versions))
}
