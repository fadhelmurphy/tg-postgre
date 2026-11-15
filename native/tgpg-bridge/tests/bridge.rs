use std::collections::BTreeMap;
use tgpg_core::crypto::{random_key, Identity, SymKey};
use tgpg_core::engine::{Engine, OpenOpts};
use tgpg_core::transport::MemChannel;

async fn open(ch: &MemChannel, sid: &str, key: &SymKey, id: Identity) -> Engine {
    let base = std::env::var("TGPG_TEST_PG").expect("TGPG_TEST_PG");
    let (c, conn) = tokio_postgres::connect(&base, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(conn);
    let name = format!("b_{}", uuid::Uuid::new_v4().simple());
    c.batch_execute(&format!("create database {name}")).await.unwrap();
    let e = Engine::open(OpenOpts { transport: ch.handle(sid), root_key: key.clone(), pg_url: format!("{}/{}", base.rsplit_once('/').unwrap().0, name),
        identity: id, keys: BTreeMap::new(), on_keys: None, author: sid.into(), log: Some(std::sync::Arc::new(|_, _| {})) }).await.unwrap();
    e.sync().await.unwrap(); e
}

#[tokio::test]
async fn bridge_menulis_ke_log_dan_klien_lain_ikut() {
    let (ch, key) = (MemChannel::new(), SymKey::new(&random_key()).unwrap());
    let a = open(&ch, "1", &key, Identity::generate()).await;
    let b = open(&ch, "2", &key, Identity::generate()).await;
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(tgpg_bridge::serve_listener(a, l));
    let (c, conn) = tokio_postgres::connect(&format!("host=127.0.0.1 port={port} user=u dbname=d"), tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(conn);
    c.batch_execute("create table t(id serial primary key, v text)").await.unwrap();
    c.execute("insert into t(v) values ($1)", &[&"halo"]).await.unwrap();
    let row = c.query_one("select count(*)::int4 from t where v = $1", &[&"halo"]).await.unwrap();
    assert_eq!(row.get::<_, i32>(0), 1);
    assert!(c.execute("insert into t(id,v) values (1,'x')", &[]).await.is_err());
    b.sync().await.unwrap();
    let r = b.read("select v from t").await.unwrap();
    assert_eq!(r[0].rows, vec![vec![Some("halo".to_string())]]);
}
