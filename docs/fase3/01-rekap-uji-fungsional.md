# Bukti Fase 3 (1/3): Rekap Uji Fungsional

Tanggal run: 1 November 2026, 04:28 WIB.
Sumber: `C:\Users\USER\hai-tani-ops\golden-last.log` (skrip `golden-chat.ps1`).
Hasil: **100 PASS, 0 FAIL — ALL-PASS.**

Catatan jujur: dokumen proyek menyebut "validasi 4 bidang pokok" tanpa
merinci apa saja keempatnya. Pengelompokan di bawah ini adalah pemetaan
saya atas 100 cek golden ke 4 bidang. Total cocok: 26+6+48+20 = 100.

## Bidang A: Pendataan dan akses (26 cek)

Sapaan, identitas, pendaftaran, onboarding lemah, peran, anti-spam,
blokir admin, dan daftar milik sendiri.

`1-halo, 2-identitas, 3-makasih, 4-bantuan, 5-daftar, 18a-farmerbare,`
`18b-namefiller, 18c-namecleanup, 22a-walocation, 23a-tos, 23b-role,`
`23c-locask, 23d-doneweak, 23e-cancelob, 23f-decline, 23g-declimited,`
`23h-decpublic, 23i-spamflag, 23j-admblock, 23k-blocked, 23l-admallow,`
`23m-resumed, 24a-listown, 24b-unreg, 24c-append, 24d-close`

## Bidang B: Harga dan pasar (6 cek)

Harga satuan, tabel harga pasar (67 baris live), pasar, Mantung,
gabungan sayur.

`9-harga, 14-hargapasar, 15-pasar, 19a-mantung, 19b-sayur, 19c-gabung`

Tambahan di luar run ini: cek `33a-buah` (harga buah live InfoPangan,
2 baris) lolos manual 1 Nov 2026 pagi setelah endpoint buah ditambahkan.

## Bidang C: Kas, transaksi, dan kemitraan (48 cek)

Kas/ERP, saldo, format, merge/batal, alur penawaran (demand, stok,
budget, deal, cek status), ack tenggat, pengingat follow-up, afiliasi
toko mitra (tambah, katalog, cari, beli, komisi 3%, hapus).

`10-erp, 11-dbstable, 12a-t1, 12b-merge, 12c-cancel, 12d-cleared,`
`12e-cleanup, 13a-4baris, 13b-cleanup, 16a-status, 16b-saldo,`
`16c-format, 16d-tengkulak, 16e-supcancel, 16f-greeting, 16g-makasih2,`
`16h-pasar2, 16i-erpbare, 16j-phantom, 16k-batalbare, 25a-demand,`
`25b-nostock, 25c-stock, 25d-price, 25e-budget, 25f-deal, 25g-stockleft,`
`25h-cekstatus, 26a-alasandulu, 26b-ackdeadline, 27a-reset, 27b-push,`
`27c-answer, 27d-gate, 27e-reset2, 27f-push2, 27g-optout, 27h-noopt,`
`27i-reset3, 27j-push3, 27k-pull, 27l-cleanup, 30a-tambah, 30b-katalog,`
`30c-cari, 30d-beli, 30e-komisi, 30f-hapus`

## Bidang D: Integrasi dan dokumen (20 cek)

Rekap, list, analisis, voice note, foto, klaim manfaat, status Sheets,
saran/komplain, ekspor XLSX/CSV, kartu QR (buat, id, saya, 404),
ringkas publik tanpa PII.

`6-rekap, 7-list, 8-analisis, 17a-voice, 17b-image, 20a-benefitadmin,`
`20b-benefitfarmer, 20c-nosheetsclaim, 21a-sheetsstatus, 28a-saran,`
`28b-komplain, 28c-lihatsaran, 29a-xlsx, 29b-csv, 29c-badfmt,`
`31a-kartu, 31b-kartuid, 31c-kartusaya, 31d-kartu404, 32a-publik`

## Cara verifikasi ulang

Jalankan `C:\Users\USER\hai-tani-ops\golden-chat.ps1` saat backend hidup.
Harus diulang dari kondisi sepi (jeda 6 menit dari run sebelumnya) agar
cooldown anti-spam tidak menggugurkan cek chat. Ekspektasi: ALL-PASS.
