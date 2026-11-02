# Backend Schema Documentation (BSD)
## Hai Tani (Data Schemas, REST API Contracts & Integrations)

**Versi Dokumen:** 1.1.0  
**Tanggal Rilis:** Oktober 2026 (Amandemen Audit Hardening)  
**Status:** Approved — Tambah Skema ERP, Auth & Log Kanonis  

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

#### 1.5 Skema ERP Fase 5 (Kas, Stok, HPP)

```typescript
export interface CashTransaction {
  id: string;                    // "KAS-0001" via nextId (single source ./lib/next-id)
  farmerId: string;              // pemilik; petani hanya miliknya sendiri (403 bila bukan)
  tanggal: string;               // ISO YYYY-MM-DD
  jenis: 'MASUK' | 'KELUAR';
  kategori: string;              // divalidasi silang: MASUK ⊂ [Penjualan Panen, Subsidi/Bantuan, Pinjaman, Lainnya]
                                 // KELUAR ⊂ [Benih, Pupuk, Pestisida, Upah Tenaga, Sewa Lahan/Alat, Transportasi, Irigasi/BBM, Cicilan, Lainnya]
  jumlahRp: number;              // integer > 0 (parser ID: "1.500.000" → 1500000)
  komoditas?: string; musimTanam?: string; // "MT-2026-1"
  catatan?: string;              // sanitizeText 500
  dicatatOleh: string;           // senderPhone / "dashboard"
  waktuCatat: string;            // ISO; anti-duplikat 5 mnt (farmer+jenis+kategori+nominal+tanggal)
  googleSheetRow?: number;       // via nextSheetRow
  syncStatus?: string;
}
export interface StockMutation {
  id: string;                    // "STM-0001"
  supplierId: string;            // pemilik; kios hanya miliknya sendiri
  produk: string;                // sanitizeText 80
  satuan: string;                // ⊂ [kg, gram, liter, ml, sak, botol, bungkus, pak, unit]
  arah: 'MASUK' | 'KELUAR' | 'PENYESUAIAN'; // PENYESUAIAN: qty boleh negatif (koreksi)
  qty: number;                   // > 0 (kecuali PENYESUAIAN); KELUAR ditolak bila saldo negatif
  hargaSatuanRp?: number;
  tanggal: string; keterangan?: string; dicatatOleh: string;
  waktuCatat: string; googleSheetRow?: number;
}
export interface HppReport {
  id: string;                    // "HPP-0001"
  farmerId: string; komoditas?: string; musimTanam?: string;
  totalBiayaRp: number;           // Σ KELUAR terfilter (400 bila nol)
  totalPendapatanRp: number;      // Σ MASUK kategori "Penjualan Panen"
  biayaPerKategori: Record<string, number>;
  volumePanenKg: number;         // > 0
  hppPerKg: number;              // totalBiaya/volume, 2 desimal
  hargaJualPerKg?: number;       // ≥ 0
  marginPerKg?: number; marginPersen?: number; // (harga-hpp)/harga*100
  generatedAt: string; generatedBy: string;
}
```

#### 1.6 Skema Sesi & Auth Dashboard
* `AdminUser.passwordHash?: string` — format `salt:scryptHex` (scrypt 32B, Node built-in).
* Cookie `tani_sid = <sid>.<hmac-sha256(sid)>` — `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`; store in-memory + sliding expiry 12 jam; kunci di `DATA_DIR/.session-key` (0600).
* Endpoint: `POST /api/auth/setup-password` (migrasi satu-kali / reset oleh ADMIN_UTAMA bersesi) → `POST /api/auth/login` → `GET /api/auth/me` → `POST /api/auth/logout`.
* `/api/chat` gerbang ganda: sesi dashboard ATAU header `x-tani-forward-secret` (forwarder resmi); self-assert mentah → 401. Identitas efektif (`effPhone`) = noHp admin sesi bila bersesi.

#### 1.7 Skema Indeks Harga Pasar Komoditas (`MarketCommodity`)

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
* **Gerbang ganda (v1.1.0):** sesi dashboard (cookie `tani_sid`) ATAU header `x-tani-forward-secret` (forwarder resmi). Tanpa keduanya → 401. `senderPhone` body hanya dipercaya dari forwarder; dari dashboard diganti identitas admin sesi (`effPhone`).
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
* **Reply loop v2 (1.1.0, file `api/webhook/whatsapp.ts` di-deploy ke Vercel):** forwarder mem-pipe body mentah ke backend dan paralel memanggil `POST /api/chat` (header `x-tani-forward-secret`), lalu mengirim `reply` via Meta Graph API (`WHATSAPP_TOKEN` + `PHONE_NUMBER_ID` di env Vercel). Hanya pesan pengguna (abaikan `statuses` + nomor sendiri sebagai anti-loop; batas 4000 karakter); gagal reply tidak menggagalkan webhook; balasan error gerbang tidak diteruskan.

---

### 4. Log Kanonis Berversi (sumber data training)
JSON runtime tetap system of record operasional; untuk ML, setiap tulis domain
**wajib** memancarkan event append-only (file `events_db.json` / tujuan setara):

```typescript
export interface CanonicalEvent {
  eventId: string;               // "EVT-<yyyymmdd>-<seq>"
  ts: string;                    // ISO-8601 waktu catat server
  source: 'wa-chat' | 'wa-webhook' | 'dashboard' | 'import' | 'system';
  entity: 'farmer' | 'supplier' | 'cash' | 'stock' | 'hpp' | 'admin' | 'commodity';
  entityId: string;              // id record terkait
  action: 'create' | 'update' | 'verify' | 'delete' | 'generate';
  actor: string;                 // noHp admin sesi / nomor WA / "system"
  payload: Record<string, unknown>; // snapshot field relevan (PII termasking)
  schemaV: 1;                    // versi skema — naikkan bila bentuk payload berubah
}
```
Aturan: PII (`noHp` penuh, koordinat presisi) **tidak** masuk payload — hanya versi mask. Konsumen training membaca log ini, bukan JSON mentah.

### 5. Endpoint Auth (v1.1.0)
* `POST /api/auth/setup-password` `{noHp, password≥8}` — sekali per admin (migrasi) / reset oleh ADMIN_UTAMA bersesi.
* `POST /api/auth/login` → Set-Cookie `tani_sid`; `GET /api/auth/me`; `POST /api/auth/logout`.
* Seluruh route tulis + baca-PII kini memakai middleware `requireSession()` (401 bila tanpa sesi).
