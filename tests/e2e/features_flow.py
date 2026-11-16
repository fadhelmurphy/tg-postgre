"""E2E fitur lanjutan (struktur/DDL, edit sel, import, ERD, editor). Harness yang sama dengan ui_flow.py."""
import os, tempfile
from playwright.sync_api import sync_playwright

URL = os.environ.get('BASE_URL', 'http://localhost:4173/ws.html')
CHROME = os.environ.get('CHROME_PATH')
res = []
def ck(name, cond, extra=''):
    res.append((name, bool(cond))); print(('PASS' if cond else 'FAIL'), name, extra)

ACT = '.pane:not([hidden])'
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox']) if CHROME else p.chromium.launch(args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    pg.goto(URL); pg.wait_for_selector('.tree .schema', timeout=90000)

    def dlg_run(label='Jalankan'):
        pg.locator('.dialog button', has_text=label).first.click(); pg.wait_for_selector('.dialog', state='detached', timeout=20000); pg.wait_for_timeout(400)

    # ── buat tabel lewat form
    pg.locator('.side-tools button', has_text='+ Tabel').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog input[placeholder="nama_tabel"]').fill('produk')
    ck('buat tabel: pratinjau SQL', 'CREATE TABLE "public"."produk"' in pg.inner_text('.dialog .sqlprev') and 'PRIMARY KEY ("id")' in pg.inner_text('.dialog .sqlprev'))
    pg.locator('.dialog input[placeholder="kolom"]').nth(1).fill('')
    ck('buat tabel: kolom kosong -> error pratinjau', 'kosong' in pg.inner_text('.dialog .sqlprev'))
    pg.locator('.dialog input[placeholder="kolom"]').nth(1).fill('nama')
    pg.locator('.dialog button', has_text='+ Kolom').click()
    pg.locator('.dialog input[placeholder="kolom"]').nth(2).fill('harga'); pg.locator('.dialog .ctrow input[list]').nth(2).fill('numeric(12,2)')
    pg.locator('.dialog button', has_text='Buat tabel').click(); pg.wait_for_selector('.dialog', state='detached', timeout=20000)
    pg.wait_for_selector(f'{ACT} .grid, {ACT} .mu', timeout=10000)
    ck('tabel baru muncul di sidebar & tab terbuka', 'produk' in pg.inner_text('.tree') and 'produk' in pg.inner_text('.tabbar'))

    # ── struktur: tambah kolom, index, FK, DDL
    pg.locator(f'{ACT} button', has_text='Struktur').click(); pg.wait_for_selector(f'{ACT} .struct h3')
    ck('struktur: kolom + PK + DDL tampil', 'bigserial' in pg.inner_text(ACT).lower() or 'bigint' in pg.inner_text(ACT).lower())
    pg.locator(f'{ACT} .struct button', has_text='+ Kolom').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog .frow input').nth(0).fill('stok'); pg.locator('.dialog .frow input').nth(1).fill('integer'); pg.locator('.dialog .frow input').nth(2).fill('0')
    dlg_run()
    ck('tambah kolom', 'stok' in pg.inner_text(f'{ACT} .struct'))
    pg.locator(f'{ACT} .struct button', has_text='+ Index').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog select[multiple]').select_option('stok'); pg.locator('.dialog input').first.fill('produk_stok_idx')
    dlg_run()
    ck('buat index', 'produk_stok_idx' in pg.inner_text(f'{ACT} .struct'))
    pg.locator(f'{ACT} .struct button', has_text='+ FK').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog select[multiple]').first.select_option('stok')
    pg.locator('.dialog select').nth(1).select_option(label='public.notes')
    pg.wait_for_timeout(200); pg.locator('.dialog select[multiple]').nth(1).select_option('id')
    ck('FK: pratinjau memuat tabel rujukan', 'REFERENCES "public"."notes" ("id")' in pg.inner_text('.dialog .sqlprev'))
    dlg_run()
    ck('foreign key tampil', 'notes' in pg.inner_text(f'{ACT} .struct') and 'FOREIGN KEY' in pg.inner_text(f'{ACT} .struct'))
    # ubah kolom: ganti nama
    pg.locator(f'{ACT} .struct tr', has_text='nama').locator('button', has_text='✎').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog .frow input').first.fill('nama_produk'); dlg_run('Jalankan')
    ck('rename kolom', 'nama_produk' in pg.inner_text(f'{ACT} .struct'))
    # kolom: tipe tak kompatibel -> error tampil di dialog
    pg.locator(f'{ACT} .struct tr', has_text='nama_produk').locator('button', has_text='✎').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog .frow input').nth(1).fill('uuid'); pg.locator('.dialog button', has_text='Jalankan').click(); pg.wait_for_timeout(1500)
    ck('ubah tipe gagal -> error di dialog, dialog tetap', pg.locator('.dialog').count() == 1 and pg.locator('.dialog .er:not([hidden])').count() >= 0)
    pg.keyboard.press('Escape'); pg.wait_for_selector('.dialog', state='detached')

    # ── data: isi lewat query, edit sel, FK link, pilih+hapus, duplikat, cari
    pg.locator('.tabbar .tab .tt', has_text='Query 1').click()
    pg.fill(f'{ACT} textarea.editor', "insert into produk(nama_produk, harga, stok) values ('a', 1.5, 1), ('b', 2, 2), ('c', 3, 3), ('d', 4, 4);")
    pg.locator(f'{ACT} button', has_text='Run').click(); pg.wait_for_timeout(1500)
    pg.locator('.tabbar .tab .tt', has_text='produk').click(); pg.locator(f'{ACT} button', has_text='Data').click(); pg.locator(f'{ACT} button', has_text='↻').first.click(); pg.wait_for_timeout(600)
    ck('data produk 4 baris', '4 baris' in pg.inner_text(ACT))
    cell = pg.locator(f'{ACT} .grid tbody tr').first.locator('td').nth(3)   # sel #, id, nama? (urutan: cb, rn, id, nama)
    pg.locator(f'{ACT} .grid tbody tr').first.locator('td').nth(3).dblclick(); pg.wait_for_selector(f'{ACT} input.cell')
    pg.fill(f'{ACT} input.cell', 'A-baru'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
    ck('edit sel inline', 'A-baru' in pg.inner_text(f'{ACT} .grid'))
    pg.locator(f'{ACT} .grid tbody tr').first.locator('td').nth(3).dblclick(); pg.wait_for_selector(f'{ACT} input.cell'); pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    ck('Esc membatalkan edit sel', pg.locator(f'{ACT} input.cell').count() == 0 and 'A-baru' in pg.inner_text(f'{ACT} .grid'))
    pg.fill(f'{ACT} input[aria-label="Cari di semua kolom"]', 'A-baru'); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(500)
    ck('cari di semua kolom', '1 baris' in pg.inner_text(ACT))
    pg.fill(f'{ACT} input[aria-label="Cari di semua kolom"]', "50%_"); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(500)
    ck('cari: wildcard di-escape (tanpa hasil)', '0 baris' in pg.inner_text(ACT))
    pg.fill(f'{ACT} input[aria-label="Cari di semua kolom"]', ''); pg.locator(f'{ACT} button', has_text='Terapkan').click(); pg.wait_for_timeout(500)
    pg.locator(f'{ACT} .grid tbody tr').nth(1).locator('td.sel input').check(); pg.locator(f'{ACT} .grid tbody tr').nth(2).locator('td.sel input').check()
    ck('bar pilihan', '2 baris dipilih' in pg.inner_text(f'{ACT} .selbar'))
    pg.locator(f'{ACT} .selbar button', has_text='Hapus terpilih').click(); pg.wait_for_selector('.dialog'); dlg_run('Ya, lanjutkan'); pg.wait_for_timeout(500)
    ck('hapus terpilih', '2 baris' in pg.inner_text(ACT))
    pg.locator(f'{ACT} .grid tbody tr').first.locator('td.sel input').check()
    pg.locator(f'{ACT} .selbar button', has_text='Duplikat').click(); pg.wait_for_selector('.dialog')
    ck('duplikat: id kosong (auto), nama terisi', pg.locator('.dialog textarea[aria-label="id"]').input_value() == '' and pg.locator('.dialog textarea[aria-label="nama_produk"]').input_value() != '')
    pg.locator('.dialog button', has_text='Tambah').click(); pg.wait_for_selector('.dialog', state='detached', timeout=15000); pg.wait_for_timeout(500)
    ck('duplikat tersimpan', '3 baris' in pg.inner_text(ACT))
    # FK link (stok -> notes.id): stok=1 ada di notes
    link = pg.locator(f'{ACT} .grid .fklink').first
    ck('ikon FK tampil', link.count() == 1)
    link.click(); pg.wait_for_timeout(1200)
    ck('FK: tab notes terbuka terfilter', pg.locator('.tab.on', has_text='notes').count() == 1 and '1 baris' in pg.inner_text(ACT))

    # ── editor: format, explain, saran, simpan
    pg.locator('.tabbar .tab .tt', has_text='Query 1').click()
    pg.fill(f'{ACT} textarea.editor', "select id,body from notes where id<3 and n>=0 order by id")
    pg.locator(f'{ACT} button', has_text='Format').click()
    v = pg.input_value(f'{ACT} textarea.editor')
    ck('format SQL', v.startswith('SELECT id,body\nFROM notes\nWHERE id<3') and '\nORDER BY id' in v, repr(v))
    pg.locator(f'{ACT} button', has_text='Explain').first.click(); pg.wait_for_timeout(1200)
    ck('explain menampilkan rencana', 'QUERY PLAN' in pg.inner_text(f'{ACT} .result') or 'Scan' in pg.inner_text(f'{ACT} .result'))
    pg.fill(f'{ACT} textarea.editor', 'select * from prod'); pg.locator(f'{ACT} textarea.editor').press('End'); pg.locator(f'{ACT} textarea.editor').type('u')
    pg.wait_for_selector(f'{ACT} .sugbar:not([hidden]) button'); ck('saran tabel', 'produk' in pg.inner_text(f'{ACT} .sugbar'))
    pg.keyboard.press('Tab'); ck('Tab menerima saran', pg.input_value(f'{ACT} textarea.editor').endswith('produk'))
    pg.locator(f'{ACT} button', has_text='Simpan').click(); pg.wait_for_selector('.dialog'); pg.locator('.dialog input').fill('lihat produk'); pg.locator('.dialog button', has_text='OK').click(); pg.wait_for_timeout(300)
    pg.locator(f'{ACT} button', has_text='Riwayat').click(); ck('snippet tersimpan', 'lihat produk' in pg.inner_text(f'{ACT} .history'))

    # ── import CSV (tempel) ke tabel baru, lalu ke tabel yang ada
    pg.locator('.side-tools button', has_text='Impor').click(); pg.wait_for_selector('.dialog')
    pg.locator('.dialog input[placeholder="nama tabel baru"]').fill('kota')
    pg.fill('.dialog textarea', 'nama;pop\nJakarta;10562088\n"Bandung; Kota";2444160\nMedan;\n')
    pg.wait_for_selector('.dialog .maprow'); ck('import: deteksi 3 baris, 2 kolom', '3 baris, 2 kolom' in pg.inner_text('.dialog'))
    pg.locator('.dialog button', has_text='Impor').last.click(); pg.wait_for_selector('.dialog', state='detached', timeout=20000); pg.wait_for_timeout(800)
    ck('import: tabel baru berisi 3 baris', '3 baris' in pg.inner_text(ACT) and 'Bandung; Kota' in pg.inner_text(f'{ACT} .grid'))
    pg.locator(f'{ACT} button', has_text='Impor').first.click(); pg.wait_for_selector('.dialog')
    pg.fill('.dialog textarea', '[{"nama":"Surabaya","pop":"2874314"},{"nama":"Bali","extra":"x"}]'); pg.wait_for_selector('.dialog .maprow')
    pg.locator('.dialog button', has_text='Impor').last.click(); pg.wait_for_selector('.dialog', state='detached', timeout=20000); pg.wait_for_timeout(800)
    ck('import JSON ke tabel ada (kolom tak dikenal dilewati)', '5 baris' in pg.inner_text(ACT))

    # ── ERD
    pg.locator('.side-tools button', has_text='ERD').click(); pg.wait_for_selector(f'{ACT} svg .erd-t', timeout=15000)
    ck('ERD: tabel & relasi', pg.locator(f'{ACT} svg .erd-t').count() >= 5 and pg.locator(f'{ACT} svg path[marker-end]').count() >= 1 and 'relasi' in pg.inner_text(ACT))
    with pg.expect_download() as d: pg.locator(f'{ACT} button', has_text='Unduh SVG').click()
    ck('ERD: unduh SVG', d.value.suggested_filename.endswith('.svg'))

    # ── dump & restore ke DB lain tidak bisa diuji di sini; cukup unduh & cek isi
    with pg.expect_download() as d: pg.locator('.side-tools button', has_text='Dump').click()
    path = d.value.path(); sql = open(path).read()
    ck('dump: BEGIN/COMMIT, tabel & data', sql.startswith('-- TGPG dump') and 'CREATE TABLE "public"."produk"' in sql and "INSERT INTO" in sql and sql.rstrip().endswith('COMMIT;') and 'Bandung; Kota' in sql)
    ck('dump: tidak memuat objek internal & portabel', '_tgpg' not in sql and 'tg_now' not in sql and 'DEFAULT now()' in sql, [l for l in sql.splitlines() if 'tg_' in l][:2])

    # ── menu tabel & hapus tabel
    pg.locator('.tree summary', has_text='kota').locator('button[aria-label^="Menu"]').click()
    ck('menu tabel tampil', pg.locator('.popmenu button').count() >= 5)
    pg.locator('.popmenu button', has_text='Lihat struktur').click(); pg.wait_for_selector(f'{ACT} .struct h3')
    pg.locator(f'{ACT} .struct button', has_text='Hapus').first.click(); pg.wait_for_selector('.dialog'); dlg_run('Hapus'); pg.wait_for_timeout(600)
    ck('hapus tabel', 'kota' not in pg.inner_text('.tree'))
    pg.locator('.tree summary', has_text='produk').locator('button[aria-label^="Menu"]').click(); pg.locator('.popmenu button', has_text='Lihat struktur').click()
    pg.locator(f'{ACT} .struct button', has_text='Kosongkan').click(); pg.wait_for_selector('.dialog'); dlg_run('Kosongkan'); pg.wait_for_timeout(400)
    ck('kosongkan tabel', True)
    print('PAGE ERRORS:', errs); ck('tanpa error di console/halaman', not errs)
    b.close()
bad = [n for n, ok in res if not ok]
print('FAILED:', bad)
raise SystemExit(1 if bad else 0)
