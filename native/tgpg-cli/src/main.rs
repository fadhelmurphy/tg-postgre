//! `tgpg` — klien native TGPG: login Telegram, buka database dari connection string, sajikan di localhost untuk DBeaver/psql.
//! BELUM DIUJI terhadap Telegram sungguhan (hanya transport memori yang teruji).
use std::{collections::BTreeMap, io::Write, path::PathBuf, sync::{Arc, Mutex}, time::Duration};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use tgpg_core::crypto::{Identity, SymKey};
use tgpg_core::engine::{Engine, OpenOpts};

#[derive(Serialize, Deserialize, Default)]
struct State { secret_hex: String, keys: BTreeMap<u64, String> }

fn home() -> PathBuf { let p = PathBuf::from(std::env::var("TGPG_HOME").unwrap_or_else(|_| format!("{}/.tgpg", std::env::var("HOME").unwrap_or_else(|_| ".".into())))); std::fs::create_dir_all(&p).ok(); p }
fn ask(q: &str) -> Result<String> { print!("{q}: "); std::io::stdout().flush()?; let mut s = String::new(); std::io::stdin().read_line(&mut s)?; Ok(s) }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn unhex(s: &str) -> Vec<u8> { (0..s.len() / 2).filter_map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()).collect() }
fn usage() -> ! {
    eprintln!("pemakaian:\n  tgpg login                         login Telegram (sekali)\n  tgpg serve <tgpg://hash#kunci> [--listen 127.0.0.1:5432] [--chat \"Judul Grup\"]\n\nenv: TG_API_ID, TG_API_HASH (dari my.telegram.org), TGPG_PG_URL (Postgres admin, mis. postgres://u:p@127.0.0.1:5432/postgres), TGPG_HOME");
    std::process::exit(2)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let api_id: i32 = std::env::var("TG_API_ID").context("set TG_API_ID")?.parse()?;
    let api_hash = std::env::var("TG_API_HASH").context("set TG_API_HASH")?;
    let client = tgpg_telegram::connect(home().join("telegram.session").to_str().unwrap(), api_id).await?;
    match args.first().map(String::as_str) {
        Some("login") => { tgpg_telegram::login(&client, &api_hash, &ask).await?; println!("login berhasil"); Ok(()) }
        Some("serve") => {
            let conn = args.get(1).cloned().unwrap_or_else(|| usage());
            let rest = conn.strip_prefix("tgpg://").context("connection string harus diawali tgpg://")?;
            let (hash, key_b64) = rest.split_once('#').context("connection string tanpa #kunci")?;
            let flag = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).cloned();
            let listen: std::net::SocketAddr = flag("--listen").unwrap_or_else(|| "127.0.0.1:5432".into()).parse()?;
            if !client.is_authorized().await? { bail!("belum login — jalankan `tgpg login`"); }
            let chat = match flag("--chat") {
                Some(t) => tgpg_telegram::find_chat(&client, &t).await?,
                None => tgpg_telegram::join_by_link(&client, &format!("https://t.me/+{hash}")).await
                    .context("gagal gabung via tautan (mungkin sudah jadi anggota: pakai --chat \"Judul Grup\")")?,
            };
            let transport = tgpg_telegram::TelegramTransport::new(client.clone(), chat, Duration::from_secs(3));
            let root = SymKey::new(&URL_SAFE_NO_PAD.decode(key_b64).context("kunci tidak valid")?)?;
            let sp = home().join(format!("{}.json", hash.replace(['/', '\\'], "_")));
            let st: State = std::fs::read_to_string(&sp).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let id = if st.secret_hex.is_empty() { Identity::generate() } else { Identity::from_secret_bytes(&unhex(&st.secret_hex))? };
            let secret_hex = hex(&id.secret_bytes());
            let keys = Arc::new(Mutex::new(st.keys.clone()));
            let (k2, sp2, sh2) = (keys.clone(), sp.clone(), secret_hex.clone());
            let admin = std::env::var("TGPG_PG_URL").context("set TGPG_PG_URL (Postgres lokal; postgresql_embedded belum dipasang)")?;
            let dbname = format!("tgpg_{}", hash.chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect::<String>().to_lowercase());
            let (c, conn) = tokio_postgres::connect(&admin, tokio_postgres::NoTls).await?; tokio::spawn(conn);
            if c.query_opt("select 1 from pg_database where datname=$1", &[&dbname]).await?.is_none() { c.batch_execute(&format!("create database {dbname}")).await?; }
            let pg_url = format!("{}/{}", admin.rsplit_once('/').map(|x| x.0).unwrap_or(&admin), dbname);
            let engine = Engine::open(OpenOpts {
                transport, root_key: root, pg_url, identity: id, keys: st.keys,
                on_keys: Some(Arc::new(move |k| { *k2.lock().unwrap() = k.clone(); let _ = std::fs::write(&sp2, serde_json::to_string(&State { secret_hex: sh2.clone(), keys: k }).unwrap()); })),
                author: "tgpg-native".into(), log: Some(Arc::new(|m, _| eprintln!("[tgpg] {m}"))),
            }).await?;
            let _ = std::fs::write(&sp, serde_json::to_string(&State { secret_hex, keys: keys.lock().unwrap().clone() })?);
            engine.sync().await?;
            let e2 = engine.clone();
            tokio::spawn(async move { loop { tokio::time::sleep(Duration::from_secs(3)).await; if let Err(e) = e2.sync().await { eprintln!("[tgpg] sync gagal: {e}"); } } });
            println!("TGPG siap. Sambungkan DBeaver/psql ke {listen} (database & user bebas, tanpa sandi). Hanya localhost.");
            tgpg_bridge::serve(engine, listen, false).await
        }
        _ => usage(),
    }
}
