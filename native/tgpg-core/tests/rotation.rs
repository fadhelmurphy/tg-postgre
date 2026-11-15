mod common;
use common::*;
use tgpg_core::crypto::b64;
use tgpg_core::ops::*;
use tgpg_core::transport::MemChannel;

async fn sync_all(ms: &[&Member]) { for m in ms { m.e.sync().await.unwrap(); } }
fn status(m: &Member, sid: &str) -> String { futures_status(m, sid) }
fn futures_status(_m: &Member, _sid: &str) -> String { String::new() }

async fn st(m: &Member, sid: &str) -> String { m.e.member_list().await.into_iter().find(|x| x.sid == sid).map(|x| x.status).unwrap_or_default() }

#[tokio::test(flavor = "multi_thread")]
async fn anggota_dicabut_tidak_bisa_menulis_atau_membaca_data_baru() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    let c = join(&ch, &key, "C", None, Default::default()).await;
    sync_all(&[&a, &b, &c]).await;
    assert!(a.e.is_owner().await); assert!(!b.e.is_owner().await);
    a.e.write("create table t(v text)").await.unwrap(); b.e.write("insert into t values ('b-sebelum')").await.unwrap(); c.e.sync().await.unwrap();
    assert_eq!(rows(&c.e, "select v from t").await, vec![vec!["b-sebelum".to_string()]]);

    let (n, _) = a.e.rotate(&["C".to_string()]).await.unwrap(); assert_eq!(n, 1);
    sync_all(&[&b, &c]).await;
    assert_eq!(b.e.epoch().await.0, 1); assert_eq!(c.e.epoch().await.0, 0);
    b.e.write("insert into t values ('b-sesudah')").await.unwrap(); a.e.write("insert into t values ('a-sesudah')").await.unwrap(); c.e.sync().await.unwrap();
    assert!(c.e.blocked().await.is_some());
    assert_eq!(rows(&c.e, "select count(*) from t").await, vec![vec!["1".to_string()]]);
    assert!(c.e.write("insert into t values ('c')").await.unwrap_err().to_string().contains("akses tulis"));
    b.e.sync().await.unwrap(); a.e.sync().await.unwrap();
    assert_eq!(rows(&a.e, "select v from t order by v").await.concat(), vec!["a-sesudah", "b-sebelum", "b-sesudah"]);
    assert_eq!(rows(&b.e, "select count(*) from t").await, vec![vec!["3".to_string()]]);
    assert_eq!(st(&a, "C").await, "removed");
}

#[tokio::test(flavor = "multi_thread")]
async fn op_palsu_dari_anggota_dicabut_ditolak() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    let _c = join(&ch, &key, "C", None, Default::default()).await;
    a.e.write("create table t(v text)").await.unwrap(); a.e.rotate(&["C".to_string()]).await.unwrap(); b.e.sync().await.unwrap();
    let op = Op { v: 1, sql: "insert into t values ('PALSU')".into(), a: "C".into(), t: "2026-01-01T00:00:00.000Z".into(), cid: "x".into(), oid: "o1".into() };
    ch.push_raw("C", &encode_text_op(0, &key.encrypt(&serde_json::to_vec(&op).unwrap())), None);
    sync_all(&[&a, &b]).await;
    assert_eq!(rows(&a.e, "select count(*) from t").await, vec![vec!["0".to_string()]]);
    assert_eq!(rows(&b.e, "select count(*) from t").await, vec![vec!["0".to_string()]]);
    let _ = b64(b"");
}

#[tokio::test(flavor = "multi_thread")]
async fn anggota_baru_menunggu_persetujuan_lalu_replay_penuh() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    a.e.write("create table t(v text)").await.unwrap(); a.e.rotate(&[]).await.unwrap(); b.e.sync().await.unwrap();
    a.e.write("insert into t values ('rahasia-epoch1')").await.unwrap();
    let d = join(&ch, &key, "D", None, Default::default()).await; d.e.sync().await.unwrap();
    assert!(d.e.blocked().await.is_some());
    assert!(d.e.write("insert into t values ('d')").await.is_err());
    a.e.sync().await.unwrap();   // A melihat hello D di log
    assert_eq!(st(&a, "D").await, "pending");
    a.e.approve("D").await.unwrap(); d.e.sync().await.unwrap();
    assert!(d.e.blocked().await.is_none()); assert_eq!(d.e.epoch().await.0, 1);
    assert_eq!(rows(&d.e, "select v from t").await, vec![vec!["rahasia-epoch1".to_string()]]);
    d.e.write("insert into t values ('dari-d')").await.unwrap(); a.e.sync().await.unwrap();
    assert_eq!(rows(&a.e, "select count(*) from t").await, vec![vec!["2".to_string()]]);
    let _ = (status as fn(&Member, &str) -> String);
}

#[tokio::test(flavor = "multi_thread")]
async fn perangkat_baru_dengan_vault_kosong_mengambil_kunci_dari_log() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    a.e.write("create table t(v text)").await.unwrap(); a.e.rotate(&[]).await.unwrap();
    a.e.write("insert into t values ('x')").await.unwrap();
    let b2 = join(&ch, &key, "B", Some(b.id.clone()), Default::default()).await;       // identitas sama, ring kosong, DB lokal baru
    b2.e.sync().await.unwrap();
    assert_eq!(b2.e.epoch().await.0, 1); assert_eq!(rows(&b2.e, "select v from t").await, vec![vec!["x".to_string()]]);
    assert!(b2.saved.lock().unwrap().contains_key(&1));
}

#[tokio::test(flavor = "multi_thread")]
async fn hanya_owner_bisa_rotasi_dan_keys_non_owner_diabaikan() {
    let ch = MemChannel::new(); let key = new_key();
    let a = join(&ch, &key, "A", None, Default::default()).await;
    let b = join(&ch, &key, "B", None, Default::default()).await;
    assert!(b.e.rotate(&["A".to_string()]).await.is_err());
    ch.push_raw("B", &format!("{CTL} {}", serde_json::json!({"t":"keys","n":1,"wraps":{},"remove":["A"]})), None);
    sync_all(&[&a, &b]).await;
    assert_eq!(a.e.epoch().await.1, 0); assert_eq!(st(&a, "A").await, "active");
}
