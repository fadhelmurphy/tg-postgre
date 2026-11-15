//! Demo: satu klien TGPG pada kanal memori + bridge di 127.0.0.1:$PORT. Untuk uji dengan psql/DBeaver.
use std::collections::BTreeMap;
use tgpg_core::crypto::{random_key, Identity, SymKey};
use tgpg_core::engine::{Engine, OpenOpts};
use tgpg_core::transport::MemChannel;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let base = std::env::var("TGPG_TEST_PG")?;
    let (c, conn) = tokio_postgres::connect(&base, tokio_postgres::NoTls).await?;
    tokio::spawn(conn);
    let name = format!("demo_{}", uuid::Uuid::new_v4().simple());
    c.batch_execute(&format!("create database {name}")).await?;
    let url = format!("{}/{}", base.rsplit_once('/').unwrap().0, name);
    let ch = MemChannel::new();
    let e = Engine::open(OpenOpts {
        transport: ch.handle("1"), root_key: SymKey::new(&random_key())?, pg_url: url, identity: Identity::generate(),
        keys: BTreeMap::new(), on_keys: None, author: "demo".into(), log: None,
    }).await?;
    e.sync().await?;
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(55432);
    println!("bridge siap di 127.0.0.1:{port}");
    tgpg_bridge::serve(e, ([127, 0, 0, 1], port).into(), false).await
}
