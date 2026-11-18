# Grup TGPG yang ada di akun tapi belum ada kuncinya di browser: muncul di "Ditemukan", terbuka setelah kunci ditempel.
from playwright.sync_api import sync_playwright
bad = []
def ck(n, ok, extra=''):
    print(('PASS ' if ok else 'FAIL ') + n, extra if not ok else '')
    if not ok: bad.append(n)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:5198/'); pg.wait_for_timeout(800)
    pg.fill('#apiId', '1'); pg.fill('#apiHash', 'a'); pg.fill('#newPass', 'passphrase123'); pg.click('#btnLogin')
    pg.wait_for_selector('#c-db:not([hidden])'); pg.fill('#dbName', 'rahasia'); pg.click('#btnCreate')
    pg.wait_for_selector('#c-work:not([hidden])', timeout=60000); pg.wait_for_timeout(800)
    v = pg.locator('#c-work > div:not([hidden])'); v.locator('button', has_text='Bagikan').click()
    conn = v.locator('.ws-share .mono').inner_text(); ck('connection string ada', conn.startswith('tgpg://') and '#' in conn)
    pg.click('.dbtab.add'); pg.wait_for_selector('#c-db:not([hidden])')
    pg.locator('.saved-item button', has_text='Lupakan').click(); pg.wait_for_timeout(500)
    ck('muncul di Ditemukan setelah dilupakan', 'Ditemukan' in pg.inner_text('#saved') and 'rahasia' in pg.inner_text('#saved'))
    pg.locator('#saved .saved-item input').fill('salah'); pg.locator('#saved .saved-item button').click(); pg.wait_for_timeout(300)
    ck('kunci salah ditolak', pg.locator('.dbtab:not(.add)').count() == 0)
    pg.locator('#saved .saved-item input').fill(conn); pg.locator('#saved .saved-item button').click()
    pg.wait_for_selector('#c-work:not([hidden])', timeout=60000); pg.wait_for_timeout(500)
    ck('terbuka dengan kunci', pg.locator('.dbtab:not(.add)').count() == 1)
    print('errs', errs); ck('tanpa page error', not errs); b.close()
print('FAILED:', bad)
