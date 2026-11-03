# Implementation Plan Documentation (IPD)
## Hai Tani (Rencana Implementasi, Tahapan Rilis & Verifikasi)

**Versi Dokumen:** 1.2.0  
**Tanggal Rilis:** November 2026 (Amandemen Marketplace Pivot)  
**Status:** Approved — roadmap diselaraskan ke rilis nyata  

---

### 1. Rencana Fase Pelaksanaan (Implementation Roadmap)

```
[Fase 1: Fondasi] ---> [Fase 2: Laya & GIS] ---> [Fase 3: Marketplace WA] ---> [Fase 4: Skala Penuh]
(Selesai)               (Selesai)                 (Selesai Nov 2026)              (Rencana)
- Model Data & CRUD     - Laya sub-50ms           - Negosiasi buyer↔petani        - Named tunnel + domain
- Chatbot WA Engine     - Maps GIS dual-layer     - Fulfil ALAMAT→SELESAI         - AWS onboarding
- Sheets 2-Sheet sync   - Circuit breaker         - CI 51 live-gate checks        - Payment gateway lisensi
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

#### Fase 3: Marketplace WA (Status: Selesai Nov 2026)
* [x] Webhook WhatsApp Cloud API resmi Meta + forwarder Vercel + reply loop.
* [x] Negosiasi buyer↔petani: demand/budget/quote/spek/alokasi/deal + notifikasi otomatis dua pihak.
* [x] Fulfil pasca-DEAL: alamat/ShareLoc, foto + juri vision, jadwal kirim, bayar 2-pihak, SELESAI/sengketa.
* [x] CI: static + 5 live gates (51 checks BLOCKING) + seed fixture; SLSA provenance.
* [x] Anti-misroute: audit P0/P1 + router-shadow gate; peran kontekstual (petani/admin bisa beli).

#### Fase 4: Skala Penuh (Status: Rencana)
* [ ] Named tunnel + domain sendiri (pengganti quick tunnel).
* [ ] AWS onboarding (backend persisten + data).
* [ ] Payment gateway berlisensi untuk jual-beli (Hai Tani mengawasi); langganan ke rekening Hai Tani.
* [ ] Beta live: 20 transaksi selesai + repeat order sebagai bukti marketplace.

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
| 7 | **Negosiasi E2E** | Demand → notifikasi → quote → COCOK → deal oke → DEAL terminal; oversell ditolak. | **LULUS (gate 10/10)** |
| 8 | **Fulfil E2E** | ALAMAT → FOTO (juri) → KIRIM → BAYAR → SELESAI; sengketa → admin. | **LULUS (gate 14/14)** |
| 9 | **Anti-Misroute** | Demand/quote tak dibajak ke draf supplier; perintah lolos pendingAsk. | **LULUS (gate 18/18)** |

---

### 4. Rencana Pemulihan & Mitigasi Risiko (Rollback & Disaster Recovery)
1. **Kegagalan Koneksi Model Eksternal:**
   * Jika API Gemini atau kuota LLM habis, sistem otomatis beralih ke *rule-based heuristic* lokal yang sudah tertanam di `server.ts` (100% *zero downtime*).
2. **Kegagalan Service Laya Sidecar:**
   * Circuit breaker otomatis menonaktifkan pemanggilan sidecar selama 30 detik (*cooldown*) dan melayani intent menggunakan regex pencocokan kata kunci primer.
3. **Konflik Integritas Data Spreadsheet:**
   * Setiap penambahan baris selalu mengevaluasi baris terakhir (`nextSheetRow`) untuk mencegah penumpukan baris ganda (*race condition*).
