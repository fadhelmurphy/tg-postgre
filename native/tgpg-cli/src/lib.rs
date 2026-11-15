//! Logika bersama CLI & GUI: buka Engine dari connection string. BELUM DIUJI terhadap Telegram sungguhan.
use std::{collections::BTreeMap, path::PathBuf, sync::{Arc, Mutex}, time::Duration};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use tgpg_core::crypto::{Identity, SymKey};
use tgpg_core::engine::{Engine, LogCb, OpenOpts};

#[derive(Serialize, Deserialize, Default)]
struct State { secret_hex: String, keys: BTreeMap<u64, String> }

pub fn home() -> PathBuf { let p = PathBuf::from(std::env::var("TGPG_HOME").unwrap_or_else(|_| format!("{}/.tgpg", std::env::var("HOME").unwrap_or_else(|_| ".".into())))); std::fs::create_dir_all(&p).ok(); p }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn unhex(s: &str) -> Vec<u8> { (0..s.len() / 2).filter_map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()).collect() }

/// Gabung/temukan grup, siapkan database Postgres lokal, buka Engine, sync sekali, dan jalankan sync berkala di latar belakang.
pub async fn open_engine(client: &grammers_client::Client, conn: &str, chat_title: Option<&str>, pg_admin: &str, log: LogCb) -> Result<Engine> {
    let rest = conn.trim().strip_prefix("tgpg://").context("connection string harus diawali tgpg://")?;
    let (hash, key_b64) = rest.split_once('#').context("connection string tanpa #kunci")?;
    let chat = match chat_title.filter(|t| !t.is_empty()) {
        Some(t) => tgpg_telegram::find_chat(client, t).await?,
        None => tgpg_telegram::join_by_link(client, &format!("https://t.me/+{hash}")).await
            .context("gagal gabung via tautan (mungkin sudah jadi anggota: isi judul grup)")?,
    };
    let transport = tgpg_telegram::TelegramTransport::new(client.clone(), chat, Duration::from_secs(3));
    let root = SymKey::new(&URL_SAFE_NO_PAD.decode(key_b64).context("kunci tidak valid")?)?;
    let sp = home().join(format!("{}.json", hash.replace(['/', '\\'], "_")));
    let st: State = std::fs::read_to_string(&sp).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let id = if st.secret_hex.is_empty() { Identity::generate() } else { Identity::from_secret_bytes(&unhex(&st.secret_hex))? };
    let secret_hex = hex(&id.secret_bytes());
    let (sp2, sh2) = (sp.clone(), secret_hex.clone());
    let dbname = format!("tgpg_{}", hash.chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect::<String>().to_lowercase());
    let (c, cn) = tokio_postgres::connect(pg_admin, tokio_postgres::NoTls).await.context("tidak bisa konek ke Postgres lokal")?; tokio::spawn(cn);
    if c.query_opt("select 1 from pg_database where datname=$1", &[&dbname]).await?.is_none() { c.batch_execute(&format!("create database {dbname}")).await?; }
    let pg_url = format!("{}/{}", pg_admin.rsplit_once('/').map(|x| x.0).unwrap_or(pg_admin), dbname);
    let _ = std::fs::write(&sp, serde_json::to_string(&State { secret_hex: secret_hex.clone(), keys: st.keys.clone() })?);
    let keys = Arc::new(Mutex::new(st.keys.clone())); let k2 = keys.clone();
    let l2 = log.clone();
    let engine = Engine::open(OpenOpts {
        transport, root_key: root, pg_url, identity: id, keys: st.keys,
        on_keys: Some(Arc::new(move |k| { *k2.lock().unwrap() = k.clone(); let _ = std::fs::write(&sp2, serde_json::to_string(&State { secret_hex: sh2.clone(), keys: k }).unwrap()); })),
        author: "tgpg-native".into(), log: Some(log),
    }).await?;
    engine.sync().await?;
    let e2 = engine.clone();
    tokio::spawn(async move { loop { tokio::time::sleep(Duration::from_secs(3)).await; if let Err(e) = e2.sync().await { l2(&format!("sync gagal: {e}"), "er"); } } });
    Ok(engine)
}
