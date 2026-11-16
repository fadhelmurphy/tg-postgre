# Multi-database: buka beberapa database sekaligus, pindah tab, schema terpisah per database. Jalankan: vite --config vite.mainharness.config.js --port 5198
from playwright.sync_api import sync_playwright
import sys
URL = 'http://localhost:5198/'
bad = []
def ck(n, ok, extra=''):
    print(('PASS ' if ok else 'FAIL ') + n, extra if not ok else '')
    if not ok: bad.append(n)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL); pg.wait_for_timeout(800)
    pg.fill('#apiId', '123'); pg.fill('#apiHash', 'abc'); pg.fill('#newPass', 'passphrase123'); pg.click('#btnLogin')
    pg.wait_for_selector('#c-db:not([hidden])', timeout=15000)
    for name in ['alpha', 'beta']:
        pg.fill('#dbName', name); pg.click('#btnCreate')
        pg.wait_for_selector('#c-work:not([hidden])', timeout=60000); pg.wait_for_timeout(800)
        # buat schema + tabel lewat query tab
        if name == 'alpha': sql = 'create schema ska; create table ska.t(id int primary key, v text); insert into ska.t values (1,\'a\')'
        else: sql = 'create schema skb; create table skb.t(id int primary key, v text); insert into skb.t values (1,\'b\')'
        vis = pg.locator('#c-work > div:not([hidden])')
        vis.locator('.plus').click(); pg.wait_for_timeout(400)
        ta = vis.locator('.pane:not([hidden]) .editor').first; ta.fill(sql); ta.press('Control+Enter'); pg.wait_for_timeout(1500)
        pg.click('.dbtab.add'); pg.wait_for_selector('#c-db:not([hidden])')
    tabs = pg.locator('.dbtab:not(.add)')
    ck('dua tab database terbuka', tabs.count() == 2, tabs.count())
    pg.locator('.dbtab:not(.add)').nth(0).click(); pg.wait_for_timeout(500)
    t0 = pg.inner_text('#c-work > div:not([hidden])')
    ck('tab 1 hanya punya schema ska', 'ska' in t0 and 'skb' not in t0)
    pg.locator('.dbtab:not(.add)').nth(1).click(); pg.wait_for_timeout(500)
    t1 = pg.inner_text('#c-work > div:not([hidden])')
    ck('tab 2 hanya punya schema skb', 'skb' in t1 and 'ska' not in t1)
    ck('hanya satu workspace terlihat', pg.locator('#c-work > div:not([hidden])').count() == 1)
    pg.locator('.dbtab:not(.add) .x').nth(0).click(); pg.wait_for_timeout(500)
    ck('tutup satu → sisa satu', pg.locator('.dbtab:not(.add)').count() == 1)
    ck('database sisa tetap tampil', 'skb' in pg.inner_text('#c-work > div:not([hidden])'))
    print('page errors:', errs); ck('tanpa page error', not errs)
    b.close()
print('FAILED:', bad)
