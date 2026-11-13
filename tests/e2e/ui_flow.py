"""E2E UI (Chrome headless) terhadap harness workspace (engine + transport in-memori, tanpa Telegram).
Jalankan:  npm run build:harness && python3 -m http.server 4173 -d /tmp/harness-site &  python3 tests/e2e/ui_flow.py
Env: BASE_URL (default http://localhost:4173/harness/ws.html), CHROME_PATH (opsional)."""
import json, os, sys
from playwright.sync_api import sync_playwright

URL = os.environ.get('BASE_URL', 'http://localhost:4173/harness/ws.html')
CHROME = os.environ.get('CHROME_PATH')
SHOTS = os.environ.get('SHOT_DIR', '/tmp')
res = []
def ck(name, cond, extra=''):
    res.append((name, bool(cond)))
    print(('PASS' if cond else 'FAIL'), name, extra)

ACT = '.pane:not([hidden])'
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox']) if CHROME else p.chromium.launch(args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 820}, accept_downloads=True)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    pg.goto(URL); pg.wait_for_selector('.tree .schema', timeout=90000)

    # ── sidebar
    ck('sidebar: dua schema', len(pg.locator('.tree .schema').all()) == 2)
    ck('sidebar menyembunyikan objek internal', all(x not in pg.inner_text('.tree') for x in ['_tgpg', 'tg_now', 'tg_uuid']))
    ck('view berlabel', 'view' in pg.inner_text('.tree'))

    # ── tabel notes: grid, sort, paging, filter
    pg.locator('.tree .tname', has_text='notes').first.click(); pg.wait_for_selector(f'{ACT} .grid tbody tr')
    ck('grid 50 baris', pg.locator(f'{ACT} .grid tbody tr').count() == 50)
    ck('status 120 baris', '120 baris' in pg.inner_text(ACT))
    ck('kolom __pk tidak tampil', '__pk' not in pg.inner_text(f'{ACT} thead'))
    pg.locator(f'{ACT} th.sortable', has_text='n').first.click(); pg.wait_for_timeout(300)
    ck('sort asc', '▲' in pg.inner_text(f'{ACT} thead'))
    pg.locator(f'{ACT} th.sortable', has_text='n').first.click(); pg.wait_for_timeout(300)
    ck('sort desc', '▼' in pg.inner_text(f'{ACT} thead'))
    pg.locator(f'{ACT} .pager button', has_text='›').click(); pg.wait_for_timeout(400)
    ck('halaman 2 / 3 & nomor baris 51', '2 / 3' in pg.inner_text(f'{ACT} .pageinfo') and pg.locator(f'{ACT} .grid tbody tr td.rn').first.inner_text() == '51')
    pg.fill(f'{ACT} .filter', 'id > 100'); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(400)
    ck('filter -> 20 baris', '20 baris' in pg.inner_text(ACT))
    pg.fill(f'{ACT} .filter', 'nope = 1'); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(400)
    ck('filter salah -> error', pg.locator(f'{ACT} .er').count() == 1)
    pg.fill(f'{ACT} .filter', ''); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(300)

    # ── edit / tambah / hapus baris
    pg.fill(f'{ACT} .filter', 'id <= 3'); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(400)
    pg.locator(f'{ACT} .grid tbody tr').first.locator('button[aria-label="Edit baris"]').click()
    pg.wait_for_selector('.dialog')
    pg.locator('.dialog textarea[aria-label="body"]').fill("diedit 'kutip' & <b>")
    pg.locator('.dialog button', has_text='Simpan').click(); pg.wait_for_selector('.dialog', state='detached', timeout=15000)
    pg.wait_for_timeout(300)
    ck('edit baris: nilai baru tampil (kutip & html aman)', "diedit 'kutip' & <b>" in pg.inner_text(f'{ACT} .grid') and pg.locator(f'{ACT} .grid b').count() == 0)
    # NULL checkbox
    pg.locator(f'{ACT} .grid tbody tr').first.locator('button[aria-label="Edit baris"]').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog input[aria-label="NULL untuk body"]').check()
    pg.locator('.dialog button', has_text='Simpan').click(); pg.wait_for_selector('.dialog', state='detached', timeout=15000); pg.wait_for_timeout(300)
    ck('set NULL', 'NULL' in pg.locator(f'{ACT} .grid tbody tr').first.inner_text())
    # tambah baris + default
    pg.locator(f'{ACT} button', has_text='+ Baris').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog textarea[aria-label="id"]').fill('5000'); pg.locator('.dialog textarea[aria-label="body"]').fill('baris baru')
    pg.locator('.dialog button', has_text='Tambah').click(); pg.wait_for_selector('.dialog', state='detached', timeout=15000)
    pg.fill(f'{ACT} .filter', 'id = 5000'); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(400)
    ck('tambah baris (created_at default terisi)', 'baris baru' in pg.inner_text(f'{ACT} .grid') and '20' in pg.inner_text(f'{ACT} .grid tbody tr td:last-child') or '2026' in pg.inner_text(f'{ACT} .grid'))
    # tambah duplikat -> error di dialog, dialog tetap terbuka
    pg.locator(f'{ACT} button', has_text='+ Baris').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog textarea[aria-label="id"]').fill('5000')
    pg.locator('.dialog button', has_text='Tambah').click(); pg.wait_for_selector('.dialog .er:not([hidden])', timeout=15000)
    ck('PK duplikat -> error di dialog', 'duplicate key' in pg.inner_text('.dialog .er') and pg.locator('.dialog').count() == 1)
    pg.keyboard.press('Escape'); pg.wait_for_selector('.dialog', state='detached')
    ck('Esc menutup dialog', True)
    # hapus
    pg.once('dialog', lambda d: d.accept())
    pg.locator(f'{ACT} .grid tbody tr').first.locator('button[aria-label="Hapus baris"]').click(); pg.wait_for_timeout(1200)
    ck('hapus baris', 'Tidak ada baris yang cocok' in pg.inner_text(ACT) or pg.locator(f'{ACT} .grid tbody tr').count() == 0)
    pg.fill(f'{ACT} .filter', ''); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(400)
    ck('total jadi 120 (120 + 1 tambah - 1 hapus)', '120 baris' in pg.inner_text(ACT))

    # ── struktur & export
    pg.locator(f'{ACT} button', has_text='Struktur').click(); pg.wait_for_timeout(500)
    st = pg.inner_text(f'{ACT} .struct')
    ck('struktur: kolom, PK, default deterministik, index', all(x in st for x in ['created_at', '🔑', 'tg_now', 'notes_n_idx']))
    pg.locator(f'{ACT} button', has_text='Data').click(); pg.wait_for_timeout(400)
    with pg.expect_download() as d: pg.locator(f'{ACT} button', has_text='CSV').click()
    raw = open(d.value.path(), 'rb').read().decode()
    ck('export CSV tabel (header + 120 baris, CRLF)', raw.startswith('id,body,n,created_at') and raw.count('\r\n') == 120)

    # ── hanya-baca: tanpa PK & view
    pg.locator('.tree .tname', has_text='nopk').first.click(); pg.wait_for_selector(f'{ACT} .grid tbody tr')
    ck('tabel tanpa PK: hanya-baca', pg.locator(f'{ACT} button', has_text='+ Baris').is_disabled() and pg.locator(f'{ACT} .grid td.act').count() == 0 and 'hanya-baca' in pg.inner_text(ACT))
    pg.locator('.tree .tname', has_text='v_users').first.click(); pg.wait_for_selector(f'{ACT} .grid tbody tr')
    ck('view: hanya-baca', pg.locator(f'{ACT} button', has_text='+ Baris').is_disabled())
    pg.locator('.tree .tname', has_text='users').first.click(); pg.wait_for_selector(f'{ACT} .grid tbody tr')
    ck('tabel serial PK: NULL tampil, editable', 'NULL' in pg.inner_text(f'{ACT} .grid') and pg.locator(f'{ACT} .grid td.act').count() == 2)

    # ── tab query
    pg.locator('.plus').click(); ta = pg.locator(f'{ACT} .editor'); ta.fill("select 1 as a, 'x' as b"); ta.press('Control+Enter')
    pg.wait_for_selector(f'{ACT} .result .grid')
    ck('query read', '1 baris' in pg.inner_text(f'{ACT} .tools'))
    ta.fill("insert into notes(id, body) values (777, 'q')"); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(800)
    ck('query write', 'ditulis sebagai #' in pg.inner_text(f'{ACT} .tools'))
    ta.fill("insert into notes(id, body) values (777, 'dup')"); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(800)
    ck('error duplikat tampil', 'duplicate key' in pg.inner_text(f'{ACT} .result'))
    ta.fill("selct 1"); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(800)
    ck('syntax error tampil', 'syntax error' in pg.inner_text(f'{ACT} .result').lower())
    ta.fill("select 1 as a; select 2 as b; select 3 as c"); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(600)
    ck('multi-statement: 3 grid', pg.locator(f'{ACT} .result .grid').count() == 3)
    ta.fill("select 'A' as x; select 'B' as y"); ta.evaluate("e=>{e.setSelectionRange(0,15)}")
    pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(500)
    ck('run selection', pg.locator(f'{ACT} .result .grid').count() == 1 and 'A' in pg.inner_text(f'{ACT} .result'))
    pg.locator(f'{ACT} button', has_text='Riwayat').click()
    ck('riwayat', pg.locator(f'{ACT} .hitem').count() >= 3)
    ta.fill("create table baru_tbl(a int)"); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(1200)
    ck('sidebar refresh setelah DDL', 'baru_tbl' in pg.inner_text('.tree'))
    ta.fill("select * from notes order by id limit 5"); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_selector(f'{ACT} .result .grid'); pg.wait_for_timeout(300)
    with pg.expect_download() as d2: pg.locator(f'{ACT} .tools button', has_text='JSON').click()
    js = json.load(open(d2.value.path())); ck('export JSON hasil query', len(js) == 5)
    n0 = pg.locator('.tabbar .tab').count(); pg.locator('.tabbar .tab .x').first.click(); ck('tutup tab', pg.locator('.tabbar .tab').count() == n0 - 1)
    pg.screenshot(path=f'{SHOTS}/shot-desktop.png')

    # ── offline / online
    pg.locator('button', has_text='Sinkron').first.click(); pg.wait_for_timeout(500)
    ck('chip: tersinkron', '✓' in pg.inner_text('.net'), pg.inner_text('.net'))
    ctx.set_offline(True); pg.wait_for_timeout(300)
    ck('chip: offline', 'offline' in pg.inner_text('.net'))
    ta2 = pg.locator(f'{ACT} .editor'); ta2.fill('create table off_tbl(a int)'); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(600)
    ck('write saat offline ditolak dengan pesan jelas', 'offline' in pg.inner_text(f'{ACT} .result').lower())
    ta2.fill('select 1 as masih_bisa_baca'); pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(500)
    ck('read saat offline tetap jalan', 'masih_bisa_baca' in pg.inner_text(f'{ACT} .result'))
    ctx.set_offline(False); pg.wait_for_timeout(300)
    ck('chip pulih setelah online', 'offline' not in pg.inner_text('.net'))

    # ── mobile
    m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
    m.goto(URL); m.wait_for_selector('.tree .schema', timeout=90000)
    ck('mobile: drawer tersembunyi', m.locator('.ws-side').bounding_box()['x'] < 0)
    m.locator('.side-toggle').click(); m.wait_for_timeout(400)
    ck('mobile: drawer terbuka', m.locator('.ws-side').bounding_box()['x'] >= 0)
    m.mouse.click(370, 400); m.wait_for_timeout(300)
    ck('mobile: sentuh luar menutup drawer', m.locator('.ws-side').bounding_box()['x'] < 0)
    m.locator('.side-toggle').click(); m.wait_for_timeout(300)
    m.locator('.tree .tname', has_text='notes').first.click(); m.wait_for_selector(f'{ACT} .grid tbody tr'); m.wait_for_timeout(400)
    ck('mobile: drawer menutup setelah pilih tabel', m.locator('.ws-side').bounding_box()['x'] < 0)
    ck('mobile: tanpa overflow horizontal', m.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    m.locator(f'{ACT} .grid tbody tr').first.locator('button[aria-label="Edit baris"]').click(); m.wait_for_selector('.dialog')
    box = m.locator('.dialog').bounding_box()
    ck('mobile: dialog edit muat di layar', box['x'] >= 0 and box['x'] + box['width'] <= 391 and box['y'] >= 0)
    m.screenshot(path=f'{SHOTS}/shot-mobile-dialog.png')
    print('PAGE ERRORS:', errs[:5]); ck('tanpa error di console/halaman', not errs)
    b.close()
failed = [n for n, ok in res if not ok]
print('FAILED:', failed); sys.exit(1 if failed else 0)
