mod common;
use common::*;
use tgpg_core::crypto::{b64, SymKey};
use tgpg_core::ops::*;
use tgpg_core::transport::MemChannel;

#[tokio::test(flavor = "multi_thread")]
async fn dua_klien_konvergen_dengan_fungsi_deterministik() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    a.e.write("create table t(id uuid primary key default gen_random_uuid(), v text, at timestamptz default now(), r float8 default random())").await.unwrap();
    let (x, y) = tokio::join!(b.e.write("insert into t(v) values ('b1')"), a.e.write("insert into t(v) values ('a1')"));
    x.unwrap(); y.unwrap();
    a.e.write(&format!("insert into t(v) values ('{}')", "z".repeat(9000))).await.unwrap();   // > batas teks → file
    b.e.sync().await.unwrap(); a.e.sync().await.unwrap();
    let q = "select id, left(v,5), at, r from t order by id";
    let (ra, rb) = (rows(&a.e, q).await, rows(&b.e, q).await);
    assert_eq!(ra.len(), 3); assert_eq!(ra, rb, "dua klien harus punya data identik (uuid/waktu/random deterministik)");
    assert_eq!(a.e.last_applied().await, b.e.last_applied().await);
}

#[tokio::test(flavor = "multi_thread")]
async fn error_deterministik_dilewati_dan_dilaporkan() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    a.e.write("create table u(id int primary key)").await.unwrap();
    a.e.write("insert into u values (1)").await.unwrap();
    let dup = b.e.write("insert into u values (1)").await.unwrap();
    assert!(dup.result.unwrap_err().message.contains("duplicate key"));
    a.e.write("insert into u values (2)").await.unwrap(); a.e.sync().await.unwrap(); b.e.sync().await.unwrap();
    assert_eq!(rows(&a.e, "select id from u order by id").await, rows(&b.e, "select id from u order by id").await);
    assert_eq!(rows(&a.e, "select count(*) from u").await, vec![vec!["2".to_string()]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_menolak_tulis_dan_run_merutekan() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    a.e.write("create table r(a int)").await.unwrap();
    assert!(a.e.read("insert into r values (1)").await.is_err());
    assert!(matches!(a.e.run("select 1").await.unwrap(), tgpg_core::engine::RunOutcome::Read(_)));
    let n = ch.len();
    a.e.run("select * from r").await.unwrap(); assert_eq!(ch.len(), n, "SELECT tidak boleh masuk log");
    assert!(matches!(a.e.run("insert into r values (1)").await.unwrap(), tgpg_core::engine::RunOutcome::Write(_)));
}

#[tokio::test(flavor = "multi_thread")]
async fn op_duplikat_diterapkan_sekali() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    a.e.write("create table d(v int)").await.unwrap();
    let op = Op { v: 1, sql: "insert into d values (1)".into(), a: "A".into(), t: "2026-01-01T00:00:00.000Z".into(), cid: "x".into(), oid: "sama".into() };
    let enc = key.encrypt(&serde_json::to_vec(&op).unwrap());
    ch.push_raw("A", &encode_text_op(0, &enc), None); ch.push_raw("A", &encode_text_op(0, &enc), None);
    a.e.sync().await.unwrap();
    assert_eq!(rows(&a.e, "select count(*) from d").await, vec![vec!["1".to_string()]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn kunci_salah_dan_pesan_rusak_dilewati() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    a.e.write("create table k(v int)").await.unwrap();
    let other = new_key();
    ch.push_raw("A", &encode_text_op(0, &other.encrypt(b"{}")), None);
    ch.push_raw("A", "TGPG2 0 !!!bukan-base64", None);
    a.e.write("insert into k values (1)").await.unwrap();
    assert_eq!(rows(&a.e, "select count(*) from k").await, vec![vec!["1".to_string()]]);
    let _ = (b64(b""), SymKey::new(&[0u8; 32]));
}
