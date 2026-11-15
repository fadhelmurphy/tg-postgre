//! Aplikasi desktop mini TGPG (egui). BELUM DIUJI terhadap Telegram sungguhan; hanya terkompilasi.
use std::sync::{Arc, Mutex};

use eframe::egui;
use grammers_client::{Client, SignInError};
use tgpg_core::engine::{Engine, Member};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

#[derive(Default, Clone, Copy, PartialEq)]
enum Auth { #[default] Off, LoggedOut, NeedCode, NeedPassword, In }

#[derive(Default)]
struct Shared { auth: Auth, logs: Vec<String>, engine: Option<Engine>, members: Vec<Member>, serving: Option<String>, client: Option<Client>, busy: bool }
type Sh = Arc<Mutex<Shared>>;

fn push(sh: &Sh, m: impl Into<String>) { let mut s = sh.lock().unwrap(); s.logs.push(m.into()); if s.logs.len() > 500 { s.logs.remove(0); } }

struct App {
    rt: Arc<tokio::runtime::Runtime>, sh: Sh, tx_in: Option<UnboundedSender<String>>,
    api_id: String, api_hash: String, pg_url: String, conn: String, chat: String, listen: String, phone: String, input: String,
}

impl App {
    fn new() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
        Self {
            rt: Arc::new(tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()), sh: Default::default(), tx_in: None,
            api_id: env("TG_API_ID", ""), api_hash: env("TG_API_HASH", ""), pg_url: env("TGPG_PG_URL", "postgres://postgres:postgres@127.0.0.1:5432/postgres"),
            conn: String::new(), chat: String::new(), listen: "127.0.0.1:5432".into(), phone: String::new(), input: String::new(),
        }
    }

    fn connect(&mut self) {
        let Ok(id) = self.api_id.trim().parse::<i32>() else { push(&self.sh, "API ID harus angka"); return };
        let (sh, hash, phone) = (self.sh.clone(), self.api_hash.trim().to_string(), self.phone.clone());
        let sess = tgpg::home().join("telegram.session");
        let (tx, mut rx) = unbounded_channel::<String>();
        self.tx_in = Some(tx);
        self.rt.spawn(async move {
            let r: anyhow::Result<()> = async {
                let client = tgpg_telegram::connect(sess.to_str().unwrap(), id).await?;
                sh.lock().unwrap().client = Some(client.clone());
                if client.is_authorized().await? { sh.lock().unwrap().auth = Auth::In; return Ok(()); }
                sh.lock().unwrap().auth = Auth::LoggedOut;
                if phone.trim().is_empty() { anyhow::bail!("isi nomor telepon lalu klik Hubungkan lagi"); }
                let token = client.request_login_code(phone.trim(), &hash).await?;
                sh.lock().unwrap().auth = Auth::NeedCode;
                let code = rx.recv().await.ok_or_else(|| anyhow::anyhow!("dibatalkan"))?;
                match client.sign_in(&token, code.trim()).await {
                    Ok(_) => {}
                    Err(SignInError::PasswordRequired(pt)) => {
                        sh.lock().unwrap().auth = Auth::NeedPassword;
                        let pw = rx.recv().await.ok_or_else(|| anyhow::anyhow!("dibatalkan"))?;
                        client.check_password(pt, pw.trim()).await.map_err(|e| anyhow::anyhow!("sandi 2FA salah: {e}"))?;
                    }
                    Err(e) => anyhow::bail!("login gagal: {e}"),
                }
                sh.lock().unwrap().auth = Auth::In; Ok(())
            }.await;
            match r { Ok(()) => push(&sh, "Telegram: terhubung"), Err(e) => { push(&sh, format!("Telegram: {e}")); let mut s = sh.lock().unwrap(); if s.auth != Auth::LoggedOut { s.auth = Auth::LoggedOut; } } }
        });
    }

    fn open_db(&mut self) {
        let Some(client) = self.sh.lock().unwrap().client.clone() else { return };
        let (sh, conn, chat, pg, listen) = (self.sh.clone(), self.conn.clone(), self.chat.clone(), self.pg_url.clone(), self.listen.clone());
        self.sh.lock().unwrap().busy = true;
        self.rt.spawn(async move {
            let l2 = sh.clone();
            let log: tgpg_core::engine::LogCb = Arc::new(move |m, _| push(&l2, m));
            let r: anyhow::Result<()> = async {
                let addr: std::net::SocketAddr = listen.parse()?;
                if !addr.ip().is_loopback() { anyhow::bail!("hanya loopback yang diizinkan"); }
                let e = tgpg::open_engine(&client, &conn, Some(&chat), &pg, log).await?;
                sh.lock().unwrap().engine = Some(e.clone());
                let bind = tokio::net::TcpListener::bind(addr).await.map_err(|x| anyhow::anyhow!("port {addr} tidak bisa dipakai: {x}"))?;
                sh.lock().unwrap().serving = Some(addr.to_string());
                let e3 = e.clone();
                tokio::spawn(async move { let _ = tgpg_bridge::serve_listener(e3, bind).await; });
                let sh2 = sh.clone();
                tokio::spawn(async move { loop { let m = e.member_list().await; sh2.lock().unwrap().members = m; tokio::time::sleep(std::time::Duration::from_secs(3)).await; } });
                Ok(())
            }.await;
            let mut s = sh.lock().unwrap(); s.busy = false;
            drop(s);
            if let Err(e) = r { push(&sh, format!("Gagal membuka database: {e}")); }
        });
    }

    fn act(&self, label: &'static str, f: impl FnOnce(Engine) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>> + Send + 'static) {
        let Some(e) = self.sh.lock().unwrap().engine.clone() else { return };
        let sh = self.sh.clone();
        self.rt.spawn(async move { match f(e).await { Ok(m) => push(&sh, format!("{label}: {m}")), Err(e) => push(&sh, format!("{label} gagal: {e}")) } });
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        ctx.request_repaint_after(std::time::Duration::from_millis(500));
        let (auth, serving, busy, members, logs) = { let s = self.sh.lock().unwrap(); (s.auth, s.serving.clone(), s.busy, s.members.clone(), s.logs.clone()) };
        egui::TopBottomPanel::bottom("log").resizable(true).min_height(120.0).show(ctx, |ui| {
            ui.label("Log");
            egui::ScrollArea::vertical().stick_to_bottom(true).show(ui, |ui| { for l in &logs { ui.monospace(l); } });
        });
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("TGPG — Postgres lewat Telegram");
            ui.separator();
            ui.collapsing("1. Telegram", |ui| {
                ui.horizontal(|ui| { ui.label("API ID"); ui.text_edit_singleline(&mut self.api_id); });
                ui.horizontal(|ui| { ui.label("API hash"); ui.add(egui::TextEdit::singleline(&mut self.api_hash).password(true)); });
                ui.horizontal(|ui| { ui.label("Nomor HP"); ui.text_edit_singleline(&mut self.phone); });
                match auth {
                    Auth::Off | Auth::LoggedOut => { if ui.button("Hubungkan / Login").clicked() { self.connect(); } }
                    Auth::NeedCode | Auth::NeedPassword => {
                        ui.label(if auth == Auth::NeedCode { "Masukkan kode OTP dari Telegram" } else { "Masukkan sandi 2FA" });
                        ui.horizontal(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut self.input).password(auth == Auth::NeedPassword));
                            if ui.button("Kirim").clicked() { if let Some(t) = &self.tx_in { let _ = t.send(std::mem::take(&mut self.input)); } }
                        });
                    }
                    Auth::In => { ui.colored_label(egui::Color32::GREEN, "Sudah login"); }
                }
            });
            ui.collapsing("2. Database", |ui| {
                ui.horizontal(|ui| { ui.label("Connection string"); ui.text_edit_singleline(&mut self.conn); });
                ui.horizontal(|ui| { ui.label("Judul grup (opsional)"); ui.text_edit_singleline(&mut self.chat); });
                ui.horizontal(|ui| { ui.label("Postgres lokal"); ui.text_edit_singleline(&mut self.pg_url); });
                ui.horizontal(|ui| { ui.label("Alamat server"); ui.text_edit_singleline(&mut self.listen); });
                ui.add_enabled_ui(auth == Auth::In && !busy && serving.is_none(), |ui| { if ui.button("Buka & jalankan server").clicked() { self.open_db(); } });
            });
            if let Some(a) = &serving {
                ui.separator();
                ui.colored_label(egui::Color32::GREEN, format!("Server aktif di {a} — DBeaver: host/port itu, database & user bebas, tanpa sandi (hanya localhost)"));
                ui.collapsing("Anggota", |ui| {
                    for m in &members {
                        ui.horizontal(|ui| {
                            ui.label(format!("{} [{}]{}{}", if m.name.is_empty() { &m.sid } else { &m.name }, m.status, if m.owner { " owner" } else { "" }, if m.me { " (saya)" } else { "" }));
                            if m.status == "pending" && ui.button("Setujui").clicked() { let sid = m.sid.clone(); self.act("Setujui", move |e| Box::pin(async move { e.approve(&sid).await.map(|_| "ok".into()) })); }
                            if m.status == "active" && !m.owner && !m.me && ui.button("Cabut akses").clicked() { let sid = m.sid.clone(); self.act("Cabut", move |e| Box::pin(async move { let (ep, sk) = e.rotate(&[sid]).await?; Ok(format!("epoch {ep}, dilewati {}", sk.len())) })); }
                        });
                    }
                });
            }
        });
    }
}

fn main() -> eframe::Result<()> {
    eframe::run_native("TGPG", eframe::NativeOptions::default(), Box::new(|_| Ok(Box::new(App::new()))))
}
