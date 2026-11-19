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

/// Token layanan: membawa sesi Telegram (akun layanan), connection string, judul grup, dan state identitas,
/// supaya `tgpg serve --token` jalan tanpa login interaktif. Token = kredensial penuh: perlakukan seperti sandi.
/// (Bukan terenkripsi: token itu sendiri adalah rahasianya.)
pub mod token {
    use super::*;
    pub const PREFIX: &str = "tgpg-token1.";

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    pub struct Token { pub api_id: i32, pub conn: String, pub chat: String, pub session_b64: String, pub state: Option<String> }

    pub fn hash_of(conn: &str) -> Result<String> {
        let rest = conn.trim().strip_prefix("tgpg://").context("connection string harus diawali tgpg://")?;
        Ok(rest.split_once('#').context("connection string tanpa #kunci")?.0.replace(['/', '\\'], "_"))
    }
    pub fn encode(t: &Token) -> Result<String> { Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(t)?))) }
    pub fn decode(s: &str) -> Result<Token> {
        let body = s.trim().strip_prefix(PREFIX).context("bukan token TGPG (harus diawali tgpg-token1.)")?;
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).context("token rusak")?).context("isi token tidak valid")
    }
    /// Buat token dari sesi hasil `tgpg login` di `dir` (TGPG_HOME) untuk connection string + judul grup.
    pub fn create(dir: &std::path::Path, api_id: i32, conn: &str, chat: &str) -> Result<String> {
        let session = std::fs::read(dir.join("telegram.session")).context("sesi tidak ditemukan — jalankan `tgpg login` dulu")?;
        let state = std::fs::read_to_string(dir.join(format!("{}.json", hash_of(conn)?))).ok();
        encode(&Token { api_id, conn: conn.trim().into(), chat: chat.into(), session_b64: URL_SAFE_NO_PAD.encode(session), state })
    }
    /// Pasang sesi + state dari token ke `dir`; kembalikan path file sesi. State yang sudah ada tidak ditimpa.
    pub fn install(dir: &std::path::Path, t: &Token) -> Result<PathBuf> {
        std::fs::create_dir_all(dir)?;
        let hash = hash_of(&t.conn)?;
        let sess = dir.join(format!("token-{hash}.session"));
        if !sess.exists() { write_private(&sess, &URL_SAFE_NO_PAD.decode(&t.session_b64).context("sesi dalam token rusak")?)?; }
        let sp = dir.join(format!("{hash}.json"));
        if let (false, Some(st)) = (sp.exists(), &t.state) { write_private(&sp, st.as_bytes())?; }
        Ok(sess)
    }
    fn write_private(p: &std::path::Path, b: &[u8]) -> Result<()> {
        std::fs::write(p, b)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))?; }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn bolak_balik_dan_install() {
            let d = std::env::temp_dir().join(format!("tgpg-tok-{}", std::process::id())); let _ = std::fs::remove_dir_all(&d); std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("telegram.session"), b"SQLITEBYTES").unwrap();
            std::fs::write(d.join("HASH1.json"), r#"{"secret_hex":"aa","keys":{}}"#).unwrap();
            let tok = create(&d, 12345, "tgpg://HASH1#KUNCI", "TGPG · uji").unwrap();
            assert!(tok.starts_with(PREFIX));
            let t = decode(&tok).unwrap();
            assert_eq!((t.api_id, t.chat.as_str()), (12345, "TGPG · uji"));
            let d2 = std::env::temp_dir().join(format!("tgpg-tok2-{}", std::process::id())); let _ = std::fs::remove_dir_all(&d2);
            let sess = install(&d2, &t).unwrap();
            assert_eq!(std::fs::read(sess).unwrap(), b"SQLITEBYTES");
            assert!(std::fs::read_to_string(d2.join("HASH1.json")).unwrap().contains("secret_hex"));
            assert!(decode("sampah").is_err() && decode("tgpg-token1.@@@").is_err());
        }
    }
}
