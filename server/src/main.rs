use anyhow::Result;
use redsync_server::{State, admin, config, db, export, router, snapshots, spawn_background};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let config = config::Config::from_env()?;
    match args.as_slice() {
        [] | ["serve"] => serve(config).await,
        ["restore"] => {
            println!("{}", snapshots::restore(&config, config::store_from_env()?.as_ref()).await?);
            Ok(())
        }
        ["export", vault, folder] => {
            let passphrase = std::env::var("REDSYNC_PASSPHRASE").ok();
            let report = export::export(config::store_from_env()?.as_ref(), vault, std::path::Path::new(folder), passphrase.as_deref()).await?;
            println!("{report}");
            Ok(())
        }
        ["snapshot"] => {
            let state = State::new(config.clone(), db::Db::open(&config.db_path())?, config::store_from_env()?);
            println!("Snapshots written: {}", snapshots::run(&state).await?);
            Ok(())
        }
        ["help" | "--help" | "-h"] => {
            println!("{}", admin::USAGE);
            Ok(())
        }
        _ => {
            println!("{}", admin::run(&db::open(&config.db_path())?, &args)?);
            Ok(())
        }
    }
}

async fn serve(config: config::Config) -> Result<()> {
    tracing_subscriber::fmt::init();
    let store = config::store_from_env()?;
    let db = db::Db::open(&config.db_path())?;
    let state = State::new(config, db, store);
    spawn_background(&state);
    let address = std::env::var("REDSYNC_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = TcpListener::bind(&address).await?;
    tracing::info!("listening on {address}");
    axum::serve(listener, router(state)).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn shutdown() {
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
