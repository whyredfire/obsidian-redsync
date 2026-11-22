pub mod protocol;

use axum::{Json, Router, routing::get};
use serde_json::{Value, json};

pub fn app() -> Router {
    Router::new().route("/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}
