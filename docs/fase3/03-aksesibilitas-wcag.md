# Bukti Fase 3 (3/3): Audit Aksesibilitas WCAG (Statis)

Tanggal: 1 November 2026. Metode: skrip `docs/fase3/contrast.js` +
pemeriksaan statis kode `src/`. BUKAN audit browser penuh (butuh
pengujian keyboard/screen-reader manual) — dinyatakan jujur sebagai
pra-audit.

## 1.4.3 Kontras teks (AA: 4,5:1)

Hasil `node docs/fase3/contrast.js`:

- emerald-700 di putih: 5,48 LULUS AA (teks + tombol)
- slate-900 di putih: 17,85 LULUS AAA
- slate-600 di putih: 7,58 LULUS AAA
- slate-500 di putih: 4,76 LULUS AA
- slate-400 di putih: 2,56 GAGAL
- rose-700 di rose-50: 5,72 LULUS AA (error)
- emerald-200 di emerald-950: 11,81 LULUS AAA
- putih di emerald-950: 15,15 LULUS AAA
- slate-300 di slate-900: 12,02 LULUS AAA
- emerald-400 di slate-900: 9,29 LULUS AAA

Temuan: `slate-400` dipakai luas untuk teks sekunder di permukaan
terang (2,56:1, gagal AA). Perbaikan saat audit: 25 kemunculan di 6
berkas inti (dasbor, Operasi Lapangan, tabel harga, sidebar, publik,
login) dinaikkan ke `slate-500` (4,76:1). Penggunaan di permukaan
gelap (pita dasbor, tooltip) dibiarkan karena lolos.

Sisa backlog (jujur belum diperbaiki): ~100 kemunculan `slate-400` di
permukaan sekunder (simulator chat, panel peta, modal Sheets/Laya/
webhook/whitepaper). Butuh penyisiran per berkas karena sebagian
berlatar gelap.

## 3.3.2 Label input

- Login admin: label asli + autocomplete. LULUS.
- Modal tambah petani/supplier/admin: label di atas tiap input. LULUS.
- Filter dasbor (select): label di atas. LULUS.
- Klinik Tanaman + form buah: label/aria-label. LULUS.
- Kolom cari dasbor: tanpa label, hanya placeholder. DIPERBAIKI saat
  audit (tambah `aria-label="Cari petani"`).

## 2.4.7 Fokus terlihat

`:focus-visible` emerald 2px global di `index.css`. LULUS statis.

## 1.1.1 Alternatif teks gambar

6/6 tag `<img>` punya `alt` (5 foto landing + 1 avatar Google).
LULUS.

## 2.3.3 / prefers-reduced-motion

Override global di `index.css` mematikan animasi; komponen Reveal
menghormati `useReducedMotion`. LULUS statis.

## 2.5.8 Target sentuh minimum (AA: 24px)

Sampel: tombol ikon keluar 28px, menu sidebar ~33px, CTA publik
~38px. LULUS lantai 24px AA. Catatan: di bawah panduan 44px iOS —
diterima untuk konsol desktop, ditinjau bila ada aplikasi seluler.

## 4.1.3 Status pesan

Error login, klinik, dan aktivitas memakai `role="alert"`;
menu aktif memakai `aria-current`. LULUS statis.

## Kesimpulan

Permukaan inti (publik + dasbor + login): lolos cek statis di semua
kriteria sampel setelah 2 perbaikan saat audit. Status keseluruhan:
pra-audit lolos, audit browser penuh + backlog slate-400 sekunder
masih terbuka sebelum klaim "WCAG AA" penuh.
