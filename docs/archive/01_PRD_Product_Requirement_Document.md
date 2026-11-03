# Product Requirement Document (PRD)
## Hai Tani (Kang Tani AI & AgroSpasial Platform)

**Versi Dokumen:** 1.2.0  
**Tanggal Rilis:** November 2026 (Amandemen Marketplace Pivot)  
**Status:** Disetujui — Flagship negosiasi buyer↔petani via WA  
**Jargon:** Dari Petani untuk Kesejahteraan Petani  
**Target Pengguna:** Petani Lapangan, Penyuluh Pertanian Lapangan (PPL/BPP), Dinas Pertanian & Ketahanan Pangan, Pemilik Kios Saprodi, Data Scientist Pertanian

---

### 1. Ringkasan Eksekutif & Latar Belakang Masalah
Sektor pertanian tanaman pangan dan hortikultura di Indonesia menghadapi empat tantangan struktural utama:
0. **Akses Buyer (keluhan #1 petani, flagship):** Petani menjual ke tengkulak yang itu-itu saja; harga panen dibeli murah di pintu kebun sementara tengkulak menguasai penjualan di pasar. Petani hanya dapat margin sangat tipis dan tak punya akses buyer langsung.
1. **Pencatatan Lahan yang Terfragmentasi:** Data petani sering dicatat manual di atas kertas atau buku kelompok tani, berisiko hilang dan lambat direkapitulasi ke dinas kabupaten/provinsi.
2. **Keterbatasan Literasi Aplikasi Rumit:** Sebagian besar petani enggan mengunduh aplikasi mobile rumit yang membebani memori smartphone dan memerlukan registrasi akun yang berbelit. Sebaliknya, aplikasi pesan instan WhatsApp sudah digunakan oleh lebih dari 90% petani dan kelompok tani.
3. **Kesenjangan Informasi Rantai Pasok & Anomali Harga:** Ketiadaan visibilitas stok kios pupuk terdekat dan keterlambatan deteksi gejolak harga komoditas (seperti cabai dan bawang merah) memicu krisis pasokan atau kerugian panen mendalam bagi petani.

Hai Tani hadir sebagai marketplace agenik WhatsApp-first: fitur utamanya mempertemukan buyer yang cari hasil panen dengan petani siap panen lewat bot negosiasi 2-arah (demand → budget → quote petani → verifikasi spek → alokasi → deal → fulfil), dipadukan database JSON runtime + cermin Google Sheets, peta Google Maps, dan dashboard monitoring. Tanpa unduh aplikasi: cukup chat nomor WA Hai Tani.

---

### 2. Tujuan Produk (Product Goals & OKRs)
* **Transaksi Selesai (flagship):** Buyer membeli lagi dan petani menerima hasil bersih lebih baik — 20 transaksi selesai, dibayar, dan repeat-order sebagai bukti, bukan jumlah fitur.
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
5. **Buyer / Offtaker (Penggerak Transaksi):**
   * *Profil:* Pedagang pasar, pengepul non-tengkulak, UMKM olahan, retail.
   * *Kebutuhan:* Cari pasokan ("butuh bawang 500 kg"), pasang budget, terima quote petani, verifikasi spek (ukuran/potongan), deal, terima foto barang, bayar, terima kiriman — semua via chat WA.
   * *Batasan Akses:* Hanya melihat penawarannya sendiri; kontak petani termasking sampai deal.

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

#### FR-06: ERP Pertanian Fase 5 (Buku Kas, Stok Kios & HPP)
* **FR-06.1 Buku Kas Petani:** Catat MASUK/KELUAR via chat ("catat beli pupuk 2 sak 350 ribu") maupun dashboard; kategori tervalidasi silang terhadap jenis; anti-duplikat 5 menit; saldo per petani.
* **FR-06.2 Stok Kios:** Mutasi MASUK/KELUAR/PENYESUAIAN per kios; penolakan stok negatif (saldo dicek sebelum KELUAR); satuan tervalidasi.
* **FR-06.3 HPP & Margin:** Hitung HPP per kg dari agregat biaya (filter komoditas + musim tanam), margin dan % margin terhadap harga jual; tolak bila volume ≤ 0 atau belum ada biaya.
* **FR-06.4 Parser Angka Indonesia:** Titik sebagai pemisah ribuan ("1.500.000" → 1500000), koma sebagai desimal — berlaku konsisten di seluruh ekstraktor chat.

#### FR-07: Negosiasi Buyer↔Petani (FLAGSHIP)
* **FR-07.1 Demand & Budget:** Buyer chat "butuh <komoditas> <qty>" → offer OPEN; "budget <Rp/kg>" tercatat. Petani terkait otomatis dikabari tiap order baru (teks dalam jendela 24 jam, template opener di luar itu; dedupe per farmer).
* **FR-07.2 Quote & Spek:** Petani pasang harga ("jual <komoditas> <harga>"); spek buyer ("spek OFR-x: ukuran besar") wajib diverifikasi petani (`sanggup`/`tidak`) sebelum alokasi.
* **FR-07.3 Alokasi & Deal:** Alokasi termurah-dulu; status COCOK → buyer "deal oke" → DEAL terkunci (terminal, tak bisa dibuka lagi); selisih negosiasi di atas komisi tier (5/2/0%) kembali ke petani; komisi masuk kas.
* **FR-07.4 Peran Kontekstual:** Petani bisa jadi buyer (stok sendiri dikecualikan) dan admin bisa beli — tergantung isi chat, bukan peran akun.

#### FR-08: Fulfil Pasca-DEAL (otomatis via WA)
* **FR-08.1 Alamat:** Buyer ditanya alamat kirim (teks atau Share Location → tersimpan sebagai alamat + peta).
* **FR-08.2 Foto & Juri:** Seller diminta foto barang (+ jam kirim); juri vision menilai cocok/tidak — lolos baru diteruskan ke buyer; buyer memberi vonis akhir ("foto oke"/tolak + retake).
* **FR-08.3 Kirim & Bayar:** Jadwal kirim seller → buyer "sudah bayar" → seller "uang masuk" → SELESAI. Sengketa ("belum terima") membekukan offer + memanggil admin. Perintah: "minta foto", "teruskan lokasi OFR-x".

---

### 5. Batasan & Kebutuhan Non-Fungsional (Non-Functional Requirements)
* **Kinerja (Performance):** Latensi respon klasifikasi intent di bawah 50 ms menggunakan router Laya System-1. Respon chatbot lengkap di bawah 2.5 detik.
* **Keamanan Data (Security & Privacy):** Nomor telepon dan koordinat detail lahan petani tidak dipublikasikan ke publik tanpa otentikasi peran. Dashboard web wajib login sesi (cookie HttpOnly + SameSite, password scrypt); seluruh endpoint tulis/baca-PII di balik `requireSession()`. Webhook WA memverifikasi HMAC `X-Hub-Signature-256` bila secret dikonfigurasi; challenge verifikasi dikirim sebagai `text/plain`. Nomor HP tidak disuntik penuh ke prompt AI (masking, detail kontak hanya untuk admin).
* **Kesiapan Data Training:** Seluruh kejadian domain (kas, stok, HPP, registrasi, verifikasi) diekspor sebagai event-log append-only berversi (`eventId, ts, source, entity, entityId, payload, schemaV`) — lihat BSD §4. JSON runtime adalah system of record operasional; Sheets adalah cermin baca.
* **Ketersediaan (Availability):** Sistem fallback cerdas (rule-based heuristic) tetap berjalan 100% aktif sekalipun koneksi internet ke provider AI luar terganggu.
* **Responsivitas Layanan (Mobile Friendly):** Seluruh antarmuka portal dapat dioperasikan secara ergonomis di layar ponsel smartphone (minimum tap target 44px).

---

### 6. Kriteria Terima (Acceptance Criteria — hasil audit 29 Okt 2026)
* **A-Auth:** Tanpa cookie sesi valid, semua endpoint tulis + baca-PII menjawab 401; login salah menjawab 401 tanpa membocorkan akun mana yang salah.
* **A-Parser:** "1.500.000" → 1500000; "2,5 juta" → 2500000; "1.5" → 1.5; kategori silang ("jual … kategori Pupuk") ditolak dengan pesan jelas, bukan 400 generik.
* **A-ERP:** Stok tidak bisa negatif via KELUAR; HPP menolak volume ≤ 0 dan biaya nol; duplikat kas 5 menit ditolak 409.
* **A-Webhook:** Tanpa secret → mode kompatibilitas + warning boot; dengan secret → signature invalid ditolak 403.
* **A-PII:** Respons AI/chatbot tidak memuat nomor HP penuh untuk non-admin; `/api/trace/:id` tetap publik tapi termasking.
* **A-Data:** Setiap tulis kas/stok/HPP/registrasi menghasilkan event di log kanonis (BSD §4) dengan `schemaV` terisi.
* **A-NEGO (Nov 2026):** Demand → notifikasi petani 1x; quote → COCOK + kabari buyer; "deal oke" → DEAL terminal + kabari dua pihak; stok live divalidasi ulang (tak bisa oversell).
* **A-FULFIL (Nov 2026):** DEAL → tanya alamat → foto lolos juri → "foto oke" → jadwal → "sudah bayar" → "uang masuk" → SELESAI; "belum terima" → SENGKETA + admin.
