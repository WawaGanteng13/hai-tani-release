# Product Requirement Document (PRD)
## Hai Tani (Kang Tani AI & AgroSpasial Platform)

**Versi Dokumen:** 1.0.0  
**Tanggal Rilis:** Oktober 2026  
**Status:** Disetujui (Approved)  
**Target Pengguna:** Petani Lapangan, Penyuluh Pertanian Lapangan (PPL/BPP), Dinas Pertanian & Ketahanan Pangan, Pemilik Kios Saprodi, Data Scientist Pertanian

---

### 1. Ringkasan Eksekutif & Latar Belakang Masalah
Sektor pertanian tanaman pangan dan hortikultura di Indonesia menghadapi tiga tantangan struktural utama:
1. **Pencatatan Lahan yang Terfragmentasi:** Data petani sering dicatat manual di atas kertas atau buku kelompok tani, berisiko hilang dan lambat direkapitulasi ke dinas kabupaten/provinsi.
2. **Keterbatasan Literasi Aplikasi Rumit:** Sebagian besar petani enggan mengunduh aplikasi mobile rumit yang membebani memori smartphone dan memerlukan registrasi akun yang berbelit. Sebaliknya, aplikasi pesan instan WhatsApp sudah digunakan oleh lebih dari 90% petani dan kelompok tani.
3. **Kesenjangan Informasi Rantai Pasok & Anomali Harga:** Ketiadaan visibilitas stok kios pupuk terdekat dan keterlambatan deteksi gejolak harga komoditas (seperti cabai dan bawang merah) memicu krisis pasokan atau kerugian panen mendalam bagi petani.

Hai Tani hadir sebagai solusi terintegrasi: memanfaatkan antarmuka WhatsApp berbasis conversational AI yang ramah petani ("Kang Tani AI"), dipadukan dengan database Google Sheets transparan, pemetaan spasial Google Maps, dan portal analitik prediksi panen.

---

### 2. Tujuan Produk (Product Goals & OKRs)
* **Adopsi Tanpa Hambatan:** Petani dapat mendaftarkan lahan dan berkonsultasi dalam waktu kurang dari 2 menit melalui WhatsApp tanpa unduh aplikasi baru.
* **Transparansi Administratif:** Seluruh data pendaftaran otomatis masuk ke Google Sheets resmi dinas secara realtime (0 latency sync).
* **Efisiensi Logistik Pertanian:** Menghubungkan titik lahan garapan petani dengan kios pupuk dan toko saprodi berizin terdekat dalam radius 25-50 km.
* **Early Warning System (EWS):** Mengidentifikasi anomali fluktuasi harga komoditas pangan lebih dari 15% dalam 24 jam untuk rekomendasi operasi pasar.

---

### 3. Persona Pengguna (User Personas)
1. **Pak Tani / Petani Mitra (End-User):**
   * *Profil:* Petani padi/cabai/jagung, usia 35-60 tahun, familiar dengan WhatsApp dan voice note.
   * *Kebutuhan:* Mendaftarkan lahan garapan untuk alokasi pupuk bersubsidi, mengecek harga pasar di sentra terdekat, menanyakan solusi hama.
   * *Batasan Akses:* Hanya dapat melihat status lahan sendiri, tidak diizinkan membuka rekapitulasi kontak petani lain.
2. **Petugas PPL & Admin Dinas (Operator / Verifikator):**
   * *Profil:* Penyuluh Wilayah Kerja Penyuluhan Pertanian (WKPP) dan staf dinas kabupaten.
   * *Kebutuhan:* Memverifikasi fisik lahan pendaftar, mengunduh spreadsheet resmi, menerbitkan Kartu Registrasi Petani ber-QR Code, mengelola admin baru.
   * *Akses:* Hak akses penuh (Full RBAC) via nomor WhatsApp terverifikasi dan dashboard web.
3. **Pemilik Kios Tani / Distributor Saprodi (Mitra Toko):**
   * *Profil:* Kios pupuk resmi, agen pestisida, offtaker hasil panen.
   * *Kebutuhan:* Terdata di peta Google Maps agar dapat dihubungi oleh kelompok tani sekitar, menginformasikan ketersediaan stok urea, NPK, dan benih.
4. **Data Scientist & Pengambil Kebijakan (Policy Maker):**
   * *Profil:* Analis ketahanan pangan tingkat kabupaten/provinsi.
   * *Kebutuhan:* Simulasi neraca pangan (supply vs demand), identifikasi risiko oversupply atau defisit, rekomendasi stabilisasi harga.

---

### 4. Fitur Utama & Kebutuhan Fungsional (Functional Requirements)

#### FR-01: WhatsApp Chatbot ("Kang Tani AI")
* **FR-01.1 Ekstraksi Entitas Otomatis:** Chatbot mampu mengekstraksi 4 data pokok: (1) Nama Petani, (2) Komoditas, (3) Luas Lahan (Ha/m²), (4) Lokasi Wilayah (Desa/Kecamatan/Kabupaten).
* **FR-01.2 Penanganan Data Belum Lengkap:** Jika petani baru mengirimkan komoditas saja, bot secara ramah menanyakan luas lahan dan nama tanpa menolak pendaftaran.
* **FR-01.3 Role-Based Access Control (RBAC):** Deteksi otomatis nomor pengirim. Jika nomor bukan admin dinas mencoba meminta "rekap seluruh petani", sistem membatasi akses secara sopan demi kerahasiaan data pribadi.
* **FR-01.4 Registrasi Kios Saprodi:** Mendukung alur pendaftaran kios toko tani ke Lembar 2 Google Sheets (Nama toko, kategori, nomor kontak, alamat, produk unggulan, radius layanan).
* **FR-01.5 Konsultasi Agronomi:** Memberikan solusi hama spesifik (wereng coklat, ulat grayak, busuk daun) dan takaran pupuk berimbang.

#### FR-02: Integrasi Spreadsheet Google Sheets & Drive
* **FR-02.1 Dua Lembar Data (2-Sheet Architecture):**
  * Lembar 1: Database Pendaftaran Petani (11 kolom standar dinas).
  * Lembar 2: Direktori Kios Pupuk & Supplier Saprodi (10 kolom logistik).
* **FR-02.2 Ekspor CSV Berstandar Dinas:** Pengunduhan file CSV terformat dengan sanitasi karakter kutip ganda dan pemisah koma standar UTF-8.
* **FR-02.3 Webhook Integrasi Dua Arah:** Endpoint penerima payload pendaftaran dari bot WA eksternal atau Google Apps Script.

#### FR-03: Peta Spasial Google Maps (GIS AgroSpasial)
* **FR-03.1 Visualisasi Dual-Layer:** Marker hijau untuk titik lahan petani dan marker biru untuk lokasi kios saprodi.
* **FR-03.2 Buffer Radius Layanan Kios:** Lingkaran jangkauan transparan (25-50 km) yang menunjukkan cakupan suplai pupuk.
* **FR-03.3 Navigasi Langsung:** Tombol eksternal "Buka di Google Maps" untuk memandu arah jalan (turn-by-turn directions) ke lokasi toko atau sawah binaan.
* **FR-03.4 Kalkulasi Jarak Otomatis:** Algoritma Haversine menghitung jarak kilometer akurat antara lahan petani terpilih dengan kios terdekat.

#### FR-04: Penerbitan Kartu Tanda Registrasi Petani (QR Code)
* Menerbitkan kartu fisik/digital dengan identitas petani, luas lahan, status verifikasi BPP, dan QR Code verifikasi dokumen resmi.

#### FR-05: Early Warning System (EWS) Pasar & Analitika Data Scientist
* Grafik fluktuasi harian komoditas utama (Cabai rawit merah, bawang merah, beras premium, jagung pipil).
* Notifikasi anomali lonjakan ekstrim (misal: lonjakan cabai rawit merah > 30%).
* Ringkasan eksekutif neraca panen gabungan luas lahan (Ha) dan tonase prediksi panen.

---

### 5. Batasan & Kebutuhan Non-Fungsional (Non-Functional Requirements)
* **Kinerja (Performance):** Latensi respon klasifikasi intent di bawah 50 ms menggunakan router Laya System-1. Respon chatbot lengkap di bawah 2.5 detik.
* **Keamanan Data (Security & Privacy):** Nomor telepon dan koordinat detail lahan petani tidak dipublikasikan ke publik tanpa otentikasi peran (RBAC).
* **Ketersediaan (Availability):** Sistem fallback cerdas (rule-based heuristic) tetap berjalan 100% aktif sekalipun koneksi internet ke provider AI luar terganggu.
* **Responsivitas Layanan (Mobile Friendly):** Seluruh antarmuka portal dapat dioperasikan secara ergonomis di layar ponsel smartphone (minimum tap target 44px).
