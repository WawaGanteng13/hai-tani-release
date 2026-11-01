export interface FarmerRecord {
  id: string;
  timestamp: string;
  nama: string;
  noHp: string;
  alamat: string;
  kabupaten?: string;
  luasLahan: number; // in Hectares (Ha)
  luasLahanFormatted: string; // e.g., "1.5 Ha (15.000 m²)"
  komoditas: string;
  varietas?: string;
  estimasiPanen: string; // e.g., "Oktober 2026"
  estimasiHasilTon: number; // in Ton
  statusVerifikasi: 'Terverifikasi' | 'Menunggu Verifikasi' | 'Perlu Klarifikasi';
  catatanAI?: string;
  syncStatus: 'synced' | 'pending' | 'failed';
  googleSheetRow?: number;
  latitude?: number;
  longitude?: number;
  supplierTerhubungId?: string; // ID supplier mitra terdekat
}

export interface SupplierRecord {
  id: string;
  nama: string;
  kategori: 'Pupuk & Saprodi' | 'Bibit & Benih' | 'Alat & Mesin Pertanian (Alsintan)' | 'Buyer & Offtaker' | 'Koperasi Tani';
  kontak: string;
  alamat: string;
  kabupaten: string;
  latitude: number;
  longitude: number;
  statusKemitraan: 'Mitra Aktif' | 'Terverifikasi Dinas' | 'Kios Resmi BUMN';
  produkUnggulan: string[];
  stokTersedia?: string;
  radiusLayananKm?: number;
  jamBuka?: string;
  petaniBinaanCount?: number;
  catatan?: string;
  googleSheetRow?: number;
  timestamp?: string;
  syncStatus?: 'synced' | 'pending' | 'failed';
}

export interface MarketCommodity {
  id: string;
  nama: string;
  kategori: 'Pangan Pokok' | 'Hortikultura' | 'Palawija' | 'Perkebunan';
  hargaSekarang: number; // Rp per Kg
  hargaKemarin: number;
  hargaAcuanPemerintah: number; // HAP / HET
  perubahanPersen: number;
  statusAnomali: 'NORMAL' | 'LONJAKAN_EKSTREM' | 'PENURUNAN_DRASTIS' | 'PERINGATAN_FLUKTUASI';
  daerahSampel: string;
  tanggalUpdate: string;
  pesanAnomali?: string;
  rekomendasiPetani: string;
  tren7Hari: { tanggal: string; harga: number }[];
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'bot' | 'system';
  text: string;
  timestamp: string;
  type?: 'text' | 'form_confirm' | 'price_alert' | 'image' | 'voice_note';
  entityType?: 'farmer' | 'supplier';
  extractedData?: Partial<FarmerRecord>;
  extractedSupplier?: Partial<SupplierRecord>;
  quickReplies?: string[];
  imageUrl?: string;
  audioDuration?: string;
  transcription?: string;
  aiProvider?: 'meta' | 'gemini' | 'rule_based' | 'cache' | 'agronomy_engine' | 'analytics_engine';
  aiModel?: string;
  fromCache?: boolean;
  tokensUsed?: number;
}

export interface AnomalyNotification {
  id: string;
  komoditas: string;
  tipeAnomali: 'LONJAKAN_EKSTREM' | 'PENURUNAN_DRASTIS' | 'PERINGATAN_PASAR';
  pesanPeringatan: string;
  waktuKirim: string;
  jumlahPetaniTerdampak: number;
  status: 'Terkirim' | 'Dijadwalkan' | 'Pending';
  targetPetaniNames: string[];
}

export interface StrategicRecommendation {
  id: string;
  tanggal: string;
  judul: string;
  urgensi: 'Tinggi' | 'Sedang' | 'Rendah';
  ringkasanEksekutif: string;
  analisisOversupplyShortage: string[];
  rekomendasiAgronomi: string[];
  rekomendasiKebijakanHarga: string[];
  rekomendasiRantaiPasok: string[];
  dataScientistNotes: string;
  fromCache?: boolean;
  cachedAt?: string;
  cacheNotice?: string;
}

export interface AdminUser {
  id: string;
  nama: string;
  noHp: string;
  instansi: string;
  role: 'SUPER_ADMIN' | 'ADMIN_UTAMA' | 'PETUGAS_PPL' | 'DATA_SCIENTIST';
  izinAkses: string[];
  aktif: boolean;
  waktuTerdaftar: string;
  didaftarkanOleh?: string;
  appointedBy?: string;
}

export type UserRole = 'PETANI' | 'BUYER' | 'SUPPLIER';
export type OnboardingState = 'NEW' | 'TOS_SENT' | 'ROLE_ASK' | 'LOC_ASK' | 'DONE' | 'DONE_WEAK' | 'DECLINED';
export type UserTier = 'FREE' | 'PAID';
export type UserStatus = 'ACTIVE' | 'DECLINED' | 'FLAGGED' | 'BLOCKED';

// F1: identitas + onboarding + anti-spam per nomor WA (users_db.json).
// Field tier = telemetri pasif (rencana; tanpa enforcement sampai F9).
export interface UserRecord {
  phone: string;
  role?: UserRole;
  onboardingState: OnboardingState;
  onboardingTries?: number;
  tosVersion?: string;
  tosAt?: string;
  locLat?: number;
  locLng?: number;
  locLabel?: string;
  locMapsUrl?: string;
  locAt?: string;
  locWeak?: boolean;
  tier: UserTier;
  paidAt?: string;
  paidRef?: string;
  dailyChats?: number;
  lastChatDate?: string;
  status: UserStatus;
  declineNoticed?: boolean;
  spamScore?: number;
  spamCooldownUntil?: number;
  blockedAt?: string;
  blockReason?: string;
  blockNoticed?: boolean;
  keywordHist?: Array<{ kw: string; ts: string }>;
  feedbackCount?: number;
  // F3: pertanyaan negosiasi yang menunggu jawaban user ini.
  // F6: kind 'NUDGE' = pertanyaan proaktif harga (nudge harian).
  pendingAsk?: { kind: 'HARGA_JUAL' | 'BUDGET' | 'KONFIRM_DEAL' | 'NUDGE' | 'SPEK_OK'; offerId: string; ts: string; nudge?: { komoditasId: string; field: 'harga' } };
  // F6 session-maximizer: 1x sodoran/hari + opt-out permanen.
  lastNudgeAt?: string;
  nudgeOptOut?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type KomoditasStatus = 'AKTIF' | 'PANEN' | 'SELESAI';

// F2: multi-komoditas append-only per petani (komoditas_db.json, KMD-xxx).
// PANEN = siap panen/jual (dipakai F3 negotiator); SELESAI = musim berakhir.
export interface FarmerCommodity {
  id: string;
  farmerId: string;
  komoditas: string;
  varietas?: string;
  luasHa?: number;
  estimasiPanen?: string;
  estimasiHasilTon?: number;
  musimTanam?: string;
  status: KomoditasStatus;
  createdAt: string;
  updatedAt: string;
  googleSheetRow?: number;
  // F3: stok panen siap jual — HANYA dari ucapan petani, tak pernah dikarang.
  stokSiapJualTon?: number;
  stokUpdatedAt?: string;
  hargaMintaPerKg?: number;
  hargaMintaAt?: string;
}

// F3: negosiator buyer-petani (offers_db.json, OFR-xxx). Harga jual ditanya
// dulu ke petani; cocok bila <= budget buyer; selisih masuk kas Hai Tani.
export type OfferStatus = 'OPEN' | 'COCOK' | 'SEBAGIAN' | 'DEAL' | 'BATAL';
export interface OfferLine {
  farmerId: string;
  komoditasId: string;
  stokKg: number;
  hargaPetaniPerKg?: number;
  hargaAt?: string;
  alokasiKg?: number;
  cocok?: boolean;
  spekOk?: boolean;
}
export interface Offer {
  id: string;
  buyerPhone: string;
  komoditas: string;
  qtyKg: number;
  spesifikasi?: string;
  budgetPerKg?: number;
  budgetAt?: string;
  status: OfferStatus;
  lines: OfferLine[];
  spreadTotalRp?: number;
  namaBuyer?: string;
  followupAt?: string;
  catatan?: string;
  kasId?: string;
  createdAt: string;
  updatedAt: string;
}

// Kebutuhan saprodi petani (needs_db.json, NDB-xxx). Dihubungkan ke
// supplier/kios mitra terdekat; status dikelola dari tab Kemitraan.
export type NeedStatus = 'BARU' | 'DIHUBUNGKAN' | 'TERPENUHI' | 'BATAL';
export type NeedKategori = 'PUPUK' | 'OBAT' | 'BIBIT' | 'LAINNYA';
export interface FarmerNeed {
  id: string;
  farmerId: string;
  kategori: NeedKategori;
  item: string;
  jumlah?: string;
  status: NeedStatus;
  supplierId?: string;
  catatan?: string;
  createdAt: string;
  updatedAt: string;
}

// F7: log Saran & Masukan (feedback_db.json, FDB-xxx) + cermin tab Sheets.
export type FeedbackKategori = 'SARAN' | 'KOMPLAIN' | 'TIDAK_TAHU';
export interface FeedbackRecord {
  id: string;
  tanggal: string;
  phone: string;
  nama?: string;
  kategori: FeedbackKategori;
  pesan: string;
  konteks?: string;
  status: 'BARU' | 'DIBACA';
  waktuCatat: string;
  googleSheetRow?: number;
}

// F8: dokumen WA (nota/katalog/laporan) yang diparsing + entitasnya.
export type DocumentTipe = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'lainnya';
export interface DocumentRecord {
  id: string;
  tanggal: string;
  phone: string;
  nama?: string;
  namaFile: string;
  tipe: string;
  ukuranByte: number;
  komoditas: string[];
  harga: string[];
  saprodi: string[];
  ringkasan: string;
  mediaPath?: string;
  waktuCatat: string;
}

// F4: katalog produk toko mitra + penjualan afiliasi (komisi 3%).
export type ProductKategori = 'Obat' | 'Pupuk' | 'Saprodi' | 'Alat' | 'Benih';
export interface ProductRecord {
  id: string;
  supplierId: string;
  nama: string;
  kategori: ProductKategori;
  hargaNormal: number;
  satuan: string;
  kataKunci: string[];
  aktif: boolean;
  waktuCatat: string;
}
export interface AffiliateSale {
  id: string;
  tanggal: string;
  phone: string;
  farmerId?: string;
  productId: string;
  namaProduk: string;
  toko: string;
  hargaRp: number;
  komisiRp: number;
  status: 'TERCATAT' | 'DITERIMA';
  kasId?: string;
  waktuCatat: string;
}

// Harga buah input admin (digabung sumber live InfoPangan).
export interface FruitPrice {
  id: string;
  nama: string;
  satuan: string;
  harga: number;
  pasar?: string;
  waktuCatat: string;
}

export type CashJenis = 'MASUK' | 'KELUAR';
export type CashKategoriMasuk = 'Penjualan Panen' | 'Subsidi/Bantuan' | 'Pinjaman' | 'Lainnya';
export type CashKategoriKeluar =
  | 'Benih' | 'Pupuk' | 'Pestisida' | 'Upah Tenaga' | 'Sewa Lahan/Alat'
  | 'Transportasi' | 'Irigasi/BBM' | 'Cicilan' | 'Lainnya';

export interface CashTransaction {
  id: string;
  farmerId: string;
  tanggal: string;
  jenis: CashJenis;
  kategori: string;
  jumlahRp: number;
  komoditas?: string;
  musimTanam?: string;
  catatan?: string;
  buktiUrl?: string;
  dicatatOleh: string;
  waktuCatat: string;
  googleSheetRow?: number;
  syncStatus?: string;
}

export type StockArah = 'MASUK' | 'KELUAR' | 'PENYESUAIAN';

export interface StockMutation {
  id: string;
  supplierId: string;
  produk: string;
  satuan: string;
  arah: StockArah;
  qty: number;
  hargaSatuanRp?: number;
  tanggal: string;
  keterangan?: string;
  dicatatOleh: string;
  waktuCatat: string;
  googleSheetRow?: number;
}

export interface HppReport {
  id: string;
  farmerId: string;
  komoditas?: string;
  musimTanam?: string;
  totalBiayaRp: number;
  totalPendapatanRp: number;
  biayaPerKategori: Record<string, number>;
  volumePanenKg: number;
  hppPerKg: number;
  hargaJualPerKg?: number;
  marginPerKg?: number;
  marginPersen?: number;
  generatedAt: string;
  generatedBy: string;
}

export interface LayaStatus {
  configured: boolean;
  url: string;
  healthy: boolean;
  circuitBreakerActive: boolean;
  circuitBreakerCooldownRemainingSec: number;
  latencyMs: number;
  sidecarDetails?: {
    status?: string;
    loaded?: boolean;
    model?: string;
    error?: string;
  };
  cacheStats: {
    cachedKeysCount: number;
    maxKeys: number;
    ttlMs: number;
  };
  engineSpecs: {
    repo: string;
    huggingface: string;
    primitive: string;
    confidenceThreshold: number;
    supportedIntents: string[];
    optimizations: string[];
  };
}

export interface LayaDecisionResult {
  text: string;
  result: {
    intent: string;
    confidence: number;
    model?: string;
    source?: string;
  } | null;
  latencyMs: number;
  source: string;
  layaAvailable: boolean;
}


