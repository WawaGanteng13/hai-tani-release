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
  kategori: 'Pupuk & Saprodi' | 'Bibit & Benih' | 'Alat & Mesin Pertanian (Alsintan)' | 'Offtaker & Pengepul' | 'Koperasi Tani';
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
  role: 'ADMIN_UTAMA' | 'PETUGAS_PPL' | 'DATA_SCIENTIST';
  izinAkses: string[];
  aktif: boolean;
  waktuTerdaftar: string;
  didaftarkanOleh?: string;
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


