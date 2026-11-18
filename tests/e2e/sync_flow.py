# Sinkron antar perangkat: aktifkan sinkron → "perangkat baru" (vault kosong) memulihkan daftar database dengan passphrase sinkron.
from playwright.sync_api import sync_playwright
bad = []
def ck(n, ok, extra=''):
    print(('PASS ' if ok else 'FAIL ') + n, extra if not ok else '')
    if not ok: bad.append(n)
def login(pg, pw):
    pg.fill('#apiId', '1'); pg.fill('#apiHash', 'a'); pg.fill('#newPass', pw); pg.click('#btnLogin'); pg.wait_for_selector('#c-db:not([hidden])')
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5198/'); pg.wait_for_timeout(800); login(pg, 'passphrase-lokal-1')
    pg.fill('#dbName', 'rahasia'); pg.click('#btnCreate'); pg.wait_for_selector('#c-work:not([hidden])', timeout=60000)
    pg.click('.dbtab.add'); pg.wait_for_selector('#c-db:not([hidden])')
    pg.fill('#syncBox input', 'sinkron-rahasia-1'); pg.locator('#syncBox button', has_text='Aktifkan').click(); pg.wait_for_timeout(1500)
    ck('sinkron aktif', 'Sinkron antar perangkat aktif' in pg.inner_text('#syncBox'))
    ck('cadangan terenkripsi tersimpan', pg.evaluate("!!sessionStorage.getItem('fake-sync')"))
    ck('cadangan tidak memuat nama db/kunci plaintext', 'rahasia' not in (pg.evaluate("atob(sessionStorage.getItem('fake-sync'))") or ''))
    # perangkat baru: vault lokal kosong, session sinkron (Saved Messages) tetap ada
    pg.evaluate("localStorage.clear(); indexedDB.deleteDatabase('tgpg-device')"); pg.reload(); pg.wait_for_timeout(1200)
    login(pg, 'passphrase-lokal-2'); pg.wait_for_timeout(800)
    ck('cadangan ditemukan', 'Cadangan ditemukan' in pg.inner_text('#syncBox'))
    ck('belum ada database lokal', 'rahasia' not in pg.inner_text('#saved').split('Ditemukan')[0])
    pg.fill('#syncBox input', 'salah-passphrase'); pg.locator('#syncBox button', has_text='Pulihkan').click(); pg.wait_for_timeout(800)
    ck('passphrase salah ditolak', 'rahasia' not in pg.inner_text('#saved').split('Ditemukan')[0] and 'Pulihkan' in pg.inner_text('#syncBox'))
    pg.fill('#syncBox input', 'sinkron-rahasia-1'); pg.locator('#syncBox button', has_text='Pulihkan').click(); pg.wait_for_timeout(1500)
    ck('database dipulihkan', 'rahasia' in pg.inner_text('#saved').split('Ditemukan')[0])
    ck('sinkron aktif lagi', 'Sinkron antar perangkat aktif' in pg.inner_text('#syncBox'))
    print('errs', errs); ck('tanpa page error', not errs); b.close()
print('FAILED:', bad)
