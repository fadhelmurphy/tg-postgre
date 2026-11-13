# Smoke test pertama dengan Telegram sungguhan

Belum pernah diuji terhadap server Telegram asli. Jalankan ini sekali sebelum dipakai serius. Butuh 2 akun Telegram (A, B) dan 2 browser/profil, plus `api_id`/`api_hash` dari my.telegram.org.

1. **A**: login (nomor, kode, 2FA bila ada) → buat database → salin connection string `tgpg://…#…`.
2. **A**: `create table t(id serial primary key, v text); insert into t(v) values ('a');`
3. **B**: login → Gabung dengan connection string → `select * from t` harus berisi `a`.
4. **B**: `insert into t(v) values ('b');` → di **A** muncul dalam ≤15 dtk (atau segera lewat update real-time).
5. Tulis dari A dan B hampir bersamaan (`insert ... now(), gen_random_uuid()`) → hasil `select` identik di keduanya (urutan sama).
6. Reload kedua tab → data tetap ada tanpa memutar ulang seluruh log (cek log: "snapshot"/"lanjut dari").
7. Buat >200 op (atau tekan Snapshot) → **C**/akun baru gabung dan memuat dari snapshot.
8. Matikan jaringan di A: chip "⚠ offline", write ditolak, read jalan; nyalakan lagi → chip pulih, sinkron otomatis.
9. Edit baris lewat UI di A → B melihat perubahan.
10. Pastikan di grup Telegram hanya ada pesan terenkripsi (tak terbaca).

Catat bila ada: FLOOD_WAIT, pesan hilang/ganda, urutan beda antar klien, gagal join lewat invite. Itu titik yang belum terverifikasi.
