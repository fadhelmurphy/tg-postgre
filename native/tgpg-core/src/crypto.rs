//! AES-GCM (iv12 || ciphertext+tag) dan pembungkus kunci ECDH P-256, kompatibel dengan WebCrypto.
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use p256::{ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint, PublicKey, SecretKey};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

pub type Result<T> = anyhow::Result<T>;

pub fn b64(bytes: &[u8]) -> String { STANDARD.encode(bytes) }
pub fn unb64(s: &str) -> Result<Vec<u8>> { Ok(STANDARD.decode(s)?) }
pub fn unb64u(s: &str) -> Result<Vec<u8>> { Ok(URL_SAFE_NO_PAD.decode(s.trim_end_matches('='))?) }
pub fn b64u(bytes: &[u8]) -> String { URL_SAFE_NO_PAD.encode(bytes) }

pub fn random_key() -> [u8; 32] { let mut k = [0u8; 32]; OsRng.fill_bytes(&mut k); k }

/// Kunci simetris AES-256-GCM (kunci mentah 32 byte).
#[derive(Clone)]
pub struct SymKey(Aes256Gcm, [u8; 32]);
impl SymKey {
    pub fn new(raw: &[u8]) -> Result<Self> {
        let a: [u8; 32] = raw.try_into().map_err(|_| anyhow::anyhow!("kunci harus 32 byte"))?;
        Ok(Self(Aes256Gcm::new((&a).into()), a))
    }
    pub fn raw(&self) -> [u8; 32] { self.1 }
    pub fn encrypt(&self, plain: &[u8]) -> Vec<u8> {
        let mut iv = [0u8; 12]; OsRng.fill_bytes(&mut iv);
        let ct = self.0.encrypt(Nonce::from_slice(&iv), plain).expect("aes-gcm encrypt");
        let mut out = iv.to_vec(); out.extend(ct); out
    }
    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>> {
        if data.len() < 12 + 16 { anyhow::bail!("data terlalu pendek"); }
        self.0.decrypt(Nonce::from_slice(&data[..12]), &data[12..]).map_err(|_| anyhow::anyhow!("dekripsi gagal (kunci salah / data rusak)"))
    }
}

/// Identitas anggota: pasangan kunci ECDH P-256. `pub_b64` = titik tidak terkompresi (65 byte) base64, sama dgn WebCrypto 'raw'.
#[derive(Clone)]
pub struct Identity { secret: SecretKey, pub_b64: String }
impl Identity {
    pub fn generate() -> Self { Self::from_secret(SecretKey::random(&mut OsRng)) }
    pub fn from_secret_bytes(d: &[u8]) -> Result<Self> { Ok(Self::from_secret(SecretKey::from_slice(d)?)) }
    fn from_secret(secret: SecretKey) -> Self {
        let pub_b64 = b64(secret.public_key().to_encoded_point(false).as_bytes());
        Self { secret, pub_b64 }
    }
    pub fn secret_bytes(&self) -> Vec<u8> { self.secret.to_bytes().to_vec() }
    pub fn pub_b64(&self) -> &str { &self.pub_b64 }
}

/// Pembungkus: {e: kunci publik ephemeral, c: iv||ct}. Kunci AES = sumbu-x rahasia bersama ECDH (persis deriveKey WebCrypto).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Wrap { pub e: String, pub c: String }

fn shared(secret: &SecretKey, pub_raw: &[u8]) -> Result<SymKey> {
    let public = PublicKey::from_sec1_bytes(pub_raw)?;
    let s = diffie_hellman(secret.to_nonzero_scalar(), public.as_affine());
    SymKey::new(s.raw_secret_bytes().as_slice())
}

pub fn wrap_for(pub_b64: &str, bytes: &[u8]) -> Result<Wrap> {
    let eph = SecretKey::random(&mut OsRng);
    let key = shared(&eph, &unb64(pub_b64)?)?;
    Ok(Wrap { e: b64(eph.public_key().to_encoded_point(false).as_bytes()), c: b64(&key.encrypt(bytes)) })
}

pub fn unwrap(id: &Identity, w: &Wrap) -> Result<Vec<u8>> {
    shared(&id.secret, &unb64(&w.e)?)?.decrypt(&unb64(&w.c)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let k = SymKey::new(&random_key()).unwrap();
        assert_eq!(k.decrypt(&k.encrypt(b"halo")).unwrap(), b"halo");
        assert!(SymKey::new(&random_key()).unwrap().decrypt(&k.encrypt(b"x")).is_err());
        let a = Identity::generate();
        let w = wrap_for(a.pub_b64(), b"rahasia").unwrap();
        assert_eq!(unwrap(&a, &w).unwrap(), b"rahasia");
        assert!(unwrap(&Identity::generate(), &w).is_err());
        assert_eq!(unb64(a.pub_b64()).unwrap().len(), 65);
    }
}
