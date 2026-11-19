//! `tgpg` — klien native TGPG (CLI). BELUM DIUJI terhadap Telegram sungguhan.
use std::{io::Write, sync::Arc};
use anyhow::{bail, Context, Result};

fn ask(q: &str) -> Result<String> { print!("{q}: "); std::io::stdout().flush()?; let mut s = String::new(); std::io::stdin().read_line(&mut s)?; Ok(s) }
fn usage() -> ! {
    eprintln!("pemakaian:
  tgpg login                                   login Telegram (sekali)
  tgpg serve <tgpg://hash#kunci> [--listen 127.0.0.1:5432] [--chat \"Judul Grup\"] [--password SANDI]
  tgpg token create <tgpg://hash#kunci> --chat \"TGPG · nama\"   buat token layanan dari sesi hasil `tgpg login`
  tgpg serve --token <tgpg-token1.…> [--listen ADDR] [--password SANDI]   tanpa login (atau env TGPG_TOKEN)

env: TG_API_ID, TG_API_HASH (my.telegram.org; tidak perlu untuk --token), TGPG_PG_URL (Postgres lokal admin, mis. postgres://u:p@127.0.0.1:5432/postgres), TGPG_HOME, TGPG_PG_PASSWORD (sandi koneksi), TGPG_TOKEN
Bila --listen bukan localhost, sandi (--password) wajib. Token = kredensial penuh: simpan seperti sandi, pakai akun Telegram khusus layanan.");
    std::process::exit(2)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).cloned();
    let env_id = || -> Result<i32> { Ok(std::env::var("TG_API_ID").context("set TG_API_ID")?.parse()?) };
    match args.first().map(String::as_str) {
        Some("login") => {
            let api_hash = std::env::var("TG_API_HASH").context("set TG_API_HASH")?;
            let client = tgpg_telegram::connect(tgpg::home().join("telegram.session").to_str().unwrap(), env_id()?).await?;
            tgpg_telegram::login(&client, &api_hash, &ask).await?; println!("login berhasil"); Ok(())
        }
        Some("token") if args.get(1).map(String::as_str) == Some("create") => {
            let conn = args.get(2).cloned().unwrap_or_else(|| usage());
            let chat = flag("--chat").context("--chat \"Judul Grup\" wajib (judul persis di Telegram, mis. \"TGPG · nama\")")?;
            println!("{}", tgpg::token::create(&tgpg::home(), env_id()?, &conn, &chat)?);
            eprintln!("Token dibuat. Perlakukan seperti sandi (berisi sesi Telegram + kunci database). Cabut akses lewat Anggota → Cabut / terminate session di Telegram.");
            Ok(())
        }
        Some("serve") => {
            let listen: std::net::SocketAddr = flag("--listen").unwrap_or_else(|| "127.0.0.1:5432".into()).parse()?;
            let password = flag("--password").or_else(|| std::env::var("TGPG_PG_PASSWORD").ok()).filter(|p| !p.is_empty());
            if !listen.ip().is_loopback() && password.is_none() { bail!("--listen {listen} bukan localhost: set --password (atau TGPG_PG_PASSWORD)"); }
            let admin = std::env::var("TGPG_PG_URL").context("set TGPG_PG_URL (Postgres lokal)")?;
            let (client, conn, chat) = if let Some(tok) = flag("--token").or_else(|| std::env::var("TGPG_TOKEN").ok()).filter(|t| !t.is_empty()) {
                let t = tgpg::token::decode(&tok)?;
                let sess = tgpg::token::install(&tgpg::home(), &t)?;
                (tgpg_telegram::connect(sess.to_str().unwrap(), t.api_id).await?, t.conn.clone(), Some(t.chat.clone()))
            } else {
                let conn = args.get(1).filter(|a| !a.starts_with("--")).cloned().unwrap_or_else(|| usage());
                (tgpg_telegram::connect(tgpg::home().join("telegram.session").to_str().unwrap(), env_id()?).await?, conn, flag("--chat"))
            };
            if !client.is_authorized().await? { bail!("sesi Telegram tidak berlaku (belum login / token dicabut) — jalankan `tgpg login` atau buat token baru"); }
            let engine = tgpg::open_engine(&client, &conn, chat.as_deref(), &admin, Arc::new(|m, _| eprintln!("[tgpg] {m}"))).await?;
            if password.is_some() { println!("TGPG siap di {listen} (user bebas, sandi wajib; tanpa TLS — pakai jaringan tepercaya/tunnel)."); }
            else { println!("TGPG siap. Sambungkan DBeaver/psql ke {listen} (database & user bebas, tanpa sandi). Hanya localhost."); }
            tgpg_bridge::serve_with(engine, listen, false, password).await
        }
        _ => usage(),
    }
}
