# Implementation Plan Documentation (IPD)
## Hai Tani (Rencana Implementasi, Tahapan Rilis & Verifikasi)

**Versi Dokumen:** 1.0.0  
**Tanggal Rilis:** Oktober 2026  
**Status:** Approved  

---

### 1. Rencana Fase Pelaksanaan (Implementation Roadmap)

```
[Fase 1: Fondasi Inti] ---> [Fase 2: Integrasi Laya & GIS] ---> [Fase 3: Pengujian Lapangan] ---> [Fase 4: Rilis Skala Penuh]
(Selesai)                    (Selesai)                           (Aktif Berjalan)                 (Rencana Q4 2026)
- Model Data & CRUD          - Laya Sidecar Daemon sub-50ms     - Uji Coba BPP Subang & Brebes   - Integrasi 27 Kab Jawa
- WhatsApp Chatbot Engine    - Dual-Layer Google Maps GIS       - Validasi 4 Bidang Pokok        - Sinkronisasi Cloud SQL
- Google Sheets Sync 2-Sheet - Circuit Breaker & Fallback Heuristic - Uji Kuota & Client Abort   - Sertifikasi Keamanan ISO
```

---

### 2. Rincian Pekerjaan Tiap Fase (Work Breakdown Structure)

#### Fase 1: Fondasi Inti & Chatbot Dasar (Status: Selesai)
* [x] Inisialisasi arsitektur full-stack React 19 + TypeScript + Node.js Express.
* [x] Pembuatan simulator WhatsApp Chatbot dengan dukungan format teks tebal, miring, dan quick replies.
* [x] Implementasi algoritma ekstraksi entitas regex dan Gemini AI untuk 4 bidang pokok petani.
* [x] Sinkronisasi dua arah struktur spreadsheet Google Sheets (Lembar 1: Petani & Lembar 2: Supplier).
* [x] Fitur ekspor CSV resmi dinas berstandar UTF-8.

#### Fase 2: Integrasi Keputusan Cepat & Geospasial GIS (Status: Selesai)
* [x] Pengembangan `laya_sidecar.py` non-autoregresif port 8787 berbasis primitif `choice`.
* [x] Pemasangan pembatas thread CPU fisik (`torch.set_num_threads`) dan serialisasi inferensi aman (`threading.Lock`).
* [x] Integrasi Google Maps Platform (`@vis.gl/react-google-maps`) dengan filter sebaran komoditas dan buffer radius jangkauan kios saprodi.
* [x] Implementasi formula Haversine untuk kalkulasi jarak kilometer antara sawah dan kios pupuk terdekat.
* [x] Implementasi deteksi pembatalan koneksi klien (`clientAbortController`) untuk efisiensi token AI.
* [x] Pembuatan komponen antarmuka `LayaModal` untuk monitoring kesehatan engine secara transparan.

#### Fase 3: Stabilisasi & Uji Coba Penyuluhan Lapangan (Status: Sedang Berjalan)
* [ ] Uji coba simulasi pendaftaran oleh 50 petani mitra di Balai Penyuluhan Pertanian (BPP) Subang dan Brebes.
* [ ] Kalibrasi ambang batas confidence Laya pada dialek lokal (Sunda dan Jawa pantura).
* [ ] Uji stres konkurensi request chatbot simultan hingga 100 request/detik.
* [ ] Audit kepatuhan standar WCAG AA pada perangkat smartphone kelas menengah ke bawah.

#### Fase 4: Integrasi Cloud Enterprise & Replikasi Provinsi (Status: Terjadwal)
* [ ] Penyambungan langsung dengan webhook WhatsApp Cloud API resmi Meta untuk nomor resmi dinas.
* [ ] Replikasi pemetaan geospasial ke 27 kabupaten/kota sentra pertanian di Pulau Jawa.
* [ ] Otomasi pengiriman pesan peringatan dini (EWS) anomali harga cabai/bawang melalui broadcast terjadwal kepada petani binaan.

---

### 3. Matriks Kesiapan Rilis & Pengujian (Acceptance Criteria & QA Checklist)

| No | Modul / Skenario Pengujian | Kriteria Lolos (Pass Criteria) | Status |
| :---: | :--- | :--- | :---: |
| 1 | **Ekstraksi Pendaftaran Lahan** | Kalimat pendaftaran berhasil diekstrak menjadi 4 kolom pokok tanpa membuang entitas yang sudah ada. | **LULUS** |
| 2 | **Role-Based Access Control (RBAC)** | Nomor non-admin ditolak saat meminta data rekapitulasi kontak petani lain. | **LULUS** |
| 3 | **Kinerja Laya System-1** | Latensi klasifikasi intent di bawah 50 ms dan fallback mulus saat sidecar dimatikan sementara. | **LULUS** |
| 4 | **Peta Spasial Google Maps** | Marker petani dan supplier muncul di koordinat Jawa Barat/Tengah, radius lingkaran terlukis tepat, dan tombol "Buka di Google Maps" membuka navigasi valid. | **LULUS** |
| 5 | **Unduh Lembar Kerja & Dokumen** | Ekspor CSV dan cetak PDF kartu pendaftaran ber-QR Code dapat diunduh tanpa galat sintaksis. | **LULUS** |
| 6 | **Resilience & Client Cancellation** | Tidak terjadi kebocoran memori saat klien membatalkan koneksi; dev server tetap stabil pada port 3000. | **LULUS** |

---

### 4. Rencana Pemulihan & Mitigasi Risiko (Rollback & Disaster Recovery)
1. **Kegagalan Koneksi Model Eksternal:**
   * Jika API Gemini atau kuota LLM habis, sistem otomatis beralih ke *rule-based heuristic* lokal yang sudah tertanam di `server.ts` (100% *zero downtime*).
2. **Kegagalan Service Laya Sidecar:**
   * Circuit breaker otomatis menonaktifkan pemanggilan sidecar selama 30 detik (*cooldown*) dan melayani intent menggunakan regex pencocokan kata kunci primer.
3. **Konflik Integritas Data Spreadsheet:**
   * Setiap penambahan baris selalu mengevaluasi baris terakhir (`nextSheetRow`) untuk mencegah penumpukan baris ganda (*race condition*).
