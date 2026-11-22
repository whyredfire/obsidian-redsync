use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    let address = std::env::var("REDSYNC_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = TcpListener::bind(&address).await?;
    tracing::info!("listening on {address}");
    axum::serve(listener, redsync_server::app())
        .with_graceful_shutdown(shutdown())
        .await
}

async fn shutdown() {
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
