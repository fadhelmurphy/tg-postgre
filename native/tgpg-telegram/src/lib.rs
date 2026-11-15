//! Transport Telegram (MTProto lewat grammers) untuk TGPG. BELUM DIUJI terhadap Telegram sungguhan.
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use grammers_client::{message::InputMessage, Client, SignInError};
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_session::types::PeerRef;
use tgpg_core::transport::{Msg, Permanent, Transport};
use tokio::sync::broadcast;

pub struct Login { pub client: Client }

/// Sambung ke Telegram memakai file sesi; kembalikan klien (belum tentu sudah login).
pub async fn connect(session_path: &str, api_id: i32) -> anyhow::Result<Client> {
    let session = Arc::new(SqliteSession::open(session_path).await?);
    let SenderPool { runner, handle, .. } = SenderPool::new(Arc::clone(&session), api_id);
    let client = Client::new(handle);
    tokio::spawn(runner.run());
    Ok(client)
}

/// Login interaktif lewat callback (nomor, kode, sandi 2FA).
pub async fn login(client: &Client, api_hash: &str, ask: &(dyn Fn(&str) -> anyhow::Result<String> + Sync)) -> anyhow::Result<()> {
    if client.is_authorized().await? { return Ok(()); }
    let phone = ask("Nomor telepon (format internasional)")?;
    let token = client.request_login_code(phone.trim(), api_hash).await?;
    let code = ask("Kode OTP dari Telegram")?;
    match client.sign_in(&token, code.trim()).await {
        Ok(_) => Ok(()),
        Err(SignInError::PasswordRequired(pt)) => {
            let pw = ask(&format!("Sandi 2FA (petunjuk: {})", pt.hint().unwrap_or("-")))?;
            client.check_password(pt, pw.trim()).await.map_err(|e| anyhow::anyhow!("sandi 2FA salah: {e}"))?;
            Ok(())
        }
        Err(e) => Err(anyhow::anyhow!("login gagal: {e}")),
    }
}

/// Cari grup berdasarkan judul persis di daftar dialog.
pub async fn find_chat(client: &Client, title: &str) -> anyhow::Result<PeerRef> {
    let mut it = client.iter_dialogs();
    while let Some(d) = it.next().await? {
        if d.peer().name().unwrap_or_default() == title { return Ok(d.peer_ref()); }
    }
    anyhow::bail!("grup \"{title}\" tidak ditemukan di dialog Anda")
}

/// Gabung lewat tautan undangan lalu kembalikan peer grup.
pub async fn join_by_link(client: &Client, link: &str) -> anyhow::Result<PeerRef> {
    let peer = client.accept_invite_link(link).await?.ok_or_else(|| anyhow::anyhow!("tautan undangan tidak valid"))?;
    Ok(peer.to_ref().await.map_err(|e| anyhow::anyhow!(e.to_string()))?.ok_or_else(|| anyhow::anyhow!("peer grup tidak bisa diresolusi"))?)
}

pub struct TelegramTransport { client: Client, chat: PeerRef, tx: broadcast::Sender<()> }

impl TelegramTransport {
    /// `poll`: jeda polling pesan baru (subscribe memicu sync tiap tick bila ada id baru).
    pub fn new(client: Client, chat: PeerRef, poll: Duration) -> Arc<Self> {
        let (tx, _) = broadcast::channel(16);
        let t = Arc::new(Self { client, chat, tx });
        let w = Arc::downgrade(&t);
        tokio::spawn(async move {
            let mut last = 0i64;
            loop {
                tokio::time::sleep(poll).await;
                let Some(t) = w.upgrade() else { break };
                if let Ok(m) = t.list_after(last, 1).await { if let Some(x) = m.last() { if x.id != last { last = x.id; let _ = t.tx.send(()); } } }
            }
        });
        t
    }
    fn map_err(e: grammers_client::InvocationError) -> anyhow::Error {
        let s = e.to_string();
        if s.contains("CHAT_WRITE_FORBIDDEN") || s.contains("USER_BANNED_IN_CHANNEL") || s.contains("CHAT_ADMIN_REQUIRED") { Permanent(s).into() } else { anyhow::anyhow!(s) }
    }
}

#[async_trait]
impl Transport for TelegramTransport {
    async fn self_id(&self) -> anyhow::Result<String> { Ok(self.client.get_me().await.map_err(Self::map_err)?.id().bare_id_unchecked().to_string()) }

    async fn list_after(&self, id: i64, limit: usize) -> anyhow::Result<Vec<Msg>> {
        let mut it = self.client.iter_messages(self.chat);   // terbaru → terlama
        let mut out = vec![];
        while let Some(m) = it.next().await.map_err(Self::map_err)? {
            if (m.id() as i64) <= id { break; }
            out.push(Msg { id: m.id() as i64, text: m.text().to_string(), has_file: m.media().is_some(), edited: m.edit_date().is_some(),
                sender: m.sender_id().map(|p| p.bare_id_unchecked().to_string()).unwrap_or_default() });
        }
        out.reverse(); out.truncate(limit);   // `limit` pertama setelah `id`, urut naik
        Ok(out)
    }

    async fn send_text(&self, text: &str) -> anyhow::Result<i64> {
        Ok(self.client.send_message(self.chat, InputMessage::new().text(text)).await.map_err(Self::map_err)?.id() as i64)
    }

    async fn send_file(&self, bytes: &[u8], caption: &str) -> anyhow::Result<i64> {
        let mut cur = std::io::Cursor::new(bytes.to_vec());
        let up = self.client.upload_stream(&mut cur, bytes.len(), "op.bin".into()).await?;
        Ok(self.client.send_message(self.chat, InputMessage::new().text(caption).file(up)).await.map_err(Self::map_err)?.id() as i64)
    }

    async fn download(&self, id: i64) -> anyhow::Result<Vec<u8>> {
        let msgs = self.client.get_messages_by_id(self.chat, &[id as i32]).await.map_err(Self::map_err)?;
        let m = msgs.into_iter().flatten().next().ok_or_else(|| anyhow::anyhow!("pesan #{id} tidak ada"))?;
        let media = m.media().ok_or_else(|| anyhow::anyhow!("pesan #{id} tanpa berkas"))?;
        let mut it = self.client.iter_download(&media);
        let mut out = vec![];
        while let Some(chunk) = it.next().await.map_err(Self::map_err)? { out.extend_from_slice(&chunk); }
        Ok(out)
    }

    fn subscribe(&self) -> broadcast::Receiver<()> { self.tx.subscribe() }
}
