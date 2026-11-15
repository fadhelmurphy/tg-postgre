//! Interop dengan klien JS: vektor dibuat oleh `node scripts/gen-vectors.mjs`.
use tgpg_core::crypto::*;
use tgpg_core::sqlx::{is_read, rewrite};

fn js() -> serde_json::Value { serde_json::from_str(include_str!("vectors/js.json")).unwrap() }

#[test]
fn js_ciphertext_dibuka_rust() {
    let v = js();
    let k = SymKey::new(&unb64(v["aesKey"].as_str().unwrap()).unwrap()).unwrap();
    let pt = k.decrypt(&unb64(v["cipher"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(String::from_utf8(pt).unwrap(), v["plain"].as_str().unwrap());
}

#[test]
fn js_wrap_dibuka_rust_dan_sebaliknya() {
    let v = js();
    let d = unb64u(v["identity"]["jwk"]["d"].as_str().unwrap()).unwrap();
    let id = Identity::from_secret_bytes(&d).unwrap();
    assert_eq!(id.pub_b64(), v["identity"]["pub"].as_str().unwrap());      // turunan kunci publik sama dgn WebCrypto
    let w: Wrap = serde_json::from_value(v["wrap"].clone()).unwrap();
    assert_eq!(String::from_utf8(unwrap(&id, &w).unwrap()).unwrap(), v["wrapPlain"].as_str().unwrap());
    // keluaran Rust untuk dibuka JS (diuji oleh tests/interop.test.js lewat rust.json)
    let k = SymKey::new(&unb64(v["aesKey"].as_str().unwrap()).unwrap()).unwrap();
    let out = serde_json::json!({
        "cipher": b64(&k.encrypt("dari rust ✓".as_bytes())),
        "wrap": wrap_for(id.pub_b64(), "bungkus rust".as_bytes()).unwrap(),
    });
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/rust.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
}

#[test]
fn rewrite_dan_is_read_sama_dengan_js() {
    let v = js();
    for c in v["rewrite"].as_array().unwrap() {
        assert_eq!(rewrite(c["in"].as_str().unwrap()), c["out"].as_str().unwrap(), "rewrite: {}", c["in"]);
    }
    for c in v["isRead"].as_array().unwrap() {
        assert_eq!(is_read(c["sql"].as_str().unwrap()), c["read"].as_bool().unwrap(), "is_read: {}", c["sql"]);
    }
}
