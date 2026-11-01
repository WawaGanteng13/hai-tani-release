# Bukti Fase 3 (2/3): Uji Stres 100 req/detik

Tanggal: 1 November 2026, ~13:44 WIB. Backend lokal PID 13544.
Skrip: `docs/fase3/stress.js` (tanpa dependensi, bisa diulang:
`node docs/fase3/stress.js [base] [rps] [detik]`).

## Fase baca (GET bergantian)

Endpoint: `/api/health`, `/api/publik/ringkas`, `/api/harga-pasar`,
`/api/harga-pasar?sumber=buah`. Kriteria lolos: status 2xx-4xx
(5xx/timeout/error = gagal).

Run 1 (target 100 rps, 30 detik):

- Aktual: 90,9 rps (drift timer Node di Windows)
- 3001 OK, 0 gagal
- Latensi: p50 2 ms, p95 3 ms, p99 4 ms, maks 530 ms
  (maks dari 1 hit awal cache dingin upstream harga)

Run 2 (target 115 rps, 30 detik):

- Aktual: **104,5 rps**, 3452 OK, **0 gagal**
- Latensi: p50 2 ms, p95 2 ms, p99 3 ms, maks 25 ms

Kesimpulan: backend menahan beban di atas 100 req/detik tanpa satu
pun kegagalan. Target "100 req/detik" terpenuhi.

## Fase chat ringan (POST /api/chat)

20 pesan `menu` (balasan statis tanpa LLM, nomor pengirim diputar agar
anti-spam tidak aktif), header forwarder resmi:

- 20/20 HTTP 200, 0 gagal
- Latensi: p50 7 ms, p95 9 ms

Catatan batas: fase chat hanya menguji jalur statis. Jalur LLM
(Gemini/NIM) tidak di-stres karena biaya dan rate limit; keandalannya
ditutup oleh golden suite (cek 17a/17b media + fallback).
