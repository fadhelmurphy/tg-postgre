//! Interop log: replay log buatan klien JS di Rust, dan buat log Rust untuk direplay JS (tests/interop-log.test.js).
mod common;
use common::*;
use tgpg_core::crypto::{b64, unb64, unb64u, Identity, SymKey};
use tgpg_core::transport::{DumpMsg, MemChannel};

const Q1: &str = "select id::text, left(v,5), to_char(at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS'), r::text from t order by id";
const Q2: &str = "select id::text from u order by id";

#[tokio::test(flavor = "multi_thread")]
async fn rust_mereplay_log_klien_js() {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/jslog.json")).expect("jalankan dulu: npx vitest run tests/interop-log.test.js")).unwrap();
    let dump: Vec<DumpMsg> = serde_json::from_value(v["channel"].clone()).unwrap();
    let ch = MemChannel::load(&dump).unwrap();
    let key = SymKey::new(&unb64(v["key"].as_str().unwrap()).unwrap()).unwrap();
    let id = Identity::from_secret_bytes(&unb64u(v["members"]["B"]["d"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(id.pub_b64(), v["members"]["B"]["pub"].as_str().unwrap());
    let b = join(&ch, &key, "B", Some(id), Default::default()).await;
    assert_eq!(b.e.epoch().await.0, 1, "B (anggota yang bertahan) harus membuka kunci rotasi buatan JS");
    let want = |k: &str| -> Vec<Vec<String>> { v[k].as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()).collect() };
    assert_eq!(rows(&b.e, Q1).await, want("expect1"), "data tabel t harus identik dgn hasil JS (uuid/waktu/random deterministik)");
    assert_eq!(rows(&b.e, Q2).await, want("expect2"));
    assert_eq!(b.e.last_applied().await as usize, dump.last().unwrap().id as usize);
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_membuat_log_untuk_replay_js() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    let _c = join(&ch, &key, "C", None, Default::default()).await;
    a.e.write("create table t(id uuid primary key default gen_random_uuid(), v text, at timestamptz default now(), r float8 default random())").await.unwrap();
    let (x, y) = tokio::join!(b.e.write("insert into t(v) values ('b1')"), a.e.write("insert into t(v) values ('a1')")); x.unwrap(); y.unwrap();
    a.e.write(&format!("insert into t(v) values ('{}')", "z".repeat(9000))).await.unwrap();
    a.e.rotate(&["C".to_string()]).await.unwrap(); b.e.sync().await.unwrap();
    b.e.write("insert into t(v) values ('b-ep1')").await.unwrap();
    a.e.write("create table u(id int primary key); insert into u values (1)").await.unwrap();
    assert!(b.e.write("insert into u values (1)").await.unwrap().result.is_err());
    a.e.write("insert into u values (2)").await.unwrap(); b.e.sync().await.unwrap(); a.e.sync().await.unwrap();
    let (e1, e2) = (rows(&a.e, Q1).await, rows(&a.e, Q2).await);
    assert_eq!(e1.len(), 4); assert_eq!(rows(&b.e, Q1).await, e1);
    let pubk = unb64(b.id.pub_b64()).unwrap();
    let out = serde_json::json!({
        "key": b64(&key.raw()), "channel": ch.dump(), "q1": Q1, "q2": Q2, "expect1": e1, "expect2": e2,
        "members": { "B": { "d": tgpg_core::crypto::b64u(&b.id.secret_bytes()), "pub": b.id.pub_b64() } },
    });
    let _ = pubk;
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/rustlog.json"), serde_json::to_string(&out).unwrap()).unwrap();
}
