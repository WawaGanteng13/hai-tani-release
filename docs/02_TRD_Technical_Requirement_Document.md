# Technical Requirement Document (TRD)
## Hai Tani (TaniAI Platform Architecture)

**Versi Dokumen:** 1.0.0  
**Tanggal Rilis:** Oktober 2026  
**Status:** Approved  

---

### 1. Arsitektur Sistem Terdistribusi
Sistem Hai Tani dirancang dengan arsitektur **Hybrid Edge & Cloud** yang memadukan backend Node.js Express, sidecar mikro-model non-autoregresif (Laya), dan model bahasa besar generasi terbaru (Google Gemini / 9Router Gateway).

```
                      +-----------------------------------+
                      |      WhatsApp Client / Webhook    |
                      +-----------------+-----------------+
                                        | POST /api/chat
                                        v
+--------------------------------------------------------------------------------+
|                         Node.js Express Backend (server.ts)                   |
|                                                                                |
|  [Pilar 1: Role-Based Access Control] <---> Admin Phone Directory (adminsDb)   |
|  [Pilar 2: Regex Fast-Path (0ms)]     ---> Hit: Langsung routing intent        |
|  [Pilar 3: Laya System-1 Sidecar]     ---> Miss: Panggil http://127.0.0.1:8787 |
|  [Pilar 4: Universal AI Gateway]      ---> Gemini 2.5 Flash / 9Router Fallback |
|  [Pilar 5: Cancellation Controller]   ---> AbortController (Hemat Kuota)      |
+--------------------------------------------------------------------------------+
          |                                            |
          v                                            v
+---------------------------+              +-------------------------------------+
|  Laya Sidecar (Python)    |              |     Google Workspace & Maps APIs    |
|  - Choice Primitive       |              |  - Google Sheets API (2-Sheet Sync) |
|  - Sub-50ms Decision      |              |  - Google Maps JS SDK (GIS Layer)   |
|  - Thread affinity cap    |              |  - Google Drive Folder Sync         |
+---------------------------+              +-------------------------------------+
```

---

### 2. Spesifikasi Stack Teknologi

| Komponen | Spesifikasi & Versi | Peran Teknis |
| :--- | :--- | :--- |
| **Runtime Server** | Node.js v20+ / tsx v4.21.0 | Backend API asynchronous, melayani endpoint REST dan WebSocket. |
| **Web Server Framework**| Express.js v4.21.2 | Routing API, sanitasi input, CORS handling, file static serving. |
| **Frontend Framework** | React v19.0.1 + TypeScript v5.8.2 | Arsitektur komponen reaktif, hooks kustom, state management lokal. |
| **Bundler & Tooling**  | Vite v6.2.3 | Kompilasi cepat ESModules, hot replacement dev server. |
| **CSS & Design Engine**| Tailwind CSS v4.1.14 | Menggunakan `@tailwindcss/vite` modern tanpa dependensi build legacy. |
| **Spatial Mapping**    | `@vis.gl/react-google-maps` v1.10.1 | Render peta interaktif, marker kustom, bounds viewport pulau Jawa. |
| **AI LLM SDK**         | `@google/genai` v2.4.0 | Ekstraksi entitas JSON terstruktur, reasoning agronomi tingkat lanjut. |
| **Fast Intent Sidecar**| Python 3.10 + HTTP Server (port 8787) | Engine Laya non-autoregresif untuk penentuan intent sub-50ms. |
| **Visualisasi Data**   | Recharts v3.10.1 | Grafik time-series fluktuasi harga komoditas dan pie chart luas lahan. |
| **Document Generator** | jsPDF v4.2.1 + jsPDF-AutoTable | Cetak digital kartu registrasi ber-QR Code dan laporan arsitektur. |

---

### 3. Integrasi Khusus: Laya Decision Engine (System-1)
Mengacu pada arsitektur resmi [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya):
* **Primitif Pertanyaan:** Wajib menggunakan tipe `"choice"` dengan kriteria 5 intent spesifik:
  1. `daftar_lahan`: Registrasi lahan garapan petani, nama, komoditas, luas, desa/kabupaten.
  2. `cek_harga`: Informasi harga pasar komoditas dan anomali fluktuasi harga.
  3. `hama_pupuk`: Konsultasi penyakit tanaman, wereng, ulat, takaran dosis pupuk.
  4. `supplier`: Pencarian dan registrasi kios saprodi, toko pupuk, dan offtaker.
  5. `lain`: Salam pembuka, ucapan terima kasih, dan percakapan umum.
* **Gating Metrik Keyakinan:** Menggunakan `confidence` terkalibrasi dengan threshold `>= 0.50`. Tidak menggunakan `action.act_probability` (AUROC 0.30 vs confidence 0.77).
* **Manajemen Thread & Kinerja CPU:**
  * Membatasi `torch.set_num_threads` maksimal pada core fisik untuk menghindari regresi oversubscribing hyperthreads.
  * Menggunakan `threading.Lock()` untuk serialisasi inferensi torch, menjaga server HTTP tetap responsif untuk request health check.
* **Mekanisme Circuit Breaker & Cache:**
  * Timeout request: 1200 ms.
  * In-memory LRU Cache: TTL 10 menit (kapasitas 500 query unik).
  * Cooldown Circuit Breaker: 30 detik saat sidecar tidak merespon (otomatis fallback ke rule-based heuristic tanpa memutus layanan pengguna).

---

### 4. Integrasi Khusus: Google Maps Platform (GIS)
* **API yang Digunakan:** Maps JavaScript API, Geocoding API, Places Library.
* **Visualisasi Geospasial:**
  * Pusat koordinat default: Jawa Tengah/Barat (`lat: -7.0, lng: 108.5`).
  * Koordinat petani: Dilengkapi jitter mikroskopis (~0.01 derajat) untuk membedakan lahan dalam desa yang sama.
  * Koordinat supplier: Lokasi presisi kios saprodi di jalan raya sentra pertanian.
  * Jarak Haversine:
    $$d = 2R \cdot \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta \lambda}{2}\right)}\right)$$
    dengan $R = 6371$ km.

---

### 5. Keamanan & Efisiensi Biaya (Cost Optimization)
* **Deteksi Pembatalan Klien (Client Abort):** Event `res.on('close')` mendeteksi soket yang ditutup pengguna secara instan dan memicu `AbortController.abort()` ke API Gemini untuk mencegah pemborosan token.
* **Lean Targeted Context:** Backend tidak membuang seluruh database JSON ribuan baris ke prompt LLM. Sebaliknya, query pengguna difilter terlebih dahulu (misal: hanya melampirkan data Subang jika kata "Subang" disebutkan), memangkas konsumsi token hingga 85%.
* **Sanitasi Masukan:** Panjang teks pengguna dibatasi maksimal 2000 karakter, teks HTML di-escape (`escHtml`), dan parameter query disanitasi.
