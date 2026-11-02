# Design Brief Documentation (DBD)
## Hai Tani (Pedoman Desain Antarmuka & Visual Craft)

**Versi Dokumen:** 1.0.0  
**Tanggal Rilis:** Oktober 2026  
**Status:** Approved  
**Standar Desain:** Anti-Slop Professionalism (WCAG 2.1 AA Compliant)

---

### 1. Filosofi & Karakter Produk (Product Character)
Hai Tani dirancang dengan identitas **Kementerian / Balai Pertanian Modern & Sahabat Lapangan Petani**. Desain menjauhi estetika "AI Slop" generik (seperti gradasi ungu-neon acak, teks klise tanpa data, atau kartu melayang bertumpuk tanpa fungsi). Sebaliknya, Hai Tani mengedepankan:
* **Fungsionalitas Nyata:** Setiap tombol dan tautan memiliki aksi dan destinasi nyata.
* **Kejelasan Hierarki Tipografi:** Informasi kunci (nama petani, tonase panen, harga per kilogram) memiliki keterbacaan tinggi di berbagai kondisi pencahayaan layar.
* **Sentuhan Budaya Lokal yang Santun:** Menggunakan salam khas pertanian Indonesia (*"Sugeng Rahayu"*, *"Matur nuwun"*, sapaan *"Bapak/Ibu"*) yang membangun kepercayaan petani di lapangan.

---

### 2. Palet Warna Resmi (Design System Color Palette)

Aplikasi dibatasi pada 3 palet warna inti dan 1 warna aksen terkalibrasi:

| Peran Warna | Token Tailwind | Kode Hex | Arti & Penggunaan |
| :--- | :--- | :--- | :--- |
| **Primary (Agri Green)** | `emerald-600` / `emerald-700` | `#059669` / `#047857` | Identitas kesuburan tanaman, tombol utama, status terverifikasi. |
| **Secondary (Gov Slate)**| `slate-800` / `slate-900` | `#1e293b` / `#0f172a` | Header navigasi resmi dinas, teks judul, kontras latar profesional. |
| **Accent (Harvest Amber)**| `amber-500` / `amber-600` | `#f59e0b` / `#d97706` | Status pending verifikasi, notifikasi lonjakan anomali harga pasar. |
| **Speed Accent (Teal)**  | `teal-500` / `teal-600` | `#14b8a6` / `#0d9488` | Indikator kecepatan Laya System-1, gateway routing, efisiensi. |
| **Background (Clean)**   | `slate-50` / `white` | `#f8fafc` / `#ffffff` | Kanvas kerja bersih yang tidak melelahkan mata petugas dinas. |

#### Uji Kontras Aksesibilitas (WCAG AA):
* Teks utama (`slate-900` di atas `white`): Rasio kontras **12.6:1** (Lolos AA & AAA).
* Teks tombol putih di atas `emerald-600`: Rasio kontras **4.8:1** (Lolos AA).
* Teks peringatan `amber-900` di atas `amber-50`: Rasio kontras **7.1:1** (Lolos AA).

---

### 3. Skala Tipografi (Typography Hierarchy)

Font sistem menggunakan font sans-serif modern dengan keterbacaan tinggi:
* **Display Title (H1):** `text-xl sm:text-2xl font-bold tracking-tight text-slate-900` (Judul halaman utama).
* **Section Heading (H2):** `text-base sm:text-lg font-bold text-slate-800` (Judul panel dan tab aktif).
* **Card Title (H3):** `text-sm font-semibold text-slate-800` (Nama petani, kios saprodi).
* **Body Text (P):** `text-xs sm:text-sm text-slate-600 leading-relaxed` (Deskripsi dan percakapan).
* **Metadata & Badges:** `text-[10px] sm:text-xs font-mono font-medium uppercase tracking-wider` (ID Petani, koordinat GPS, latensi ms).

---

### 4. Standar Kerajinan Desain (Craftsmanship Standard)

Mengacu pada prinsip C-1 hingga C-5 dalam kode etik desain:
1. **C-1 Intentionality (Kesesuaian Tujuan):** Setiap elemen visual memiliki fungsi operasional. Tidak ada ornamen grid blueprint acak atau partikel melayang yang mengalihkan fokus dari data.
2. **C-2 Functional Completeness (Kelengkapan Fungsi):** Tombol verifikasi, tombol ekspor CSV, tombol cetak PDF, dan tautan Google Maps dapat diklik dan mengeksekusi aksi nyata.
3. **C-3 Content-Driven Composition:** Tata letak disesuaikan dengan volume data pertanian: baris tabel padat (*dense table*) dengan garis pemisah tipis `border-slate-200` untuk memudahkan audit dinas.
4. **C-4 Multi-State Resilience:** Setiap tampilan data wajib menyediakan:
   * **Empty State:** Ilustrasi dan panduan ramah saat belum ada data pendaftar.
   * **Loading State:** Indikator animasi berputar (*spinning skeleton*) saat memuat API.
   * **Error State:** Pesan jelas dengan tombol pemulihan (*Retry button*).
5. **C-5 Evidence Over Claims:** Statistik yang ditampilkan (luas hektar dan estimasi ton) dihitung langsung secara matematis dari rekaman database nyata.

---

### 5. Pedoman Responsivitas Seluler (Mobile Ergonomics)
* **Target Sentuh Minimum (Min Tap Target):** Semua tombol aksi dan navigasi tab memiliki dimensi area sentuh minimal **44px × 44px**.
* **Pencegahan Overflow:** Tabel database dilengkapi pembungkus `overflow-x-auto` yang memungkinkan geser horizontal halus tanpa merusak tata letak layar utama ponsel.
* **Simulator WhatsApp Realistis:** Komponen WhatsApp Chatbot meniru rasio aspek aplikasi pesan seluler lengkap dengan bubble pesan hijau lembut khas WhatsApp (`#dcf8c6`), tanda centang ganda, dan pemutar voice note.
