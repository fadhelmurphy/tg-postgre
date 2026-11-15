#![allow(dead_code)]
use std::{collections::BTreeMap, sync::{Arc, Mutex}};
use tgpg_core::crypto::{random_key, Identity, SymKey};
use tgpg_core::engine::{Engine, OpenOpts, StmtResult};
use tgpg_core::transport::MemChannel;

pub fn pg_base() -> String { std::env::var("TGPG_TEST_PG").expect("set TGPG_TEST_PG (lihat native/scripts/pg-test.sh)") }

/// Database Postgres baru untuk satu klien.
pub async fn fresh_db() -> String {
    let base = pg_base();
    let (c, conn) = tokio_postgres::connect(&base, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(conn);
    let name = format!("t_{}", uuid::Uuid::new_v4().simple());
    c.batch_execute(&format!("create database {name}")).await.unwrap();
    format!("{}/{}", base.rsplit_once('/').unwrap().0, name)
}

pub struct Member { pub e: Engine, pub id: Identity, pub saved: Arc<Mutex<BTreeMap<u64, String>>> }

pub fn quiet() -> Option<tgpg_core::engine::LogCb> { Some(Arc::new(|_, _| {})) }

pub async fn join(ch: &MemChannel, key: &SymKey, sid: &str, id: Option<Identity>, keys: BTreeMap<u64, String>) -> Member {
    let id = id.unwrap_or_else(Identity::generate); let saved = Arc::new(Mutex::new(BTreeMap::new())); let s2 = saved.clone();
    let e = Engine::open(OpenOpts {
        transport: ch.handle(sid), root_key: key.clone(), pg_url: fresh_db().await, identity: id.clone(), keys,
        on_keys: Some(Arc::new(move |k| { *s2.lock().unwrap() = k; })), author: format!("user{sid}"), log: quiet(),
    }).await.unwrap();
    Member { e, id, saved }
}

pub fn new_key() -> SymKey { SymKey::new(&random_key()).unwrap() }

pub fn flat(r: &[StmtResult]) -> Vec<Vec<Option<String>>> { r.iter().flat_map(|s| s.rows.clone()).collect() }
pub async fn rows(e: &Engine, q: &str) -> Vec<Vec<String>> {
    flat(&e.read(q).await.unwrap()).into_iter().map(|r| r.into_iter().map(|v| v.unwrap_or_else(|| "NULL".into())).collect()).collect()
}
