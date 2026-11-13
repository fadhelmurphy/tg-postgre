# TGPG

PostgreSQL (PGlite/WASM) yang jalan penuh di browser. Datanya dibagi antar user lewat **grup Telegram**, bukan TCP: tiap user punya salinan lokal, dan grup Telegram menjadi log perubahan terenkripsi.

## Cara kerja
- **Write** (`INSERT/UPDATE/DDL`) dienkripsi (AES-GCM) lalu dikirim ke supergroup privat sebagai satu pesan. Op besar dikirim sebagai file.
- Message ID Telegram berurutan, jadi semua klien menerapkan op dalam urutan yang sama dan hasilnya konvergen.
- **Read** (`SELECT`) jalan lokal, read-only, tidak masuk log.
- `now()`, `gen_random_uuid()`, `random()` ditulis ulang menjadi `tg_now()`, `tg_uuid()`, `tg_random()` yang nilainya diturunkan dari op, jadi sama di semua klien (termasuk `DEFAULT` di `CREATE TABLE`).
- **Snapshot** (dump terenkripsi) dikirim berkala (tiap 50 write per klien, atau tombol Snapshot). User baru memulihkan snapshot terakhir lalu replay sisa log.
- **Connection string:** `tgpg://<invite>#<kunci>`. Invite = link undangan grup, kunci = kunci enkripsi 256-bit. Siapa pun yang memegangnya bisa membaca dan menulis.

## Antarmuka (ala pgAdmin)
- **Sidebar objek:** schema → tabel/view → kolom (tipe, PK), plus fungsi. Klik nama tabel untuk membuka datanya, tombol `SQL` untuk membuka tab query berisi `select *`.
- **Tab tabel:** data grid dengan sort (klik header), paginasi, filter `WHERE`, inspector sel, tab **Struktur** (kolom, default, index), export CSV/JSON.
- **Tab query:** banyak tab, `Ctrl+Enter`, jalankan sebagian (blok teks), hasil multi-statement, waktu eksekusi, riwayat, export hasil.
- Sidebar menyegarkan diri saat ada DDL, baik dari kamu maupun dari user lain. Di layar kecil sidebar menjadi drawer.

## Deploy ke GitHub Pages
1. Push repo ini ke GitHub (branch `main`).
2. Settings → Pages → Source: **GitHub Actions**.
3. Push ke `main` memicu `.github/workflows/deploy.yml` (tes → build → deploy).

Catatan: semua halaman `username.github.io/*` berbagi origin yang sama (localStorage/IndexedDB). Vault di sini dienkripsi passphrase, tapi domain custom lebih aman.

## Pakai
1. Buat `api_id`/`api_hash` di my.telegram.org. **Pakai akun Telegram khusus.**
2. Buka halaman → isi kredensial + passphrase lokal → login (kode Telegram, dan 2FA bila aktif).
3. "Buat baru" (membuat supergroup privat) atau tempel connection string dari teman → Connect.

## Pengembangan
```
npm ci
npm run dev      # dev server
npm test         # tes engine multi-klien (transport in-memori)
npm run build    # output di dist/
```

## Batasan yang perlu dipahami
- **Semua anggota dipercaya penuh.** Siapa pun di grup bisa menjalankan SQL apa pun (termasuk `DROP`). Tidak ada hak akses per tabel.
- **Jangan hapus atau edit pesan di grup.** Itu mengubah log dan membuat salinan baru berbeda dari yang lama. Telegram tidak bisa mencegah anggota menghapus pesannya sendiri. Kalau terjadi, pakai "Reset salinan lokal", dan snapshot lama masih jadi jalan pulih.
- Throughput rendah: sekitar 1 detik per write dan kena rate limit Telegram. Cocok untuk tim kecil dan beban tulis ringan.
- Tidak ada transaksi lintas statement: tiap Run dengan banyak statement dieksekusi atomik sebagai satu op, tapi `BEGIN/COMMIT` manual tidak didukung.
- `now()`/`random()` di dalam badan fungsi (`$$ ... $$`) tidak ditulis ulang. Pakai `tg_now()`/`tg_uuid()`/`tg_random()` langsung di sana.
- Satu database hanya bisa dibuka di satu tab per browser (Web Locks).
- Penggunaan Telegram sebagai penyimpanan data bisa melanggar ToS bila dipakai massal. Pakai untuk skala pribadi/tim kecil.
- Session Telegram + kunci database disimpan di localStorage terenkripsi passphrase (PBKDF2 250k iterasi). Lupa passphrase berarti harus login ulang.

## Ketahanan & keamanan (ringkas)

- **Idempotent**: tiap op punya `oid`; retry setelah respons hilang tidak menggandakan data.
- **Offline**: baca lokal tetap jalan; write ditolak dengan pesan jelas; sinkron otomatis saat online/tab aktif.
- **Edit baris**: hanya tabel dengan primary key; update per-kolom yang berubah. Tanpa optimistic locking (last-write-wins).
- **PGlite di Web Worker** (fallback ke utas utama bila gagal). Satu tab per database (Web Locks).
- **Vault** lokal terenkripsi passphrase; CSP ketat di build produksi; render tanpa innerHTML.

### Batasan yang jujur
- Belum diuji ke Telegram sungguhan — jalankan `SMOKE_TEST.md` dulu.
- Semua anggota grup dipercaya penuh (bisa menulis SQL apa pun). Menghapus/mengedit pesan grup merusak log.
- Throughput rendah (batas rate Telegram). Rotasi kunci belum ada. Risiko ToS Telegram untuk pemakaian berat.
