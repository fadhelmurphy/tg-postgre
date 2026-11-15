// Vektor yang dibuat klien Rust (native/) harus bisa dibuka klien JS.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importKey, decrypt, loadIdentity, unwrap, b64 } from '../src/crypto.js';

const dir = 'native/tgpg-core/tests/vectors/';
const js = JSON.parse(readFileSync(dir + 'js.json', 'utf8')), rs = JSON.parse(readFileSync(dir + 'rust.json', 'utf8'));
describe('interop Rust → JS', () => {
  it('AES-GCM dari Rust dibuka JS', async () => {
    const key = await importKey(b64.dec(js.aesKey));
    expect(new TextDecoder().decode(await decrypt(key, b64.dec(rs.cipher)))).toBe('dari rust ✓');
  });
  it('pembungkus ECDH dari Rust dibuka JS', async () => {
    const id = await loadIdentity(js.identity);
    expect(new TextDecoder().decode(await unwrap(id.priv, rs.wrap))).toBe('bungkus rust');
  });
});
