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

- **Undang @username**: tombol di panel Bagikan menambahkan user ke grup (dan opsional DM connection string — Telegram bisa melihat DM itu). Belum diuji ke Telegram asli; privasi target dapat menolak.

## Mencabut akses (rotasi kunci)

- Tiap anggota punya identitas ECDH (P-256) di vault lokal; kunci publiknya didaftarkan di log (`hello`). ID pengirim dari Telegram tidak bisa dipalsukan, jadi dipakai sebagai identitas anggota.
- **Owner** = pengirim pesan TGPG pertama di grup (pembuat database). Di panel **Anggota**, owner bisa **Cabut** (kunci baru dibungkus hanya untuk anggota yang tersisa, user dikeluarkan dari grup, op darinya ditolak semua klien) dan **Setujui** (anggota baru setelah rotasi mendapat kunci).
- Setelah rotasi, siapa pun yang hanya punya connection string lama hanya bisa membaca data sampai titik rotasi.
- **Batas**: yang dicabut tetap memegang data yang pernah ia lihat (tidak bisa ditarik kembali). Bila owner kehilangan vault (identitas), ia tidak bisa merotasi lagi. Anggota yang tidak pernah `hello` (klien lama) tidak ikut menerima kunci baru. Tidak ada transfer kepemilikan.

- **Diagnostik** (toolbar): uji satu klik terhadap Telegram asli (login, kirim/baca maju, senderId, file, pencarian, event realtime). **Backup**: unduh salinan lokal database (`.tar.gz` PGlite).

## Klien native (Rust) — untuk DBeaver / psql

Folder `native/` berisi klien TGPG tanpa browser. Ia memakai log Telegram yang sama dengan klien web (format op, kunci, dan rotasi kompatibel; diuji dua arah dengan vektor bersama), lalu membuka server protokol Postgres di `127.0.0.1` supaya DBeaver/psql/JDBC bisa tersambung. Tidak ada backend lain.

```
export TG_API_ID=... TG_API_HASH=...            # dari my.telegram.org
export TGPG_PG_URL=postgres://u:p@127.0.0.1:5432/postgres   # Postgres lokal (admin)
cargo run -p tgpg -- login
cargo run -p tgpg -- serve 'tgpg://<hash>#<kunci>' --listen 127.0.0.1:5432
```
Lalu di DBeaver: host `127.0.0.1`, port sesuai `--listen`, database/user bebas, tanpa sandi.

Perilaku & batas:
- Baca (`SELECT`, dst.) dijalankan di Postgres lokal; tulis dikirim ke grup sebagai op terenkripsi. Transaksi ditahan sampai `COMMIT` dan dikirim sebagai satu op; `SAVEPOINT` belum didukung.
- Server tanpa autentikasi — hanya mau bind ke loopback.
### Untuk REST API / server (tanpa login interaktif)

Buat **token layanan** sekali dari mesin yang sudah `tgpg login` (sebaiknya dengan akun Telegram khusus layanan yang sudah jadi anggota grup):

```bash
tgpg token create 'tgpg://HASH#KUNCI' --chat 'TGPG · nama-db' > token.txt
# di server/container API (butuh Postgres lokal untuk TGPG_PG_URL):
TGPG_TOKEN="$(cat token.txt)" TGPG_PG_URL=postgres://u:p@127.0.0.1:5432/postgres \
  tgpg serve --token "$TGPG_TOKEN" --listen 0.0.0.0:55432 --password "$SANDI"
# REST API memakai driver Postgres biasa: postgres://app:$SANDI@host:55432/db
```

- Token berisi sesi Telegram + kunci database dan **tidak terenkripsi**: perlakukan seperti sandi. Jangan di-commit/di-log.
- `--password` wajib bila `--listen` bukan localhost. Sandi dikirim cleartext tanpa TLS: pakai jaringan privat atau tunnel.
- Cabut akses: Anggota → **Cabut** di aplikasi web (rotasi kunci + keluarkan akun), atau akhiri sesi di Telegram → Perangkat.

- Klien native memutar ulang seluruh log (belum memakai snapshot); satu owner per database.
- **Belum diuji terhadap Telegram sungguhan**: hanya transport memori yang diuji otomatis (`cargo test`, butuh `TGPG_TEST_PG`; lihat `native/scripts/pg-test.sh`). Transport Telegram (`tgpg-telegram`, grammers) baru terbukti terkompilasi. Aplikasi desktop mini (egui): `cargo run -p tgpg-gui` — login, buka database, status server, setujui/cabut anggota; juga baru terkompilasi, belum diuji.
- Postgres tertanam (`postgresql_embedded`) belum dipasang; saat ini butuh Postgres lokal.
