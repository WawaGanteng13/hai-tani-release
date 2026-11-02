# App Flow Documentation (AFD)
## Hai Tani (Alur Sistem & Navigasi Antarmuka)

**Versi Dokumen:** 1.0.0  
**Tanggal Rilis:** Oktober 2026  
**Status:** Approved  

---

### 1. Diagram Alur Makro Pengguna (High-Level User Journey)

```
[Pengguna Membuka Sistem]
        |
        +---> [A] WhatsApp Chatbot (Kang Tani AI)
        |       |
        |       +---> Petani Biasa: Pendaftaran Lahan / Tanya Harga / Konsultasi Hama
        |       +---> Kios Tani: Pendaftaran Toko Saprodi / Update Stok
        |       +---> Admin / PPL: Rekapitulasi Data / Validasi Status / Ekspor
        |
        +---> [B] Dashboard Web Portal Terpadu
                |
                +---> Tab 1: Dashboard Ringkasan Eksekutif (PPL & Manajemen)
                +---> Tab 2: WhatsApp Chatbot Simulator
                +---> Tab 3: Database Google Sheets (Lembar 1: Petani, Lembar 2: Supplier)
                +---> Tab 4: Indeks Harga Pasar & EWS Anomali Pangan
                +---> Tab 5: Portal Data Scientist (Prediksi & Rekomendasi Kebijakan)
                +---> Tab 6: Peta Sebaran Petani & Supplier (Google Maps GIS)
```

---

### 2. Alur Percakapan Chatbot WhatsApp (Conversational State Machine)

#### 2.1 Alur Pendaftaran Lahan Petani
1. **Inisiasi:** Petani mengirim pesan bebas, misalnya: *"Halo kang tani, saya mau daftar sawah 1.5 hektar di Subang"*.
2. **Intent Classification:**
   * Regex Fast-Path mengecek kata kunci: `daftar`, `daftarkan`, `lahan`.
   * Jika ambigu, Laya System-1 Sidecar mengevaluasi kalimat -> terdeteksi `daftar_lahan` (confidence > 0.75).
3. **Ekstraksi Entitas:**
   * Nama: `null` (belum ada).
   * Komoditas: `Padi` (diasumsikan dari kata sawah atau ditanyakan).
   * Luas Lahan: `1.5 Ha` (15.000 m²).
   * Kabupaten: `Subang`.
4. **Evaluasi Kelengkapan (4 Bidang Pokok):**
   * Bidang pokok: (1) Nama, (2) Komoditas, (3) Luas > 0, (4) Wilayah.
   * Hasil: Belum lengkap (Nama belum terisi).
5. **Respons Bot:**
   * Bot menyimpan draft sementara (`currentDraft`) dan merespons santun: *"Data luasan 1.5 Ha di Subang sudah Kang Tani catat. Boleh tahu atas nama siapa pendaftaran ini dan komoditas apa yang ditanam?"*
6. **Finalisasi:**
   * Petani membalas: *"Nama saya Pak Supardi, komoditas padi Ciherang"*.
   * Sistem menggabungkan draft lama dengan pesan baru.
   * Status 4 bidang pokok lengkap -> Data otomatis disimpan ke database dan Google Sheets Baris baru.
   * Bot memberikan pesan konfirmasi resmi ber-ID Petani unik (contoh: `PTN-010`).

#### 2.2 Alur Role-Based Access Control (RBAC) Admin
1. **Identifikasi Nomor:** Setiap pesan masuk dicek nomor pengirimnya (`senderPhone`) terhadap database admin dinas (`adminsDb`).
2. **Jika Pengirim = Admin / Petugas PPL:**
   * Pertanyaan seperti *"Tampilkan semua data petani yang belum diverifikasi"* langsung diproses.
   * Sistem menyajikan rekap data tabular lengkap dengan tombol unduh spreadsheet.
3. **Jika Pengirim = Petani Mitra (Non-Admin):**
   * Pertanyaan yang meminta data admin/rekap disaring otomatis.
   * Bot merespons dengan protokol privasi: *"Mohon maaf Bpk/Ibu, nomor Anda terdeteksi sebagai Petani Mitra. Demi kerahasiaan data anggota kelompok tani, rekapitulasi kontak hanya dapat diakses oleh Petugas PPL Terdaftar."*

#### 2.3 Alur Pendaftaran Kios / Supplier Saprodi
1. **Pemicu:** Pengguna mengirimkan kata kunci seperti *"Daftarkan kios pupuk Berkah Tani di Karawang"* atau terdeteksi oleh Laya sebagai intent `supplier`.
2. **Pengisian Parameter Toko:** Nama toko, kategori (Kios Resmi Pupuk Bersubsidi, Toko Saprodi, Offtaker), alamat, nomor kontak WA, produk unggulan, dan radius layanan (km).
3. **Penyimpanan:** Data otomatis dialirkan ke **Lembar 2 Google Sheets** dan pin lokasi kios langsung muncul di Google Maps dengan warna biru.

---

### 3. Alur Verifikasi Lahan & Penerbitan Kartu Tanda Registrasi

```
[Petani Terdaftar di Google Sheets]
                |
                v  (Status Awal: 'Pending')
[Petugas PPL Membuka Tab Dashboard / Sheets]
                |
                v
[PPL Melakukan Verifikasi Lapangan]
                |
    +-----------+-----------+
    |                       |
    v                       v
[Lahan Valid]          [Data Bermasalah]
    |                       |
    | Klik 'Verifikasi'     | Klik 'Perbaiki / Hubungi'
    v                       v
Status -> 'Terverifikasi'  Pesan WA Terkirim ke Petani
    |
    v
[Buka Modal Kartu Registrasi]
    |
    v
[Generate Kartu Digital Ber-QR Code]
    |
    v
[Cetak / Unduh Kartu PDF]
```

---

### 4. Alur Eksplorasi Spasial Google Maps
1. Pengguna membuka tab **"Peta Sebaran Petani & Supplier"**.
2. Komponen memuat peta terpusat pada sentra pertanian Jawa Barat & Jawa Tengah.
3. Pengguna dapat memilih filter:
   * Menampilkan semua titik, hanya Petani, atau hanya Kios Supplier.
   * Memfilter komoditas spesifik (Padi, Cabai, Bawang, Jagung).
   * Memfilter wilayah kabupaten (Subang, Karawang, Brebes, Kediri, Garut, Cianjur, Malang).
4. Klik pada salah satu marker membuka kartu detail:
   * Menampilkan kontak WhatsApp langsung.
   * Menampilkan estimasi tonase panen dan status verifikasi.
   * Menampilkan jarak logistik ke kios pupuk resmi terdekat.
   * Tombol **"Buka di Google Maps"** untuk panduan rute jalan.

---

### 5. Penanganan Error & Fallback Transisi
* **Jika Laya Sidecar Offline:** Backend otomatis mengalihkan klasifikasi intent ke modul rule-based heuristic tanpa memicu pesan error ke pengguna, dan menyalakan cooldown circuit breaker 30 detik.
* **Jika Kuota Gemini Terbatas:** Sistem otomatis mengalihkan pemrosesan ke gateway cadangan 9Router atau modul respons deterministik lokal.
* **Jika Pengguna Membatalkan Percakapan:** Soket koneksi yang putus mematikan proses generasi AI seketika demi menghemat token dan menjaga throughput server.
