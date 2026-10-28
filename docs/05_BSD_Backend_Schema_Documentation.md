# Backend Schema Documentation (BSD)
## Hai Tani (Data Schemas, REST API Contracts & Integrations)

**Versi Dokumen:** 1.0.0  
**Tanggal Rilis:** Oktober 2026  
**Status:** Approved  

---

### 1. Skema Database Entitas (Entity Data Models)

#### 1.1 Skema Lembar 1: Petani Binaan (`FarmerRecord`)
Skema ini merefleksikan 11 kolom resmi pada Lembar 1 Google Sheets dinas:

```typescript
export interface FarmerRecord {
  id: string;                    // Format: "PTN-001", "PTN-002", dst.
  nama: string;                  // Nama lengkap petani (contoh: "Supardi Wardoyo")
  noHp: string;                  // Nomor WhatsApp format E.164 (contoh: "+62 812-3456-7890")
  komoditas: string;             // Nama tanaman utama (contoh: "Padi Ciherang", "Cabai Rawit Merah")
  varietas?: string;             // Varietas spesifik tanaman (contoh: "Inpari 32")
  luasLahan: number;             // Luas lahan dalam satuan Hektar (contoh: 1.5)
  luasLahanFormatted?: string;   // Representasi ramah petani (contoh: "1.5 Ha (15.000 m²)")
  estimasiPanen: string;         // Periode panen (contoh: "November 2026")
  estimasiHasilTon?: number;     // Perhitungan tonase hasil panen (contoh: 9.8)
  alamat: string;                // Dusun / Desa dan Kecamatan domisili lahan
  kabupaten: string;             // Nama Kabupaten/Kota (contoh: "Subang", "Brebes")
  statusVerifikasi: 'Terverifikasi' | 'Pending' | 'Ditolak';
  waktuPendaftaran: string;      // Timestamp ISO-8601 (contoh: "2026-10-24 09:30 WIB")
  petugasPpl?: string;           // Nama petugas PPL penanggung jawab WKPP
  googleSheetRow?: number;       // Posisi baris pada spreadsheet (contoh: 2)
  catatanKhusus?: string;        // Catatan teknis agronomi atau kendala irigasi
  latitude?: number;             // Koordinat geospasial WGS-84 Lintang
  longitude?: number;            // Koordinat geospasial WGS-84 Bujur
}
```

#### 1.2 Skema Lembar 2: Kios Saprodi & Supplier Pertanian (`SupplierRecord`)
Skema ini merefleksikan 10 kolom logistik pada Lembar 2 Google Sheets:

```typescript
export interface SupplierRecord {
  id: string;                    // Format: "SPL-001", "SPL-002", dst.
  nama: string;                  // Nama toko/kios (contoh: "Kios Tani Makmur Subang")
  kategori: string;              // "Kios Resmi Pupuk Bersubsidi" | "Toko Saprodi" | "Offtaker"
  kontak: string;                // Nomor telepon / WhatsApp resmi toko
  alamat: string;                // Alamat fisik toko (jalan / desa)
  kabupaten: string;             // Kabupaten sentra operasional
  statusKemitraan: 'Aktif Resmi' | 'Mitra Binaan' | 'Dalam Peninjauan';
  produkUnggulan: string[];      // Array produk (contoh: ["Urea Pupuk Indonesia", "NPK Phonska"])
  stokTersedia: string;          // Ringkasan stok pupuk (contoh: "Tersedia 45 Ton Urea")
  radiusLayananKm: number;       // Radius operasional logistik dalam kilometer (contoh: 25)
  jamBuka?: string;              // Jam layanan (contoh: "07:30 - 17:00 WIB")
  petaniBinaanCount?: number;    // Jumlah kelompok tani langganan terhubung
  latitude: number;              // Koordinat GPS Toko Lintang
  longitude: number;             // Koordinat GPS Toko Bujur
  googleSheetRow?: number;       // Posisi baris pada Lembar 2
  catatan?: string;              // Nomor izin distributor kementerian
}
```

#### 1.3 Skema Role-Based Access Control (`AdminUser`)

```typescript
export interface AdminUser {
  id: string;                    // Format: "ADM-001"
  nama: string;                  // Nama lengkap petugas (contoh: "Ir. Hendro Wibowo, M.P.")
  noHp: string;                  // Nomor HP terdaftar izin akses
  instansi: string;              // "Dinas Pertanian Kab. Subang"
  role: 'ADMIN_UTAMA' | 'PETUGAS_PPL' | 'DATA_SCIENTIST';
  izinAkses: string[];           // ["READ_ALL", "VERIFY_FARMER", "DOWNLOAD_SHEETS", "MANAGE_ADMIN"]
  aktif: boolean;
  waktuTerdaftar: string;
}
```

#### 1.4 Skema Indeks Harga Pasar Komoditas (`MarketCommodity`)

```typescript
export interface MarketCommodity {
  id: string;
  nama: string;                  // "Cabai Rawit Merah"
  kategori: 'Hortikultura' | 'Pangan Pokok' | 'Palawija';
  hargaKemarin: number;          // Rp 60.000
  hargaSekarang: number;         // Rp 82.000
  satuan: string;                // "Kg"
  perubahanPersen: number;       // +36.67
  statusAnomali: 'Normal' | 'Lonjakan Ekstrim' | 'Penurunan Drastis';
  sentraProduksi: string;        // "Kediri, Blitar, Garut"
  tanggalPembaruan: string;
}
```

---

### 2. Spesifikasi Endpoint REST API

#### 2.1 Chatbot WhatsApp AI
* **Endpoint:** `POST /api/chat`
* **Request Body:**
  ```json
  {
    "message": "Mau daftarkan sawah padi 2 Ha di Subang nama Supardi",
    "senderPhone": "+62 812-3456-7890",
    "currentDraft": {},
    "currentSupplierDraft": {},
    "history": []
  }
  ```
* **Response (Success 200 OK):**
  ```json
  {
    "reply": "Pesan konfirmasi pendaftaran berformat WhatsApp...",
    "extracted": {
      "nama": "Supardi",
      "komoditas": "Padi",
      "luasLahan": 2.0,
      "kabupaten": "Subang"
    },
    "isComplete": true,
    "savedRecord": { "id": "PTN-011", "statusVerifikasi": "Pending" },
    "quickReplies": ["Cek Status Lahan", "Tanya Harga Pasar"]
  }
  ```

#### 2.2 Endpoint Diagnostik Laya Decision Engine
* **GET `/api/laya/status`**
  * Mengecek kondisi kesehatan sidecar port 8787, status circuit breaker, latensi inferensi, dan statistik cache memori.
* **POST `/api/laya/decide`**
  * Uji langsung kalimat input petani:
  * Request: `{"text": "sawah terserang hama wereng coklat"}`
  * Response: `{"intent": "hama_pupuk", "confidence": 0.7826, "latencyMs": 5, "source": "laya_sidecar"}`

#### 2.3 Operasi CRUD Data Pertanian
* **GET `/api/farmers`** - Mengambil seluruh data petani terdaftar.
* **POST `/api/farmers`** - Menambahkan data pendaftaran lahan manual.
* **PATCH `/api/farmers/:id/verify`** - Mengubah status verifikasi (`Terverifikasi` / `Pending`).
* **DELETE `/api/farmers/:id`** - Menghapus data petani.
* **GET `/api/suppliers`** - Mengambil seluruh data kios saprodi.
* **POST `/api/suppliers`** - Menambahkan kios baru.
* **GET `/api/export-csv`** - Mengunduh file CSV Lembar 1 Petani.
* **GET `/api/export-suppliers-csv`** - Mengunduh file CSV Lembar 2 Supplier.

---

### 3. Kontrak Webhook Integrasi Luar
* **Endpoint:** `POST /api/webhook/farmer-registration`
* **Fungsi:** Menerima payload pendaftaran dari WhatsApp Business Gateway eksternal (Twilio, Baileys, WhatsApp Cloud API) atau pemicu Google Apps Script.
* **Autentikasi Header:** `X-TaniAI-Signature: sha256_hash`
