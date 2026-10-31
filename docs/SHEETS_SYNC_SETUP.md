# Cermin Google Sheets (write-behind) — Panduan Aktivasi

Status kode: LIVE di backend, nonaktif sampai kredensial diisi.
Cek: `GET /api/sheets/status` → `configured:false` = antrean menumpuk lokal.

## Cara kerja (ringkas)

- Tiap mutasi petani/supplier/kas/stok masuk antrean lokal (<1 ms, tak
  memengaruhi kecepatan chat). Worker background mengirim berkelompok tiap 15 dtk.
- Saat boot dengan kredensial valid: 4 tab (`Petani`, `Supplier`, `Kas`, `Stok`)
  dibuat otomatis bila belum ada + seluruh data ditulis-ulang (kolom = persis
  ekspor CSV). `googleSheetRow` disimpan per baris untuk update cepat.
- Bot satu-satunya penulis (single-writer). HPP belum dicerminkan.

## Aktivasi (10 menit)

1. Buka Google Cloud Console → pilih/buat project → aktifkan **Google Sheets API**.
2. **IAM & Admin → Service Accounts** → buat akun → **Keys → Add key → JSON** → unduh.
3. Simpan file JSON ke `data/gcp-service-account.json` (otomatis di-gitignore).
   Alternatif: isi `GOOGLE_SERVICE_ACCOUNT_FILE` (path lain) atau
   `GOOGLE_SERVICE_ACCOUNT_JSON` (isi JSON satu baris) di `.env`.
4. Buat spreadsheet kosong → **Share** → tempel `client_email` dari JSON → **Editor**.
5. Salin ID spreadsheet dari URL (`.../d/<ID>/edit`) → `.env`: `GOOGLE_SHEETS_ID=<ID>`.
6. Restart backend → buka `/api/sheets/status` → `configured:true`.
   ±10 dtk kemudian 4 tab terisi penuh.
7. Uji: ubah data via chat/dashboard → ≤15 dtk muncul di Sheets; atau paksa via
   `POST /api/sheets/sync-now` (butuh sesi Admin Utama).

## Aturan pakai

- Jangan edit sel data manual (bot menimpa saat tulis-ulang boot).
- Boleh tambah tab/analisis sendiri di luar 4 tab data.
- Kuota aman: ±1 panggilan API per kelompok perubahan (debounce 5 dtk).
- Gangguan Google tidak mematikan bot: antrean tersimpan di
  `data/sheets_queue.json` dan terkirim saat pulih.
- Mencabut akses: hapus share service account di spreadsheet.
