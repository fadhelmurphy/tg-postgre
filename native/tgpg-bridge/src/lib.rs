//! Server protokol Postgres di localhost untuk klien SQL biasa (DBeaver, psql, JDBC…).
//! Query baca dijalankan di Postgres lokal (read-only); query tulis dikirim ke grup sebagai op terenkripsi.
use std::{collections::HashMap, net::SocketAddr, sync::{Arc, Mutex}};

use async_trait::async_trait;
use bytes::{BufMut, BytesMut};
use futures::{stream, Sink};
use pgwire::api::auth::noop::NoopStartupHandler;
use pgwire::api::portal::{Format, Portal};
use pgwire::api::query::{ExtendedQueryHandler, SimpleQueryHandler};
use pgwire::api::results::{DescribePortalResponse, DescribeStatementResponse, FieldFormat, FieldInfo, QueryResponse, Response, Tag};
use pgwire::api::stmt::{NoopQueryParser, StoredStatement};
use pgwire::api::store::PortalStore;
use pgwire::api::{ClientInfo, ClientPortalStore, PgWireServerHandlers, Type};
use pgwire::error::{ErrorInfo, PgWireError, PgWireResult};
use pgwire::messages::data::DataRow;
use pgwire::messages::PgWireBackendMessage;
use pgwire::tokio::process_socket;
use std::fmt::Debug;
use tgpg_core::engine::{Engine, OpError, StmtResult};
use tgpg_core::sqlx::{inline_params, is_read, split_statements};

#[derive(Default)]
struct ConnState { in_tx: bool, buf: Vec<String> }

pub struct Bridge { engine: Engine, conns: Mutex<HashMap<SocketAddr, ConnState>>, parser: Arc<NoopQueryParser> }

impl Bridge {
    pub fn new(engine: Engine) -> Arc<Bridge> { Arc::new(Bridge { engine, conns: Mutex::new(HashMap::new()), parser: Arc::new(NoopQueryParser::new()) }) }
}

fn uerr(code: &str, msg: impl Into<String>) -> PgWireError { PgWireError::UserError(Box::new(ErrorInfo::new("ERROR".into(), code.into(), msg.into()))) }
fn err_resp(code: &str, msg: impl Into<String>) -> Response { Response::Error(Box::new(ErrorInfo::new("ERROR".into(), code.into(), msg.into()))) }
fn op_err(e: &OpError) -> Response { err_resp(&e.code, e.message.clone()) }

fn is_bin(f: &Format, i: usize) -> bool {
    match f { Format::UnifiedBinary => true, Format::UnifiedText => false, Format::Individual(v) => v.get(i).map(|c| *c == 1).unwrap_or(false) }
}
fn ty(oid: u32) -> Type { Type::from_oid(oid).unwrap_or(Type::TEXT) }

/// Kata pertama statement (huruf kecil), melewati spasi dan komentar di awal.
fn first_word(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(r) = s.strip_prefix("--") { s = r.split_once('\n').map(|x| x.1).unwrap_or("").trim_start(); }
        else if let Some(r) = s.strip_prefix("/*") { s = r.split_once("*/").map(|x| x.1).unwrap_or("").trim_start(); }
        else { break; }
    }
    s.trim_start_matches('(').chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_lowercase()
}

fn tag_for(sql: &str, n: u64) -> Tag {
    let words: Vec<String> = sql.split_whitespace().map(|w| w.to_ascii_lowercase()).collect();
    let w0 = first_word(sql);
    match w0.as_str() {
        "insert" => Tag::new("INSERT").with_oid(0).with_rows(n as usize),
        "update" | "delete" | "select" | "merge" | "copy" | "fetch" | "move" => Tag::new(&w0.to_uppercase()).with_rows(n as usize),
        "create" | "drop" | "alter" => {
            const SKIP: [&str; 12] = ["or", "replace", "unique", "temp", "temporary", "unlogged", "global", "local", "concurrently", "if", "not", "exists"];
            let obj = words.iter().skip(1).find(|w| !SKIP.contains(&w.as_str())).cloned().unwrap_or_default();
            Tag::new(&format!("{} {}", w0.to_uppercase(), obj.to_uppercase()).trim().to_string())
        }
        "" => Tag::new("OK"),
        w => Tag::new(&w.to_uppercase()),
    }
}

fn mk_row(cols: &[Option<Vec<u8>>]) -> DataRow {
    let mut b = BytesMut::new();
    for c in cols { match c { None => b.put_i32(-1), Some(v) => { b.put_i32(v.len() as i32); b.put_slice(v); } } }
    DataRow::new(b, cols.len() as i16)
}

fn query_response(cols: &[(String, u32)], rows: Vec<Vec<Option<Vec<u8>>>>, rf: &Format) -> Response {
    let fields: Vec<FieldInfo> = cols.iter().enumerate().map(|(i, (n, oid))| FieldInfo::new(n.clone(), None, None, ty(*oid), if is_bin(rf, i) { FieldFormat::Binary } else { FieldFormat::Text })).collect();
    let data: Vec<PgWireResult<DataRow>> = rows.iter().map(|r| Ok(mk_row(r))).collect();
    Response::Query(QueryResponse::new(Arc::new(fields), stream::iter(data)))
}

fn stmt_result_response(r: &StmtResult, stmt_sql: &str) -> Response {
    if r.columns.is_empty() { return Response::Execution(tag_for(stmt_sql, r.affected.unwrap_or(0))); }
    let cols: Vec<(String, u32)> = r.columns.iter().map(|c| (c.clone(), 25)).collect();   // hasil tulis (RETURNING) dikirim sebagai teks
    let rows = r.rows.iter().map(|row| row.iter().map(|v| v.as_ref().map(|s| s.as_bytes().to_vec())).collect()).collect();
    query_response(&cols, rows, &Format::UnifiedText)
}

impl Bridge {
    fn with_conn<T>(&self, addr: SocketAddr, f: impl FnOnce(&mut ConnState) -> T) -> T { f(self.conns.lock().unwrap().entry(addr).or_default()) }

    async fn flush_tx(&self, addr: SocketAddr) -> Response {
        let buf = self.with_conn(addr, |c| { c.in_tx = false; std::mem::take(&mut c.buf) });
        if buf.is_empty() { return Response::TransactionEnd(Tag::new("COMMIT")); }
        match self.engine.write(&buf.join(";\n")).await {
            Err(e) => err_resp("XX000", e.to_string()),
            Ok(o) => match o.result { Err(e) => op_err(&e), Ok(_) => Response::TransactionEnd(Tag::new("COMMIT")) },
        }
    }

    async fn exec_stmt(&self, addr: SocketAddr, sql: &str, rf: &Format) -> Vec<Response> {
        let w = first_word(sql);
        match w.as_str() {
            "begin" | "start" => { self.with_conn(addr, |c| { c.in_tx = true; c.buf.clear(); }); return vec![Response::TransactionStart(Tag::new("BEGIN"))]; }
            "commit" | "end" => return vec![if self.with_conn(addr, |c| c.in_tx) { self.flush_tx(addr).await } else { Response::TransactionEnd(Tag::new("COMMIT")) }],
            "rollback" | "abort" => { self.with_conn(addr, |c| { c.in_tx = false; c.buf.clear(); }); return vec![Response::TransactionEnd(Tag::new("ROLLBACK"))]; }
            "savepoint" | "release" => return vec![err_resp("0A000", "SAVEPOINT tidak didukung oleh TGPG (transaksi dikirim sebagai satu op saat COMMIT)")],
            "set" | "reset" | "discard" | "deallocate" | "listen" | "unlisten" => {
                return match self.engine.session_exec(sql).await { Ok(()) => vec![Response::Execution(tag_for(sql, 0))], Err(e) => vec![err_resp("XX000", e.to_string())] };
            }
            _ => {}
        }
        if is_read(sql) {
            return match self.engine.read_mixed(sql, &|i| is_bin(rf, i)).await {
                Ok(rs) => vec![query_response(&rs.cols, rs.rows, rf)],
                Err(e) => vec![err_resp("42000", e.to_string())],
            };
        }
        if self.with_conn(addr, |c| c.in_tx) {   // tulis dalam transaksi: ditahan sampai COMMIT
            self.with_conn(addr, |c| c.buf.push(sql.to_string()));
            return vec![Response::Execution(tag_for(sql, 0))];
        }
        match self.engine.write(sql).await {
            Err(e) => vec![err_resp("XX000", e.to_string())],
            Ok(o) => match o.result {
                Err(e) => vec![op_err(&e)],
                Ok(rs) => {
                    let parts = split_statements(sql);
                    rs.iter().enumerate().map(|(i, r)| stmt_result_response(r, if parts.len() == rs.len() { &parts[i] } else { sql })).collect::<Vec<_>>()
                }
            },
        }
    }

    async fn exec_script(&self, addr: SocketAddr, sql: &str) -> Vec<Response> {
        let parts = split_statements(sql);
        let in_tx = self.with_conn(addr, |c| c.in_tx);
        let pure_write = |s: &String| !is_read(s) && !matches!(first_word(s).as_str(), "begin" | "start" | "commit" | "end" | "rollback" | "abort" | "set" | "reset" | "discard" | "deallocate" | "listen" | "unlisten" | "savepoint" | "release");
        if parts.len() > 1 && !in_tx && parts.iter().all(pure_write) {   // skrip tulis murni = satu op atomik
            return self.exec_stmt(addr, sql, &Format::UnifiedText).await;
        }
        let mut out = vec![];
        for p in &parts {
            let r = self.exec_stmt(addr, p, &Format::UnifiedText).await;
            let failed = r.iter().any(|x| matches!(x, Response::Error(_)));
            out.extend(r); if failed { break; }
        }
        out
    }

    async fn render_all(&self, portal: &Portal<String>) -> Result<String, PgWireError> {
        let sql = &portal.statement.statement;
        let n = portal.parameter_len();
        if n == 0 { return Ok(sql.clone()); }
        let described = if (0..n).any(|i| portal.statement.parameter_types.get(i).and_then(|t| t.as_ref()).map(|t| t.oid() == 0 || *t == Type::UNKNOWN).unwrap_or(true)) {
            Some(self.engine.describe(sql).await.map_err(|e| uerr("42P18", e.to_string()))?)
        } else { None };
        let mut lits = Vec::with_capacity(n);
        for i in 0..n {
            let oid = portal.statement.parameter_types.get(i).and_then(|t| t.as_ref()).map(|t| t.oid()).filter(|o| *o != 0 && *o != Type::UNKNOWN.oid())
                .or_else(|| described.as_ref().and_then(|d| d.params.get(i).copied())).unwrap_or(0);
            let data = portal.parameters.get(i).and_then(|p| p.as_deref());
            lits.push(self.engine.render_param(oid, portal.parameter_format.is_binary(i), data).await.map_err(|e| uerr("22023", e.to_string()))?);
        }
        Ok(inline_params(sql, &lits))
    }
}

#[async_trait]
impl NoopStartupHandler for Bridge {}

#[async_trait]
impl SimpleQueryHandler for Bridge {
    async fn do_query<C>(&self, client: &mut C, query: &str) -> PgWireResult<Vec<Response>>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        Ok(self.exec_script(client.socket_addr(), query).await)
    }
}

#[async_trait]
impl ExtendedQueryHandler for Bridge {
    type Statement = String;
    type QueryParser = NoopQueryParser;
    fn query_parser(&self) -> Arc<Self::QueryParser> { self.parser.clone() }

    async fn do_query<C>(&self, client: &mut C, portal: &Portal<Self::Statement>, _max_rows: usize) -> PgWireResult<Response>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Self::Statement>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let sql = self.render_all(portal).await?;
        let mut rs = self.exec_stmt(client.socket_addr(), &sql, &portal.result_column_format).await;
        Ok(if rs.is_empty() { Response::EmptyQuery } else { rs.remove(0) })
    }

    async fn do_describe_statement<C>(&self, _client: &mut C, stmt: &StoredStatement<Self::Statement>) -> PgWireResult<DescribeStatementResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Self::Statement>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let d = self.engine.describe(&stmt.statement).await.map_err(|e| uerr("42601", e.to_string()))?;
        let params = d.params.iter().enumerate().map(|(i, oid)| stmt.parameter_types.get(i).and_then(|t| t.clone()).filter(|t| t.oid() != 0).unwrap_or_else(|| ty(*oid))).collect();
        let fields = d.cols.iter().map(|(n, oid)| FieldInfo::new(n.clone(), None, None, ty(*oid), FieldFormat::Text)).collect();
        Ok(DescribeStatementResponse::new(params, fields))
    }

    async fn do_describe_portal<C>(&self, _client: &mut C, portal: &Portal<Self::Statement>) -> PgWireResult<DescribePortalResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Self::Statement>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let d = self.engine.describe(&portal.statement.statement).await.map_err(|e| uerr("42601", e.to_string()))?;
        let fields = d.cols.iter().enumerate().map(|(i, (n, oid))| FieldInfo::new(n.clone(), None, None, ty(*oid), if is_read(&portal.statement.statement) && is_bin(&portal.result_column_format, i) { FieldFormat::Binary } else { FieldFormat::Text })).collect();
        Ok(DescribePortalResponse::new(fields))
    }
}

/// Handler pabrik: membungkus Arc<Bridge> agar bisa dipakai process_socket.
pub struct Factory(pub Arc<Bridge>);
impl PgWireServerHandlers for Factory {
    fn simple_query_handler(&self) -> Arc<impl SimpleQueryHandler> { self.0.clone() }
    fn extended_query_handler(&self) -> Arc<impl ExtendedQueryHandler> { self.0.clone() }
    fn startup_handler(&self) -> Arc<impl pgwire::api::auth::StartupHandler> { self.0.clone() }
}

/// Jalankan server. Secara default hanya menerima alamat loopback (tanpa autentikasi, jangan dibuka ke jaringan).
pub async fn serve(engine: Engine, addr: SocketAddr, allow_remote: bool) -> anyhow::Result<()> {
    if !addr.ip().is_loopback() && !allow_remote { anyhow::bail!("alamat {addr} bukan loopback; server tanpa autentikasi hanya boleh di 127.0.0.1 (gunakan allow_remote bila benar-benar paham risikonya)"); }
    let listener = tokio::net::TcpListener::bind(addr).await?;
    serve_listener(engine, listener).await
}

pub async fn serve_listener(engine: Engine, listener: tokio::net::TcpListener) -> anyhow::Result<()> {
    let factory = Arc::new(Factory(Bridge::new(engine)));
    loop {
        let (sock, _) = listener.accept().await?;
        let f = factory.clone();
        tokio::spawn(async move { let _ = process_socket(sock, None, f).await; });
    }
}
