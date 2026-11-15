//! Transport log (Telegram atau memori untuk tes).
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

#[derive(Clone, Debug)]
pub struct Msg { pub id: i64, pub text: String, pub has_file: bool, pub edited: bool, pub sender: String }

/// Error permanen (mis. CHAT_WRITE_FORBIDDEN): jangan di-retry.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Permanent(pub String);

#[async_trait]
pub trait Transport: Send + Sync {
    async fn self_id(&self) -> anyhow::Result<String>;
    /// Semua pesan dengan id > `id`, urut naik, paling banyak `limit`.
    async fn list_after(&self, id: i64, limit: usize) -> anyhow::Result<Vec<Msg>>;
    async fn send_text(&self, text: &str) -> anyhow::Result<i64>;
    async fn send_file(&self, bytes: &[u8], caption: &str) -> anyhow::Result<i64>;
    async fn download(&self, id: i64) -> anyhow::Result<Vec<u8>>;
    /// Dipicu tiap ada pesan baru.
    fn subscribe(&self) -> broadcast::Receiver<()>;
}

/// Bentuk dump kanal — sama dengan yang ditulis tes JS (tests/memory-transport.js).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DumpMsg { pub id: i64, #[serde(default)] pub text: String, #[serde(default)] pub file: Option<String>, #[serde(default)] pub sender: String }

struct Inner { msgs: Vec<(Msg, Option<Vec<u8>>)>, next: i64 }

#[derive(Clone)]
pub struct MemChannel { inner: Arc<Mutex<Inner>>, tx: broadcast::Sender<()> }

impl Default for MemChannel { fn default() -> Self { Self::new() } }
impl MemChannel {
    pub fn new() -> Self { Self { inner: Arc::new(Mutex::new(Inner { msgs: vec![], next: 1 })), tx: broadcast::channel(64).0 } }
    pub fn handle(&self, sender: &str) -> Arc<MemTransport> { Arc::new(MemTransport { ch: self.clone(), sender: sender.into() }) }
    pub fn len(&self) -> usize { self.inner.lock().unwrap().msgs.len() }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    pub fn push_raw(&self, sender: &str, text: &str, file: Option<Vec<u8>>) -> i64 {
        let mut g = self.inner.lock().unwrap(); let id = g.next; g.next += 1;
        g.msgs.push((Msg { id, text: text.into(), has_file: file.is_some(), edited: false, sender: sender.into() }, file));
        drop(g); let _ = self.tx.send(()); id
    }
    pub fn dump(&self) -> Vec<DumpMsg> {
        use crate::crypto::b64;
        self.inner.lock().unwrap().msgs.iter().map(|(m, f)| DumpMsg { id: m.id, text: m.text.clone(), file: f.as_ref().map(|b| b64(b)), sender: m.sender.clone() }).collect()
    }
    pub fn load(dump: &[DumpMsg]) -> anyhow::Result<Self> {
        let ch = Self::new(); let mut g = ch.inner.lock().unwrap();
        for d in dump {
            let file = match &d.file { Some(s) => Some(crate::crypto::unb64(s)?), None => None };
            g.msgs.push((Msg { id: d.id, text: d.text.clone(), has_file: file.is_some(), edited: false, sender: d.sender.clone() }, file));
            g.next = g.next.max(d.id + 1);
        }
        drop(g); Ok(ch)
    }
}

pub struct MemTransport { ch: MemChannel, sender: String }

#[async_trait]
impl Transport for MemTransport {
    async fn self_id(&self) -> anyhow::Result<String> { Ok(self.sender.clone()) }
    async fn list_after(&self, id: i64, limit: usize) -> anyhow::Result<Vec<Msg>> {
        Ok(self.ch.inner.lock().unwrap().msgs.iter().filter(|(m, _)| m.id > id).take(limit).map(|(m, _)| m.clone()).collect())
    }
    async fn send_text(&self, text: &str) -> anyhow::Result<i64> { Ok(self.ch.push_raw(&self.sender, text, None)) }
    async fn send_file(&self, bytes: &[u8], caption: &str) -> anyhow::Result<i64> { Ok(self.ch.push_raw(&self.sender, caption, Some(bytes.to_vec()))) }
    async fn download(&self, id: i64) -> anyhow::Result<Vec<u8>> {
        self.ch.inner.lock().unwrap().msgs.iter().find(|(m, _)| m.id == id).and_then(|(_, f)| f.clone()).ok_or_else(|| anyhow::anyhow!("file #{id} tidak ada"))
    }
    fn subscribe(&self) -> broadcast::Receiver<()> { self.ch.tx.subscribe() }
}
