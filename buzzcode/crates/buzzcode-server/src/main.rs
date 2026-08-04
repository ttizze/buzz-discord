use anyhow::Context;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let bind_address =
        std::env::var("BUZZCODE_BIND").unwrap_or_else(|_| "127.0.0.1:3100".to_owned());
    let pool = buzzcode_server::connect_database(&database_url).await?;
    let auth = buzzcode_server::AuthConfig::from_environment()?;
    let listener = TcpListener::bind(&bind_address).await?;
    tracing::info!(address = %bind_address, "Buzzcode server listening");
    buzzcode_server::serve(listener, pool, auth).await?;
    Ok(())
}
