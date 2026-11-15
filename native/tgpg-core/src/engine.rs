//! Engine: Postgres nyata (lokal) + log op terenkripsi di sebuah Transport. Port dari src/engine.js —
//! semantik penerapan (determinisme, dedupe, epoch kunci, anggota) identik agar klien JS dan Rust konvergen.
use crate::crypto::{b64, random_key, unb64, unwrap, wrap_for, Identity, SymKey, Wrap};
use crate::ops::*;
use crate::sqlx::{is_read, rewrite};
use crate::transport::{Msg, Permanent, Transport};
use anyhow::{bail, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};
use tokio_postgres::types::{FromSql, IsNull, Kind as PgKind, ToSql, Type};
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};

/// Sumber tunggal dengan klien JS.
pub const INIT_SQL: &str = include_str!("../../../src/init.sql");
const BATCH: usize = 100;
const SEEN_KEEP: i64 = 5000;
const SEND_TRIES: u32 = 3;

#[derive(Debug, thiserror::Error)]
#[error("butuh kunci epoch {0}")]
pub struct Blocked(pub u64);

/// Error deterministik dari Postgres saat op diterapkan (sama di semua klien).
#[derive(Clone, Debug, PartialEq)]
pub struct OpError { pub code: String, pub message: String }
impl std::fmt::Display for OpError { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.message) } }
impl std::error::Error for OpError {}
type OpResult = std::result::Result<Vec<StmtResult>, OpError>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StmtResult { pub columns: Vec<String>, pub rows: Vec<Vec<Option<String>>>, pub affected: Option<u64> }

#[derive(Clone, Debug, PartialEq)]
pub struct Member { pub sid: String, pub pub_key: String, pub name: String, pub status: String, pub owner: bool, pub me: bool }

#[derive(Debug)]
pub struct WriteOutcome { pub id: i64, pub result: OpResult }

/// Hasil describe (parameter & kolom) dari Postgres lokal.
#[derive(Clone, Debug)]
pub struct Described { pub params: Vec<u32>, pub cols: Vec<(String, u32)> }

/// Hasil baca dengan format kolom sesuai permintaan klien (teks/biner).
#[derive(Debug)]
pub struct Rowset { pub cols: Vec<(String, u32)>, pub rows: Vec<Vec<Option<Vec<u8>>>> }

struct Raw<'a>(&'a [u8]);
impl<'a> FromSql<'a> for Raw<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> std::result::Result<Self, Box<dyn std::error::Error + Sync + Send>> { Ok(Raw(raw)) }
    fn accepts(_: &Type) -> bool { true }
}
#[derive(Debug)]
struct RawParam<'a>(&'a [u8]);
impl ToSql for RawParam<'_> {
    fn to_sql(&self, _: &Type, out: &mut bytes::BytesMut) -> std::result::Result<IsNull, Box<dyn std::error::Error + Sync + Send>> { out.extend_from_slice(self.0); Ok(IsNull::No) }
    fn accepts(_: &Type) -> bool { true }
    tokio_postgres::types::to_sql_checked!();
}

pub type LogCb = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type KeysCb = Arc<dyn Fn(BTreeMap<u64, String>) + Send + Sync>;

pub struct OpenOpts {
    pub transport: Arc<dyn Transport>,
    pub root_key: SymKey,
    pub pg_url: String,
    pub identity: Identity,
    pub keys: BTreeMap<u64, String>,
    pub on_keys: Option<KeysCb>,
    pub author: String,
    pub log: Option<LogCb>,
}

#[derive(Clone)]
struct MemberRow { pub_key: String, name: String, status: String }

#[derive(Default)]
struct State {
    last_applied: i64, owner: String, db_epoch: u64, my_epoch: u64,
    ring: BTreeMap<u64, SymKey>, ring_raw: BTreeMap<u64, String>,
    members: BTreeMap<String, MemberRow>,
    blocked: Option<u64>, scan_pos: Option<i64>,
    results: HashMap<String, OpResult>,
    warned_edited: std::collections::HashSet<i64>, decrypt_errors: u64,
}

struct Inner {
    t: Arc<dyn Transport>, root: SymKey, identity: Identity, self_id: String, author: String, cid: String,
    db: Mutex<Client>, rdb: Mutex<Client>, rdb_task: tokio::task::JoinHandle<()>, type_names: std::sync::Mutex<HashMap<u32, String>>, st: Mutex<State>, sync_lock: Mutex<()>, applied: watch::Sender<i64>,
    on_keys: Option<KeysCb>, log: LogCb, pg_task: tokio::task::JoinHandle<()>, sub_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Engine(Arc<Inner>);

fn db_msg(e: &tokio_postgres::Error) -> String { e.as_db_error().map(|d| d.message().to_string()).unwrap_or_else(|| e.to_string()) }

fn collect(msgs: Vec<SimpleQueryMessage>) -> Vec<StmtResult> {
    let (mut out, mut cur) = (vec![], StmtResult::default());
    for m in msgs {
        match m {
            SimpleQueryMessage::RowDescription(cols) => cur.columns = cols.iter().map(|c| c.name().to_string()).collect(),
            SimpleQueryMessage::Row(r) => {
                if cur.columns.is_empty() { cur.columns = r.columns().iter().map(|c| c.name().to_string()).collect(); }
                cur.rows.push((0..r.len()).map(|i| r.get(i).map(String::from)).collect());
            }
            SimpleQueryMessage::CommandComplete(n) => { cur.affected = Some(n); out.push(std::mem::take(&mut cur)); }
            _ => {}
        }
    }
    out
}

fn iso(t: &str) -> String {
    DateTime::parse_from_rfc3339(t).map(|d| d.with_timezone(&Utc)).unwrap_or(DateTime::<Utc>::UNIX_EPOCH).to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl State {
    fn key_for(&self, root: &SymKey, epoch: u64) -> Option<SymKey> { if epoch == 0 { Some(root.clone()) } else { self.ring.get(&epoch).cloned() } }
    fn sender_ok(&self, sid: &str) -> bool {
        self.db_epoch == 0 || sid == self.owner || self.members.get(sid).map(|m| m.status == "active").unwrap_or(false)
    }
}

impl Engine {
    pub async fn open(o: OpenOpts) -> Result<Engine> {
        let (client, conn) = tokio_postgres::connect(&o.pg_url, NoTls).await?;
        let pg_task = tokio::spawn(async move { let _ = conn.await; });
        client.batch_execute("set timezone='UTC'; set datestyle='ISO, MDY'").await?;   // sama dgn PGlite: hasil teks op deterministik
        client.batch_execute(INIT_SQL).await?;
        let (rclient, rconn) = tokio_postgres::connect(&o.pg_url, NoTls).await?;
        let rdb_task = tokio::spawn(async move { let _ = rconn.await; });
        rclient.batch_execute("set timezone='UTC'; set datestyle='ISO, MDY'").await?;
        let last: i64 = client.query_one("select v from _tgpg_meta where k='last'", &[]).await?.get(0);
        let self_id = o.transport.self_id().await?;
        let log: LogCb = o.log.unwrap_or_else(|| Arc::new(|m, _| tracing::info!("{m}")));
        let (applied, _) = watch::channel(last);
        let inner = Arc::new(Inner {
            t: o.transport, root: o.root_key, identity: o.identity, self_id, author: o.author, cid: uuid::Uuid::new_v4().to_string(),
            db: Mutex::new(client), rdb: Mutex::new(rclient), rdb_task, type_names: Default::default(), st: Mutex::new(State { last_applied: last, ..Default::default() }), sync_lock: Mutex::new(()),
            applied, on_keys: o.on_keys, log, pg_task, sub_task: std::sync::Mutex::new(None),
        });
        let e = Engine(inner);
        for (ep, k) in &o.keys { e.add_key(*ep, k, false).await?; }
        e.load_ctl().await?;
        let (db_epoch, my_epoch) = { let s = e.0.st.lock().await; (s.db_epoch, s.my_epoch) };
        if db_epoch > my_epoch { e.scan_keys(Some(0)).await?; }   // kunci rotasi hilang: ambil ulang dari log
        e.sync().await?;
        e.ensure_hello().await;
        let weak = Arc::downgrade(&e.0); let mut rx = e.0.t.subscribe();
        let h = tokio::spawn(async move {
            loop {
                match rx.recv().await { Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}, Err(_) => break }
                match weak.upgrade() { Some(i) => { let _ = Engine(i).sync().await; } None => break }
            }
        });
        *e.0.sub_task.lock().unwrap() = Some(h);
        Ok(e)
    }

    pub fn close(&self) {
        if let Some(h) = self.0.sub_task.lock().unwrap().take() { h.abort(); }
        self.0.pg_task.abort(); self.0.rdb_task.abort();
    }

    fn log(&self, m: &str, lvl: &str) { (self.0.log)(m, lvl) }

    /* ───────── state ───────── */
    pub async fn last_applied(&self) -> i64 { self.0.st.lock().await.last_applied }
    pub async fn epoch(&self) -> (u64, u64) { let s = self.0.st.lock().await; (s.my_epoch, s.db_epoch) }
    pub async fn blocked(&self) -> Option<u64> { self.0.st.lock().await.blocked }
    pub async fn is_owner(&self) -> bool { let s = self.0.st.lock().await; !self.0.self_id.is_empty() && s.owner == self.0.self_id }
    pub fn self_id(&self) -> &str { &self.0.self_id }
    pub async fn ring_raw(&self) -> BTreeMap<u64, String> { self.0.st.lock().await.ring_raw.clone() }

    pub async fn member_list(&self) -> Vec<Member> {
        let s = self.0.st.lock().await;
        let mut v: Vec<Member> = s.members.iter().map(|(sid, m)| Member { sid: sid.clone(), pub_key: m.pub_key.clone(), name: m.name.clone(), status: m.status.clone(), owner: *sid == s.owner, me: *sid == self.0.self_id }).collect();
        if !s.owner.is_empty() && !s.members.contains_key(&s.owner) {
            v.insert(0, Member { sid: s.owner.clone(), pub_key: String::new(), name: String::new(), status: "active".into(), owner: true, me: s.owner == self.0.self_id });
        }
        v
    }

    async fn add_key(&self, epoch: u64, key_b64: &str, persist: bool) -> Result<bool> {
        if epoch < 1 { return Ok(false); }
        let raw = {
            let mut s = self.0.st.lock().await;
            if s.ring.contains_key(&epoch) { return Ok(false); }
            s.ring.insert(epoch, SymKey::new(&unb64(key_b64)?)?);
            s.ring_raw.insert(epoch, key_b64.to_string()); s.my_epoch = s.my_epoch.max(epoch);
            s.ring_raw.clone()
        };
        if persist { if let Some(cb) = &self.0.on_keys { cb(raw); } }
        Ok(true)
    }

    async fn load_ctl(&self) -> Result<()> {
        let db = self.0.db.lock().await;
        let ctl: HashMap<String, String> = db.query("select k, v from _tgpg_ctl", &[]).await?.iter().map(|r| (r.get(0), r.get(1))).collect();
        let members: BTreeMap<String, MemberRow> = db.query("select sid, pub, name, status from _tgpg_member", &[]).await?.iter()
            .map(|r| (r.get::<_, String>(0), MemberRow { pub_key: r.get(1), name: r.get(2), status: r.get(3) })).collect();
        drop(db);
        let mut s = self.0.st.lock().await;
        s.owner = ctl.get("owner").cloned().unwrap_or_default();
        s.db_epoch = ctl.get("epoch").and_then(|v| v.parse().ok()).unwrap_or(0);
        s.members = members; Ok(())
    }

    /* ───────── sinkron ───────── */
    pub async fn sync(&self) -> Result<()> {
        let _g = self.0.sync_lock.lock().await;
        match self.catch_up().await {
            Ok(()) => Ok(()),
            Err(e) => { self.log(&format!("Sync gagal: {e}"), "er"); Err(e) }
        }
    }

    async fn catch_up(&self) -> Result<()> {
        loop {
            let last = self.0.st.lock().await.last_applied;
            let mut msgs: Vec<Msg> = self.0.t.list_after(last, BATCH).await?.into_iter().filter(|m| m.id > last).collect();
            msgs.sort_by_key(|m| m.id);
            if msgs.is_empty() { break; }
            let n = msgs.len();
            for m in msgs {
                if let Err(e) = self.apply(&m).await {
                    if let Some(b) = e.downcast_ref::<Blocked>() {
                        let mut s = self.0.st.lock().await;
                        if s.blocked != Some(b.0) { drop(s); self.log(&format!("Menunggu persetujuan owner (butuh kunci epoch {}).", b.0), "er"); s = self.0.st.lock().await; }
                        s.blocked = Some(b.0); return Ok(());
                    }
                    return Err(e);
                }
            }
            if n < BATCH { break; }
        }
        let mut s = self.0.st.lock().await; s.blocked = None; s.scan_pos = None; Ok(())
    }

    async fn set_last(&self, id: i64) -> Result<()> {
        self.0.db.lock().await.execute("update _tgpg_meta set v=$1 where k='last'", &[&id]).await?; Ok(())
    }

    async fn apply(&self, m: &Msg) -> Result<()> {
        let sender = m.sender.clone();
        let set_owner = { let mut s = self.0.st.lock().await; if s.owner.is_empty() && m.text.starts_with("TGPG") { s.owner = sender.clone(); true } else { false } };
        if set_owner { self.0.db.lock().await.execute("insert into _tgpg_ctl values ('owner', $1) on conflict do nothing", &[&sender]).await?; }
        match classify(&m.text, m.has_file) {
            Kind::Ctl => self.apply_ctl(m).await?,
            Kind::Op { epoch, data } => self.apply_op(m, epoch, data).await?,
            _ => self.set_last(m.id).await?,
        }
        if m.edited {
            let first = self.0.st.lock().await.warned_edited.insert(m.id);
            if first { self.log(&format!("#{} pernah diedit di Telegram; salinan lain bisa berbeda.", m.id), "er"); }
        }
        self.0.st.lock().await.last_applied = m.id;
        self.0.applied.send_replace(m.id);
        Ok(())
    }

    async fn apply_op(&self, m: &Msg, epoch: u64, data: OpData) -> Result<()> {
        let ok = self.0.st.lock().await.sender_ok(&m.sender);
        if !ok { self.log(&format!("#{} dilewati: pengirim tidak berwenang (belum disetujui / dicabut)", m.id), "er"); return self.set_last(m.id).await; }
        let mut key = self.0.st.lock().await.key_for(&self.0.root, epoch);
        if key.is_none() && epoch > 0 && self.scan_keys(None).await? { key = self.0.st.lock().await.key_for(&self.0.root, epoch); }
        let Some(key) = key else { return Err(Blocked(epoch).into()) };
        let bytes = match data { OpData::Inline(b) => b, OpData::File => self.0.t.download(m.id).await? };
        let op: Option<Op> = match key.decrypt(&bytes).and_then(|p| Ok(serde_json::from_slice::<Op>(&p)?)) {
            Ok(op) if op.v == 1 => Some(op),
            Ok(_) => None,
            Err(_) => { self.0.st.lock().await.decrypt_errors += 1; self.log(&format!("#{}: op tidak bisa dibuka (kunci salah / pesan rusak)", m.id), "er"); None }
        };
        let Some(op) = op else { return self.set_last(m.id).await };
        let res = self.run_op(&op, m.id).await?;
        if let Some(res) = res {   // None = duplikat
            if let Err(e) = &res { self.log(&format!("#{} ditolak: {}", m.id, e.message), "er"); }
            if op.cid == self.0.cid { self.0.st.lock().await.results.insert(op.oid.clone(), res); }
            else { self.log(&format!("#{} {}: {}", m.id, op.a, op.sql.chars().take(80).collect::<String>().replace('\n', " ")), "mu"); }
        }
        Ok(())
    }

    /// Jalankan op dalam satu transaksi. Ok(None)=duplikat, Ok(Some(Err))=ditolak deterministik oleh Postgres, Err=masalah koneksi.
    async fn run_op(&self, op: &Op, id: i64) -> Result<Option<OpResult>> {
        let ts = iso(&op.t); let seed = id.to_string();
        let mut db = self.0.db.lock().await;
        let r: std::result::Result<Option<Vec<StmtResult>>, tokio_postgres::Error> = async {
            let tx = db.transaction().await?;
            if !op.oid.is_empty() {
                let n = tx.execute("insert into _tgpg_seen(oid, msg) values ($1, $2) on conflict do nothing", &[&op.oid, &id]).await?;
                if n == 0 { tx.execute("update _tgpg_meta set v=$1 where k='last'", &[&id]).await?; tx.commit().await?; return Ok(None); }
            }
            tx.query("select set_config('tgpg.ts',$1,true), set_config('tgpg.seed',$2,true), set_config('tgpg.n','0',true)", &[&ts, &seed]).await?;
            let res = collect(tx.simple_query(&op.sql).await?);
            if id % 100 == 0 { tx.execute("delete from _tgpg_seen where msg < $1", &[&(id - SEEN_KEEP)]).await?; }
            tx.execute("update _tgpg_meta set v=$1 where k='last'", &[&id]).await?;
            tx.commit().await?; Ok(Some(res))
        }.await;
        match r {
            Ok(None) => Ok(None),
            Ok(Some(res)) => Ok(Some(Ok(res))),
            Err(e) if e.as_db_error().is_some() => {   // error deterministik (unique violation dsb): semua klien gagal sama
                db.execute("update _tgpg_meta set v=$1 where k='last'", &[&id]).await?;
                Ok(Some(Err(OpError { code: e.code().map(|c| c.code().to_string()).unwrap_or_else(|| "XX000".into()), message: db_msg(&e) })))
            }
            Err(e) => Err(e.into()),
        }
    }

    /* ───────── pesan kontrol ───────── */
    async fn read_ctl(&self, m: &Msg) -> Option<Ctl> {
        let txt = if m.has_file { String::from_utf8(self.0.t.download(m.id).await.ok()?).ok()? } else { m.text.get(CTL.len() + 1..)?.to_string() };
        serde_json::from_str(&txt).ok()
    }

    async fn take_keys(&self, wraps: &BTreeMap<String, Wrap>) -> bool {
        let Some(w) = wraps.get(&self.0.self_id) else { return false };
        let mut got = false;
        match unwrap(&self.0.identity, w).and_then(|p| Ok(serde_json::from_slice::<BTreeMap<String, String>>(&p)?)) {
            Ok(ring) => for (ep, k) in ring { if let Ok(ep) = ep.parse::<u64>() { got = self.add_key(ep, &k, true).await.unwrap_or(false) || got; } },
            Err(e) => self.log(&format!("Gagal membuka kunci rotasi: {e}"), "er"),
        }
        got
    }

    /// Pindai log ke depan mencari pesan 'keys' untuk diri sendiri (tanpa menerapkan op).
    async fn scan_keys(&self, from: Option<i64>) -> Result<bool> {
        let (mut pos, mut owner) = { let s = self.0.st.lock().await; (from.or(s.scan_pos).unwrap_or(s.last_applied), s.owner.clone()) };
        let mut got = false;
        loop {
            let mut msgs: Vec<Msg> = self.0.t.list_after(pos, BATCH).await?.into_iter().filter(|m| m.id > pos).collect();
            msgs.sort_by_key(|m| m.id);
            if msgs.is_empty() { break; }
            let n = msgs.len();
            for m in msgs {
                pos = m.id;
                if owner.is_empty() && m.text.starts_with("TGPG") { owner = m.sender.clone(); }
                if m.text.starts_with(CTL) && m.sender == owner {
                    if let Some(Ctl::Keys { wraps, .. }) = self.read_ctl(&m).await { got = self.take_keys(&wraps).await || got; }
                }
            }
            if n < BATCH { break; }
        }
        self.0.st.lock().await.scan_pos = Some(pos); Ok(got)
    }

    async fn apply_ctl(&self, m: &Msg) -> Result<()> {
        let sender = m.sender.clone();
        let ctl = self.read_ctl(m).await;
        let (owner, db_epoch, members) = { let s = self.0.st.lock().await; (s.owner.clone(), s.db_epoch, s.members.clone()) };
        let mut keys_wraps: Option<BTreeMap<String, Wrap>> = None;
        {
            let mut db = self.0.db.lock().await; let tx = db.transaction().await?;
            match &ctl {
                Some(Ctl::Hello { pub_key, name }) => {
                    let auto = db_epoch == 0 || sender == owner;
                    let skip = members.get(&sender).map(|e| e.status == "removed" || e.pub_key == *pub_key).unwrap_or(false);
                    if !skip {
                        let nm: String = name.chars().take(60).collect();
                        tx.execute("insert into _tgpg_member values ($1,$2,$3,$4) on conflict (sid) do update set pub=$2, name=$3, status=$4",
                            &[&sender, pub_key, &nm, &(if auto { "active" } else { "pending" })]).await?;
                    }
                }
                Some(Ctl::Keys { n, wraps, remove }) if sender == owner && (*n == db_epoch || *n == db_epoch + 1) => {
                    if *n == db_epoch + 1 {
                        tx.execute("update _tgpg_member set status='pending' where status='active' and sid <> $1", &[&owner]).await?;
                        tx.execute("insert into _tgpg_ctl values ('epoch', $1) on conflict (k) do update set v=$1", &[&n.to_string()]).await?;
                    }
                    for sid in wraps.keys() {
                        tx.execute("insert into _tgpg_member values ($1,'','','active') on conflict (sid) do update set status='active' where _tgpg_member.status <> 'removed'", &[sid]).await?;
                    }
                    for sid in remove {
                        tx.execute("insert into _tgpg_member values ($1,'','','removed') on conflict (sid) do update set status='removed'", &[sid]).await?;
                    }
                    keys_wraps = Some(wraps.clone());
                }
                _ => {}
            }
            tx.execute("update _tgpg_meta set v=$1 where k='last'", &[&m.id]).await?;
            tx.commit().await?;
        }
        self.load_ctl().await?;
        if let Some(w) = keys_wraps { self.take_keys(&w).await; }
        Ok(())
    }

    async fn ensure_hello(&self) {
        let me = self.0.st.lock().await.members.get(&self.0.self_id).cloned();
        if let Some(me) = me { if me.pub_key == self.0.identity.pub_b64() || me.status == "removed" { return; } }
        // tidak menunggu: anggota yang terblokir tidak akan menerapkannya sampai disetujui
        if let Err(e) = self.send_ctl(&Ctl::Hello { pub_key: self.0.identity.pub_b64().to_string(), name: self.0.author.clone() }, false).await {
            self.log(&format!("Gagal mendaftarkan identitas: {e}"), "er");
        }
    }

    async fn send_msg(&self, text: Option<String>, file: Option<(Vec<u8>, String)>) -> Result<i64> {
        let mut i = 0;
        loop {
            i += 1;
            let r = match (&text, &file) { (Some(t), _) => self.0.t.send_text(t).await, (None, Some((b, c))) => self.0.t.send_file(b, c).await, _ => unreachable!() };
            match r {
                Ok(id) => return Ok(id),
                Err(e) => {
                    if e.downcast_ref::<Permanent>().is_some() || i >= SEND_TRIES { return Err(e); }
                    self.log(&format!("Kirim gagal ({e}), mencoba lagi {i}/{}…", SEND_TRIES - 1), "er");
                    tokio::time::sleep(Duration::from_millis(800 * i as u64)).await;
                }
            }
        }
    }

    async fn wait_applied(&self, id: i64, timeout: Duration) -> Result<()> {
        let end = tokio::time::Instant::now() + timeout;
        loop {
            if *self.0.applied.borrow() >= id { return Ok(()); }
            let _ = self.sync().await;
            if *self.0.applied.borrow() >= id { return Ok(()); }
            if tokio::time::Instant::now() >= end { bail!("Terkirim sebagai #{id} tapi belum terkonfirmasi; akan diterapkan saat sinkron."); }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn send_ctl(&self, c: &Ctl, wait: bool) -> Result<i64> {
        let json = serde_json::to_string(c)?;
        let id = if json.len() <= 3500 { self.send_msg(Some(format!("{CTL} {json}")), None).await? } else { self.send_msg(None, Some((json.into_bytes(), CTL.to_string()))).await? };
        if wait { self.wait_applied(id, Duration::from_secs(30)).await?; }
        Ok(id)
    }

    /// Owner: beri anggota 'pending' akses ke seluruh kunci.
    pub async fn approve(&self, sid: &str) -> Result<()> {
        if !self.is_owner().await { bail!("Hanya owner yang bisa menyetujui anggota."); }
        let (m, ring, n) = { let s = self.0.st.lock().await; (s.members.get(sid).cloned(), s.ring_raw.clone(), s.db_epoch) };
        let Some(m) = m.filter(|m| m.status == "pending") else { bail!("Anggota tidak sedang menunggu persetujuan.") };
        if m.pub_key.is_empty() { bail!("Anggota belum mendaftarkan kunci publik."); }
        let mut wraps = BTreeMap::new();
        wraps.insert(sid.to_string(), wrap_for(&m.pub_key, &serde_json::to_vec(&ring)?)?);
        self.send_ctl(&Ctl::Keys { n, wraps, remove: vec![] }, true).await?; Ok(())
    }

    /// Owner: ganti kunci database; anggota di `remove` tidak menerima kunci baru dan op-nya ditolak seterusnya.
    pub async fn rotate(&self, remove: &[String]) -> Result<(u64, Vec<String>)> {
        if !self.is_owner().await { bail!("Hanya owner yang bisa merotasi kunci."); }
        let (my, dbe, owner) = { let s = self.0.st.lock().await; (s.my_epoch, s.db_epoch, s.owner.clone()) };
        if my < dbe { bail!("Owner belum memegang kunci terbaru."); }
        if remove.contains(&owner) { bail!("Owner tidak bisa mencabut dirinya sendiri."); }
        let n = dbe + 1; let fresh = b64(&random_key());
        let mut ring = self.ring_raw().await; ring.insert(n, fresh);
        let ring_json = serde_json::to_vec(&ring)?;
        let mut wraps = BTreeMap::new(); let mut skipped = vec![];
        wraps.insert(self.0.self_id.clone(), wrap_for(self.0.identity.pub_b64(), &ring_json)?);
        let members = self.0.st.lock().await.members.clone();
        for (sid, m) in members {
            if sid == self.0.self_id || m.status != "active" || remove.contains(&sid) { continue; }
            if m.pub_key.is_empty() { skipped.push(sid); continue; }
            wraps.insert(sid, wrap_for(&m.pub_key, &ring_json)?);
        }
        self.send_ctl(&Ctl::Keys { n, wraps, remove: remove.to_vec() }, true).await?;
        Ok((n, skipped))
    }

    /* ───────── baca / tulis ───────── */

    /// Baca lokal (read-only), tidak masuk log.
    pub async fn read(&self, sql: &str) -> Result<Vec<StmtResult>> {
        let mut db = self.0.rdb.lock().await;
        let tx = db.transaction().await?;
        tx.batch_execute("set transaction read only").await?;
        Ok(collect(tx.simple_query(sql).await.map_err(|e| anyhow::anyhow!(db_msg(&e)))?))
    }

    /// Statement sesi lokal yang tidak boleh masuk log (SET/RESET/DISCARD/DEALLOCATE). Dijalankan di koneksi baca, bukan koneksi penerap op.
    pub async fn session_exec(&self, sql: &str) -> Result<()> {
        self.0.rdb.lock().await.batch_execute(sql).await.map_err(|e| anyhow::anyhow!(db_msg(&e)))
    }

    /// Deskripsi statement (tipe parameter & kolom) dari Postgres lokal, tanpa menjalankannya.
    pub async fn describe(&self, sql: &str) -> Result<Described> {
        let db = self.0.rdb.lock().await;
        let st = db.prepare(sql).await.map_err(|e| anyhow::anyhow!(db_msg(&e)))?;
        Ok(Described { params: st.params().iter().map(|t| t.oid()).collect(), cols: st.columns().iter().map(|c| (c.name().to_string(), c.type_().oid())).collect() })
    }

    /// Baca satu statement; kolom `binary[i]` dikembalikan dalam format biner, sisanya teks (satu snapshot).
    pub async fn read_mixed(&self, sql: &str, binary: &(dyn Fn(usize) -> bool + Sync)) -> Result<Rowset> {
        let mut db = self.0.rdb.lock().await;
        let tx = db.build_transaction().isolation_level(tokio_postgres::IsolationLevel::RepeatableRead).read_only(true).start().await.map_err(|e| anyhow::anyhow!(db_msg(&e)))?;
        let wrap = |e: tokio_postgres::Error| anyhow::anyhow!(db_msg(&e));
        let st = tx.prepare(sql).await.map_err(wrap)?;
        let cols: Vec<(String, u32)> = st.columns().iter().map(|c| (c.name().to_string(), c.type_().oid())).collect();
        let is_bin = |i: usize| binary(i);
        let (want_text, want_bin) = ((0..cols.len()).any(|i| !is_bin(i)), (0..cols.len()).any(is_bin));
        let mut rows: Vec<Vec<Option<Vec<u8>>>> = vec![];
        if want_text {
            for m in tx.simple_query(sql).await.map_err(wrap)? {
                if let SimpleQueryMessage::Row(r) = m { rows.push((0..cols.len()).map(|i| r.get(i).map(|v| v.as_bytes().to_vec())).collect()); }
            }
        }
        if want_bin {
            let brows = tx.query(&st, &[]).await.map_err(wrap)?;
            if !want_text { rows = vec![vec![None; cols.len()]; brows.len()]; }
            if brows.len() != rows.len() { bail!("jumlah baris tidak konsisten antar format"); }
            for (ri, r) in brows.iter().enumerate() {
                for i in (0..cols.len()).filter(|i| is_bin(*i)) { rows[ri][i] = r.try_get::<_, Option<Raw>>(i).map_err(wrap)?.map(|v| v.0.to_vec()); }
            }
        }
        Ok(Rowset { cols, rows })
    }

    async fn type_name(&self, oid: u32) -> Result<String> {
        if let Some(n) = self.0.type_names.lock().unwrap().get(&oid) { return Ok(n.clone()); }
        let db = self.0.rdb.lock().await;
        let n: String = db.query_one("select ($1::oid)::regtype::text", &[&oid]).await.map_err(|e| anyhow::anyhow!(db_msg(&e)))?.get(0);
        self.0.type_names.lock().unwrap().insert(oid, n.clone()); Ok(n)
    }

    /// Ubah satu parameter bind menjadi literal SQL bertipe, mis. `('5'::integer)`. Nilai biner dikonversi ke teks oleh Postgres lokal.
    pub async fn render_param(&self, oid: u32, binary: bool, data: Option<&[u8]>) -> Result<String> {
        if oid == 0 { bail!("tipe parameter tidak diketahui"); }
        let tname = self.type_name(oid).await?;
        let Some(d) = data else { return Ok(format!("(NULL::{tname})")) };
        let text = if binary {
            let ty = Type::from_oid(oid).unwrap_or_else(|| Type::new(String::new(), oid, PgKind::Simple, String::new()));
            let db = self.0.rdb.lock().await;
            let st = db.prepare_typed("select ($1)::text", &[ty]).await.map_err(|e| anyhow::anyhow!(db_msg(&e)))?;
            db.query_one(&st, &[&RawParam(d)]).await.map_err(|e| anyhow::anyhow!("parameter biner tidak valid: {}", db_msg(&e)))?.get::<_, String>(0)
        } else { String::from_utf8(d.to_vec()).map_err(|_| anyhow::anyhow!("parameter bukan UTF-8"))? };
        if text.contains('\0') { bail!("parameter mengandung NUL"); }
        Ok(format!("('{}'::{tname})", text.replace('\'', "''")))
    }

    /// SELECT lokal; selain itu masuk log.
    pub async fn run(&self, sql: &str) -> Result<RunOutcome> {
        if is_read(sql) { Ok(RunOutcome::Read(self.read(sql).await?)) } else { Ok(RunOutcome::Write(self.write(sql).await?)) }
    }

    pub async fn write(&self, sql: &str) -> Result<WriteOutcome> {
        let (epoch, key) = {
            let s = self.0.st.lock().await;
            if !(s.sender_ok(&self.0.self_id) && s.my_epoch >= s.db_epoch) { bail!("Belum punya akses tulis: menunggu persetujuan owner database."); }
            (s.my_epoch, s.key_for(&self.0.root, s.my_epoch).unwrap())
        };
        let op = Op { v: 1, sql: rewrite(sql), a: self.0.author.clone(), t: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true), cid: self.0.cid.clone(), oid: uuid::Uuid::new_v4().to_string() };
        let plain = serde_json::to_vec(&op)?;
        if plain.len() > MAX_OP { bail!("Statement terlalu besar (maks 8 MB)."); }
        let enc = key.encrypt(&plain);
        let id = if plain.len() <= TEXT_LIMIT { self.send_msg(Some(encode_text_op(epoch, &enc)), None).await? }
                 else { self.send_msg(None, Some((enc, file_caption(epoch)))).await? };
        self.wait_applied(id, Duration::from_secs(30)).await?;
        let result = self.0.st.lock().await.results.remove(&op.oid).unwrap_or_else(|| Ok(vec![]));
        Ok(WriteOutcome { id, result })
    }
}

pub enum RunOutcome { Read(Vec<StmtResult>), Write(WriteOutcome) }
