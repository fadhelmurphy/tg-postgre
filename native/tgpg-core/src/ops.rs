//! Format pesan di log (identik dengan klien JS).
use crate::crypto::{b64, unb64, Wrap};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const OP_PREFIX: &str = "TGPG1 ";   // legacy, epoch 0
pub const OP2: &str = "TGPG2 ";         // TGPG2 <epoch> <base64>
pub const OP_FILE: &str = "TGPG-OP";    // caption file op: "TGPG-OP e=<epoch>"
pub const CTL: &str = "TGPG-CTL";
pub const SNAP: &str = "TGPG-SNAP";     // snapshot PGlite (klien browser) — klien Rust tidak memakainya
pub const PGSNAP: &str = "TGPG-PGSNAP"; // snapshot milik klien Rust (pg_dump), tidak dikenali klien browser
pub const TEXT_LIMIT: usize = 2800;
pub const MAX_OP: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Op { pub v: u32, pub sql: String, pub a: String, pub t: String, pub cid: String, pub oid: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Ctl {
    Hello { #[serde(rename = "pub")] pub_key: String, #[serde(default)] name: String },
    Keys { n: u64, #[serde(default)] wraps: BTreeMap<String, Wrap>, #[serde(default)] remove: Vec<String> },
}

/// Hasil klasifikasi satu pesan log.
pub enum Kind { Op { epoch: u64, data: OpData }, Ctl, Snapshot, Other }
pub enum OpData { Inline(Vec<u8>), File }

pub fn encode_text_op(epoch: u64, enc: &[u8]) -> String { format!("{OP2}{epoch} {}", b64(enc)) }
pub fn file_caption(epoch: u64) -> String { format!("{OP_FILE} e={epoch}") }

pub fn classify(text: &str, has_file: bool) -> Kind {
    if !has_file {
        if let Some(rest) = text.strip_prefix(OP2) {
            if let Some((e, b)) = rest.split_once(' ') {
                if let (Ok(e), Ok(raw)) = (e.parse::<u64>(), unb64(b)) { return Kind::Op { epoch: e, data: OpData::Inline(raw) }; }
            }
            return Kind::Other;
        }
        if let Some(b) = text.strip_prefix(OP_PREFIX) { return unb64(b).map(|r| Kind::Op { epoch: 0, data: OpData::Inline(r) }).unwrap_or(Kind::Other); }
    }
    if text.starts_with(CTL) { return Kind::Ctl; }
    if has_file && text.starts_with(OP_FILE) { return Kind::Op { epoch: parse_epoch(text), data: OpData::File }; }
    if has_file && (text.starts_with(SNAP) || text.starts_with(PGSNAP)) { return Kind::Snapshot; }
    Kind::Other
}

pub fn parse_epoch(caption: &str) -> u64 {
    caption.split_whitespace().find_map(|w| w.strip_prefix("e=")).and_then(|v| v.parse().ok()).unwrap_or(0)
}
