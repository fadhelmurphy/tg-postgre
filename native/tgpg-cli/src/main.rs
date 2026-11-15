//! `tgpg` — klien native TGPG (CLI). BELUM DIUJI terhadap Telegram sungguhan.
use std::{io::Write, sync::Arc};
use anyhow::{bail, Context, Result};

fn ask(q: &str) -> Result<String> { print!("{q}: "); std::io::stdout().flush()?; let mut s = String::new(); std::io::stdin().read_line(&mut s)?; Ok(s) }
fn usage() -> ! {
    eprintln!("pemakaian:\n  tgpg login                         login Telegram (sekali)\n  tgpg serve <tgpg://hash#kunci> [--listen 127.0.0.1:5432] [--chat \"Judul Grup\"]\n\nenv: TG_API_ID, TG_API_HASH (dari my.telegram.org), TGPG_PG_URL (Postgres admin, mis. postgres://u:p@127.0.0.1:5432/postgres), TGPG_HOME");
    std::process::exit(2)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let api_id: i32 = std::env::var("TG_API_ID").context("set TG_API_ID")?.parse()?;
    let api_hash = std::env::var("TG_API_HASH").context("set TG_API_HASH")?;
    let client = tgpg_telegram::connect(tgpg::home().join("telegram.session").to_str().unwrap(), api_id).await?;
    match args.first().map(String::as_str) {
        Some("login") => { tgpg_telegram::login(&client, &api_hash, &ask).await?; println!("login berhasil"); Ok(()) }
        Some("serve") => {
            let conn = args.get(1).cloned().unwrap_or_else(|| usage());
            let flag = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).cloned();
            let listen: std::net::SocketAddr = flag("--listen").unwrap_or_else(|| "127.0.0.1:5432".into()).parse()?;
            if !client.is_authorized().await? { bail!("belum login — jalankan `tgpg login`"); }
            let admin = std::env::var("TGPG_PG_URL").context("set TGPG_PG_URL (Postgres lokal)")?;
            let engine = tgpg::open_engine(&client, &conn, flag("--chat").as_deref(), &admin, Arc::new(|m, _| eprintln!("[tgpg] {m}"))).await?;
            println!("TGPG siap. Sambungkan DBeaver/psql ke {listen} (database & user bebas, tanpa sandi). Hanya localhost.");
            tgpg_bridge::serve(engine, listen, false).await
        }
        _ => usage(),
    }
}
