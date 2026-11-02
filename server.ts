import express from "express";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import crypto from "node:crypto";
import https from "node:https";
import dotenv from "dotenv";
import QRCode from "qrcode";
import { jsPDF } from "jspdf";
import { GoogleGenAI } from "@google/genai";
import {
  INITIAL_FARMERS,
  INITIAL_COMMODITIES,
  INITIAL_NOTIFICATIONS,
  INITIAL_STRATEGIC_RECOMMENDATION,
  INITIAL_ADMINS,
  INITIAL_SUPPLIERS,
} from "./src/data/mockData";
import {
  FarmerRecord,
  MarketCommodity,
  AnomalyNotification,
  StrategicRecommendation,
  AdminUser,
  SupplierRecord,
  CashTransaction,
  StockMutation,
  HppReport,
  UserRecord,
  UserRole,
  OnboardingState,
  FarmerCommodity,
  Offer,
  OfferLine,
  OfferStatus,
  FruitPrice,
  FarmerNeed,
  NeedStatus,
  NeedKategori,
  FeedbackRecord,
  FeedbackKategori,
  DocumentRecord,
  ProductRecord,
  ProductKategori,
  AffiliateSale,
  UserMemory,
} from "./src/types";
import { calculateFertilizerRecommendation } from "./src/utils/agronomy";
import { REFERENSI_PERTANIAN } from "./src/data/referensi_pertanian";
import { nextId } from "./lib/next-id";
import { nextSheetRow } from "./lib/sheet-row";
import { initSheetsSync, enqueueSheetSync, drainSheetsQueue, getSheetsStatus, getSheetsRemote } from "./lib/sheets-sync";
import multer from "multer";

dotenv.config();

// In-memory data stores (with local disk-backed persistence)
let farmersDb: FarmerRecord[] = [...INITIAL_FARMERS];
let commoditiesDb: MarketCommodity[] = [...INITIAL_COMMODITIES];
let notificationsDb: AnomalyNotification[] = [...INITIAL_NOTIFICATIONS];
let latestRecommendation: StrategicRecommendation = { ...INITIAL_STRATEGIC_RECOMMENDATION };
let latestRecommendationDataHash = "";
let lastRecommendationGeneratedAt = Date.now();
let adminsDb: AdminUser[] = [...INITIAL_ADMINS];
let suppliersDb: SupplierRecord[] = [...INITIAL_SUPPLIERS];

// ERP Fase 5: kas tani, mutasi stok kios, laporan HPP (disk-backed seperti db lain)
let cashDb: CashTransaction[] = [];
let stockDb: StockMutation[] = [];
let hppDb: HppReport[] = [];

// F1: identitas + onboarding + anti-spam per nomor WA (disk-backed).
let usersDb: UserRecord[] = [];
const SUPER_ADMIN_PHONE = (process.env.SUPER_ADMIN_PHONE || "6281977358208").trim();

// F2: multi-komoditas append-only (disk-backed).
let komoditasDb: FarmerCommodity[] = [];

// F3: negosiator buyer-petani (disk-backed).
let offersDb: Offer[] = [];

// F7: log Saran & Masukan (disk-backed).
let feedbackDb: FeedbackRecord[] = [];

// F8: dokumen WA terparsing (disk-backed).
let documentsDb: DocumentRecord[] = [];

// F4: katalog produk toko mitra + penjualan afiliasi (disk-backed).
let productsDb: ProductRecord[] = [];
let affiliateDb: AffiliateSale[] = [];
// Keputusan Wawa: usahakan komisi afiliasi 3% dari harga jual normal.
const AFFILIATE_PCT = 3;

// Harga pasar live SISKAPERBAPO Disperindag Jatim (cache 30 menit)
interface PasarPrice {
  nama: string;
  satuan: string;
  harga: number;
}
let pasarCache: { at: number; tanggal: string; daftar: PasarPrice[] } | null = null;
const PASAR_TTL_MS = 30 * 60 * 1000;

function stripHtmlTags(s: string): string {
  return (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchHargaPasar(): Promise<{ tanggal: string; daftar: PasarPrice[]; live: boolean }> {
  const now = Date.now();
  if (pasarCache && now - pasarCache.at < PASAR_TTL_MS) {
    return { tanggal: pasarCache.tanggal, daftar: pasarCache.daftar, live: false };
  }
  const d = new Date();
  const tanggal = `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch("https://siskaperbapo.jatimprov.go.id/harga/tabel.nodesign", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `tanggal=${encodeURIComponent(tanggal)}&kabkota=&pasar=`,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const html = await res.text();
    const daftar: PasarPrice[] = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(html)) !== null) {
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1])) !== null) cells.push(stripHtmlTags(cm[1]));
      if (cells.length >= 4 && /^\d+$/.test(cells[0] || "")) {
        const harga = parseIdNumber(cells[3] || "");
        if (cells[1] && harga !== undefined) daftar.push({ nama: cells[1], satuan: cells[2] || "kg", harga });
      }
    }
    if (daftar.length > 0) {
      pasarCache = { at: now, tanggal, daftar };
      try { detectPriceAnomalies(daftar); } catch { /* detektor tak boleh ganggu chat */ }
      return { tanggal, daftar, live: true };
    }
  } catch (e) {
    console.log("[HargaPasar] fetch gagal, pakai cache:", (e as Error)?.message || e);
  }
  if (pasarCache) return { tanggal: pasarCache.tanggal, daftar: pasarCache.daftar, live: false };
  return { tanggal, daftar: [], live: false };
}

// ---- Auto-EWS: deteksi anomali dari harga live SISKAPERBAPO ----
// Berjalan tiap fetch live sukses (sync, murah: ~5 komoditas). Hanya mencatat
// transisi status -> notifikasi "Pending" untuk admin; broadcast ke petani tetap
// manual 1-tap (hemat biaya WA, anti-spam). Tak boleh throw ke pemanggil.
function detectPriceAnomalies(daftar: PasarPrice[]): void {
  try {
    if (!Array.isArray(daftar) || daftar.length === 0) return;
    const today = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
    for (const item of commoditiesDb) {
      const cn = String(item.nama || "").toLowerCase();
      const alias = HARGA_ALIAS.find((a) => a.keys.some((k) => cn.includes(k)));
      if (!alias) continue;
      const row = daftar.find((d) => {
        const dn = String(d.nama || "").toLowerCase();
        return alias.keys.some((k) => dn.includes(k));
      });
      const live = Number(row?.harga);
      const base = Number(item.hargaSekarang);
      if (!(live > 0) || !(base > 0)) continue;
      const pct = Number((((live - base) / base) * 100).toFixed(2));
      const st: MarketCommodity["statusAnomali"] = pct >= 20 ? "LONJAKAN_EKSTREM"
        : pct <= -20 ? "PENURUNAN_DRASTIS"
        : Math.abs(pct) >= 10 ? "PERINGATAN_FLUKTUASI" : "NORMAL";
      if (st === item.statusAnomali) continue;
      item.hargaKemarin = base;
      item.hargaSekarang = live;
      item.perubahanPersen = pct;
      item.statusAnomali = st;
      item.tanggalUpdate = today;
      item.pesanAnomali = st === "NORMAL" ? "Kondisi harga relatif stabil dalam rentang normal."
        : st === "LONJAKAN_EKSTREM" ? `Lonjakan ekstrem (+${pct}%) terdeteksi otomatis dari SISKAPERBAPO.`
        : st === "PENURUNAN_DRASTIS" ? `Penurunan drastis (${pct}%) terdeteksi otomatis dari SISKAPERBAPO.`
        : `Perubahan signifikan (${pct}%) terdeteksi otomatis dari SISKAPERBAPO.`;
      item.tren7Hari.push({ tanggal: new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short" }), harga: live });
      if (item.tren7Hari.length > 7) item.tren7Hari.shift();
      if (st !== "NORMAL") {
        const growers = farmersDb.filter((f) => String(f.komoditas || "").toLowerCase().split(/[;,]/).some((c) => {
          const cc = c.trim();
          return cc && (alias.keys.some((k) => cc.includes(k)) || cn.includes(cc));
        }));
        notificationsDb.unshift({
          id: `NOTIF-${Date.now()}-${item.id}`,
          komoditas: item.nama,
          tipeAnomali: (st === "PERINGATAN_FLUKTUASI" ? "PERINGATAN_PASAR" : st) as AnomalyNotification["tipeAnomali"],
          pesanPeringatan: item.pesanAnomali || "",
          waktuKirim: new Date().toISOString(),
          jumlahPetaniTerdampak: growers.length,
          status: "Pending",
          targetPetaniNames: growers.slice(0, 20).map((g) => g.nama),
        });
        emitCanonicalEvent({
          source: "ews-auto", entity: "commodity", entityId: item.id,
          action: "anomaly", actor: "sistem",
          payload: { nama: item.nama, harga: live, pct, status: st },
        });
      }
      bumpDataVersion();
    }
  } catch (err) {
    console.error("[EWS] deteksi gagal:", (err as Error)?.message || err);
  }
}
const HARGA_ALIAS: Array<{ keys: string[]; match: string[] }> = [
  { keys: ["rawit"], match: ["cabe rawit merah"] },
  { keys: ["keriting"], match: ["cabe merah keriting"] },
  { keys: ["cabai", "cabe", "lombok"], match: ["cabe rawit merah", "cabe merah keriting", "cabe merah besar"] },
  { keys: ["bawang merah"], match: ["bawang merah"] },
  { keys: ["bawang putih"], match: ["bawang putih"] },
  { keys: ["bawang"], match: ["bawang merah", "bawang putih"] },
  { keys: ["jagung"], match: ["jagung pipilan kering"] },
  { keys: ["beras", "padi", "gabah"], match: ["beras premium", "beras medium"] },
  { keys: ["kedelai", "kedele"], match: ["kacang kedelai lokal", "kacang kedelai impor"] },
  { keys: ["tomat"], match: ["tomat"] },
  { keys: ["kentang"], match: ["kentang"] },
  { keys: ["kubis"], match: ["kol/kubis"] },
  { keys: ["kol"], match: ["kol/kubis"] },
  { keys: ["wortel", "wortal"], match: ["wortel"] },
  { keys: ["buncis"], match: ["buncis"] },
  { keys: ["ketela", "singkong"], match: ["ketela pohon"] },
  { keys: ["ubi"], match: ["ketela pohon"] },
  { keys: ["kacang hijau"], match: ["kacang hijau"] },
  { keys: ["kacang tanah"], match: ["kacang tanah"] },
  { keys: ["telur"], match: ["telur ayam ras"] },
  { keys: ["ayam"], match: ["daging ayam ras", "telur ayam ras"] },
  { keys: ["urea"], match: ["pupuk urea"] },
  { keys: ["npk", "phonska"], match: ["pupuk npk"] },
  { keys: ["za"], match: ["pupuk za"] },
  { keys: ["kcl"], match: ["pupuk kcl"] },
  { keys: ["sp36", "sp-36", "sp 36"], match: ["pupuk sp"] },
  { keys: ["pupuk"], match: ["pupuk urea", "pupuk npk", "pupuk sp", "pupuk za", "pupuk kcl"] },
];

const KOMODITAS_ID: Record<string, number> = {
  "cabe rawit merah": 50, "cabe merah keriting": 37, "cabe merah besar": 38,
  "bawang merah": 39, "bawang putih": 49, "jagung pipilan kering": 25,
  "beras premium": 2, "beras medium": 4,
  "kacang kedelai lokal": 33, "kacang kedelai impor": 32,
  "tomat": 46, "kentang": 45, "kol/kubis": 44, "wortel": 47, "buncis": 48,
  "ketela pohon": 43, "kacang hijau": 41, "kacang tanah": 42,
  "telur ayam ras": 16, "daging ayam ras": 13,
  "pupuk urea": 87, "pupuk npk": 85, "pupuk sp": 86, "pupuk za": 88, "pupuk kcl": 84,
};

interface PasarRow {
  lokasi: string;
  harga: number;
  tanggal: string;
}
const pasarKomoditasCache = new Map<number, { at: number; rows: PasarRow[] }>();

async function fetchPasarKomoditas(id: number): Promise<PasarRow[]> {
  const now = Date.now();
  const hit = pasarKomoditasCache.get(id);
  if (hit && now - hit.at < PASAR_TTL_MS) return hit.rows;
  const d = new Date();
  const tgl = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch("https://siskaperbapo.jatimprov.go.id/harga-komoditas", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `komoditas=${id}&tanggal_akhir=${tgl}`,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const html = await res.text();
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let dates: string[] = [];
    const rows: PasarRow[] = [];
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(html)) !== null) {
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1])) !== null) cells.push(stripHtmlTags(cm[1]));
      if (cells.length < 3) continue;
      if (/^no$/i.test(cells[0] || "") && /lokasi/i.test(cells[1] || "")) {
        dates = cells.slice(2);
        continue;
      }
      const lokasi = cells[1] || "";
      if (!lokasi || /propinsi/i.test(lokasi)) continue;
      for (let i = cells.length - 1; i >= 2; i--) {
        const h = parseIdNumber(cells[i] || "");
        if (h !== undefined) {
          const rawT = dates[i - 2] || "";
          const dm = rawT.match(/(\d{4})-(\d{2})-(\d{2})/);
          rows.push({ lokasi, harga: h, tanggal: dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : rawT });
          break;
        }
      }
    }
    if (rows.length > 0) {
      pasarKomoditasCache.set(id, { at: now, rows });
      return rows;
    }
  } catch (e) {
    console.log("[HargaPasar] fetch per-pasar gagal:", (e as Error)?.message || e);
  }
  if (hit) return hit.rows;
  return [];
}

// Harga sayur live Pasar Mantung Kab. Malang (Dinas TPH / mantung.malangkab.go.id,
// ~40 komoditas sayur, update harian). Sertifikat TLS situs ini tidak dikenali
// Node -> pakai https.request rejectUnauthorized:false KHUSUS host ini (data publik).
interface MantungPrice {
  nama: string;
  satuan: string;
  harga: number;
  trend: string;
  alasan: string;
}
let mantungCache: { at: number; tanggal: string; daftar: MantungPrice[] } | null = null;

function fetchHttpsTextInsecure(url: string, redirects = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, timeout: 15000, headers: { "User-Agent": "TaniAI-HargaBot/1.0" } },
      (res) => {
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
          res.resume();
          fetchHttpsTextInsecure(new URL(loc, url).toString(), redirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 2 * 1024 * 1024) {
            req.destroy();
            reject(new Error("respons terlalu besar"));
          }
        });
        res.on("end", () => resolve(body));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const EN_MONTH: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", mei: "05", jun: "06",
  jul: "07", aug: "08", agu: "08", sep: "09", oct: "10", okt: "10", nov: "11", dec: "12", des: "12",
};

function mantungDateId(raw: string): string {
  const m = (raw || "").match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return (raw || "").trim();
  const mo = EN_MONTH[m[2].slice(0, 3).toLowerCase()] || "01";
  return `${m[1].padStart(2, "0")}-${mo}-${m[3]}`;
}

async function fetchHargaMantung(): Promise<{ tanggal: string; daftar: MantungPrice[]; live: boolean }> {
  const now = Date.now();
  if (mantungCache && now - mantungCache.at < PASAR_TTL_MS) {
    return { tanggal: mantungCache.tanggal, daftar: mantungCache.daftar, live: false };
  }
  const d = new Date();
  const todayId = `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  try {
    const html = await fetchHttpsTextInsecure("https://mantung.malangkab.go.id/");
    const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const daftar: MantungPrice[] = [];
    const dates: string[] = [];
    const seenNames = new Set<string>();
    for (const chunk of html.split("Lihat Detail")) {
      const t = strip(chunk).slice(-500);
      // Tempered groups: nama & alasan tak boleh menelan blok harga kartu sebelumnya.
      const m = t.match(/((?:(?!Rp\s*[\d.]|Update:)[\s\S]){2,70}?)\s*Rp\s*([\d.]+)\s*\/\s*([A-Za-z]+)\s*(Naik|Turun|Stabil)?((?:(?!Rp\s*[\d.])[\s\S]){0,120}?)\s*Update:\s*(\d{1,2}\s+\w+\s+\d{4})?\s*$/);
      if (!m) continue;
      const nama = m[1].replace(/^[\s\S]*?(Tutup|Export to CSV)\s+/, "").replace(/\s+/g, " ").trim();
      const harga = parseIdNumber(m[2] || "");
      if (!nama || nama.length < 2 || /harga sayuran/i.test(nama) || harga === undefined || seenNames.has(nama.toLowerCase())) continue;
      seenNames.add(nama.toLowerCase());
      daftar.push({ nama, satuan: m[3] || "Kg", harga, trend: m[4] || "Stabil", alasan: (m[5] || "").replace(/\s+/g, " ").trim() });
      if (m[6]) dates.push(m[6]);
    }
    if (daftar.length > 0) {
      const freq = new Map<string, number>();
      for (const x of dates) freq.set(x, (freq.get(x) || 0) + 1);
      let mode = "";
      let best = 0;
      for (const [x, c] of freq) if (c > best) { best = c; mode = x; }
      const tanggal = mode ? mantungDateId(mode) : todayId;
      mantungCache = { at: now, tanggal, daftar };
      return { tanggal, daftar, live: true };
    }
  } catch (e) {
    console.log("[HargaMantung] fetch gagal, pakai cache:", (e as Error)?.message || e);
  }
  if (mantungCache) return { tanggal: mantungCache.tanggal, daftar: mantungCache.daftar, live: false };
  return { tanggal: todayId, daftar: [], live: false };
}

// Alias query user -> nama komoditas di Pasar Mantung (komoditas yg tumpang tindih
// dengan SISKAPERBAPO dijawab dari KEDUA sumber agar petani bisa membandingkan).
const MANTUNG_ALIAS: Array<{ keys: string[]; match: string[] }> = [
  { keys: ["rawit"], match: ["cabe rawit"] },
  { keys: ["keriting"], match: ["cabe keriting"] },
  { keys: ["cabe besar"], match: ["cabe besar"] },
  { keys: ["cabai", "cabe", "lombok"], match: ["cabe rawit", "cabe keriting", "cabe besar"] },
  { keys: ["bawang merah"], match: ["bawang merah"] },
  { keys: ["bawang putih"], match: ["bawang putih"] },
  { keys: ["daun bawang", "bawang prei", "prei", "layur", "segon"], match: ["prei", "layur", "segon"] },
  { keys: ["bombay", "bombai"], match: ["bombay"] },
  { keys: ["tomat"], match: ["tomat buah", "tomat sayur"] },
  { keys: ["kentang"], match: ["kentang"] },
  { keys: ["kubis", "kol"], match: ["kubis"] },
  { keys: ["wortel", "wortal"], match: ["wortel"] },
  { keys: ["buncis"], match: ["buncis"] },
  { keys: ["brokoli", "brocoli"], match: ["brokoli"] },
  { keys: ["bunga kol", "kembang kol"], match: ["bunga kol"] },
  { keys: ["sawi"], match: ["sawi daging", "sawi putih"] },
  { keys: ["seledri", "sledri"], match: ["seledri"] },
  { keys: ["terong", "terung"], match: ["terong"] },
  { keys: ["timun", "ketimun"], match: ["timun", "ketimun"] },
  { keys: ["selada"], match: ["selada"] },
  { keys: ["andewi", "endive"], match: ["andewi"] },
  { keys: ["jamur"], match: ["jamur kuping", "jamur tiram"] },
  { keys: ["kapri"], match: ["kapri"] },
  { keys: ["lobak"], match: ["lobak"] },
  { keys: ["manisa", "labusiem", "labu siem", "siem"], match: ["manisa", "labusiem"] },
  { keys: ["kacang merah"], match: ["kacang merah"] },
];

function mantungTrendEmoji(t: string): string {
  if (/naik/i.test(t || "")) return "📈";
  if (/turun/i.test(t || "")) return "📉";
  return "➡️";
}

const PILOT_MARKETS: Array<{ keys: string[]; display: string }> = [
  { keys: ["mantung", "pujon"], display: "Pasar Mantung" },
  { keys: ["karangploso", "karang ploso"], display: "Pasar Karang Ploso" },
  { keys: ["songgoriti"], display: "Pasar Songgoriti" },
  { keys: ["gentengan"], display: "Pasar Gentengan" },
  { keys: ["pesanggrahan"], display: "Pasar Pesanggrahan" },
  { keys: ["dinoyo"], display: "Pasar Dinoyo" },
  { keys: ["blimbing"], display: "Pasar Blimbing" },
  { keys: ["tawangmangu"], display: "Pasar Tawangmangu" },
  { keys: ["ororodowo", "oro-oro dowo", "oro oro dowo"], display: "Pasar Oro-oro Dowo" },
  { keys: ["klojen"], display: "Pasar Klojen" },
];

function detectPasar(lower: string): string | null {
  const m = lower.match(/(?:di\s+)?pasar\s+([a-z][a-z\s]{1,30}?)(?:\?|,|\.|$| dan | tapi | yang | untuk | berapa | harga | dong\b)/);
  if (m && m[1]) {
    const c = m[1].trim().replace(/\s+/g, " ");
    if (c.length >= 3 && !/^(hari ini|sekarang|tersebut|itu|ini|tani)$/.test(c)) return c;
  }
  const flat = (lower || "").toLowerCase();
  for (const pm of PILOT_MARKETS) {
    if (pm.keys.some((k) => flat.includes(k))) return pm.display;
  }
  return null;
}

function normLok(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z]/g, "");
}

function komoditasIdOf(nama: string): number | undefined {
  const key = (nama || "").toLowerCase().split(" /")[0].replace(/\s*\(.*\)\s*$/, "").trim();
  for (const [k, id] of Object.entries(KOMODITAS_ID)) {
    if (key.includes(k)) return id;
  }
  return undefined;
}

function hargaKeyHit(lower: string, key: string): boolean {
  if (key.length <= 3) return new RegExp(`\\b${key}\\b`).test(lower);
  return lower.includes(key);
}

async function formatHargaPasarReply(message: string): Promise<string> {
  const lower = (message || "").toLowerCase();
  // Tentukan sumber yg dibutuhkan dari intent dulu (hemat 1 fetch di jalur cepat).
  const siskaHit = HARGA_ALIAS.find((a) => a.keys.some((k) => hargaKeyHit(lower, k)));
  const mantungHit = MANTUNG_ALIAS.find((a) => a.keys.some((k) => hargaKeyHit(lower, k)));
  const sayurGenerik = !siskaHit && !mantungHit && /sayur|lalap/.test(lower);
  const pasarQ = detectPasar(lower);
  const isMantungPasar = !!pasarQ && /mantung|pujon/.test(normLok(pasarQ));
  const isPrei = /daun bawang|bawang prei|\bprei\b|layur|segon/.test(lower);
  const needSiska = !isPrei && !!(siskaHit || (!mantungHit && !sayurGenerik && !isMantungPasar));
  const needMantung = !!(mantungHit || sayurGenerik || isMantungPasar);
  const [s, mt] = await Promise.all([
    needSiska ? fetchHargaPasar() : Promise.resolve({ tanggal: "", daftar: [] as PasarPrice[], live: false }),
    needMantung ? fetchHargaMantung() : Promise.resolve({ tanggal: "", daftar: [] as MantungPrice[], live: false }),
  ]);
  const tanggal = s.tanggal || mt.tanggal;
  const byName = (want: string) => s.daftar.find((p) => p.nama.toLowerCase().includes(want));
  let picks: PasarPrice[] = [];
  if (needSiska && s.daftar.length > 0) {
    for (const a of HARGA_ALIAS) {
      if (a.keys.some((k) => hargaKeyHit(lower, k))) {
        picks = a.match.map(byName).filter((p): p is PasarPrice => !!p);
        if (picks.length > 0) break;
      }
    }
    if (picks.length === 0) {
      picks = ["beras premium", "cabe rawit merah", "bawang merah", "jagung pipilan kering"]
        .map(byName)
        .filter((p): p is PasarPrice => !!p);
    }
  }
  // Picks Mantung: semua varian yg cocok (maks 6 baris, dedup nama).
  const mWant: string[] = mantungHit
    ? mantungHit.match
    : (sayurGenerik || isMantungPasar ? ["tomat", "cabe rawit", "bawang merah", "kubis", "wortel", "kentang"] : []);
  const seen = new Set<string>();
  const mPicks: MantungPrice[] = [];
  for (const w of mWant) {
    for (const p of mt.daftar) {
      if (p.nama.toLowerCase().includes(w) && !seen.has(p.nama)) {
        seen.add(p.nama);
        mPicks.push(p);
      }
    }
  }
  const mLinesAll = mPicks.slice(0, 6).map((p) => {
    const extra = p.alasan && /naik|turun/i.test(p.trend) ? ` — ${p.alasan}` : "";
    return `• ${p.nama} *(Mantung)*: Rp ${p.harga.toLocaleString("id-ID")}/${p.satuan} ${mantungTrendEmoji(p.trend)}${extra}`;
  });
  if (pasarQ && !isMantungPasar && picks.length > 0) {
    const withId = picks
      .map((p) => ({ p, id: komoditasIdOf(p.nama) }))
      .filter((x): x is { p: PasarPrice; id: number } => x.id !== undefined);
    if (withId.length > 0) {
      const tables = await Promise.all(withId.map((x) => fetchPasarKomoditas(x.id)));
      const want = normLok(pasarQ);
      let foundAny = false;
      const mLines = withId.map((x, idx) => {
        const rows = tables[idx]
          .slice()
          .sort((a, b) => Number(b.lokasi.toLowerCase().startsWith("pasar")) - Number(a.lokasi.toLowerCase().startsWith("pasar")));
        const hitRow = rows.find((r) => {
          const a = normLok(r.lokasi);
          return a.includes(want) || want.includes(a);
        });
        if (hitRow) {
          foundAny = true;
          const short = x.p.nama.split(" /")[0];
          return `• ${short} di *${hitRow.lokasi}*: Rp ${hitRow.harga.toLocaleString("id-ID")}/${x.p.satuan} (${hitRow.tanggal})`;
        }
        return `• ${x.p.nama}: data pasar tidak ada, rata-rata Jatim Rp ${x.p.harga.toLocaleString("id-ID")}/${x.p.satuan}`;
      });
      if (foundAny) {
        const banding = mLinesAll.length > 0 ? `\n\n⚖️ *Pembanding Pasar Mantung (${mt.tanggal}):*\n${mLinesAll.join("\n")}` : "";
        const src = mLinesAll.length > 0
          ? "SISKAPERBAPO Disperindag Jatim + Pasar Mantung Kab. Malang"
          : "SISKAPERBAPO Disperindag Jatim";
        return `📊 *Harga Pasar (${tanggal}):*\n${mLines.join("\n")}${banding}\n\n🔎 _Sumber: ${src}_\n\nApakah Bapak/Ibu ingin mendaftarkan komoditas dan perkiraan waktu panen?`;
      }
    }
  }
  if (picks.length === 0 && mPicks.length === 0) {
    return `📊 *Informasi Harga Pasar:*\n\nMohon maaf, data harga pasar SISKAPERBAPO Jatim sedang tidak bisa diakses saat ini. Silakan coba lagi beberapa menit lagi atau cek langsung di siskaperbapo.jatimprov.go.id/harga/tabel`;
  }
  const lines = picks.map((p) => `• ${p.nama}: Rp ${p.harga.toLocaleString("id-ID")}/${p.satuan}`);
  const src: string[] = [];
  if (picks.length > 0) src.push("SISKAPERBAPO Disperindag Jatim");
  if (mLinesAll.length > 0) src.push(`Pasar Mantung Kab. Malang (${mt.tanggal})`);
  const head = picks.length > 0 && mLinesAll.length === 0 ? `📊 *Harga Pasar Jatim (${tanggal}):*` : `📊 *Harga Pasar (${tanggal}):*`;
  return `${head}\n${[...lines, ...mLinesAll].join("\n")}\n\n🔎 _Sumber: ${src.join(" + ")}_\n\nApakah Bapak/Ibu ingin mendaftarkan komoditas dan perkiraan waktu panen?`;
}

// Disk-backed persistence directories & paths
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FARMERS_FILE = path.join(DATA_DIR, "farmers_db.json");
const ADMINS_FILE = path.join(DATA_DIR, "admins_db.json");
const SUPPLIERS_FILE = path.join(DATA_DIR, "suppliers_db.json");
const CASH_FILE = path.join(DATA_DIR, "cash_db.json");
const STOCK_FILE = path.join(DATA_DIR, "stock_db.json");
const HPP_FILE = path.join(DATA_DIR, "hpp_db.json");
const USERS_FILE = path.join(DATA_DIR, "users_db.json");
const KOMODITAS_FILE = path.join(DATA_DIR, "komoditas_db.json");
const OFFERS_FILE = path.join(DATA_DIR, "offers_db.json");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback_db.json");
const FEEDBACK_CSV = path.join(DATA_DIR, "feedback_db.csv");
const DOCUMENTS_FILE = path.join(DATA_DIR, "documents_db.json");
const FRUIT_FILE = path.join(DATA_DIR, "fruit_db.json");
const NEEDS_FILE = path.join(DATA_DIR, "needs_db.json");
let fruitPricesDb: FruitPrice[] = [];
let needsDb: FarmerNeed[] = [];
const PRODUCTS_FILE = path.join(DATA_DIR, "products_db.json");
const AFFILIATE_FILE = path.join(DATA_DIR, "affiliate_db.json");

// Webhook audit logs
let webhookLogs: Array<{ id: string; timestamp: string; event: string; detail: string; status: string }> = [
  {
    id: "wh-init",
    timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
    event: "system_init",
    detail: "Sistem Webhook TaniAI siap menerima data dua arah dari Google Apps Script",
    status: "READY",
  },
];

function readJsonSafe<T>(file: string, fallback: T, label: string): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    console.error(`[Storage] ${label} korup, pakai data awal:`, (err as Error)?.message);
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return fallback;
  }
}

function initPersistence() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const farmersData = readJsonSafe<unknown>(FARMERS_FILE, [], "farmers_db.json");
    if (Array.isArray(farmersData) && farmersData.length > 0) {
      farmersDb = (farmersData as FarmerRecord[]).map((f: FarmerRecord) => {
        const init = INITIAL_FARMERS.find((i) => i.id === f.id);
        return {
          ...f,
          latitude: f.latitude ?? init?.latitude ?? -6.5 + (Math.random() * 0.1 - 0.05),
          longitude: f.longitude ?? init?.longitude ?? 107.5 + (Math.random() * 0.1 - 0.05),
          supplierTerhubungId: f.supplierTerhubungId ?? init?.supplierTerhubungId,
        };
      });
      console.log(`[Storage] Berhasil memuat ${farmersDb.length} data petani dari disk (${FARMERS_FILE})`);
    } else if (!fs.existsSync(FARMERS_FILE)) {
      saveFarmersToDisk();
    }

    const adminsData = readJsonSafe<unknown>(ADMINS_FILE, [], "admins_db.json");
    if (Array.isArray(adminsData) && adminsData.length > 0) {
      adminsDb = adminsData as AdminUser[];
      console.log(`[Storage] Berhasil memuat ${adminsDb.length} admin dari disk (${ADMINS_FILE})`);
    } else if (!fs.existsSync(ADMINS_FILE)) {
      saveAdminsToDisk();
    }

    const suppliersData = readJsonSafe<unknown>(SUPPLIERS_FILE, [], "suppliers_db.json");
    if (Array.isArray(suppliersData) && suppliersData.length > 0) {
      suppliersDb = suppliersData as SupplierRecord[];
      console.log(`[Storage] Berhasil memuat ${suppliersDb.length} data supplier dari disk (${SUPPLIERS_FILE})`);
    } else if (!fs.existsSync(SUPPLIERS_FILE)) {
      saveSuppliersToDisk();
    }

    const cashData = readJsonSafe<unknown>(CASH_FILE, [], "cash_db.json");
    if (Array.isArray(cashData) && cashData.length > 0) {
      cashDb = cashData as CashTransaction[];
      console.log(`[Storage] Berhasil memuat ${cashDb.length} transaksi kas dari disk (${CASH_FILE})`);
    }

    const stockData = readJsonSafe<unknown>(STOCK_FILE, [], "stock_db.json");
    if (Array.isArray(stockData) && stockData.length > 0) {
      stockDb = stockData as StockMutation[];
      console.log(`[Storage] Berhasil memuat ${stockDb.length} mutasi stok dari disk (${STOCK_FILE})`);
    }

    const hppData = readJsonSafe<unknown>(HPP_FILE, [], "hpp_db.json");
    if (Array.isArray(hppData) && hppData.length > 0) {
      hppDb = hppData as HppReport[];
      console.log(`[Storage] Berhasil memuat ${hppDb.length} laporan HPP dari disk (${HPP_FILE})`);
    }

    const usersData = readJsonSafe<unknown>(USERS_FILE, [], "users_db.json");
    if (Array.isArray(usersData) && usersData.length > 0) {
      usersDb = usersData as UserRecord[];
      console.log(`[Storage] Berhasil memuat ${usersDb.length} user WA dari disk (${USERS_FILE})`);
    }

    const offersData = readJsonSafe<unknown>(OFFERS_FILE, [], "offers_db.json");
    if (Array.isArray(offersData) && offersData.length > 0) {
      offersDb = offersData as Offer[];
      console.log(`[Storage] Berhasil memuat ${offersDb.length} penawaran negosiasi dari disk (${OFFERS_FILE})`);
    }

    const feedbackData = readJsonSafe<unknown>(FEEDBACK_FILE, [], "feedback_db.json");
    if (Array.isArray(feedbackData) && feedbackData.length > 0) {
      feedbackDb = feedbackData as FeedbackRecord[];
      console.log(`[Storage] Berhasil memuat ${feedbackDb.length} saran/masukan dari disk (${FEEDBACK_FILE})`);
    }
    const docData = readJsonSafe<unknown>(DOCUMENTS_FILE, [], "documents_db.json");
    if (Array.isArray(docData) && docData.length > 0) {
      documentsDb = docData as DocumentRecord[];
      console.log(`[Storage] Berhasil memuat ${documentsDb.length} dokumen dari disk (${DOCUMENTS_FILE})`);
    }
    const prdData = readJsonSafe<unknown>(PRODUCTS_FILE, [], "products_db.json");
    if (Array.isArray(prdData) && prdData.length > 0) {
      productsDb = prdData as ProductRecord[];
      console.log(`[Storage] Berhasil memuat ${productsDb.length} produk afiliasi dari disk (${PRODUCTS_FILE})`);
    }
    const buhData = readJsonSafe<unknown>(FRUIT_FILE, [], "fruit_db.json");
    if (Array.isArray(buhData) && buhData.length > 0) {
      fruitPricesDb = buhData as FruitPrice[];
      console.log(`[Storage] Berhasil memuat ${fruitPricesDb.length} harga buah admin dari disk (${FRUIT_FILE})`);
    }
    const ndData = readJsonSafe<unknown>(NEEDS_FILE, [], "needs_db.json");
    if (Array.isArray(ndData) && ndData.length > 0) {
      needsDb = ndData as FarmerNeed[];
      console.log(`[Storage] Berhasil memuat ${needsDb.length} kebutuhan saprodi dari disk (${NEEDS_FILE})`);
    }
    const affData = readJsonSafe<unknown>(AFFILIATE_FILE, [], "affiliate_db.json");
    if (Array.isArray(affData) && affData.length > 0) {
      affiliateDb = affData as AffiliateSale[];
      console.log(`[Storage] Berhasil memuat ${affiliateDb.length} penjualan afiliasi dari disk (${AFFILIATE_FILE})`);
    }

    const kmdData = readJsonSafe<unknown>(KOMODITAS_FILE, [], "komoditas_db.json");
    if (Array.isArray(kmdData) && kmdData.length > 0) {
      komoditasDb = kmdData as FarmerCommodity[];
      console.log(`[Storage] Berhasil memuat ${komoditasDb.length} komoditas dari disk (${KOMODITAS_FILE})`);
    }
    // F2: migrasi sekali-jalan — tiap petani tanpa baris KMD dapat 1 baris AKTIF
    // dari field legacy-nya. Idempoten (petani berbaris dilewati).
    {
      let added = 0;
      const now = new Date().toISOString();
      for (const f of farmersDb) {
        const has = komoditasDb.some((k) => k.farmerId === f.id);
        if (has || !String(f.komoditas || "").trim()) continue;
        komoditasDb.push({
          id: nextId("KMD", komoditasDb.map((k) => k.id)),
          farmerId: f.id,
          komoditas: String(f.komoditas).trim(),
          varietas: f.varietas || "",
          luasHa: Number(f.luasLahan) || 0,
          estimasiPanen: f.estimasiPanen || "",
          estimasiHasilTon: Number(f.estimasiHasilTon) || 0,
          status: "AKTIF",
          createdAt: now,
          updatedAt: now,
        });
        added++;
      }
      if (added > 0) {
        saveKomoditasToDisk();
        console.log(`[Storage] Migrasi F2: ${added} baris komoditas dari data legacy.`);
      }
    }

    // F1: migrasi SUPER_ADMIN kanonis (env SUPER_ADMIN_PHONE, default ADM-006).
    // Idempoten + reversibel (ubah env bila nomor berganti).
    const saHit = adminsDb.find((a) => normalizePhone(a.noHp) === normalizePhone(SUPER_ADMIN_PHONE) && a.aktif);
    if (saHit && saHit.role !== "SUPER_ADMIN") {
      saHit.role = "SUPER_ADMIN";
      saveAdminsToDisk();
      console.log(`[Storage] ${saHit.id} diangkat SUPER_ADMIN (${maskPhone(saHit.noHp)})`);
    }

    // F3: migrasi terminologi tengkulak→buyer (sekali-jalan, idempoten).
    // Nilai lama di disk: users role "TENGKULAK", suppliers kategori
    // "Offtaker & Pengepul". Riwayat events_db.json dibiarkan apa adanya.
    {
      let migrated = 0;
      for (const u of usersDb) {
        if ((u as { role?: string }).role === "TENGKULAK") {
          u.role = "BUYER";
          migrated++;
        }
      }
      for (const s of suppliersDb) {
        const rec = s as unknown as { kategori?: string; nama?: string };
        if (rec.kategori === "Offtaker & Pengepul") {
          rec.kategori = "Buyer & Offtaker";
          migrated++;
        }
        if (typeof rec.nama === "string" && rec.nama.includes("Offtaker & Pengepul")) {
          rec.nama = rec.nama.replace(/Offtaker & Pengepul/g, "Buyer");
          migrated++;
        }
      }
      if (migrated > 0) {
        saveUsersToDisk();
        saveSuppliersToDisk();
        console.log(`[Storage] Migrasi F3 terminologi buyer: ${migrated} baris.`);
      }
    }

    // Event log dimuat terpisah via loadEventsDb() (dipanggil di startServer,
    // setelah semua deklarasi top-level — menghindari TDZ).
  } catch (err) {
    console.error("[Storage] Inisialisasi storage lokal gagal:", err);
  }
}

function writeJsonAtomic(file: string, data: unknown, label: string) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[Storage] Gagal menyimpan ${label}:`, err);
  }
}

// ---- Training store: simpan dulu (JSONL append-only lokal, bukan Sheets) ----
// Satu berkas per hari: data/training/events-YYYY-MM-DD.jsonl (gitignored).
// Media biner (voice/image) disimpan terpisah di data/training/media/HARI/;
// JSONL hanya mencatat path relatif + transkrip/hasil analisis.
// Privasi: nomor pengirim TIDAK disimpan mentah, hanya hash sha256.
// Tak pernah melempar: kegagalan simpan hanya di-log agar bot tak terpengaruh.
// Nonaktifkan darurat via env TRAINING_STORE_OFF=1.
const TRAINING_DIR = path.join(DATA_DIR, "training");
function hashPhone(p?: string): string {
  if (!p) return "";
  try {
    return crypto.createHash("sha256").update(String(p)).digest("hex");
  } catch {
    return "";
  }
}
function clipText(s: any, n = 8000): string {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function trainingLog(entry: Record<string, unknown>): void {
  try {
    if (process.env.TRAINING_STORE_OFF === "1") return;
    if (!fs.existsSync(TRAINING_DIR)) fs.mkdirSync(TRAINING_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(path.join(TRAINING_DIR, `events-${day}.jsonl`), line, "utf-8");
  } catch (err) {
    console.error("[Training] gagal simpan:", (err as any)?.message || err);
  }
}
// Simpan biner media untuk training; kembalikan path relatif ("" bila gagal).
function trainingSaveMedia(kind: "voice" | "image" | "document", buf: Buffer, mime: string): string {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(TRAINING_DIR, "media", day);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const m = String(mime || "").toLowerCase();
    const ext = m.includes("png") ? "png"
      : m.includes("jpeg") || m.includes("jpg") ? "jpg"
      : m.includes("webp") ? "webp"
      : m.includes("ogg") ? "ogg"
      : m.includes("mp3") || m.includes("mpeg") ? "mp3"
      : m.includes("wav") ? "wav"
      : m.includes("pdf") ? "pdf"
      : m.includes("wordprocessingml") || m.includes("msword") ? "docx"
      : m.includes("spreadsheetml") || m.includes("ms-excel") ? "xlsx"
      : m.includes("csv") ? "csv"
      : m.includes("text/plain") ? "txt"
      : kind === "image" ? "jpg" : kind === "document" ? "bin" : "webm";
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const rel = `media/${day}/${kind}-${id}.${ext}`;
    fs.writeFileSync(path.join(TRAINING_DIR, rel), buf);
    return rel;
  } catch (err) {
    console.error("[Training] gagal simpan media:", (err as any)?.message || err);
    return "";
  }
}

// nextId: single source di ./lib/next-id (ada self-check).
function saveFarmersToDisk() {
  writeJsonAtomic(FARMERS_FILE, farmersDb, "farmers_db.json");
}

function saveAdminsToDisk() {
  writeJsonAtomic(ADMINS_FILE, adminsDb, "admins_db.json");
}

function saveSuppliersToDisk() {
  writeJsonAtomic(SUPPLIERS_FILE, suppliersDb, "suppliers_db.json");
}

function saveCashToDisk() {
  writeJsonAtomic(CASH_FILE, cashDb, "cash_db.json");
}

function saveStockToDisk() {
  writeJsonAtomic(STOCK_FILE, stockDb, "stock_db.json");
}

function saveHppToDisk() {
  writeJsonAtomic(HPP_FILE, hppDb, "hpp_db.json");
}

function saveUsersToDisk() {
  writeJsonAtomic(USERS_FILE, usersDb, "users_db.json");
}

function saveKomoditasToDisk() {
  writeJsonAtomic(KOMODITAS_FILE, komoditasDb, "komoditas_db.json");
}

function saveOffersToDisk() {
  writeJsonAtomic(OFFERS_FILE, offersDb, "offers_db.json");
}

function saveFeedbackToDisk() {
  writeJsonAtomic(FEEDBACK_FILE, feedbackDb, "feedback_db.json");
  // CSV audit append-only (selalu tulis-ulang ringan: skala kecil).
  try {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["id,tanggal,nama,phone,kategori,pesan,konteks,status,waktuCatat",
      ...feedbackDb.map((f) => [f.id, f.tanggal, f.nama, f.phone, f.kategori, f.pesan, f.konteks, f.status, f.waktuCatat].map(q).join(","))];
    fs.writeFileSync(FEEDBACK_CSV, lines.join("\n") + "\n");
  } catch (err) { console.error("[Storage] Gagal tulis feedback_db.csv:", (err as any)?.message || err); }
}

// F7: catat saran/komplain/ketidaktahuan -> JSON + event (cermin Sheets otomatis).
function logFeedback(phone: string, kategori: FeedbackKategori, pesan: string, konteks?: string): FeedbackRecord {
  const now = new Date().toISOString();
  const me = normalizePhone(phone);
  const fr = farmersDb.find((f) => normalizePhone(f.noHp) === me);
  const rec: FeedbackRecord = {
    id: nextId("FDB", feedbackDb.map((f) => f.id)),
    tanggal: now.substring(0, 10),
    phone: String(phone || ""),
    nama: fr?.nama || undefined,
    kategori,
    pesan: sanitizeText(pesan, 500) || "(kosong)",
    konteks: konteks ? sanitizeText(konteks, 300) : undefined,
    status: "BARU",
    waktuCatat: now,
  };
  feedbackDb.unshift(rec);
  saveFeedbackToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: "wa-chat", entity: "feedback", entityId: rec.id,
    action: "create", actor: phone,
    payload: { kategori, status: "BARU" },
  });
  return rec;
}

function saveDocumentsToDisk() {
  writeJsonAtomic(DOCUMENTS_FILE, documentsDb, "documents_db.json");
}

// F8: parsing dokumen WA (PDF/DOCX/XLSX/CSV/TXT). Dynamic-import agar boot
// tetap cepat; pdf-parse v2 API kelas (new PDFParse({data}).getText()).
async function parseDocumentBuffer(buf: Buffer, mime: string, filename: string): Promise<{ text: string; tipe: string }> {
  const m = String(mime || "").toLowerCase();
  const fn = String(filename || "").toLowerCase();
  const isPdf = m.includes("pdf") || fn.endsWith(".pdf");
  const isDocx = m.includes("wordprocessingml") || m.includes("msword") || fn.endsWith(".docx") || fn.endsWith(".doc");
  const isXlsx = m.includes("spreadsheetml") || m.includes("ms-excel") || fn.endsWith(".xlsx") || fn.endsWith(".xls");
  const isCsv = m.includes("csv") || fn.endsWith(".csv");
  const isTxt = m.includes("text/plain") || fn.endsWith(".txt");
  if (isPdf) {
    const mod: any = await import("pdf-parse");
    const parser = new mod.PDFParse({ data: buf });
    const r = await parser.getText();
    return { text: String(r?.text || ""), tipe: "pdf" };
  }
  if (isDocx) {
    const mammoth: any = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: buf });
    return { text: String(r?.value || ""), tipe: "docx" };
  }
  if (isXlsx) {
    const XLSX: any = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return { text: String(XLSX.utils.sheet_to_csv(ws) || ""), tipe: "xlsx" };
  }
  if (isCsv || isTxt) return { text: buf.toString("utf-8"), tipe: isCsv ? "csv" : "txt" };
  throw new Error("format belum didukung");
}

const DOC_SAPRODI = ["pupuk", "urea", "npk", "phonska", "kcl", "tsp", "sp36", "za", "kompos",
  "pestisida", "insektisida", "fungisida", "herbisida", "bibit", "benih",
  "traktor", "sprayer", "pompa", "cangkul"];

// F8: ekstraksi entitas deterministik (tanpa LLM): kosakata komoditas reuse
// HARGA_ALIAS, harga via pola Rp, saprodi/alat via daftar kunci.
function extractDocEntities(text: string): { komoditas: string[]; harga: string[]; saprodi: string[] } {
  const t = String(text || "").toLowerCase();
  const kom: string[] = [];
  for (const a of HARGA_ALIAS) for (const k of a.keys) {
    if (k.length < 3 || kom.includes(k)) continue;
    try {
      if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) kom.push(k);
    } catch { /* kunci tak-valid dilewati */ }
  }
  const harga = Array.from(new Set(
    (String(text || "").match(/rp\.?\s?[\d][\d.\s]*(?:,\d{1,2})?/gi) || []).map((s) => s.trim().slice(0, 24))
  )).slice(0, 20);
  const sap: string[] = [];
  for (const s of DOC_SAPRODI) {
    if (sap.includes(s)) continue;
    try {
      if (new RegExp(`\\b${s}\\b`).test(t)) sap.push(s);
    } catch { /* abaikan */ }
  }
  return { komoditas: kom.slice(0, 20), harga, saprodi: sap };
}

// F8: catat dokumen terparsing -> JSON + event (tanpa cermin Sheets).
function logDocument(phone: string, namaFile: string, tipe: string, ukuranByte: number,
    ent: { komoditas: string[]; harga: string[]; saprodi: string[] }, mediaPath: string): DocumentRecord {
  const now = new Date().toISOString();
  const me = normalizePhone(phone);
  const fr = farmersDb.find((f) => normalizePhone(f.noHp) === me);
  const ringkasan = [
    ent.komoditas.length ? `${ent.komoditas.length} komoditas (${ent.komoditas.slice(0, 5).join(", ")})` : "",
    ent.harga.length ? `${ent.harga.length} harga` : "",
    ent.saprodi.length ? `${ent.saprodi.length} saprodi/alat (${ent.saprodi.slice(0, 5).join(", ")})` : "",
  ].filter(Boolean).join("; ") || "tidak ada entitas dikenali";
  const rec: DocumentRecord = {
    id: nextId("DOC", documentsDb.map((d) => d.id)),
    tanggal: now.substring(0, 10),
    phone: String(phone || ""),
    nama: fr?.nama || undefined,
    namaFile: sanitizeText(namaFile, 200) || "(tanpa nama)",
    tipe: String(tipe || "lainnya"),
    ukuranByte: Number(ukuranByte) || 0,
    komoditas: ent.komoditas,
    harga: ent.harga,
    saprodi: ent.saprodi,
    ringkasan,
    mediaPath: mediaPath || undefined,
    waktuCatat: now,
  };
  documentsDb.unshift(rec);
  saveDocumentsToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: "wa-media", entity: "document", entityId: rec.id,
    action: "create", actor: phone,
    payload: { tipe, komoditas: ent.komoditas.length, harga: ent.harga.length },
  });
  return rec;
}

function saveProductsToDisk() {
  writeJsonAtomic(PRODUCTS_FILE, productsDb, "products_db.json");
}

function saveAffiliateToDisk() {
  writeJsonAtomic(AFFILIATE_FILE, affiliateDb, "affiliate_db.json");
}

function saveFruitToDisk() {
  writeJsonAtomic(FRUIT_FILE, fruitPricesDb, "fruit_db.json");
}

function nextFruitId(): string {
  let n = 0;
  for (const r of fruitPricesDb) {
    const m = /^BUH-(\d+)$/.exec(r.id || "");
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `BUH-${String(n + 1).padStart(3, "0")}`;
}

function saveNeedsToDisk() {
  writeJsonAtomic(NEEDS_FILE, needsDb, "needs_db.json");
}

function nextNeedId(): string {
  let n = 0;
  for (const r of needsDb) {
    const m = /^NDB-(\d+)$/.exec(r.id || "");
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `NDB-${String(n + 1).padStart(3, "0")}`;
}

// Harga buah: live InfoPangan DKI Jakarta (API publik, cache 30 mnt) digabung
// baris input admin. Buah live = Semangka + Jeruk Medan (commodity 24/25).
const BUAH_LIVE_IDS = new Set([24, 25]);
let buahCache: { at: number; tanggal: string; daftar: Array<{ nama: string; satuan: string; harga: number; asal: string }> } | null = null;
async function fetchHargaBuah(): Promise<{ tanggal: string; live: boolean; daftar: Array<{ nama: string; satuan: string; harga: number; asal: string }> }> {
  const admin = fruitPricesDb.map((r) => ({ nama: r.nama, satuan: r.satuan, harga: r.harga, asal: "admin" }));
  const now = Date.now();
  if (buahCache && now - buahCache.at < 30 * 60 * 1000) {
    return { tanggal: buahCache.tanggal, live: true, daftar: [...buahCache.daftar, ...admin] };
  }
  try {
    const res = await fetch("https://infopangan.jakarta.go.id/api2/v1/public/master-data/commodities", {
      signal: AbortSignal.timeout(20000),
      headers: { "user-agent": "HaiTani/1.0", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    const rows: any[] = Array.isArray(j?.data?.data) ? j.data.data : [];
    const live = rows
      .filter((x) => BUAH_LIVE_IDS.has(Number(x?.commodity_id)) && /semangka|jeruk/i.test(String(x?.name || "")))
      .map((x) => ({ nama: String(x.name), satuan: String(x.unit || "kg"), harga: Number(x.newest_price) || 0, asal: "live" }))
      .filter((x) => x.harga > 0);
    const tanggal = String(j?.data?.selected_price_date || new Date().toISOString().slice(0, 10));
    buahCache = { at: now, tanggal, daftar: live };
    return { tanggal, live: true, daftar: [...live, ...admin] };
  } catch (_e) {
    if (buahCache) return { tanggal: buahCache.tanggal, live: false, daftar: [...buahCache.daftar, ...admin] };
    return { tanggal: new Date().toISOString().slice(0, 10), live: false, daftar: admin };
  }
}

// F4: cari produk mitra aktif yang cocok dengan teks (nama/kata kunci).
function matchProducts(text: string, limit = 5): ProductRecord[] {
  const t = ` ${String(text || "").toLowerCase()} `;
  const scored: Array<{ p: ProductRecord; n: number }> = [];
  for (const p of productsDb) {
    if (!p.aktif) continue;
    const keys = [p.nama, ...(p.kataKunci || [])].map((k) => String(k || "").toLowerCase().trim()).filter((k) => k.length >= 3);
    let n = 0;
    for (const k of keys) if (t.includes(k)) n++;
    if (n > 0) scored.push({ p, n });
  }
  scored.sort((a, b) => b.n - a.n);
  return scored.slice(0, limit).map((s) => s.p);
}

function supplierName(id: string): string {
  return suppliersDb.find((s) => s.id === id)?.nama || "(toko mitra)";
}

function productLine(p: ProductRecord): string {
  return `• *${p.nama}* — Rp${Number(p.hargaNormal || 0).toLocaleString("id-ID")}/${p.satuan || "pcs"} di ${supplierName(p.supplierId)}`;
}

// F4: catat laporan pembelian petani -> AFF-xxx TERCATAT (komisi 3%).
function logAffiliate(phone: string, p: ProductRecord, hargaRp: number): AffiliateSale {
  const now = new Date().toISOString();
  const me = normalizePhone(phone);
  const fr = farmersDb.find((f) => normalizePhone(f.noHp) === me);
  const harga = Number(hargaRp) > 0 ? Math.round(Number(hargaRp)) : Number(p.hargaNormal) || 0;
  const rec: AffiliateSale = {
    id: nextId("AFF", affiliateDb.map((a) => a.id)),
    tanggal: now.substring(0, 10),
    phone: String(phone || ""),
    farmerId: fr?.id || undefined,
    productId: p.id,
    namaProduk: p.nama,
    toko: supplierName(p.supplierId),
    hargaRp: harga,
    komisiRp: Math.round(harga * AFFILIATE_PCT / 100),
    status: "TERCATAT",
    waktuCatat: now,
  };
  affiliateDb.unshift(rec);
  saveAffiliateToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: "wa-chat", entity: "affiliate", entityId: rec.id,
    action: "create", actor: phone,
    payload: { productId: p.id, hargaRp: harga, komisiRp: rec.komisiRp },
  });
  return rec;
}

// F4: komisi diterima dari toko -> KAS-xxx MASUK "Komisi Affiliate" (cermin Sheets).
function receiveCommission(affId: string, actorPhone: string): { aff: AffiliateSale; kasId: string } | null {
  const a = affiliateDb.find((x) => x.id.toUpperCase() === String(affId || "").toUpperCase());
  if (!a || a.status === "DITERIMA") return null;
  const now = new Date().toISOString();
  const record: CashTransaction = {
    id: nextId("KAS", cashDb.map((c) => c.id)),
    farmerId: "",
    tanggal: now.substring(0, 10),
    jenis: "MASUK",
    kategori: "Komisi Affiliate" as any,
    jumlahRp: a.komisiRp,
    komoditas: sanitizeText(a.namaProduk, 60) || undefined,
    catatan: sanitizeText(`Komisi ${AFFILIATE_PCT}% ${a.id}: ${a.namaProduk} @ ${a.toko} (lapor ${maskPhone(a.phone)})`, 500),
    dicatatOleh: String(actorPhone || "sistem"),
    waktuCatat: now,
    googleSheetRow: nextSheetRow(cashDb.map((c) => c.googleSheetRow), cashDb.length),
    syncStatus: "synced",
  };
  cashDb.unshift(record);
  saveCashToDisk();
  a.status = "DITERIMA";
  a.kasId = record.id;
  saveAffiliateToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: "wa-chat", entity: "cash", entityId: record.id,
    action: "create", actor: actorPhone,
    payload: { jenis: "MASUK", kategori: "Komisi Affiliate", jumlahRp: a.komisiRp, affiliateId: a.id },
  });
  return { aff: a, kasId: record.id };
}

// FR-04: basis URL publik untuk tautan kartu WA. Urutan: env eksplisit ->
// file status tunnel ops (otomatis ikut URL ngrok aktif) -> host request.
function kartuPublicBase(fallbackHost: string): string {
  const env = (process.env.KARTU_PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(env)) return env;
  try {
    const last = fs.readFileSync("C:\\Users\\USER\\hai-tani-ops\\last-status.txt", "utf8");
    const m = last.match(/pub=(https?:\/\/[^\s]+)/);
    if (m) return m[1].replace(/\/+$/, "");
  } catch (_e) { /* abaikan: pakai host request */ }
  const proto = /localhost|127\.0\.0\.1/i.test(fallbackHost) ? "http" : "https";
  return `${proto}://${cleanHost(fallbackHost)}`;
}

// FR-04: susun PDF Kartu Tanda Registrasi (A6) + QR ID petani.
async function buildKartuPdf(f: FarmerRecord): Promise<ArrayBuffer> {
  const qr = await QRCode.toDataURL(`HAITANI:${f.id}`, { width: 240, margin: 1 });
  const doc = new jsPDF({ unit: "mm", format: [105, 148] });
  doc.setFillColor(5, 150, 105);
  doc.rect(0, 0, 105, 26, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("KARTU TANDA REGISTRASI PETANI", 52.5, 10, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Hai Tani - Kang Tani AI", 52.5, 17, { align: "center" });
  doc.setTextColor(20, 20, 20);
  const rows: Array<[string, string]> = [
    ["ID", f.id],
    ["Nama", f.nama || "-"],
    ["No HP", maskPhone(f.noHp)],
    ["Komoditas", [f.komoditas, f.varietas].filter(Boolean).join(" / ") || "-"],
    ["Luas Lahan", f.luasLahanFormatted || `${Number(f.luasLahan || 0)} Ha`],
    ["Kabupaten", f.kabupaten || "-"],
    ["Status", f.statusVerifikasi || "-"],
    ["Terdaftar", String(f.timestamp || "").slice(0, 10) || "-"],
  ];
  let y = 34;
  doc.setFontSize(10);
  for (const [k, v] of rows) {
    const val = String(v || "-").slice(0, 34);
    doc.setFont("helvetica", "bold");
    doc.text(`${k}:`, 10, y);
    doc.setFont("helvetica", "normal");
    doc.text(val, 38, y);
    y += 7;
  }
  doc.addImage(qr, "PNG", 32.5, 94, 40, 40);
  doc.setFontSize(8);
  doc.text(`Pindai: HAITANI:${f.id}`, 52.5, 139, { align: "center" });
  return doc.output("arraybuffer");
}

// Inisialisasi data storage saat server pertama kali booting
initPersistence();

// Helper to normalize phone numbers for accurate matching (+62, 08, dashes, spaces)
function normalizePhone(phone?: string): string {
  const s = String(phone ?? "");
  if (!s) return "";
  let p = s.replace(/[^0-9]/g, "");
  if (p.startsWith("62")) {
    p = "0" + p.slice(2);
  }
  return p;
}

function findAdmin(phone?: string): AdminUser | undefined {
  const norm = normalizePhone(phone);
  if (!norm) return undefined;
  return adminsDb.find((a) => a.aktif && normalizePhone(a.noHp) === norm);
}

// ---- WhatsApp Cloud API outbound (produksi; EWS broadcast) ----
// Token System User permanen dari WHATSAPP_ACCESS_TOKEN. phoneId default =
// nomor bisnis produksi +62 881-0261-39498 (bukan secret, hanya routing id).
const WA_GRAPH_VERSION = "v24.0";
const WA_DEFAULT_PHONE_ID = "1345016292036690";
function waOutboundConfig(): { token: string; phoneId: string } {
  return {
    token: (process.env.WHATSAPP_ACCESS_TOKEN || "").trim(),
    phoneId: (process.env.PHONE_NUMBER_ID || WA_DEFAULT_PHONE_ID).trim(),
  };
}
// ---- Router multi-nomor WA (hemat jatah gratis 1.000 pesan/nomor/bulan) ----
// WA_NUMBERS_JSON = [{"id":"<phone_number_id>","label":"CS-1"}, ...].
// Tanpa env: 1 nomor (PHONE_NUMBER_ID) = perilaku lama. Sticky per user agar
// konteks tidak pindah nomor; chat baru ke nomor yang jatahnya tersisa.
const WA_FREE_QUOTA = 1000;
const WAQUOTA_FILE = path.join(DATA_DIR, "waquota_db.json");
interface WaQuotaStore { usage: Record<string, Record<string, number>>; sticky: Record<string, string> }
let waQuotaCache: WaQuotaStore | null = null;
function waQuota(): WaQuotaStore {
  if (!waQuotaCache) {
    const d = readJsonSafe<unknown>(WAQUOTA_FILE, null, "waquota_db.json");
    waQuotaCache = (d && typeof d === "object" ? d : { usage: {}, sticky: {} }) as WaQuotaStore;
    if (!waQuotaCache.usage) waQuotaCache.usage = {};
    if (!waQuotaCache.sticky) waQuotaCache.sticky = {};
  }
  return waQuotaCache;
}
function waQuotaSave(): void {
  const q = waQuotaCache;
  if (!q) return;
  const months = Object.keys(q.usage).sort();
  while (months.length > 3) delete q.usage[months.shift() as string];
  writeJsonAtomic(WAQUOTA_FILE, q, "waquota_db.json");
}
function waMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
interface WaNumber { id: string; label: string }
let waNumbersCache: WaNumber[] | null = null;
function waNumbers(): WaNumber[] {
  if (!waNumbersCache) {
    try {
      const raw = JSON.parse(process.env.WA_NUMBERS_JSON || "[]");
      const list = (Array.isArray(raw) ? raw : []).filter((x: any) => x && String(x.id || "").trim());
      if (list.length > 0) {
        waNumbersCache = list.map((x: any, i: number) => ({ id: String(x.id).trim(), label: String(x.label || `WA-${i + 1}`).trim() }));
      }
    } catch { /* abaikan, fallback di bawah */ }
    if (!waNumbersCache) {
      const { phoneId } = waOutboundConfig();
      waNumbersCache = phoneId ? [{ id: phoneId, label: "Utama" }] : [];
    }
  }
  return waNumbersCache;
}
function waUsage(phoneId: string): number {
  return waQuota().usage[waMonth()]?.[phoneId] || 0;
}
function waNoteInbound(userPhone: string, receivingPhoneId: string): void {
  const ids = waNumbers().map((n) => n.id);
  if (!ids.includes(receivingPhoneId)) return;
  const key = normalizePhone(userPhone);
  if (!key) return;
  const q = waQuota();
  if (q.sticky[key] !== receivingPhoneId) {
    q.sticky[key] = receivingPhoneId;
    waQuotaSave();
  }
}
function waPickNumber(userPhone?: string): string {
  const nums = waNumbers();
  if (nums.length === 0) return "";
  const ids = nums.map((n) => n.id);
  if (userPhone) {
    const stick = waQuota().sticky[normalizePhone(userPhone)];
    if (stick && ids.includes(stick)) return stick;
  }
  const withFree = nums.filter((n) => waUsage(n.id) < WA_FREE_QUOTA);
  const pool = withFree.length > 0 ? withFree : nums;
  let best = pool[0];
  for (const n of pool) {
    if (waUsage(n.id) < waUsage(best.id)) best = n;
  }
  if (userPhone && normalizePhone(userPhone)) {
    waQuota().sticky[normalizePhone(userPhone)] = best.id;
    waQuotaSave();
  }
  return best.id;
}
function waCountSend(phoneId: string): void {
  const q = waQuota();
  const m = waMonth();
  q.usage[m] = q.usage[m] || {};
  q.usage[m][phoneId] = (q.usage[m][phoneId] || 0) + 1;
  waQuotaSave();
}
// 08xx/+62 campur → 62xxxxxxxxxx (format `to` Meta).
function toWaNumber(phone?: string): string {
  let p = String(phone || "").replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  else if (/^8[0-9]{8,12}$/.test(p)) p = "62" + p;
  return p;
}
type WaSendResult = { to: string; ok: boolean; messageId?: string; errorCode?: number; error?: string };
async function waPostGraph(path: string, payload: Record<string, unknown>, timeoutMs = 8000): Promise<{ ok: boolean; json: any; status: number }> {
  const { token } = waOutboundConfig();
  const __via = String((payload as any)?.__via || "");
  const __to = String((payload as any)?.to || "");
  const __ids = waNumbers().map((n) => n.id);
  let phoneId: string;
  if (__via && __ids.includes(__via)) {
    phoneId = __via;
    if (__to) waNoteInbound(__to, __via);
  } else {
    phoneId = waPickNumber(__to || undefined);
    if (!phoneId) phoneId = waOutboundConfig().phoneId || "";
  }
  if (!token || !phoneId) return { ok: false, json: null, status: 0 };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://graph.facebook.com/${WA_GRAPH_VERSION}/${phoneId}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(({ messaging_product: "whatsapp", ...payload, __via: undefined })),
      signal: ctl.signal,
    });
    const json: any = await r.json().catch(() => null);
    if (r.ok) waCountSend(phoneId);
    return { ok: r.ok, json, status: r.status };
  } finally {
    clearTimeout(t);
  }
}
function waResult(to: string, r: { ok: boolean; json: any; status: number }): WaSendResult {
  if (r.status === 0) return { to, ok: false, error: "WHATSAPP_ACCESS_TOKEN belum dikonfigurasi" };
  if (!r.ok) {
    return {
      to, ok: false,
      errorCode: Number(r.json?.error?.code) || undefined,
      error: String(r.json?.error?.message || `HTTP ${r.status}`).slice(0, 200),
    };
  }
  return { to, ok: true, messageId: String(r.json?.messages?.[0]?.id || "") };
}
// Teks biasa: hanya terkirim bila jendela layanan 24 jam penerima terbuka
// (di luar itu Meta menolak 131047 — pakai template).
async function sendWaText(toRaw: string, body: string): Promise<WaSendResult> {
  const to = toWaNumber(toRaw);
  if (!/^62[0-9]{8,13}$/.test(to)) return { to, ok: false, error: "nomor tujuan tidak valid" };
  try {
    const r = await waPostGraph("/messages", {
      to, type: "text", text: { body: String(body).slice(0, 4000), preview_url: false },
    });
    return waResult(to, r);
  } catch (err: any) {
    return { to, ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}
// Template tersetujui: terkirim kapan pun (inisiasi bisnis). bodyParams = {{1}}, {{2}}, ...
// Template statis (tanpa variabel) = components dihilangkan.
async function sendWaTemplate(toRaw: string, templateName: string, langCode: string, bodyParams: string[]): Promise<WaSendResult> {
  const to = toWaNumber(toRaw);
  if (!/^62[0-9]{8,13}$/.test(to)) return { to, ok: false, error: "nomor tujuan tidak valid" };
  try {
    const tpl: Record<string, unknown> = { name: templateName, language: { code: langCode || "id" } };
    if (bodyParams.length > 0) {
      tpl.components = [{ type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: String(p).slice(0, 1024) })) }];
    }
    const r = await waPostGraph("/messages", { to, type: "template", template: tpl });
    return waResult(to, r);
  } catch (err: any) {
    return { to, ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}
// Pembuka jendela 24 jam: template statis (lolos review tanpa variabel).
const WA_OPENER_TEMPLATE = "info_terbaru_taniai";
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function broadcastWaText(targets: { nama: string; noHp: string }[], body: string): Promise<{
  attempted: number; sent: number; failed: { nama: string; to: string; errorCode?: number; error?: string }[];
}> {
  const out = { attempted: targets.length, sent: 0, failed: [] as { nama: string; to: string; errorCode?: number; error?: string }[] };
  for (const t of targets) {
    const r = await sendWaText(t.noHp, body);
    if (r.ok) {
      out.sent++;
    } else {
      out.failed.push({ nama: t.nama, to: r.to, errorCode: r.errorCode, error: r.error });
    }
    console.log(`[WA bcast] ${r.ok ? "OK" : "GAGAL"} ${t.nama} (${r.to})${r.ok ? "" : " " + (r.errorCode || "") + " " + (r.error || "")}`);
    await sleepMs(400);
  }
  return out;
}
async function broadcastWaTemplate(targets: { nama: string; noHp: string }[], templateName: string, langCode: string, params: string[]): Promise<{
  attempted: number; sent: number; failed: { nama: string; to: string; errorCode?: number; error?: string }[];
}> {
  const out = { attempted: targets.length, sent: 0, failed: [] as { nama: string; to: string; errorCode?: number; error?: string }[] };
  for (const t of targets) {
    const r = await sendWaTemplate(t.noHp, templateName, langCode, params);
    if (r.ok) {
      out.sent++;
    } else {
      out.failed.push({ nama: t.nama, to: r.to, errorCode: r.errorCode, error: r.error });
    }
    console.log(`[WA tpl] ${r.ok ? "OK" : "GAGAL"} ${t.nama} (${r.to})${r.ok ? "" : " " + (r.errorCode || "") + " " + (r.error || "")}`);
    await sleepMs(400);
  }
  return out;
}

// Notifikasi order baru ke petani (OFR-047: Annisa->Joji tanpa kabar). Proaktif,
// 1x per (offer, farmer). Dalam jendela 24 jam Meta -> teks bebas; di luar itu
// -> template opener (teks bebas ditolak 131047), detail menyusul saat petani
// chat (digest nudge). DISABLE_WA_OUTBOUND=true: tanpa HTTP, cabang + dedupe
// tetap dihitung agar teruji gate.
async function notifyFarmersNewOrder(o: Offer): Promise<void> {
  if (!o || o.status === "DEAL" || o.status === "BATAL") return;
  const dry = process.env.DISABLE_WA_OUTBOUND === "true";
  const { token } = waOutboundConfig();
  if (!dry && !token) { console.log(`[Notify] ${o.id}: tanpa token, lewati`); return; }
  const sent = new Set(o.notifiedFarmerIds || []);
  let changed = false;
  for (const l of o.lines) {
    if (Number(l.hargaPetaniPerKg) || sent.has(l.farmerId)) continue;
    const f = farmersDb.find((x) => x.id === l.farmerId);
    if (!f || !f.noHp) continue;
    const u = usersDb.find((x) => normalizePhone(x.phone) === normalizePhone(f.noHp));
    if (u && u.status === "BLOCKED") continue;
    const lastIn = u && u.lastInboundAt ? Date.parse(u.lastInboundAt) : 0;
    const inWindow = !!lastIn && Date.now() - lastIn < 24 * 3600e3;
    const body = `Pesanan baru ${o.id}: buyer butuh ${o.komoditas} ${fmtKg(Number(o.qtyKg) || 0)}${Number(o.budgetPerKg) ? ` (budget ${fmtRp(Number(o.budgetPerKg))}/kg)` : ""}.${o.spesifikasi ? `\nSpek: ${o.spesifikasi}.` : ""}\nStok Anda tercatat ${fmtKg(Number(l.stokKg) || 0)} — balas harga jual, mis. "jual ${o.komoditas} 8000".`;
    try {
      if (dry) {
        emitCanonicalEvent({ source: "wa-chat", entity: "offer", entityId: o.id, action: "notify", actor: "system", payload: { farmerId: l.farmerId, channel: inWindow ? "text" : "template", dry: true } });
      } else if (inWindow) {
        const r = await sendWaText(f.noHp, body);
        console.log(`[Notify] ${o.id} -> ${l.farmerId} ${r.ok ? "TERKIRIM" : "GAGAL " + (r.error || "")}`);
        if (!r.ok) continue;
        emitCanonicalEvent({ source: "wa-chat", entity: "offer", entityId: o.id, action: "notify", actor: "system", payload: { farmerId: l.farmerId, channel: "text" } });
      } else {
        const r = await sendWaTemplate(f.noHp, WA_OPENER_TEMPLATE, "id", []);
        console.log(`[Notify] ${o.id} -> ${l.farmerId} opener ${r.ok ? "TERKIRIM" : "GAGAL " + (r.error || "")}`);
        if (!r.ok) continue;
        emitCanonicalEvent({ source: "wa-chat", entity: "offer", entityId: o.id, action: "notify", actor: "system", payload: { farmerId: l.farmerId, channel: "template" } });
      }
      sent.add(l.farmerId); changed = true;
    } catch (e: any) { console.log(`[Notify] ${o.id} -> ${l.farmerId} EXC ${String((e && e.message) || e).slice(0, 120)}`); }
  }
  if (changed) { o.notifiedFarmerIds = [...sent]; o.updatedAt = new Date().toISOString(); saveOffersToDisk(); }
}

// Universal Entity Extractor from conversation text / voice note
function extractFarmerFromText(text: string, currentDraft: Partial<FarmerRecord> = {}): {
  extracted: Partial<FarmerRecord>;
  hasMinimumData: boolean;
} {
  const lower = (text || "").toLowerCase();
  const ext: Partial<FarmerRecord> = { ...currentDraft };

  // 1. Nama Petani
  const nameMatch =
    text.match(/(?:nama\s*(?:saya|petani)?\s*(?:adalah|:)?\s*|petani\s+|pak\s+|bu\s+|bapak\s+|ibu\s+)([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)*)/i) ||
    text.match(/(?:nama\s*:\s*)([A-Za-z \t]+?)(?:,|\.|\n|$)/i);
  if (nameMatch && nameMatch[1] && nameMatch[1].trim().length > 2) {
    let raw = nameMatch[1].trim().replace(/^(?:bernama|nama)\s+/i, "").replace(/^[:\-,\s]+/, "").trim();
    // Ujaran lisan ("nama lengkap petani Jeremy", "petani yang bernama X"):
    // buang kata pengisi di depan nama sampai titik-tetap.
    for (let i = 0; i < 5; i++) {
      const next = raw.replace(/^(?:lengkap|petani|tani|saya|yang|adalah|ini|itu|tersebut|bernama|nama)\s+/i, "").trim();
      if (next === raw) break;
      raw = next;
    }
    const NAME_STOP = new Set(["komoditas", "luas", "lahan", "lokasi", "desa", "kelurahan", "kecamatan", "kabupaten", "kota", "alamat", "wilayah", "hp", "wa", "telepon", "telp", "no", "varietas", "benih", "bibit", "panen", "ton", "kuintal", "hektar", "hektare", "meter"]);
    const nameWords: string[] = [];
    for (const w of raw.split(/\s+/)) {
      if (NAME_STOP.has(w.toLowerCase().replace(/[^a-z]/g, ""))) break;
      nameWords.push(w);
    }
    raw = nameWords.join(" ").trim();
    if (raw.length > 2 && !["saya", "yang", "petani", "tani", "mitra", "baru", "lahan", "data", "semua", "rekap"].includes(raw.toLowerCase())) {
      const lowerRaw = raw.toLowerCase();
      if (lowerRaw.startsWith("pak ") || lowerRaw.startsWith("bapak ")) {
        const cleanName = raw.replace(/^(?:pak|bapak)\s+/i, "").trim();
        ext.nama = `Pak ${cleanName}`;
      } else if (lowerRaw.startsWith("bu ") || lowerRaw.startsWith("ibu ")) {
        const cleanName = raw.replace(/^(?:bu|ibu)\s+/i, "").trim();
        ext.nama = `Bu ${cleanName}`;
      } else {
        ext.nama = `Pak ${raw}`;
      }
    }
  }

  // 2. Komoditas
  if (lower.includes("cabai") || lower.includes("cabe")) {
    ext.komoditas = lower.includes("keriting") ? "Cabai Merah Keriting" : "Cabai Rawit Merah";
  } else if (lower.includes("bawang")) {
    ext.komoditas = "Bawang Merah";
  } else if (lower.includes("jagung")) {
    ext.komoditas = "Jagung";
  } else if (lower.includes("padi") || lower.includes("beras")) {
    ext.komoditas = "Padi";
  } else if (lower.includes("kedelai")) {
    ext.komoditas = "Kedelai";
  } else if (lower.includes("tomat")) {
    ext.komoditas = "Tomat";
  } else if (lower.includes("kentang")) {
    ext.komoditas = "Kentang";
  } else if (lower.includes("apel")) {
    ext.komoditas = "Apel";
  } else if (lower.includes("melon") || lower.includes("semangka")) {
    ext.komoditas = "Melon";
  } else if (lower.includes("kopi")) {
    ext.komoditas = "Kopi";
  } else if (lower.includes("kakao") || lower.includes("coklat")) {
    ext.komoditas = "Kakao";
  } else if (lower.includes("tebu")) {
    ext.komoditas = "Tebu";
  } else if (lower.includes("kelapa") || lower.includes("kopra")) {
    ext.komoditas = "Kelapa";
  } else if (lower.includes("sagu")) {
    ext.komoditas = "Sagu";
  }
  if (!ext.komoditas) {
    const komMatch = text.match(/komoditas(?:\s+tanaman)?\s*:?\s*([A-Za-z][A-Za-z \t]*?)(?:,|\.|\n|$)/i);
    if (komMatch && komMatch[1]) {
      const cand = komMatch[1].trim().replace(/\s+/g, " ");
      if (cand.length >= 3 && !/^(tanaman|utama|tani|belum|tidak|ada|yang|dan)$/i.test(cand)) {
        ext.komoditas = cand.charAt(0).toUpperCase() + cand.slice(1).toLowerCase();
      }
    }
  }

  // 3. Luas Lahan
  const areaMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(ha|hektar(?:e)?|m2|m²|meter\s*persegi|bahu|ubin|m(?:eter)?s?)\b/i);
  if (areaMatch && areaMatch[1]) {
    const rawNum = areaMatch[1];
    let num: number;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(rawNum)) num = parseFloat(rawNum.replace(/\./g, "").replace(",", "."));
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(rawNum)) num = parseFloat(rawNum.replace(/,/g, ""));
    else num = parseFloat(rawNum.replace(",", "."));
    const unit = (areaMatch[2] || "").toLowerCase();
    if (/^m/.test(unit)) {
      num = Number((num / 10000).toFixed(2));
    } else if (unit === "bahu") {
      num = Number((num * 0.7).toFixed(2));
    } else if (unit === "ubin") {
      num = Number(((num * 14) / 10000).toFixed(2));
    }
    ext.luasLahan = num;
    ext.luasLahanFormatted = `${num} Ha (${(num * 10000).toLocaleString("id-ID")} m²)`;
  }

  // 4. Nomor HP / WhatsApp
  const phoneMatch = text.match(/(?:\+62|62|08)[0-9\s-]{8,14}/);
  if (phoneMatch) {
    ext.noHp = phoneMatch[0].trim();
  }

  // 5. Lokasi / Alamat / Kabupaten
  const knownCities = [
    "Karawang", "Subang", "Garut", "Kediri", "Brebes", "Magetan", "Indramayu", "Cianjur", "Majalengka",
    "Boyolali", "Ngawi", "Nganjuk", "Banyuwangi", "Malang", "Klaten", "Sragen", "Temanggung", "Wonosobo",
    "Bandung", "Bogor", "Sukabumi", "Cirebon", "Sumedang", "Purwakarta", "Tasikmalaya", "Ciamis", "Kuningan",
    "Batu", "Blitar", "Madiun", "Pasuruan", "Probolinggo", "Jember", "Mojokerto", "Jombang", "Tuban", "Bojonegoro"
  ];
  for (const city of knownCities) {
    if (lower.includes(city.toLowerCase())) {
      ext.kabupaten = city;
      ext.alamat = ext.alamat && !ext.alamat.includes("Sentra Tani") ? ext.alamat : `Desa Binaan, ${city}`;
      break;
    }
  }
  const desaMatch = text.match(/(?:desa|kelurahan|kecamatan)\s+([A-Za-z]+)/i);
  if (desaMatch && desaMatch[1]) {
    ext.alamat = `Desa ${desaMatch[1]}${ext.kabupaten ? `, ${ext.kabupaten}` : ""}`;
  }
  const diMatch = text.match(/(?:\bdi\s+|\blokasi\s+|\bwilayah\s+|\bkabupaten\s+|\bkab\.?\s+)([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
  if (diMatch && diMatch[1] && !ext.kabupaten) {
    const candidate = diMatch[1].trim().replace(/^(desa|kelurahan|kecamatan)\s+/i, "")
      .split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    if (candidate.length >= 3 && !["sawah", "lahan", "kebun", "desa", "sini", "sana", "dinas", "google", "sheets", "database", "rumah", "ladang", "pasar", "kios", "toko", "kantor", "jalan", "masjid", "komunitas", "kelompok", "indonesia", "tani", "petani"].includes(candidate.toLowerCase())) {
      ext.kabupaten = candidate;
      if (!ext.alamat) ext.alamat = `Desa Binaan, ${candidate}`;
    }
  }

  // 6. Varietas
  const varMatch = text.match(/(?:varietas|benih|bibit)\s+([A-Za-z0-9\s-]+?)(?:,|\.|\n|$)/i);
  // ANTI-KARANGAN: varietas hanya dari ucapan eksplisit ("varietas/benih/bibit X").
  if (varMatch && varMatch[1]) {
    ext.varietas = varMatch[1].trim();
  }

  // 7. Estimasi Panen (bulan eksplisit ATAU relatif "bulan/minggu/tahun depan").
  const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  for (const m of months) {
    if (lower.includes(m.toLowerCase())) {
      const yearMatch = text.match(/202[6-9]/);
      ext.estimasiPanen = `${m} ${yearMatch ? yearMatch[0] : "2026"}`;
      break;
    }
  }
  if (!ext.estimasiPanen) {
    const now = new Date();
    if (/bulan depan/i.test(text)) {
      const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      ext.estimasiPanen = `${months[d.getMonth()]} ${d.getFullYear()}`;
    } else if (/bulan ini/i.test(text)) {
      ext.estimasiPanen = `${months[now.getMonth()]} ${now.getFullYear()}`;
    } else if (/minggu depan/i.test(text)) {
      const d = new Date(now.getTime() + 7 * 864e5);
      ext.estimasiPanen = `${months[d.getMonth()]} ${d.getFullYear()}`;
    } else if (/tahun depan/i.test(text)) {
      ext.estimasiPanen = `${now.getFullYear() + 1}`;
    }
  }

  // 8. Estimasi Hasil Ton — ANTI-KARANGAN (aturan user): hanya dari angka
  // eksplisit user ("5 ton"/"50 kuintal"); hitung luas×mult DIHAPUS.
  const tonMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(ton|kuintal|kwintal|kg)\b/i);
  if (tonMatch && tonMatch[1]) {
    let t = parseFloat(tonMatch[1].replace(",", "."));
    const unit = (tonMatch[2] || "").toLowerCase();
    if (unit.startsWith("ku") || unit.startsWith("kw")) t = Number((t / 10).toFixed(1));
    else if (unit === "kg") t = Number((t / 1000).toFixed(2));
    ext.estimasiHasilTon = t;
  }

  // 1b. Nama telanjang susulan: baris pertama 1-3 kata kapital ("Annisa")
  // diterima sebagai nama HANYA bila draf sudah berisi data non-nama dan nama
  // masih kosong. Tanpa syarat draf, sapaan ("Gimana") ikut tersedot.
  if (!ext.nama) {
    const d = currentDraft || {};
    const draftHasNonName = !!(d.komoditas || d.luasLahan || d.kabupaten || d.alamat || d.noHp);
    if (draftHasNonName) {
      const firstLine = String(text || "").split(/\n/)[0].trim();
      const mBare = firstLine.match(/^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})$/);
      if (mBare) {
        const words = mBare[1].toLowerCase().split(/\s+/);
        const BARE_STOP = new Set(["halo", "hai", "hi", "makasih", "terima", "kasih", "tolong", "bantu", "ya", "iya", "tidak", "batal", "udah", "sudah", "belum", "cek", "harga", "pasar", "berapa", "daftar", "tambah", "kirim", "oke", "ok", "siap", "ini", "itu", "ada", "apa", "siapa", "bagaimana", "gimana", "kabar", "baik", "pagi", "siang", "sore", "malam", "cabai", "cabe", "bawang", "jagung", "padi", "beras", "kedelai", "tomat", "kentang", "apel", "melon", "kopi", "kakao", "tebu", "kelapa", "sagu", "desa", "kabupaten", "kota", "lokasi", "alamat", "hektar", "meter"]);
        if (!words.some((w) => BARE_STOP.has(w)) && !/\d/.test(firstLine)) {
          ext.nama = `Pak ${mBare[1].trim()}`;
        }
      }
    }
  }

  const hasMinimumData = !!(ext.nama || ext.komoditas || ext.luasLahan || ext.kabupaten);
  return { extracted: ext, hasMinimumData };
}

// Strict Data Completeness Validator: Requires Nama, Komoditas, Luas Lahan, and Lokasi
function checkFarmerCompleteness(record: Partial<FarmerRecord>): {
  isComplete: boolean;
  missingFields: string[];
  presentFields: string[];
} {
  const missing: string[] = [];
  const present: string[] = [];

  // 1. Nama Petani (must not be generic placeholders)
  const hasValidName =
    !!record.nama &&
    record.nama.trim().length >= 2 &&
    !["Pak", "Bu", "Bapak", "Ibu", "Petani", "Petani Terdaftar", "Mitra Tani", "Pak Petani", "Pak Mitra Tani"].includes(
      record.nama.trim()
    );
  if (hasValidName) {
    present.push(`Nama Petani: *${record.nama}*`);
  } else {
    missing.push("Nama Lengkap Petani");
  }

  // 2. Komoditas Tanaman
  const hasValidCrop = !!record.komoditas && record.komoditas.trim().length >= 2;
  if (hasValidCrop) {
    present.push(`Komoditas: *${record.komoditas}*${record.varietas ? ` (${record.varietas})` : ""}`);
  } else {
    missing.push("Komoditas Tanaman (misal: Padi, Cabai, Jagung, Bawang)");
  }

  // 3. Luas Lahan
  const hasValidArea = !!record.luasLahan && Number(record.luasLahan) > 0;
  if (hasValidArea) {
    present.push(`Luas Lahan: *${record.luasLahanFormatted || `${record.luasLahan} Ha`}*`);
  } else {
    missing.push("Luas Lahan (misal: 1.5 Ha atau 5.000 m²)");
  }

  // 4. Lokasi / Wilayah
  const hasValidLocation =
    (!!record.kabupaten && record.kabupaten.trim().length >= 3 && !record.kabupaten.includes("Sentra Tani")) ||
    (!!record.alamat && record.alamat.trim().length >= 3 && !record.alamat.includes("Sentra Tani"));
  if (hasValidLocation) {
    const loc = [record.alamat, record.kabupaten].filter(Boolean).join(", ");
    present.push(`Lokasi: *${loc}*`);
  } else {
    missing.push("Lokasi Wilayah (Desa atau Kabupaten)");
  }

  return {
    isComplete: missing.length === 0,
    missingFields: missing,
    presentFields: present,
  };
}

// Generate friendly conversational response asking the user to complete missing fields
function formatIncompleteFarmerPrompt(
  draft: Partial<FarmerRecord>,
  recipientName?: string,
  isAdmin: boolean = false
): {
  reply: string;
  quickReplies: string[];
  extracted: Partial<FarmerRecord>;
  isComplete: boolean;
} {
  const check = checkFarmerCompleteness(draft);

  const checklist = [
    `• Nama Petani: ${draft.nama ? `✅ *${draft.nama}*` : "❌ _Belum diisi_"}`,
    `• Komoditas: ${draft.komoditas ? `✅ *${draft.komoditas}*` : "❌ _Belum diisi_"}`,
    `• Luas Lahan: ${draft.luasLahan && Number(draft.luasLahan) > 0 ? `✅ *${draft.luasLahanFormatted || `${draft.luasLahan} Ha`}*` : "❌ _Belum diisi_"}`,
    `• Lokasi/Kabupaten: ${draft.kabupaten || draft.alamat ? `✅ *${draft.kabupaten || draft.alamat}*` : "❌ _Belum diisi_"}`,
  ].join("\n");

  // Gerbang-no-HP admin: daftar kosong bukan berarti lengkap — sebutkan No HP.
  const missingList = check.missingFields.length > 0
    ? check.missingFields.map((m, idx) => `${idx + 1}. *${m}*`).join("\n")
    : (isAdmin ? `1. *No HP/WA petani* (wajib agar bisa disimpan)` : "");
  const salutation = isAdmin && recipientName ? `Bpk/Ibu *${recipientName}*` : `Bapak/Ibu`;

  const reply =
    `📝 *Draf Data Petani Dicatat (Data Belum Lengkap)*\n\n` +
    `Terima kasih ${salutation}. Data sementara telah kami simpan di draf percakapan, namun *belum dimasukkan ke database* karena data belum lengkap:\n\n` +
    `${checklist}\n\n` +
    `⚠️ *Data yang masih harus dilengkapi:*\n${missingList}\n\n` +
    `💡 *Silakan ketik data kelanjutannya* (contoh: ketik nama, komoditas, luas lahan, atau kabupaten). Begitu seluruh data pokok di atas lengkap, sistem akan langsung memverifikasi dan menyimpannya ke database secara otomatis.`;

  const quickReplies: string[] = [];
  if (!draft.komoditas) quickReplies.push("Komoditas Cabai Rawit", "Komoditas Jagung Hibrida");
  if (!draft.luasLahan || Number(draft.luasLahan) <= 0) quickReplies.push("Luas Lahan 1.5 Ha", "Luas Lahan 5.000 m²");
  if (!draft.kabupaten && !draft.alamat) quickReplies.push("Lokasi di Kab. Subang", "Lokasi di Karawang");
  if (!draft.nama) quickReplies.push("Nama Petani: Pak Suparman");

  return {
    reply,
    quickReplies: quickReplies.slice(0, 4),
    extracted: draft,
    isComplete: false,
  };
}

// D2 dedupe: cari existing by noHp ternormalisasi.
// Kunci = draft.noHp; senderPhone hanya dipakai bila pendaftar BUKAN admin
// (di jalur admin senderPhone = nomor admin, bukan identitas petani).
// Nomor placeholder dan string pendek (< 10 digit) ditolak agar tak meniban.
function findDuplicateFarmerByPhone(
  draft: Partial<FarmerRecord>,
  activeAdmin?: AdminUser,
  senderPhone?: string
): FarmerRecord | undefined {
  const rawKey = draft.noHp || (!activeAdmin ? senderPhone : "") || "";
  const normKey = normalizePhone(rawKey);
  if (normKey.length < 10) return undefined;
  return farmersDb.find((f) => normalizePhone(f.noHp) === normKey);
}
// Aturan user: nama sama + nomor beda = orang beda (simpan baru); nomor sama
// = TANYA dulu (Ya/Tidak), jangan timpa diam-diam. Dipakai gerbang pra-simpan.
function formatDuplicateAskPrompt(existing: FarmerRecord, draft: Partial<FarmerRecord>): string {
  const fmt = (f: any) => `*${f.nama || "-"}* — ${f.komoditas || "-"}, ${f.luasLahanFormatted || (f.luasLahan ? `${f.luasLahan} Ha` : "-")}, ${f.kabupaten || f.alamat || "-"}`;
  return (
    `⚠️ *Nomor WA ini sudah terdaftar!*\n\n` +
    `• Terdaftar: ${fmt(existing)} (${existing.id})\n` +
    `• Data baru: ${fmt(draft)}\n\n` +
    `Apakah ingin *MEMPERBARUI* data lama dengan data baru?\n` +
    `Balas *Ya* untuk update, atau *Tidak* untuk membatalkan.\n` +
    `_Bila ini orang berbeda, daftarkan dengan nomor HP/WA yang berbeda._`
  );
}
// ---- ShareLoc WA (pesan location Meta Cloud API) ----
// Format Meta: msg.type === "location", koordinat di msg.location.latitude /
// msg.location.longitude (+ msg.location.name / .address opsional).
// Definisi tunggal: validasi + URL Maps + tulis ke draf/record petani.
function isValidWaCoords(lat: unknown, lng: unknown): boolean {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return false;
  if (la === 0 && ln === 0) return false; // Null Island = bukan lokasi nyata
  return true;
}
function waLocationMapsUrl(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}
// Bbox kasar Indonesia; di luar ini diterima tapi ditandai lemah (minta konfirmasi desa).
function isIndonesiaCoords(lat: number, lng: number): boolean {
  return Number(lat) >= -11 && Number(lat) <= 6 && Number(lng) >= 95 && Number(lng) <= 141;
}
// Tulis koordinat ShareLoc: petani terdaftar -> update record; tamu/belum
// terdaftar -> simpan ke draf WA agar terbawa saat pendaftaran lengkap.
function applyWaLocationToFarmer(
  senderPhone: string | undefined,
  loc: { latitude: number; longitude: number; name?: string; address?: string },
  source?: string,
): { farmerId?: string; updated: boolean; mapsUrl: string; weak: boolean; label: string } {
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  const mapsUrl = waLocationMapsUrl(lat, lng);
  const weak = !isIndonesiaCoords(lat, lng);
  const label = [loc.name, loc.address].filter((s) => String(s || "").trim()).join(", ").slice(0, 200);
  const normKey = normalizePhone(senderPhone);
  const hit = normKey.length >= 10
    ? farmersDb.find((f) => normalizePhone(f.noHp) === normKey)
    : undefined;
  if (hit) {
    hit.latitude = Number(lat.toFixed(6));
    hit.longitude = Number(lng.toFixed(6));
    if (label && (!hit.alamat || hit.alamat === "Belum diketahui" || hit.alamat.includes("Sentra Tani"))) {
      hit.alamat = label;
    }
    hit.syncStatus = "synced";
    saveFarmersToDisk();
    bumpDataVersion();
    emitCanonicalEvent({
      source: source || "wa-location", entity: "farmer", entityId: hit.id,
      action: "loc_update", actor: senderPhone,
      payload: { latitude: hit.latitude, longitude: hit.longitude, mapsUrl, label: label || undefined, weak },
    });
    return { farmerId: hit.id, updated: true, mapsUrl, weak, label };
  }
  if (senderPhone) {
    let d = waDrafts.get(senderPhone);
    if (!d || Date.now() - d.updatedAt > WA_DRAFT_TTL_MS) {
      d = { ...blankWaDraft(), updatedAt: 0 };
    }
    d.farmer = {
      ...cleanStoredDraft(d.farmer),
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lng.toFixed(6)),
      ...(label && !d.farmer?.alamat ? { alamat: label } : {}),
    };
    d.updatedAt = Date.now();
    waDrafts.delete(senderPhone);
    waDrafts.set(senderPhone, d);
    while (waDrafts.size > 500) {
      const oldest = waDrafts.keys().next().value;
      if (oldest === undefined) break;
      waDrafts.delete(oldest);
    }
  }
  emitCanonicalEvent({
    source: source || "wa-location", entity: "farmer", entityId: normKey ? `draft-${hashPhone(senderPhone).slice(0, 12)}` : "draft-unknown",
    action: "loc_draft", actor: senderPhone,
    payload: { latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)), mapsUrl, label: label || undefined, weak },
  });
  return { farmerId: undefined, updated: false, mapsUrl, weak, label };
}
// Persist complete record into farmersDb
function saveFarmerRecord(
  draft: Partial<FarmerRecord>,
  activeAdmin?: AdminUser,
  senderPhone?: string,
  source?: string,
): FarmerRecord {
  // D2 dedupe: cari existing by noHp ternormalisasi → update-in-place, bukan insert.
  // Kunci = draft.noHp; senderPhone hanya dipakai bila pendaftar BUKAN admin
  // (di jalur admin senderPhone = nomor admin, bukan identitas petani).
  // Nomor placeholder ("+62 812-xxxx-xxxx" → "0812") dan string pendek (< 10 digit)
  // ditolak agar tidak saling meniban.
  {
    const existing = findDuplicateFarmerByPhone(draft, activeAdmin, senderPhone);
    if (existing) {
      existing.nama = draft.nama || existing.nama;
      if (draft.noHp) existing.noHp = draft.noHp;
      existing.alamat = draft.alamat || existing.alamat;
      existing.kabupaten = draft.kabupaten || existing.kabupaten;
      if (draft.luasLahan && Number(draft.luasLahan) > 0) {
        existing.luasLahan = Number(draft.luasLahan);
        existing.luasLahanFormatted = draft.luasLahanFormatted || `${draft.luasLahan} Ha`;
      }
      const prevKomoditas = String(existing.komoditas || "").trim().toLowerCase();
      existing.komoditas = draft.komoditas || existing.komoditas;
      existing.varietas = draft.varietas || existing.varietas;
      existing.estimasiPanen = draft.estimasiPanen || existing.estimasiPanen;
      // ANTI-KARANGAN: tonase update hanya dari angka user; hitung luas×6 DIHAPUS.
      if (draft.estimasiHasilTon && Number(draft.estimasiHasilTon) > 0) {
        existing.estimasiHasilTon = Number(draft.estimasiHasilTon);
      }
      // ShareLoc: koordinat riil dari draf (validasi rentang Meta) menimpa tebakan.
      if (isValidWaCoords((draft as any).latitude, (draft as any).longitude)) {
        existing.latitude = Number(Number((draft as any).latitude).toFixed(6));
        existing.longitude = Number(Number((draft as any).longitude).toFixed(6));
      }
      if (activeAdmin) existing.statusVerifikasi = "Terverifikasi";
      existing.syncStatus = "synced";
      // F2: komoditas BERBEDA -> baris KMD baru; SAMA -> perkaya baris AKTIF.
      {
        const newKom = String(draft.komoditas || "").trim();
        if (newKom && newKom.toLowerCase() !== prevKomoditas) {
          appendCommodity(existing.id, {
            komoditas: newKom, varietas: draft.varietas,
            luasHa: Number(draft.luasLahan) || undefined, estimasiPanen: draft.estimasiPanen,
            estimasiHasilTon: Number(draft.estimasiHasilTon) || undefined,
          }, source);
        } else {
          enrichLatestCommodity(existing.id, {
            varietas: draft.varietas, luasHa: Number(draft.luasLahan) || undefined,
            estimasiPanen: draft.estimasiPanen, estimasiHasilTon: Number(draft.estimasiHasilTon) || undefined,
          }, source);
        }
      }
      saveFarmersToDisk();
      bumpDataVersion();
      emitCanonicalEvent({
        source: source || "wa-chat", entity: "farmer", entityId: existing.id,
        action: "update", actor: senderPhone,
        payload: { nama: existing.nama, komoditas: existing.komoditas, luasLahan: existing.luasLahan, kabupaten: existing.kabupaten, statusVerifikasi: existing.statusVerifikasi },
      });
      return existing;
    }
  }
  const newRecord: FarmerRecord = {
    id: nextId("TANI", farmersDb.map((f) => f.id)),
    timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
    nama: draft.nama || "Petani Mitra",
    noHp: draft.noHp || senderPhone || "",
    // ANTI-KARANGAN (aturan user): tak-diberi-user = kosong, bukan default palsu.
    alamat: draft.alamat || draft.kabupaten || "Belum diketahui",
    kabupaten: draft.kabupaten || "Belum diketahui",
    luasLahan: Number(draft.luasLahan) || 1.0,
    luasLahanFormatted: draft.luasLahanFormatted || `${draft.luasLahan || 1.0} Ha`,
    komoditas: draft.komoditas || "Padi",
    varietas: draft.varietas || "",
    estimasiPanen: draft.estimasiPanen || "",
    estimasiHasilTon: Number(draft.estimasiHasilTon) || 0,
    statusVerifikasi: activeAdmin ? "Terverifikasi" : "Menunggu Verifikasi",
    catatanAI: activeAdmin
      ? `Didata & divalidasi langsung oleh ${activeAdmin.nama} (${activeAdmin.role}) via WhatsApp pada ${new Date().toLocaleDateString("id-ID")}. Data lengkap tersimpan ke database.`
      : `Tercatat lengkap via WhatsApp Chatbot pada ${new Date().toLocaleDateString("id-ID")}. Data telah divalidasi dan tersimpan ke database.`,
    syncStatus: "synced",
    googleSheetRow: nextSheetRow(
      farmersDb.map((f) => f.googleSheetRow),
      farmersDb.length,
    ),
    // ShareLoc: bawa koordinat riil dari draf bila valid; selain itu kosong
    // (jangan tebak di sini — resolveCoordinates hanya untuk tampilan peta).
    ...(isValidWaCoords((draft as any).latitude, (draft as any).longitude)
      ? {
          latitude: Number(Number((draft as any).latitude).toFixed(6)),
          longitude: Number(Number((draft as any).longitude).toFixed(6)),
        }
      : {}),
  };
  farmersDb.unshift(newRecord);
  saveFarmersToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: source || "wa-chat", entity: "farmer", entityId: newRecord.id,
    action: "create", actor: senderPhone,
    payload: { nama: newRecord.nama, komoditas: newRecord.komoditas, luasLahan: newRecord.luasLahan, kabupaten: newRecord.kabupaten, statusVerifikasi: newRecord.statusVerifikasi },
  });
  appendCommodity(newRecord.id, {
    komoditas: newRecord.komoditas, varietas: newRecord.varietas,
    luasHa: Number(newRecord.luasLahan) || 0, estimasiPanen: newRecord.estimasiPanen,
    estimasiHasilTon: Number(newRecord.estimasiHasilTon) || 0,
  }, source);
  return newRecord;
}

// ============ F2: multi-komoditas append-only ============
// Aturan: komoditas BERBEDA -> baris KMD baru; komoditas SAMA -> perkaya baris
// AKTIF terbaru. Field legacy FarmerRecord.komoditas selalu = KMD AKTIF terbaru.
function latestCommodity(farmerId: string, onlyActive: boolean): FarmerCommodity | undefined {
  for (let i = komoditasDb.length - 1; i >= 0; i--) {
    const k = komoditasDb[i];
    if (k.farmerId !== farmerId) continue;
    if (onlyActive && k.status !== "AKTIF") continue;
    return k;
  }
  return undefined;
}
function appendCommodity(
  farmerId: string,
  d: { komoditas: string; varietas?: string; luasHa?: number; estimasiPanen?: string; estimasiHasilTon?: number; musimTanam?: string },
  source?: string,
): FarmerCommodity {
  const now = new Date().toISOString();
  const rec: FarmerCommodity = {
    id: nextId("KMD", komoditasDb.map((k) => k.id)),
    farmerId,
    komoditas: String(d.komoditas || "").trim(),
    varietas: d.varietas || "",
    luasHa: Number(d.luasHa) || 0,
    estimasiPanen: d.estimasiPanen || "",
    estimasiHasilTon: Number(d.estimasiHasilTon) || 0,
    musimTanam: d.musimTanam || "",
    status: "AKTIF",
    createdAt: now,
    updatedAt: now,
  };
  komoditasDb.push(rec);
  saveKomoditasToDisk();
  emitCanonicalEvent({
    source: source || "wa-chat", entity: "commodity", entityId: rec.id,
    action: "create", actor: "",
    payload: { farmerId, komoditas: rec.komoditas },
  });
  return rec;
}
function enrichLatestCommodity(
  farmerId: string,
  d: { varietas?: string; luasHa?: number; estimasiPanen?: string; estimasiHasilTon?: number; musimTanam?: string },
  source?: string,
): void {
  const lc = latestCommodity(farmerId, true) || latestCommodity(farmerId, false);
  if (!lc) return;
  if (d.varietas) lc.varietas = d.varietas;
  if (Number(d.luasHa) > 0) lc.luasHa = Number(d.luasHa);
  if (d.estimasiPanen) lc.estimasiPanen = d.estimasiPanen;
  if (Number(d.estimasiHasilTon) > 0) lc.estimasiHasilTon = Number(d.estimasiHasilTon);
  if (d.musimTanam) lc.musimTanam = d.musimTanam;
  lc.updatedAt = new Date().toISOString();
  saveKomoditasToDisk();
  emitCanonicalEvent({
    source: source || "wa-chat", entity: "commodity", entityId: lc.id,
    action: "update", actor: "",
    payload: { farmerId, komoditas: lc.komoditas },
  });
}
// Sinkronkan field legacy ke KMD AKTIF terbaru (bila tak ada AKTIF: biarkan).
function syncLegacyCommodityFields(f: FarmerRecord): void {
  const last = latestCommodity(f.id, true);
  if (!last) return;
  f.komoditas = last.komoditas;
  f.varietas = last.varietas || "";
  f.estimasiPanen = last.estimasiPanen || "";
  if (Number(last.estimasiHasilTon) > 0) f.estimasiHasilTon = Number(last.estimasiHasilTon);
  if (Number(last.luasHa) > 0) {
    f.luasLahan = Number(last.luasHa);
    f.luasLahanFormatted = `${last.luasHa} Ha`;
  }
}

// ============ F3: negosiator buyer-petani ============
// Aturan Wawa: harga jual DITANYA dulu ke petani (tak pernah mengacu harga
// pasar); cocok bila <= budget buyer; selisih masuk kas Hai Tani; stok
// dilaporkan jujur apa adanya (kurang -> tawarkan agregasi multi-petani).
function parseQtyKg(s: string): number | undefined {
  const m = String(s || "").match(/(\d+(?:[.,]\d+)?)\s*(ton|kuintal|kwintal|kilogram|kg|kilo|t\b|kw\b)/i);
  if (!m) return undefined;
  const v = Number(m[1].replace(/\./g, "").replace(/,/g, "."));
  if (!Number.isFinite(v) || v <= 0) return undefined;
  const u = m[2].toLowerCase();
  if (u.startsWith("ton") || u === "t") return v * 1000;
  if (u.startsWith("ku") || u.startsWith("kw")) return v * 100;
  return v;
}
// "50000", "50.000", "50rb", "8,5rb", "Rp 8.500/kg" -> rupiah per kg.
// Tolak di luar 100..2.000.000 agar qty ("10 kg") tak terbaca sebagai harga.
// Klausa ke-4: kata komoditas boleh di antara keyword dan angka
// ("jual agave 50000 per kg") — angka WAJIB diikuti penanda satuan harga
// (rb/ribu/k//kg/per kg) agar qty ("jual 500 kg") tak salah baca.
function parseRpPerKg(s: string): number | undefined {
  const t = String(s || "").toLowerCase();
  const clause = t.match(/(?:harga|budget|jual|tawar|minta|deal)\s*(?:rp\.?|rupiah)?\s*([\d.,]+)\s*(rb|ribu|k\b)?/)
    || t.match(/(?:rp\.?|rupiah)\s*([\d.,]+)\s*(rb|ribu|k\b)?/)
    || t.match(/([\d.,]+)\s*(rb|ribu)\b/)
    || t.match(/\b(?:jual|tawar|minta|harga|budget|deal)\b[\s\S]{0,40}?([\d.,]+)\s*(rb|ribu|k\b|\/kg|per\s?kg)/)
    || t.match(/^\s*([\d.,]+)\s*(\/kg|per\s?kg|\bkg\b)?\s*$/);
  if (!clause) return undefined;
  let v = Number(clause[1].replace(/\./g, "").replace(/,/g, "."));
  if (!Number.isFinite(v) || v <= 0) return undefined;
  if (clause[2] && /^(rb|ribu|k)$/.test(clause[2].trim())) v = v * 1000;
  if (v < 100 || v > 2000000) return undefined;
  return Math.round(v);
}
function fmtRp(n: number): string {
  return `Rp${Number(n || 0).toLocaleString("id-ID")}`;
}
function fmtKg(kg: number): string {
  const v = Number(kg || 0);
  if (v >= 1000) {
    const ton = v / 1000;
    return `${Number.isInteger(ton) ? String(ton) : ton.toLocaleString("id-ID")} ton`;
  }
  return `${v.toLocaleString("id-ID")} kg`;
}
function komMatch(a: string, b: string): boolean {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}
// Kandidat jujur: baris KMD AKTIF/PANEN yang namanya cocok + stok siap > 0.
function findStockCandidates(komoditas: string, excludeFarmerId?: string): FarmerCommodity[] {
  return komoditasDb.filter(
    (k) => (k.status === "AKTIF" || k.status === "PANEN")
      && komMatch(k.komoditas, komoditas)
      && Number(k.stokSiapJualTon) > 0
      && (!excludeFarmerId || k.farmerId !== excludeFarmerId),
  );
}
// Alokasi termurah-dulu (maksimalkan selisih untuk kas) + status + spread.
function evalOffer(o: Offer): { cocokKg: number; overLines: OfferLine[]; waitingPrice: number } {
  // Status terminal tak pernah dievaluasi ulang (defense in depth): DEAL/BATAL final, kuitansi utuh.
  if (o.status === "DEAL" || o.status === "BATAL") {
    const cocokKg = o.lines.reduce((acc, l) => acc + (Number(l.alokasiKg) || 0), 0);
    const waitingPrice = o.lines.filter((l) => !Number(l.hargaPetaniPerKg)).length;
    return { cocokKg, overLines: [], waitingPrice };
  }
  const need = Number(o.qtyKg) || 0;
  const budget = Number(o.budgetPerKg) || 0;
  const priced = o.lines
    .filter((l) => Number(l.hargaPetaniPerKg) > 0 && l.spekOk !== false)
    .sort((a, b) => Number(a.hargaPetaniPerKg) - Number(b.hargaPetaniPerKg));
  const waitingPrice = o.lines.filter((l) => !Number(l.hargaPetaniPerKg)).length;
  for (const l of o.lines) { l.alokasiKg = 0; l.cocok = false; }
  let cocokKg = 0;
  const overLines: OfferLine[] = [];
  if (budget > 0) {
    let remaining = need;
    for (const l of priced) {
      if (remaining <= 0) break;
      if (Number(l.hargaPetaniPerKg) > budget) { overLines.push(l); continue; }
      // Stok tersedia = snapshot baris dikurangi alokasi offer LAIN yang belum terminal (kunci: komoditasId).
      // DEAL sudah dipotong dari stok live; BATAL diabaikan.
      const dipakaiLain = l.komoditasId ? offersDb.reduce((acc, x) => {
        if (x.id === o.id || (x.status !== "OPEN" && x.status !== "SEBAGIAN" && x.status !== "COCOK")) return acc;
        for (const l2 of x.lines) {
          if (l2.komoditasId === l.komoditasId) acc += Number(l2.alokasiKg) || 0;
        }
        return acc;
      }, 0) : 0;
      const tersedia = Math.max(0, (Number(l.stokKg) || 0) - dipakaiLain);
      const take = Math.min(tersedia, remaining);
      l.alokasiKg = take;
      l.cocok = take > 0;
      cocokKg += take;
      remaining -= take;
    }
    o.status = cocokKg >= need ? "COCOK" : cocokKg > 0 ? "SEBAGIAN" : "OPEN";
    o.spreadTotalRp = priced.reduce(
      (acc, l) => acc + (Number(l.alokasiKg) || 0) * (budget - Number(l.hargaPetaniPerKg)), 0);
  } else {
    o.status = "OPEN";
    o.spreadTotalRp = 0;
  }
  o.updatedAt = new Date().toISOString();
  return { cocokKg, overLines, waitingPrice };
}
function clearOfferAsks(offerId: string): void {
  let changed = false;
  for (const u of usersDb) {
    if (u.pendingAsk && u.pendingAsk.offerId === offerId) {
      u.pendingAsk = undefined;
      u.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveUsersToDisk();
}
function offerStatusText(o: Offer, viewer: "buyer" | "farmer"): string {
  const budgetTxt = Number(o.budgetPerKg) > 0 ? fmtRp(Number(o.budgetPerKg)) + "/kg" : "belum diisi";
  const head = `🤝 *Penawaran ${o.id}* — *${o.status}*\n` +
    `• Komoditas: *${o.komoditas}* — butuh ${fmtKg(Number(o.qtyKg))}\n` +
    `• Budget buyer: ${budgetTxt}\n` +
    (o.spesifikasi ? `• Spek: ${o.spesifikasi}\n` : "");
  const lines = o.lines.length === 0
    ? "• Petani: (belum ada yang lapor stok)"
    : "• Petani:\n" + o.lines.map((l) => {
      const f = farmersDb.find((x) => x.id === l.farmerId);
      const nm = f ? `${f.nama}${f.kabupaten ? ` (${f.kabupaten})` : ""}` : l.farmerId;
      const harga = Number(l.hargaPetaniPerKg) > 0 ? fmtRp(Number(l.hargaPetaniPerKg)) + "/kg" : "menunggu harga petani";
      const alo = Number(l.alokasiKg) > 0 ? ` → alokasi ${fmtKg(Number(l.alokasiKg))}` : "";
      return `  - ${nm}: siap ${fmtKg(Number(l.stokKg))}, ${harga}${alo}`;
    }).join("\n");
  let tail = "";
  if (o.status === "COCOK" || o.status === "DEAL") {
    const toFarmers = o.lines.reduce((acc, l) => acc + (Number(l.alokasiKg) || 0) * Number(l.hargaPetaniPerKg || 0), 0);
    tail = `\n• Total ke petani: ${fmtRp(toFarmers)} | Komisi Hai Tani: ${fmtRp(Number(o.spreadTotalRp) || 0)}`;
    if (o.status === "DEAL") tail += ` (kas ${o.kasId || "-"})`;
  }
  void viewer;
  return head + lines + tail;
}
// F9: komisi per tier (docs/revenue-streams.md: Tunas 5%, Tumbuh 2%, Panen 0%).
// FREE = tarif Tunas; PAID lawas = tarif Tumbuh. Selisih negosiasi di atas
// komisi tier dikembalikan ke petani via top-up harga (pro-petani).
const TIER_COMMISSION_PCT: Record<string, number> = { FREE: 5, TUNAS: 5, TUMBUH: 2, PANEN: 0, PAID: 2 };
function tierOfPhone(phone: string): string {
  try {
    const key = normalizePhone(phone) || String(phone || "");
    const u = usersDb.find((x) => normalizePhone(x.phone) === key);
    const t = String((u as any)?.tier || "FREE").toUpperCase();
    return TIER_COMMISSION_PCT[t] !== undefined ? t : "FREE";
  } catch {
    return "FREE";
  }
}
// DEAL: komisi (selisih) masuk kas + stok petani berkurang sesuai alokasi.
function finalizeOfferDeal(o: Offer, actorPhone: string): { kasId: string | null; spread: number; tierTxt: string } {
  const budget = Number(o.budgetPerKg) || 0;
  let spread = 0;
  const tierBits: string[] = [];
  for (const l of o.lines) {
    const kg = Number(l.alokasiKg) || 0;
    if (kg <= 0 || budget <= 0) continue;
    const fPrice = Number(l.hargaPetaniPerKg) || 0;
    const lineValue = Math.round(budget * kg);
    const lineSpread = Math.round((budget - fPrice) * kg);
    if (lineSpread <= 0) continue;
    const fr = farmersDb.find((x) => x.id === l.farmerId);
    const tier = tierOfPhone(fr?.noHp || "");
    const pct = TIER_COMMISSION_PCT[tier] ?? 5;
    const take = Math.min(lineSpread, Math.round(lineValue * pct / 100));
    spread += take;
    const back = lineSpread - take;
    if (back > 0) {
      l.hargaPetaniPerKg = Number((fPrice + back / kg).toFixed(2));
    }
    tierBits.push(`${l.farmerId}:${tier} ${pct}%`);
  }
  spread = Math.round(spread);
  o.spreadTotalRp = spread;
  const tierTxt = tierBits.length > 0 ? ` [${tierBits.join(", ")}]` : "";
  let kasId: string | null = null;
  if (spread > 0) {
    const now = new Date().toISOString();
    const record: CashTransaction = {
      id: nextId("KAS", cashDb.map((c) => c.id)),
      farmerId: "",
      tanggal: now.substring(0, 10),
      jenis: "MASUK",
      kategori: "Komisi Negosiasi",
      jumlahRp: spread,
      komoditas: sanitizeText(o.komoditas, 60) || undefined,
      catatan: sanitizeText(
        `Komisi ${o.id}${tierTxt}: buyer ${maskPhone(o.buyerPhone)} <- ${o.lines.filter((l) => Number(l.alokasiKg) > 0).map((l) => l.farmerId).join(", ")}`, 500),
      dicatatOleh: String(actorPhone || "sistem"),
      waktuCatat: now,
      googleSheetRow: nextSheetRow(cashDb.map((c) => c.googleSheetRow), cashDb.length),
      syncStatus: "synced",
    };
    cashDb.unshift(record);
    saveCashToDisk();
    kasId = record.id;
    emitCanonicalEvent({
      source: "wa-chat", entity: "cash", entityId: record.id,
      action: "create", actor: actorPhone,
      payload: { jenis: "MASUK", kategori: "Komisi Negosiasi", jumlahRp: spread, offerId: o.id, tier: tierTxt },
    });
  }
  for (const l of o.lines) {
    const take = Number(l.alokasiKg) || 0;
    if (take <= 0) continue;
    const k = komoditasDb.find((x) => x.id === l.komoditasId);
    if (k) {
      k.stokSiapJualTon = Math.max(0, Number(k.stokSiapJualTon || 0) - take / 1000);
      k.updatedAt = new Date().toISOString();
      emitCanonicalEvent({
        source: "wa-chat", entity: "commodity", entityId: k.id,
        action: "update", actor: actorPhone,
        payload: { farmerId: k.farmerId, komoditas: k.komoditas, stokSiapJualTon: k.stokSiapJualTon },
      });
    }
  }
  saveKomoditasToDisk();
  o.status = "DEAL";
  o.kasId = kasId || undefined;
  o.updatedAt = new Date().toISOString();
  saveOffersToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: "wa-chat", entity: "offer", entityId: o.id,
    action: "deal", actor: actorPhone,
    payload: { komoditas: o.komoditas, qtyKg: o.qtyKg, budgetPerKg: o.budgetPerKg, spreadTotalRp: spread, kasId },
  });
  return { kasId, spread, tierTxt };
}

// ============ F6: session-maximizer (sodoran proaktif 1x/hari) ============
// Memakai sesi 24 jam yang sudah terbuka untuk menanyakan pembaruan harga
// jual petani (hemat biaya template). Hanya sapaan santai; perintah/draf/
// negosiasi tak pernah disodori. Jawaban tercatat ke KMD + diteruskan ke
// penawaran OPEN yang menunggu harga petani yang sama.
const NUDGE_EVERY_MS = 24 * 60 * 60 * 1000;
// Perintah/fungsional: pesan seperti ini JANGAN disodori (v1 konservatif).
const NUDGE_SKIPMSG_RE = /batal|blokir|izinkan|setuju|tidak setuju|daftar|tambah|komoditas|panen selesai|tutup komoditas|butuh|cari|carikan|\bbeli\b|membeli|perlu|nyari|order|pesan|stok|ready|siap|tersedia|harga|jual|tawar|minta|budget|deal|cek penawaran|status penawaran|OFR-|kas\b|catat|terjual|laku|saldo|hpp|rekap|analisis|verifikasi|broadcast|manfaat|benefit|program|hama|penyakit|wereng|ulat|tikus|pupuk|dosis|cuaca|bantuan|help|menu|sama|skip|lewati|stop|berhenti|pengingat|lapor harga|saran|masukan|kritik|usulan|keluhan|komplain|lapor|cari|katalog|sudah beli|tambah produk|hapus produk|komisi|kartu|\d/;
function pickNudgeTarget(farmerId: string): { kmd: FarmerCommodity; text: string } | null {
  const rows = komoditasDb.filter((k) => k.farmerId === farmerId && (k.status === "AKTIF" || k.status === "PANEN"));
  if (rows.length === 0) return null;
  // Paling basi dulu (hargaMintaAt || createdAt) -> rotasi alami antar komoditas.
  const sorted = [...rows].sort((a, b) => String(a.hargaMintaAt || a.createdAt || "").localeCompare(String(b.hargaMintaAt || b.createdAt || "")));
  const kmd = sorted[0];
  const hasPrice = Number(kmd.hargaMintaPerKg) > 0;
  const text = hasPrice
    ? `\n\n💡 *Ngomong-ngomong* — harga jual *${kmd.komoditas}* masih ${fmtRp(Number(kmd.hargaMintaPerKg))}/kg? Balas "sama", angka baru, atau "skip".`
    : `\n\n💡 *Ngomong-ngomong* — harga jual *${kmd.komoditas}* Bapak/Ibu saat ini berapa per kg? Balas angka saja, mis. "8000". (Atau "skip".)`;
  return { kmd, text };
}

// Format success confirmation text
// Aturan jujur: field yang kosong ditampilkan apa adanya ("Belum diisi") —
// TIDAK pernah diisi karangan. Estimasi panen ditanyakan susulan bila kosong.
function formatSuccessFarmerRegistration(newRecord: FarmerRecord, activeAdmin?: AdminUser): string {
  const varTxt = newRecord.varietas ? ` (${newRecord.varietas})` : "";
  const locTxt = `${newRecord.alamat}${newRecord.kabupaten && newRecord.kabupaten !== "Belum diketahui" && newRecord.alamat !== newRecord.kabupaten ? ` (${newRecord.kabupaten})` : ""}`;
  const tonTxt = Number(newRecord.estimasiHasilTon) > 0 ? ` (~*${newRecord.estimasiHasilTon} Ton*)` : "";
  const panenTxt = `${newRecord.estimasiPanen || "Belum diisi"}${tonTxt}`;
  const panenAsk = !newRecord.estimasiPanen
    ? `\n💡 *Info panen belum ada:* boleh dilengkapi kapan saja — ketik mis. "panen Desember 2026" atau "hasil 8 ton".\n`
    : "";
  if (activeAdmin) {
    return (
      `✅ *Data Petani Lengkap & Berhasil Ditambahkan ke Database!*\n\n` +
      `Bpk/Ibu *${activeAdmin.nama}*, seluruh data pokok telah lengkap dan telah tersimpan di database:\n\n` +
      `• *ID Registrasi:* \`${newRecord.id}\`\n` +
      `• *Nama Petani:* *${newRecord.nama}*\n` +
      `• *Komoditas:* *${newRecord.komoditas}*${varTxt}\n` +
      `• *Luas Lahan:* *${newRecord.luasLahanFormatted}*\n` +
      `• *Lokasi:* ${locTxt}\n` +
      `• *Estimasi Panen:* ${panenTxt}\n` +
      panenAsk +
      `• *Status Verifikasi:* 🟢 *${newRecord.statusVerifikasi}* (Otoritas ${activeAdmin.role})\n\n` +
      `Data telah otomatis tersimpan dan dapat dilihat langsung di tab *Dashboard*.`
    );
  }
  return (
    `✅ *Data Petani Lengkap & Berhasil Ditambahkan ke Database!*\n\n` +
    `Data pendaftaran lahan telah lengkap dan berhasil disimpan ke database resmi:\n\n` +
    `• *ID Registrasi:* \`${newRecord.id}\`\n` +
    `• *Nama Petani:* *${newRecord.nama}*\n` +
    `• *Komoditas:* *${newRecord.komoditas}*${varTxt}\n` +
    `• *Luas Lahan:* *${newRecord.luasLahanFormatted}*\n` +
    `• *Lokasi:* ${locTxt}\n` +
    `• *Estimasi Panen:* ${panenTxt}\n` +
    panenAsk +
    `• *Status Verifikasi:* 🟢 *${newRecord.statusVerifikasi}*\n\n` +
    `Data sudah dapat dilihat di tab Dashboard.`
  );
}

// Coordinate resolver based on kabupaten name or general location
function resolveCoordinates(locationStr?: string): { lat: number; lng: number } {
  const loc = (locationStr || "").toLowerCase();
  let baseLat = -6.5716;
  let baseLng = 107.7587;

  if (loc.includes("karawang")) { baseLat = -6.3073; baseLng = 107.3069; }
  else if (loc.includes("subang")) { baseLat = -6.5716; baseLng = 107.7587; }
  else if (loc.includes("indramayu")) { baseLat = -6.3264; baseLng = 108.3200; }
  else if (loc.includes("majalengka")) { baseLat = -6.8361; baseLng = 108.2275; }
  else if (loc.includes("cianjur")) { baseLat = -6.8172; baseLng = 107.1399; }
  else if (loc.includes("bandung") || loc.includes("lembang")) { baseLat = -6.8152; baseLng = 107.6186; }
  else if (loc.includes("garut")) { baseLat = -7.2167; baseLng = 107.9000; }
  else if (loc.includes("tasikmalaya")) { baseLat = -7.3274; baseLng = 108.2207; }
  else if (loc.includes("cirebon")) { baseLat = -6.7320; baseLng = 108.5523; }
  else if (loc.includes("brebes")) { baseLat = -6.8703; baseLng = 109.0435; }
  else if (loc.includes("grobogan") || loc.includes("wirosari")) { baseLat = -7.0863; baseLng = 110.9168; }
  else if (loc.includes("nganjuk")) { baseLat = -7.5810; baseLng = 111.9480; }
  else if (loc.includes("kediri")) { baseLat = -7.8480; baseLng = 112.0178; }
  else if (loc.includes("blitar")) { baseLat = -7.8690; baseLng = 112.1580; }
  else if (loc.includes("sukabumi")) { baseLat = -6.9277; baseLng = 106.9299; }

  const jitterLat = (Math.random() - 0.5) * 0.02;
  const jitterLng = (Math.random() - 0.5) * 0.02;
  return {
    lat: Number((baseLat + jitterLat).toFixed(4)),
    lng: Number((baseLng + jitterLng).toFixed(4)),
  };
}

function isSupplierIntent(text: string): boolean {
  // P1-5/P1-6: tanya harga/rekomendasi & kalimat demand BUKAN pendaftaran.
  if (/harga|berapa|mana (yang|yg) bagus|apakah|bagaimana|gimana|rekomendasi|bagus\?|murah\?|dimana|di mana|\b(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\b/.test((text || "").toLowerCase())) return false;
  const lower = (text || "").toLowerCase();
  return (
    lower.includes("toko pupuk") || // P1-7: alias sejajar "kios pupuk".
    lower.includes("supplier") ||
    lower.includes("suplier") ||
    lower.includes("kios pupuk") ||
    lower.includes("toko saprodi") ||
    lower.includes("kios tani") ||
    lower.includes("toko tani") ||
    lower.includes("toko pertanian") ||
    lower.includes("agen pupuk") ||
    lower.includes("distributor benih") ||
    lower.includes("penyedia alsintan") ||
    lower.includes("offtaker") ||
    lower.includes("pengepul") ||
    lower.includes("tengkulak") ||
    lower.includes("pemasok") ||
    lower.includes("koperasi tani") ||
    lower.includes("penggilingan beras") ||
    lower.includes("toko benih") ||
    lower.includes("kios resmi")
  );
}

function extractSupplierFromText(
  text: string,
  existing: Partial<SupplierRecord> = {}
): { extracted: Partial<SupplierRecord>; hasMinimumData: boolean } {
  const ext: Partial<SupplierRecord> = { ...existing };
  const lower = (text || "").toLowerCase();

  // 1. Kategori Usaha
  if (lower.includes("pupuk") || lower.includes("saprodi") || lower.includes("obat") || lower.includes("pestisida")) {
    ext.kategori = "Pupuk & Saprodi";
  } else if (lower.includes("bibit") || lower.includes("benih") || lower.includes("semai")) {
    ext.kategori = "Bibit & Benih";
  } else if (lower.includes("alsintan") || lower.includes("traktor") || lower.includes("sprayer") || lower.includes("mesin")) {
    ext.kategori = "Alat & Mesin Pertanian (Alsintan)";
  } else if (lower.includes("pengepul") || lower.includes("offtaker") || lower.includes("tengkulak") || lower.includes("tampung") || lower.includes("serap") || lower.includes("giling") || lower.includes("beras")) {
    ext.kategori = "Buyer & Offtaker";
  } else if (lower.includes("koperasi") || lower.includes("poktan") || lower.includes("gapoktan")) {
    ext.kategori = "Koperasi Tani";
  }

  // 2. Nama Toko/Kios/Supplier
  const nameMatch = text.match(/(?:kios|toko|supplier|ud|pt|cv|koperasi)\s+([A-Za-z0-9\s&]+?)(?:,|di|\.|\n|$)/i);
  if (nameMatch && nameMatch[1]) {
    const raw = nameMatch[0].trim();
    if (raw.length >= 4) {
      ext.nama = raw;
    }
  }

  // 3. Kontak / Nomor HP / WhatsApp
  const phoneMatch = text.match(/(?:\+?62|08)[0-9\s-]{8,15}/);
  if (phoneMatch) {
    ext.kontak = phoneMatch[0].replace(/\s+/g, " ").trim();
  }

  // 4. Kabupaten / Wilayah
  const districts = [
    "Subang", "Karawang", "Indramayu", "Majalengka", "Cianjur",
    "Bandung Barat", "Bandung", "Lembang", "Garut", "Brebes",
    "Grobogan", "Nganjuk", "Kediri", "Blitar", "Cirebon", "Sukabumi"
  ];
  for (const d of districts) {
    if (lower.includes(d.toLowerCase())) {
      ext.kabupaten = `${d}, Jawa Barat`;
      if (d === "Brebes" || d === "Grobogan") ext.kabupaten = `${d}, Jawa Tengah`;
      if (d === "Nganjuk" || d === "Kediri" || d === "Blitar") ext.kabupaten = `${d}, Jawa Timur`;
      break;
    }
  }

  // 5. Alamat / Jalan
  const jlMatch = text.match(/(?:jl|jalan|desa|kec|kecamatan|blok)\s+([A-Za-z0-9\s,.-]+?)(?:,|\.|\n|$)/i);
  if (jlMatch && jlMatch[0]) {
    ext.alamat = jlMatch[0].trim();
  }

  // 6. Produk Unggulan
  const prodMatch = text.match(/(?:produk|jual|sedia|stok|komoditas)\s*:\s*([A-Za-z0-9\s,.-]+?)(?:\.|\n|$)/i);
  if (prodMatch && prodMatch[1]) {
    ext.produkUnggulan = prodMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  // 7. Stok
  const stokMatch = text.match(/(?:stok|kapasitas|ready)\s*:\s*([A-Za-z0-9\s,.-]+?)(?:\.|\n|$)/i);
  if (stokMatch && stokMatch[1]) {
    ext.stokTersedia = stokMatch[1].trim();
  }

  const hasMinimumData = !!(ext.nama || ext.kategori || ext.kabupaten || ext.kontak);
  return { extracted: ext, hasMinimumData };
}

function checkSupplierCompleteness(record: Partial<SupplierRecord>): {
  isComplete: boolean;
  missingFields: string[];
  presentFields: string[];
} {
  const missing: string[] = [];
  const present: string[] = [];

  const hasValidName =
    !!record.nama &&
    record.nama.trim().length >= 3 &&
    !["Supplier", "Toko", "Kios", "Mitra", "Toko Pertanian"].includes(record.nama.trim());
  if (hasValidName) {
    present.push(`Nama Toko/Kios: *${record.nama}*`);
  } else {
    missing.push("Nama Toko/Kios/Supplier");
  }

  const hasValidCategory = !!record.kategori && record.kategori.trim().length >= 3;
  if (hasValidCategory) {
    present.push(`Kategori Usaha: *${record.kategori}*`);
  } else {
    missing.push("Kategori Usaha (Pupuk & Saprodi / Bibit & Benih / Alsintan / Offtaker / Koperasi)");
  }

  const hasValidLocation =
    (!!record.kabupaten && record.kabupaten.trim().length >= 3) ||
    (!!record.alamat && record.alamat.trim().length >= 3);
  if (hasValidLocation) {
    const loc = [record.alamat, record.kabupaten].filter(Boolean).join(", ");
    present.push(`Lokasi: *${loc}*`);
  } else {
    missing.push("Lokasi / Wilayah (Kabupaten atau Alamat Toko)");
  }

  return {
    isComplete: missing.length === 0,
    missingFields: missing,
    presentFields: present,
  };
}

function saveSupplierRecord(
  draft: Partial<SupplierRecord>,
  activeAdmin?: AdminUser,
  senderPhone?: string,
  source?: string,
): SupplierRecord {
  const newId = nextId("SUP", suppliersDb.map((s) => s.id));
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  const coords = resolveCoordinates(draft.kabupaten || draft.alamat || "Subang");

  const newRecord: SupplierRecord = {
    id: newId,
    nama: draft.nama || "Supplier Saprodi Pertanian",
    kategori: (draft.kategori as any) || "Pupuk & Saprodi",
    kontak: draft.kontak || senderPhone || "+62 812-xxxx-xxxx",
    alamat: draft.alamat || draft.kabupaten || "Pusat Distribusi Pertanian",
    kabupaten: draft.kabupaten || "Subang, Jawa Barat",
    latitude: draft.latitude && !isNaN(Number(draft.latitude)) ? Number(draft.latitude) : coords.lat,
    longitude: draft.longitude && !isNaN(Number(draft.longitude)) ? Number(draft.longitude) : coords.lng,
    statusKemitraan: (draft.statusKemitraan as any) || (activeAdmin ? "Terverifikasi Dinas" : "Mitra Aktif"),
    produkUnggulan:
      Array.isArray(draft.produkUnggulan) && draft.produkUnggulan.length > 0
        ? draft.produkUnggulan
        : ["Pupuk & Saprodi Pertanian"],
    stokTersedia: draft.stokTersedia || "Tersedia",
    radiusLayananKm: Number(draft.radiusLayananKm) || 25,
    jamBuka: draft.jamBuka || "Senin - Sabtu: 08.00 - 17.00 WIB",
    petaniBinaanCount: Number(draft.petaniBinaanCount) || 12,
    catatan:
      draft.catatan ||
      (activeAdmin
        ? `Didata langsung via WhatsApp oleh Admin ${activeAdmin.nama} (${activeAdmin.role} - ${activeAdmin.instansi}) pada ${now.toLocaleDateString("id-ID")}.`
        : `Didaftarkan via WhatsApp Chatbot pada ${now.toLocaleDateString("id-ID")}.`),
    googleSheetRow: nextSheetRow(
      suppliersDb.map((s) => s.googleSheetRow),
      suppliersDb.length,
    ),
    timestamp,
    syncStatus: "synced",
  };

  suppliersDb.unshift(newRecord);
  saveSuppliersToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: source || "wa-chat", entity: "supplier", entityId: newRecord.id,
    action: "create", actor: senderPhone,
    payload: { nama: newRecord.nama, kategori: newRecord.kategori, kabupaten: newRecord.kabupaten, statusKemitraan: newRecord.statusKemitraan },
  });
  return newRecord;
}

function formatSuccessSupplierRegistration(record: SupplierRecord, activeAdmin?: AdminUser): string {
  const adminBadge = activeAdmin
    ? `\n👮 *Diverifikasi oleh:* ${activeAdmin.nama} (${activeAdmin.role} - ${activeAdmin.instansi})`
    : "";

  return (
    `✅ *Data Supplier Produk Pertanian Berhasil Ditambahkan ke Google Sheets!*\n\n` +
    `Data mitra penyedia sarana produksi / offtaker telah berhasil dicatat dan disinkronkan ke Lembar Database Supplier:\n\n` +
    `• *ID Mitra:* \`${record.id}\`\n` +
    `• *Nama Toko/Kios:* *${record.nama}*\n` +
    `• *Kategori Usaha:* *${record.kategori}*\n` +
    `• *Kontak WhatsApp:* ${record.kontak}\n` +
    `• *Wilayah:* ${record.alamat}, ${record.kabupaten}\n` +
    `• *Produk Unggulan:* ${record.produkUnggulan.join(", ")}\n` +
    `• *Status Kemitraan:* 🟢 *${record.statusKemitraan}*\n` +
    `• *Baris Google Sheets:* Baris #${record.googleSheetRow || "Baru"}\n` +
    `• *Koordinat Peta:* (${record.latitude.toFixed(4)}, ${record.longitude.toFixed(4)})\n` +
    adminBadge +
    `\n\n📌 *Data mitra ini kini otomatis muncul di Google Maps Platform* dan dapat dihubungkan langsung dengan petani binaan terdekat.`
  );
}

function formatIncompleteSupplierPrompt(
  draft: Partial<SupplierRecord>,
  recipientName?: string,
  isAdmin: boolean = false
): {
  reply: string;
  quickReplies: string[];
  extractedSupplier: Partial<SupplierRecord>;
  isComplete: boolean;
} {
  const check = checkSupplierCompleteness(draft);

  const checklist = [
    `• Nama Toko/Kios: ${draft.nama ? `✅ *${draft.nama}*` : "❌ _Belum diisi_"}`,
    `• Kategori Usaha: ${draft.kategori ? `✅ *${draft.kategori}*` : "❌ _Belum diisi_"}`,
    `• Kontak / WA: ${draft.kontak ? `✅ *${draft.kontak}*` : "❌ _Belum diisi_"}`,
    `• Wilayah / Lokasi: ${draft.kabupaten || draft.alamat ? `✅ *${draft.kabupaten || draft.alamat}*` : "❌ _Belum diisi_"}`,
    `• Produk Unggulan: ${draft.produkUnggulan && draft.produkUnggulan.length > 0 ? `✅ *${draft.produkUnggulan.join(", ")}*` : "⚪ _Opsional_"}`,
  ].join("\n");

  const missingList = check.missingFields.map((m, idx) => `${idx + 1}. *${m}*`).join("\n");
  const salutation = isAdmin && recipientName ? `Bpk/Ibu *${recipientName}*` : `Bapak/Ibu`;

  const reply =
    `📝 *Draf Data Supplier Pertanian Dicatat (Belum Lengkap)*\n\n` +
    `Terima kasih ${salutation}. Data sementara mitra supplier telah tersimpan di draf percakapan, namun *belum dimasukkan ke Google Sheets* karena data pokok belum lengkap:\n\n` +
    `${checklist}\n\n` +
    `⚠️ *Data yang masih harus dilengkapi:*\n${missingList}\n\n` +
    `💡 *Silakan ketik data kelanjutannya* (misal: sebutkan nama toko, kategori pupuk/bibit/alsintan, atau kabupaten lokasinya).`;

  const quickReplies = [
    "Kategori: Pupuk & Saprodi",
    "Kategori: Bibit & Benih",
    "Kategori: Buyer & Offtaker",
    "Lokasi: Subang",
  ];

  return {
    reply,
    quickReplies,
    extractedSupplier: draft,
    isComplete: false,
  };
}

// Smart Dynamic Fallback Generator for Admin queries if AI is busy/offline
function generateSmartAdminFallback(
  message: string,
  activeAdmin: AdminUser,
  farmers: FarmerRecord[],
  commodities: MarketCommodity[],
  currentDraft: Partial<FarmerRecord> = {}
) {
  const lower = (message || "").toLowerCase();
  const totalLuas = farmers.reduce((acc, f) => acc + (f.luasLahan || 0), 0).toFixed(1);
  const totalPanen = farmers.reduce((acc, f) => acc + (f.estimasiHasilTon || 0), 0).toFixed(1);
  const unverified = farmers.filter((f) => f.statusVerifikasi !== "Terverifikasi");

  // 0. Admin adding or registering a farmer directly via WhatsApp
  const isAddRequest =
    lower.includes("tambah") ||
    lower.includes("daftarkan") ||
    lower.includes("daftar") ||
    lower.includes("input") ||
    lower.includes("masukkan") ||
    lower.includes("catat") ||
    lower.includes("simpan");

  // P1-8: frasa pasif/tanya ("apakah petani sudah terdaftar?") BUKAN aksi daftar.
  if (!/terdaftar|pendaftaran|daftar sebagai|daftar harga|apakah|bagaimana|berapa/.test(lower) && (isAddRequest || (lower.includes("petani") && (lower.includes("lahan") || lower.includes("pak ") || lower.includes("bu "))))) {
    const { extracted: ext } = extractFarmerFromText(message, currentDraft || {});
    const merged = { ...(currentDraft || {}), ...ext };
    const check = checkFarmerCompleteness(merged);

    // If incomplete, DO NOT save to database yet! Ask for missing fields.
    if (!check.isComplete) {
      const incomplete = formatIncompleteFarmerPrompt(merged, activeAdmin.nama, true);
      if (!merged.noHp) incomplete.reply += "\n\n➕ *Admin: cantumkan juga No HP/WA petani* (misal: 0812xxxxxxx).";
      return {
        ...incomplete,
        isAdminAction: true,
      };
    }

    // Only save when data is complete (+ nomor petani wajib untuk pendaftaran admin)
    if (!merged.noHp) {
      const incompleteNoHp = formatIncompleteFarmerPrompt(merged, activeAdmin.nama, true);
      incompleteNoHp.reply += "\n\n➕ *Admin: cantumkan juga No HP/WA petani* (misal: 0812xxxxxxx).";
      return { ...incompleteNoHp, isAdminAction: true };
    }
    // Gerbang duplikat: nomor sama -> tanya Ya/Tidak (aturan user).
    const dupAdmFb = findDuplicateFarmerByPhone(merged, activeAdmin, activeAdmin.noHp);
    if (dupAdmFb) {
      return {
        reply: formatDuplicateAskPrompt(dupAdmFb, merged),
        extracted: { ...merged, _pendingUpdate: dupAdmFb.id },
        isComplete: false,
        isAdminAction: true,
        quickReplies: ["Ya, update", "Tidak"],
      };
    }
    const newRecord = saveFarmerRecord(merged, activeAdmin, activeAdmin.noHp);
    return {
      reply: formatSuccessFarmerRegistration(newRecord, activeAdmin),
      extracted: newRecord,
      isComplete: true,
      isAdminAction: true,
      savedRecord: newRecord,
      quickReplies: ["📊 Rekap Semua Petani", "📥 Buka Google Sheets", "🌾 Tambah Petani Lainnya"],
    };
  }

  // 1. Unverified / verifikasi inquiry
  if (lower.includes("belum") || lower.includes("verifikasi") || lower.includes("unverified")) {
    const list = unverified
      .map(
        (f, i) =>
          `${i + 1}. *${f.nama}* (${f.noHp})\n   📍 ${f.kabupaten || f.alamat} | Lahan: *${f.luasLahan} Ha* (${f.komoditas})\n   🗓️ Proyeksi Panen: ${f.estimasiPanen} (~${f.estimasiHasilTon} Ton)\n   ⚠️ Catatan: ${f.catatanAI || "Menunggu validasi polygon lahan oleh PPL."}`
      )
      .join("\n\n");

    return {
      reply: `🎖️ *Laporan Validasi Petani untuk Admin ${activeAdmin.nama}:*\n\nSaat ini terdapat *${unverified.length} data petani* berstatus *Menunggu Verifikasi* dari total ${farmers.length} petani mitra terdaftar:\n\n${list || "✅ Seluruh data petani saat ini telah berstatus Terverifikasi."}\n\n💡 *Rekomendasi Tindakan PPL:*\n1. Koordinasikan dengan petugas penyuluh di wilayah bersangkutan untuk ground-check batas lahan.\n2. Lakukan validasi nomor rekening kelompok tani untuk penyaluran bantuan sarana produksi.`,
      extracted: {},
      isComplete: false,
      isAdminAction: true,
      quickReplies: ["🌾 Data Petani Padi", "🌶️ Data Petani Cabai", "📥 Siapkan Ekspor Data Sheets", "📊 Rekap Statistik Lengkap"],
    };
  }

  // 2. Broadcast / Draf Pesan WA
  if (
    lower.includes("draf") ||
    lower.includes("broadcast") ||
    lower.includes("pesan") ||
    lower.includes("blast") ||
    lower.includes("umumkan")
  ) {
    return {
      reply: `🎖️ *Draf Pesan WhatsApp Resmi Disiapkan untuk Admin ${activeAdmin.nama}*\n*(Siap Salin & Kirim ke Grup Kelompok Tani / Petugas PPL)*:\n\n━━━━━━━━━━━━━━━━━━━━\n🌾 *PEMBERITAHUAN RESMI DINAS PERTANIAN & KETAHANAN PANGAN*\n\nKepada Yth. Seluruh Ketua Kelompok Tani & Petani Mitra,\n\nMenindaklanjuti pemantauan data agroklimat dan dinamika pasokan panen bulan ${new Date().toLocaleDateString("id-ID", { month: "long", year: "numeric" })}, kami menghimbau:\n\n1. *Optimalisasi Jadwal Panen:* Segera koordinasikan waktu panen dengan petugas PPL desa masing-masing untuk kelancaran logistik dan penyerapan hasil panen.\n2. *Kewaspadaan Hama & Cuaca:* Waspadai serangan hama pasca-hujan dan pastikan saluran drainase lahan tetap bersih.\n3. *Pembaruan Data Lahan:* Petani yang belum melengkapi data pendaftaran Google Sheets agar segera melapor melalui layanan WhatsApp Kang Tani AI.\n\nDemikian himbauan ini kami sampaikan demi menjaga stabilitas pasokan dan kesejahteraan bersama.\n\n*Hormat kami,*\n*${activeAdmin.nama}*\n_${activeAdmin.role} - ${activeAdmin.instansi}_\n━━━━━━━━━━━━━━━━━━━━`,
      extracted: {},
      isComplete: false,
      isAdminAction: true,
      quickReplies: ["⚠️ Cek Belum Verifikasi", "📊 Rekap Semua Petani", "🌶️ Analisis Harga Cabai", "📥 Ekspor Sheets"],
    };
  }

  // 3. Price anomaly / Pasar inquiry
  if (lower.includes("harga") || lower.includes("anomali") || lower.includes("pasar") || lower.includes("inflasi")) {
    const anomalyList = commodities
      .filter((c) => c.statusAnomali !== "NORMAL")
      .map(
        (c) =>
          `• *${c.nama}*: Rp ${c.hargaSekarang.toLocaleString("id-ID")}/kg (${c.perubahanPersen > 0 ? "+" : ""}${c.perubahanPersen}% | Status: *${c.statusAnomali}*)\n  📝 _${c.pesanAnomali || c.rekomendasiPetani}_`
      )
      .join("\n\n");

    return {
      reply: `🎖️ *Analisis Intelijen Pasar & Anomali Pangan*\n*Disiapkan untuk: ${activeAdmin.nama}*\n\nBerikut komoditas yang terdeteksi mengalami deviasi harga signifikan per ${new Date().toLocaleDateString("id-ID")}:\n\n${anomalyList}\n\n💡 *Rekomendasi Taktis Dinas:*\n1. *Intervensi Pasar Cabai:* Gelar Operasi Pasar Murah mandiri di sentra konsumen dan pasok langsung dari panen Kediri/Garut.\n2. *Subsidi Ongkos Angkut:* Manfaatkan dana BTT (Belanja Tidak Terduga) untuk subsidi logistik armada truk dari sentra surplus ke daerah defisit.\n3. *Fasilitasi Cold Storage:* Tampung kelebihan pasokan sementara di CAS (Controlled Atmosphere Storage).`,
      extracted: {},
      isComplete: false,
      isAdminAction: true,
      quickReplies: ["🌶️ Detail Petani Cabai", "🧅 Detail Petani Bawang", "📊 Rekap Semua Petani", "📥 Ekspor Sheets"],
    };
  }

  // 4. Commodity filtering (e.g. padi, cabai, bawang, jagung)
  if (lower.includes("padi") || lower.includes("cabai") || lower.includes("bawang") || lower.includes("jagung")) {
    const keyword = lower.includes("cabai")
      ? "cabai"
      : lower.includes("bawang")
      ? "bawang"
      : lower.includes("jagung")
      ? "jagung"
      : "padi";

    const filtered = farmers.filter(
      (f) => f.komoditas.toLowerCase().includes(keyword) || (f.varietas || "").toLowerCase().includes(keyword)
    );
    const cLuas = filtered.reduce((acc, f) => acc + (f.luasLahan || 0), 0).toFixed(1);
    const cPanen = filtered.reduce((acc, f) => acc + (f.estimasiHasilTon || 0), 0).toFixed(1);

    const list = filtered
      .slice(0, 5)
      .map(
        (f, i) =>
          `${i + 1}. *${f.nama}* (${f.noHp})\n   📍 ${f.kabupaten || f.alamat}\n   🌾 Varietas: ${f.varietas || "—"} | Lahan: *${f.luasLahan} Ha*\n   🗓️ Estimasi Panen: ${f.estimasiPanen} (~*${f.estimasiHasilTon} Ton*) [${f.statusVerifikasi}]`
      )
      .join("\n\n");

    return {
      reply: `🎖️ *Analisis Komoditas ${keyword.toUpperCase()} untuk Admin ${activeAdmin.nama}:*\n\n📊 *Ringkasan Agregat:*\n• Jumlah Petani Terdaftar: *${filtered.length} Petani*\n• Total Luas Lahan: *${cLuas} Hektar*\n• Estimasi Total Produksi: *${cPanen} Ton*\n\n📋 *Daftar Petani Terdata:*\n${list}\n\n💡 Seluruh data telah tercatat di Google Sheets real-time dan siap dianalisis data science.`,
      extracted: {},
      isComplete: false,
      isAdminAction: true,
      quickReplies: [
        `📥 Ekspor Data ${keyword.toUpperCase()}`,
        "📊 Rekap Semua Komoditas",
        "⚠️ Cek Belum Verifikasi",
        "📈 Analisis Harga Pasar",
      ],
    };
  }

  // 5. Export / Download
  if (
    lower.includes("ekspor") ||
    lower.includes("download") ||
    lower.includes("unduh") ||
    lower.includes("link") ||
    lower.includes("csv")
  ) {
    return {
      reply: `📥 *Akses Data Google Sheets & Ekspor CSV Siap!*\n\nBpk/Ibu ${activeAdmin.nama}, berikut tautan resmi penarikan database:\n\n• *Format CSV Master:* [/api/sheets/export.csv](/api/sheets/export.csv)\n• *Live Spreadsheet View:* [/api/sheets/live-view](/api/sheets/live-view)\n• *Total Record:* ${farmers.length} data petani mitra terdaftar\n• *Integritas Sinkronisasi:* 100% Synced ke Google Sheets Cloud\n\nFile CSV dapat langsung dibuka di Microsoft Excel, Google Sheets, atau diimpor ke Jupyter Notebook/Pandas untuk pemodelan data science.`,
      extracted: {},
      isComplete: false,
      isAdminAction: true,
      quickReplies: ["📊 Rekap Semua Petani", "🌾 Data Panen Padi", "🌶️ Data Petani Cabai"],
    };
  }

  // 5b. Google Drive & Sheets API Key Status & Security
  if (
    lower.includes("api key") ||
    lower.includes("drive") ||
    lower.includes("kunci api") ||
    lower.includes("keamanan") ||
    lower.includes("token")
  ) {
    const rawKey = process.env.GOOGLE_DRIVE_SHEETS_API_KEY;
    const isReady = !!rawKey && rawKey.length > 5;
    const masked = isReady
      ? `${rawKey!.slice(0, 4)}••••••••••••••••••••${rawKey!.slice(-4)}`
      : "Belum Dikonfigurasi";

    return {
      reply: `🔐 *Keamanan & Status Kredensial Google Drive / Sheets API*\n\nBpk/Ibu ${activeAdmin.nama}, kredensial API telah *diamankan di backend server*:\n\n• *Status Kunci:* ${isReady ? "🟢 TERPASANG & AKTIF" : "🔴 BELUM AKTIF"}\n• *Kunci Terproteksi:* \`${masked}\`\n• *Tingkat Keamanan:* *Server-Side Isolated Environment* (kunci tidak pernah dibagikan ke browser publik)\n• *Otoritas:* Read & Write Sinkronisasi Google Sheets / Drive Cloud\n• *Jumlah Data Tersinkronisasi:* *${farmers.length} Petani* (${totalPanen} Ton Proyeksi)\n\nAgent TaniAI siap mengeksekusi integrasi dan pembaruan data secara langsung dengan otorisasi kredensial ini.`,
      extracted: {},
      isComplete: false,
      isAdminAction: true,
      quickReplies: ["📥 Buka Live Sheets", "🌾 Rekap Semua Petani", "📊 Analisis Klaster Padi"],
    };
  }

  // 6. Default Executive Summary / Rekap
  const komoditasSummary = farmers.reduce((acc: any, f) => {
    acc[f.komoditas] = (acc[f.komoditas] || 0) + 1;
    return acc;
  }, {});
  const komoditasText = Object.entries(komoditasSummary)
    .map(([k, count]) => `• ${k}: *${count} Petani*`)
    .join("\n");

  return {
    reply: `🎖️ *Halo Bpk/Ibu ${activeAdmin.nama}!* \n*(Otoritas: ${activeAdmin.role} - ${activeAdmin.instansi})*\n\nBerikut ringkasan eksekutif database pertanian per ${new Date().toLocaleDateString("id-ID")}:\n\n📊 *Indikator Utama:* \n• Total Petani Terdata: *${farmers.length} Petani*\n• Total Luas Lahan: *${totalLuas} Hektar*\n• Proyeksi Total Panen: *${totalPanen} Ton*\n• Terverifikasi: *${farmers.length - unverified.length} Petani* (${unverified.length} menunggu verifikasi)\n\n🌾 *Komoditas Terdaftar:*\n${komoditasText}\n\nSilakan instruksikan analisis spesifik yang ingin Bpk/Ibu lakukan, seperti: *"analisis panen cabai"*, *"draf broadcast hama"*, *"tampilkan yang belum verifikasi"*, atau *"rekomendasi stabilisasi harga"*.`,
    extracted: {},
    isComplete: false,
    isAdminAction: true,
    quickReplies: ["📊 Analisis Klaster Padi", "🌶️ Rekomendasi Harga Cabai", "📢 Buat Draf Broadcast WA", "⚠️ Cek Belum Verifikasi", "📥 Ekspor CSV Sheets"],
  };
}

// 9Router AI Gateway Configuration & Discovery
function getNineRouterConfig() {
  let url = process.env.NINEROUTER_URL?.trim() || "";
  const key = process.env.NINEROUTER_KEY?.trim() || "";
  let model = process.env.NINEROUTER_MODEL?.trim() || "gpt-4.1";

  url = url.replace(/\/+$/, "");
  if (url.endsWith("/v1")) {
    url = url.slice(0, -3);
  }

  // Handle incompatible model aliases
  if (model === "combo1" || model.includes("openai/")) {
    model = "gpt-4.1";
  }

  const isConfigured = Boolean(url && url.length > 5);
  return {
    url,
    key,
    model,
    isConfigured,
  };
}

async function checkNineRouterHealth(): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
  const cfg = getNineRouterConfig();
  if (!cfg.isConfigured) {
    return { ok: false, message: "NINEROUTER_URL belum dikonfigurasi di environment." };
  }
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const headers: Record<string, string> = {};
    if (cfg.key) headers["Authorization"] = `Bearer ${cfg.key}`;

    const res = await fetch(`${cfg.url}/api/health`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const latency = Date.now() - startTime;
    if (res.ok) {
      return { ok: true, latencyMs: latency, message: "Terhubung ke 9Router Gateway" };
    }
    // Probe models endpoint if health endpoint is 404
    const probeRes = await fetch(`${cfg.url}/v1/models`, { headers, signal: controller.signal });
    if (probeRes.ok) {
      return { ok: true, latencyMs: Date.now() - startTime, message: "Terhubung ke 9Router (/v1/models aktif)" };
    }
    return { ok: false, latencyMs: latency, message: `9Router status: ${res.status}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Gagal menghubungi 9Router gateway" };
  } finally {
    clearTimeout(timeout);
  }
}

// ==========================================
// COST & TOKEN OPTIMIZATION ENGINE (3 PILLARS)
// 1. Kirim Hanya Yang Dibutuhkan: Ringkasan Terlebih Dahulu & Targeted Retrieval
// 2. Batasi Jawaban AI: Max Output Tokens & Instant Cancellation (AbortSignal)
// 3. Gunakan Kembali Hasil: Smart Query Cache & Report Reuse
// ==========================================

interface AICacheEntry {
  reply: string;
  quickReplies?: string[];
  extracted?: any;
  isAdminAction?: boolean;
  timestamp: number;
  dataVersion: number;
  provider: "cache";
}

const aiResponseCache = new Map<string, AICacheEntry>();
let currentDataVersion = 1;
let totalTokensSavedEstimate = 0;
let totalCacheHits = 0;

// Mutu cache: jangan simpan balasan stub/terpotong (pendek atau berakhir
// ":" / "…" / "...") agar racun tak disajikan berulang (kasus 26a, 31 Okt 2026).
function isCacheWorthyReply(reply: unknown): boolean {
  const t = String(reply || "").trim();
  if (t.length < 40) return false;
  return !/[:…]\s*$/.test(t) && !/\.\.\.\s*$/.test(t);
}
function bumpDataVersion() {
  currentDataVersion++;
  // ponytail: clear ganti LRU saat cache besar.
  if (aiResponseCache.size > 200) for (const k of aiResponseCache.keys()) { aiResponseCache.delete(k); if (aiResponseCache.size <= 150) break; }
}

function getNormalizedCacheKey(role: string, message: string): string {
  const clean = (message || "")
    .toLowerCase()
    .replace(/[^\w\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${role}::${clean}`;
}

function isQuerySafeToCache(message: string): boolean {
  const lower = (message || "").toLowerCase();
  // DO NOT cache user registration mutations or phone numbers
  const mutationKeywords = [
    "tambah", "daftarkan", "daftar", "input", "masukkan", "catat", "simpan",
    "nama saya", "lahan saya", "panen saya", "desa ", "kecamatan ", "08", "+62"
  ];
  return !mutationKeywords.some((k) => lower.includes(k));
}

// LLM kadang membungkus ganda ("reply": "{...}") atau terpotong di tengah JSON.
// Kembalikan teks balasan bersih; input non-JSON dikembalikan apa adanya.
// Kupas pagar kode markdown (```json ... ```) dari keluaran LLM agar parser
// JSON + unwrapNestedReply (termasuk JSON terpotong) bisa bekerja.
function stripCodeFences(t: string): string {
  return String(t || "").replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/```\s*$/, "").trim();
}
function unwrapNestedReply(text: string): string {
  const t = String(text || "");
  const s = t.trim();
  if (!s.startsWith("{")) return t;
  try {
    const inner = JSON.parse(s);
    if (inner && typeof inner.reply === "string") return unwrapNestedReply(inner.reply);
    return t;
  } catch {
    // JSON terpotong: ambil nilai "reply" hingga kutip penutup ATAU akhir string.
    const m = s.match(/"reply"\s*:\s*"/);
    if (!m || m.index === undefined) return t;
    let raw = "";
    let esc = false;
    for (let i = m.index + m[0].length; i < s.length; i++) {
      const c = s[i];
      if (esc) { raw += "\\" + c; esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') break;
      raw += c;
    }
    if (esc) raw += "\\";
    try {
      const unesc = JSON.parse('"' + raw + '"');
      return String(unesc).trim() ? String(unesc) : t;
    } catch {
      const manual = raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return manual.trim() ? manual : t;
    }
  }
}

// Fast-path smalltalk 0ms (tanpa LLM/Laya): salam, identitas, makasih, bantuan.
// Pola dijangkar + batas panjang agar tak membajak intent fungsional (ERP,
// daftar, analitik). "oke/makasih" mengalah bila ada draf terbuka (konfirmasi).
function handleFastSmalltalk(
  message: string, isAdmin: boolean, activeAdmin: AdminUser | undefined,
  effPhone: string | undefined, hasOpenDraft: boolean
): { reply: string; quickReplies: string[]; extracted: {}; isComplete: boolean; isAdminAction: boolean } | null {
  const clean = String(message || "").trim().toLowerCase();
  if (!clean || clean.length > 40) return null;
  const bare = (re: RegExp) => re.test(clean);
  // Salam — admin: ringkasan eksekutif yang sama via fallback deterministik.
  if (bare(/^(halo+|hallo+|hai+|hi+|hei+|pagi+|siang|sore|malam|selamat (pagi|siang|sore|malam)|assalamu'?alaikum|punten|sampurasun|permisi)[?!.\s]*$/)) {
    if (isAdmin && activeAdmin) {
      const fb: any = generateSmartAdminFallback(message, activeAdmin, farmersDb, commoditiesDb, {});
      return { reply: String(fb.reply || ""), quickReplies: fb.quickReplies || [], extracted: {}, isComplete: false, isAdminAction: true };
    }
    return {
      reply: "🌾 *Salam Berkah Petani!* Saya Kang Tani AI. Mau daftar lahan, cek harga pasar, atau konsultasi hama & pupuk?",
      quickReplies: ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini", "Konsultasi Hama Tanaman"],
      extracted: {}, isComplete: false, isAdminAction: false,
    };
  }
  // Identitas.
  if (bare(/^(aku siapa|siapa (saya|aku|gue)|kamu siapa|siapa kamu|who am i)\s*\??$/)) {
    if (isAdmin && activeAdmin) {
      return {
        reply: `👋 Halo Bpk/Ibu *${activeAdmin.nama}*!\n\nAnda terdaftar sebagai *${activeAdmin.role}* di sistem Kang Tani AI.\n🏢 *${activeAdmin.instansi}*\nAda yang bisa saya bantu?`,
        quickReplies: ["📊 Rekap Semua Petani", "🌶️ Analisis Anomali Cabai", "📥 Siapkan Ekspor Sheets"],
        extracted: {}, isComplete: false, isAdminAction: true,
      };
    }
    const me = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(effPhone));
    if (me) {
      return {
        reply: `👋 Halo *${me.nama}*!\n\nNomor ini terdaftar sebagai petani mitra (${me.komoditas || "-"}, ${me.luasLahan || "-"} Ha, ${me.kabupaten || me.alamat || "-"}). Status: *${me.statusVerifikasi}*. Ada yang bisa saya bantu?`,
        quickReplies: ["Cek Harga Pasar Hari Ini", "Konsultasi Hama Tanaman", "Cek Status Lahan Saya"],
        extracted: {}, isComplete: false, isAdminAction: false,
      };
    }
    return {
      reply: "👋 Halo! Nomor ini belum terdaftar sebagai petani mitra. Ketik *daftar* untuk mendaftarkan lahan, atau tanya harga pasar & hama langsung.",
      quickReplies: ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
      extracted: {}, isComplete: false, isAdminAction: false,
    };
  }
  // Makasih/oke — mengalah bila ada draf terbuka.
  if (!hasOpenDraft && clean.length <= 30 && bare(/^(makasih|terima kasih|thanks?|thank you|oke+|ok+|okay|siap+|baik+|mantap+|sip+)( banyak| banget)?[!.\s]*$/)) {
    return {
      reply: isAdmin ? "Sama-sama, Bpk/Ibu! 🙏 Ada lagi yang bisa saya bantu?" : "Sama-sama! 🙏 Ada lagi yang bisa saya bantu?",
      quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "🌶️ Analisis Anomali Cabai"] : ["Cek Harga Pasar Hari Ini", "Konsultasi Hama Tanaman"],
      extracted: {}, isComplete: false, isAdminAction: isAdmin,
    };
  }
  // Bantuan.
  if (clean.length <= 30 && bare(/^(bantuan|help|tolong|bisa apa|menu|panduan|info|fitur)[?.\s]*$/)) {
    if (isAdmin && activeAdmin) {
      return {
        reply: `🤖 *Bantuan Kang Tani AI (Admin)*\n\n• *Rekap & laporan* — "rekap semua petani", "analisis panen cabai"\n• *Verifikasi* — "tampilkan yang belum verifikasi"\n• *Broadcast* — "draf broadcast hama", "peringatan harga"\n• *Kas/Stok/HPP* — "catat kas", "stok urea keluar", "hitung hpp"\n• *Data* — "ekspor csv", "buka sheets"`,
        quickReplies: ["📊 Rekap Semua Petani", "Verifikasi Semua", "Buat Draf Broadcast WA"],
        extracted: {}, isComplete: false, isAdminAction: true,
      };
    }
    return {
      reply: `🤖 *Bantuan Kang Tani AI*\n\n• *Daftar lahan* — ketik "daftar" lalu ikuti panduan\n• *Harga pasar* — "cek harga cabai hari ini"\n• *Hama & pupuk* — ceritakan gejala + komoditas\n• *Status lahan* — "cek status lahan saya"`,
      quickReplies: ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini", "Konsultasi Hama Tanaman"],
      extracted: {}, isComplete: false, isAdminAction: false,
    };
  }
  return null;
}

// ---- Media AI bersama (dipakai /api/audio-transcribe + /api/wa-media) ----
const MEDIA_VISION_MODEL = "gemini-3.1-flash-lite"; // multimodal tercepat, teruji akurat
async function transcribeAudioBuffer(buf: Buffer, mime: string): Promise<{ transcription: string; extracted: any }> {
  const ai = getGemini();
  if (!ai) throw new Error("kunci AI belum valid");
  const prompt = `Dengarkan rekaman audio suara ini dari seorang petani atau petugas pertanian di Indonesia.
Lakukan:
0. ANTI-KARANGAN: jika audio TIDAK berisi ucapan manusia yang jelas (hening, nada/beep, derau, musik), isi "transcription" dengan string KOSONG dan semua "extracted" null. JANGAN PERNAH mengarang ucapan/nama/data dari suara non-ujaran.
1. Transkripsikan apa yang diucapkan secara verbatim dan akurat ke dalam teks bahasa Indonesia.
2. Analisis dan ekstrak data petani jika ada:
   - nama: nama petani (misal: "Pak Suparman", "Pak Ahmad", "Ibu Siti")
   - komoditas: tanaman pangan / hortikultura (misal: "Padi", "Jagung", "Cabai Rawit", "Bawang Merah")
   - varietas: varietas jika disebutkan (misal: "Ciherang", "Inpari 32", "Bisi 18")
   - luasLahan: angka dalam Hektar (misal 1.5 atau 0.5 atau jika dalam m2 konversi ke Ha)
   - luasLahanFormatted: teks string (misal: "1.5 Ha")
   - kabupaten: nama kabupaten/kota jika ada (misal: "Subang", "Karawang")
   - alamat: desa atau kecamatan jika ada
   - estimasiPanen: bulan atau waktu perkiraan panen jika disebutkan

Kembalikan HANYA format JSON valid tanpa tanda markdown:
{
  "transcription": "teks ucapan dalam rekaman",
  "extracted": {
    "nama": "nama atau null",
    "komoditas": "komoditas atau null",
    "varietas": "varietas atau null",
    "luasLahan": null,
    "luasLahanFormatted": null,
    "alamat": null,
    "kabupaten": null,
    "estimasiPanen": null
  }
}`;
  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: mime || "audio/webm", data: buf.toString("base64") } },
        { text: prompt },
      ],
    },
  ];
  const responseText = stripCodeFences(await generateMediaWithFallback(ai, contents));
  let parsed: any = {};
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
  } catch {
    parsed = { transcription: responseText.trim(), extracted: {} };
  }
  // Also run rule-based extractor on the transcribed text for high recall
  const ruleBased = extractFarmerFromText(parsed.transcription || "", {});
  return {
    transcription: parsed.transcription || "",
    extracted: { ...scrubUnmentionedEstimates(parsed.extracted, parsed.transcription || ""), ...(ruleBased.extracted || {}) },
  };
}
// ---- Asisten agronomi agenik: retrieval korpus terverifikasi ----
// Pola: keyword-gated (tanpa embedding) -> top-2 entri -> sitasi [REF-xxx] +
// eskalasi PPL. Dipakai Q&A chat (via callUniversalAI), kalkulator pupuk,
// dan langkah kedua analisis foto. Bukan RAG vektor; korpus starter dikurasi.
const REF_GATE_RE = /hama|penyakit|wereng|ulat|tikus|keong|jamur|cendawan|virus|bakteri|gulma|pupuk|dosis|obat|insektisida|fungisida|herbisida|tanaman|sawah|kebun|lahan|panen|padi|jagung|cabai|cabe|bawang|kedelai|agave|daun|akar|buah|bunga|layu|busuk|bercak|kuning|kerdil|keriting/i;
type RefHit = { ref: (typeof REFERENSI_PERTANIAN)[number]; skor: number };
function cariReferensiTani(teks: string, topN = 2): Array<(typeof REFERENSI_PERTANIAN)[number]> {
  try {
    const t = String(teks || "").toLowerCase();
    if (!REF_GATE_RE.test(t)) return [];
    const scored: RefHit[] = REFERENSI_PERTANIAN.map((r) => {
      let skor = 0;
      for (const k of r.kunci) if (k && t.includes(k.toLowerCase())) skor += 3;
      for (const c of r.komoditas) if (c && t.includes(c.toLowerCase())) skor += 2;
      return { ref: r, skor };
    }).filter((x) => x.skor >= 3).sort((a, b) => b.skor - a.skor);
    return scored.slice(0, Math.max(1, topN)).map((x) => x.ref);
  } catch {
    return [];
  }
}
const PPL_LINE = "🙏 Pastikan konfirmasi ke PPL/dinas setempat sebelum aplikasi.";
function blokReferensiLLM(tanya: string): string {
  const hits = cariReferensiTani(tanya, 2);
  if (hits.length === 0) return "";
  const daftar = hits.map((h) => `[${h.id}] ${h.judul} — ${h.isi} (Sumber: ${h.sumber})`).join("\n");
  return `[REFERENSI TERVERIFIKASI — pakai bila relevan dengan pertanyaan; jawab sebagai asisten agronomi: cantumkan kode [REF-xxx] tiap fakta dosis/produk, JANGAN mengarang dosis di luar referensi; tutup saran tanaman dengan: "${PPL_LINE}" Bila tak relevan, abaikan blok ini.]\n${daftar}`;
}
function rujukanPupuk(crop: string): string {
  const hits = cariReferensiTani(`pupuk ${crop} dosis`, 2).filter((h) => h.kategori === "pupuk");
  if (hits.length === 0) return "";
  return `\n\n📚 *Rujukan terverifikasi:*\n` + hits.map((h) => `• [${h.id}] ${h.judul} (${h.sumber})`).join("\n") + `\n${PPL_LINE}`;
}
// ---- Rekam kasus diagnosa foto (loop agenik: analisis -> padanan -> tindak lanjut) ----
const DIAGNOSA_FILE = path.join(DATA_DIR, "diagnosa_db.json");
function simpanKasusDiagnosa(c: { farmerId?: string; senderHash?: string; mediaPath?: string; ringkasan: string; matchIds: string[]; status: string }): string {
  try {
    const arr = readJsonSafe<any[]>(DIAGNOSA_FILE, [], "diagnosa_db.json");
    const list = Array.isArray(arr) ? arr : [];
    const id = nextId("DG", list.map((x) => x?.id).filter(Boolean));
    list.unshift({ id, ts: new Date().toISOString(), farmerId: c.farmerId || "", senderHash: c.senderHash || "", mediaPath: c.mediaPath || "", ringkasan: String(c.ringkasan || "").slice(0, 500), matchIds: c.matchIds || [], status: c.status });
    writeJsonAtomic(DIAGNOSA_FILE, list, "diagnosa_db.json");
    return id;
  } catch {
    return "";
  }
}
async function analyzeImageBuffer(buf: Buffer, mime: string, caption = ""): Promise<string> {
  const ai = getGemini();
  if (!ai) throw new Error("kunci AI belum valid");
  const cap = String(caption || "").trim().slice(0, 500);
  const prompt = `Kamu Kang Tani AI, asisten pertanian Indonesia di WhatsApp.
Deskripsikan foto ini singkat (maksimal 5 baris/bullet):
1. Apa isi foto (tanaman/hewan/lahan/dokumen/lainnya)?
2. Jika tanaman: kemungkinan komoditas + gejala hama/penyakit/kekurangan unsur yang terlihat (atau "tampak sehat" bila tak ada gejala jelas).
3. Satu saran tindak lanjut paling relevan (atau pertanyaan klarifikasi bila foto tak jelas).
ANTI-KARANGAN: jika foto kosong/tidak terbaca (hitam total, 1 piksel, buram total), katakan terus-terang fotonya tidak bisa dibaca dan JANGAN mengarang isi — abaikan caption bila visual tak mendukung. Jangan pernah membuat estimasi panen/tonase/waktu dari foto.
${cap ? `Konteks dari pengirim: "${cap}"\n` : ""}Jawab bahasa Indonesia santai-profesional, format WhatsApp (*bold*, bullet •). Tanpa pagar kode.`;
  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: mime || "image/jpeg", data: buf.toString("base64") } },
        { text: prompt },
      ],
    },
  ];
  return stripCodeFences(await generateMediaWithFallback(ai, contents)).trim();
}

// Media (voice+vision) memakai rantai model yang sama dengan teks: bila model
// utama 503/penuh, coba berikutnya. Tanpa ini 1 model down = seluruh media mati.
async function generateMediaWithFallback(ai: any, contents: any): Promise<string> {
  const models = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.8-flash"];
  let lastErr: any = null;
  for (const model of models) {
    try {
      const response: any = await ai.models.generateContent({
        model,
        contents,
        config: { abortSignal: AbortSignal.timeout(25000) },
      });
      let text = "";
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) text = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
      } catch {}
      if (!text && typeof response?.text === "string") text = response.text;
      if (text) {
        console.log(`[Gemini Media] model=${model} chars=${text.length}`);
        return text;
      }
      lastErr = new Error(`Respons kosong dari ${model}`);
    } catch (err: any) {
      lastErr = err;
      console.log(`[Gemini Media] Model ${model} fallback triggered (${err?.status || err?.message || err}), trying next...`);
    }
  }
  throw lastErr || new Error("All Gemini media models failed");
}

// Predikat intent bersama (satu-satunya sumber kebenaran; dipakai router + cabang).
function isRegistrationQuery(lower: string): boolean {
  return /daft[a-z]*|tambah(kan)?|input|masukkan|catat|simpan/.test(lower || "");
}
function isListingQuery(lower: string): boolean {
  return /semua|seluruh|\blist\b|tampilkan|lihat|yang belum|rekap|total|berapa|ringkas|analisis|laporan|agregat/.test(lower || "");
}
function isAnalyticsQuery(lower: string): boolean {
  const t = lower || "";
  return (
    t.includes("berapa") || t.includes("total") || t.includes("rekap") ||
    t.includes("daftar") || t.includes("analisis") || t.includes("laporan") ||
    t.includes("agregat") || t.includes("ringkasan")
  ) && (
    t.includes("luas") || t.includes("panen") || t.includes("ton") ||
    t.includes("hektar") || t.includes("petani") || t.includes("lahan") ||
    t.includes("komoditas") || t.includes("verifikasi")
  );
}

// Draf WA sisi server: forwarder stateless (tak kirim draf antar-pesan), sehingga
// pendaftaran multi-pesan via WA tak pernah lengkap tanpa ini. TTL 30 mnt, maks
// 500 pengirim. Restart = draf hilang (terdokumentasi, bukan bug).
const waDrafts = new Map<string, { farmer: any; supplier: any; cash: any; stock: any; hpp: any; updatedAt: number }>();
const WA_DRAFT_TTL_MS = 30 * 60 * 1000;
function blankWaDraft() { return { farmer: {}, supplier: {}, cash: {}, stock: {}, hpp: {} }; }
function getWaDraft(phone?: string) {
  if (!phone) return blankWaDraft();
  const d = waDrafts.get(phone);
  if (!d || Date.now() - d.updatedAt > WA_DRAFT_TTL_MS) {
    if (d) waDrafts.delete(phone);
    return blankWaDraft();
  }
  return d;
}
// Sanitasi nilai-hampa saat menyimpan draf: penulis draf kerap mengembalikan
// objek bentuk-penuh (mis. { farmerId: undefined } dari "catat kas" telanjang)
// yang hilang di JSON tapi terhitung Object.keys -> hasOpenDraft macet-true
// sementara cancel tak melihatnya. Selaraskan dengan semantik draftScore /
// draftHasAny: undefined/null/"" dianggap absen. Array tak pernah draf valid.
function cleanStoredDraft(o: any): any {
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  const c: any = {};
  for (const k of Object.keys(o)) {
    const v = (o as any)[k];
    if (v !== undefined && v !== null && v !== "") c[k] = v;
  }
  return c;
}
function saveWaDraft(phone: string | undefined, body: any) {
  if (!phone || !body || typeof body !== "object") return;
  let d = waDrafts.get(phone);
  if (!d || Date.now() - d.updatedAt > WA_DRAFT_TTL_MS) {
    d = { ...blankWaDraft(), updatedAt: 0 };
  }
  if (body.clearErpDrafts) { d.cash = {}; d.stock = {}; d.hpp = {}; }
  if (body.clearFarmerDraft) { d.farmer = {}; }
  if (body.clearSupplierDraft) { d.supplier = {}; }
  if (body.extracted && typeof body.extracted === "object") d.farmer = body.savedRecord ? {} : cleanStoredDraft(body.extracted);
  else if (body.savedRecord) d.farmer = {};
  if (body.extractedSupplier && typeof body.extractedSupplier === "object") d.supplier = body.savedSupplier ? {} : cleanStoredDraft(body.extractedSupplier);
  else if (body.savedSupplier) d.supplier = {};
  if (body.extractedCash && typeof body.extractedCash === "object") d.cash = body.savedCash ? {} : cleanStoredDraft(body.extractedCash);
  else if (body.savedCash) d.cash = {};
  if (body.extractedStock && typeof body.extractedStock === "object") d.stock = body.savedStock ? {} : cleanStoredDraft(body.extractedStock);
  else if (body.savedStock) d.stock = {};
  if (body.extractedHpp && typeof body.extractedHpp === "object") d.hpp = body.savedHpp ? {} : cleanStoredDraft(body.extractedHpp);
  else if (body.savedHpp) d.hpp = {};
  d.updatedAt = Date.now();
  waDrafts.delete(phone);
  waDrafts.set(phone, d);
  while (waDrafts.size > 500) {
    const oldest = waDrafts.keys().next().value;
    if (oldest === undefined) break;
    waDrafts.delete(oldest);
  }
}

// Router precedence eksplisit (telemetri + dokumen; cabang tetap early-return):
// batalkan > ERP > supplier > registrasi > analitik > harga > hama > smalltalk > LLM.
function detectTopIntent(
  message: string, isAdmin: boolean, activeAdmin: AdminUser | undefined,
  effPhone: string | undefined, hasOpenDraft: boolean
): string {
  const lower = String(message || "").toLowerCase();
  if (/^\s*batal/i.test(message || "")) return "cancel";
  if (detectErpIntent(lower, null) && !(/supplier|suplier|distributor/.test(lower) && /catat|tambah|daftar|baru/.test(lower) && !/\b(masuk|keluar)\b/.test(lower) && !ERP_QTY_UNIT_RE.test(lower))) return "erp"; // P0-6 telemetri
  if (isSupplierIntent(message)) return "supplier";
  if (isRegistrationQuery(lower) && !isListingQuery(lower) && !/daftar harga/.test(lower)) return "register"; // P0-2 telemetri
  if (isAdmin && isAnalyticsQuery(lower)) return "analytics";
  if (/harga|pasar|anomali/.test(lower)) return "price";
  if (/hama|penyakit|wereng|ulat|tikus|keong|sundep|blas|kresek|tungro/.test(lower)) return "hama";
  if (handleFastSmalltalk(message, isAdmin, activeAdmin, effPhone, hasOpenDraft)) return "smalltalk";
  return "llm";
}

// Rate limiter stdlib (tanpa dep). ponytail: ganti redis saat multi-instance.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(max: number, windowMs: number) {
  return (req: any, res: any, next: any) => {
    const ip = (req.ip || req.headers["x-forwarded-for"] || "local") as string;
    // Loopback bebas (tes lokal/health/dashboard mesin sendiri); trafik WA
    // produksi datang dari IP remote forwarder sehingga tetap dibatasi.
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    if (rateBuckets.size > 1000) for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
    const b = rateBuckets.get(key);
    if (!b || now > b.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    b.count += 1;
    if (b.count > max) {
      return res.status(429).json({ error: "Terlalu banyak permintaan, coba lagi nanti." });
    }
    next();
  };
}

function sanitizeText(s: unknown, maxLen = 2000): string {
  if (typeof s !== "string") return "";
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, maxLen).trim();
}
function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as any)[c]);
}
function escAttr(s: unknown): string {
  return escHtml(s).replace(/[\r\n]+/g, " ");
}
function maskPhone(hp: unknown): string {
  const s = String(hp || "");
  return s.length > 4 ? s.slice(0, -4).replace(/[0-9]/g, "•") + s.slice(-4) : "••••";
}

// ---------- Canonical event log (sumber data training; PII termasking) ----------
let eventsDb: any[] = [];
function emitCanonicalEvent(e: {
  source: string; entity: string; entityId: string; action: string;
  actor?: unknown; payload: Record<string, unknown>;
}) {
  try {
    const payload: Record<string, unknown> = { ...(e.payload || {}) };
    for (const k of ["noHp", "kontak", "senderPhone", "dicatatOleh", "generatedBy", "actor"]) {
      if (typeof payload[k] === "string" && payload[k]) payload[k] = maskPhone(payload[k]);
    }
    eventsDb.unshift({
      eventId: `EVT-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36)}`,
      ts: new Date().toISOString(),
      source: e.source, entity: e.entity, entityId: e.entityId,
      action: e.action,
      actor: typeof e.actor === "string" && e.actor ? maskPhone(e.actor) : "system",
      payload, schemaV: 1,
    });
    if (eventsDb.length > 5000) eventsDb.length = 5000;
    writeJsonAtomic(`${DATA_DIR}/events_db.json`, eventsDb, "events_db.json");
    // Cermin Sheets write-behind: antrean <1ms, worker background yang mengirim.
    const sk = { farmer: "farmer", supplier: "supplier", cash: "cash", stock: "stock", commodity: "commodity", feedback: "feedback" }[(e.entity || "").toLowerCase()];
    if (sk) enqueueSheetSync(sk as "farmer" | "supplier" | "cash" | "stock" | "commodity", e.entityId);
  } catch (err) {
    console.error("[Events] gagal menulis event kanonis:", err);
  }
}
function loadEventsDb(): void {
  try {
    const loaded = readJsonSafe<unknown>(`${DATA_DIR}/events_db.json`, [], "events_db.json");
    if (Array.isArray(loaded)) eventsDb = loaded as any[];
  } catch (err) {
    console.error("[Events] gagal memuat event kanonis:", err);
  }
}
function cleanHost(h: unknown, fb = "localhost:3000"): string {
  const s = String(h || fb).slice(0, 80);
  return /^[\w.\-:]+$/.test(s) ? s : fb;
}
const ADD_WORDS = ["tambah", "daftarkan", "daftar", "input", "masukkan", "catat", "simpan"];
function isAddRegex(lower: string): boolean {
  const l = lower || "";
  // Frasa pasif/tanya BUKAN aksi daftar: "terdaftar?", "pendaftaran", "daftar sebagai apa".
  // ("mendaftarkan" tetap aksi: tidak mengandung penanda pasif.)
  // P0-2: "daftar harga" milik cabang harga, bukan aksi daftar.
  if (/terdaftar|pendaftaran|daftar sebagai|daftar harga/.test(l)) return false;
  for (const w of ADD_WORDS) if (l.includes(w)) return true;
  return false;
}
// Pertanyaan/permintaan yang butuh penalaran atau penjelasan (bukan aksi data
// murni): ditempuh LLM, bukan templat deterministik. Dipakai bersama bypass,
// guard templat-draf admin+petani, dan guard fallback.
// Catatan: "simpan" SENGAJA tidak ada di sini (itu aksi tulis data).
function needsReasoningMsg(message: string): boolean {
  const lower = String(message || "").toLowerCase();
  if (lower.includes("?")) return true;
  return /analisis|rekomendasi|prediksi|kenapa|mengapa|bagaimana|\bkapan\b|apakah|jelaskan|bandingkan|\bapa\b|siapa|dimana|di mana|manfaat|benefit|keuntungan|kegunaan|tentang|program|tolong|bantu/.test(lower);
}
// Data/pendaftaran petani murni lebih cepat + tepat via jalur deterministik
// (<100ms) daripada LLM (~2-9 dtk). Pesan yang butuh penalaran (analisis,
// rekomendasi, tanya) tetap ke LLM; ekstraksi data ditempel terpisah.
function isDeterministicFarmerData(message: string, regHasMin: boolean): boolean {
  const lower = String(message || "").toLowerCase();
  return (isAddRegex(lower) || regHasMin) && !needsReasoningMsg(message);
}
// Anti-karangan estimasi (aturan user): nilai estimasiPanen/estimasiHasilTon
// dari LLM hanya dipakai bila ada buktinya di teks user (nama bulan/tahun
// untuk panen; angka+satuan untuk tonase). Draf yang sudah ada tak tersentuh.
function scrubUnmentionedEstimates(parsedExt: any, evidenceText: string): any {
  const ext = { ...(parsedExt || {}) };
  const lower = String(evidenceText || "").toLowerCase();
  const hasMonth = /januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|20\d\d|bulan\s+(depan|ini)|minggu\s+depan|tahun\s+depan/.test(lower);
  if (ext.estimasiPanen && !hasMonth) delete ext.estimasiPanen;
  const hasTon = /\d+(?:[.,]\d+)?\s*(?:ton|kuintal|kwintal|kg)\b/.test(lower);
  if (ext.estimasiHasilTon !== undefined && ext.estimasiHasilTon !== null && !hasTon) delete ext.estimasiHasilTon;
  // Lokasi/nama dari LLM wajib berjejak di teks (per token signifikan); jika
  // tidak, buang (anti-confabulation "Subang"). Komoditas/noHp dikecualikan
  // karena kanonisasi ("cabe"->"Cabai…") & format nomor yang sah.
  for (const k of ["kabupaten", "alamat", "nama"]) {
    const v = String((ext as any)[k] || "").trim();
    if (!v || v.toLowerCase() === "null") { delete (ext as any)[k]; continue; }
    const toks = v.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
    if (toks.length > 0 && !toks.some((t) => lower.includes(t))) delete (ext as any)[k];
  }
  return ext;
}

// ---------- ERP Chat: deteksi intent (regex dulu, Laya saat miss) ----------
const ERP_CASH_RE = /catat|biaya|pengeluaran|pemasukan|terjual|ongkos|\bbayar\b|\bkas\b|buku kas|modal tanam|jual gabah|panen laku|uang (masuk|keluar)|\brp\b|rupiah/;
const ERP_STOCK_RE = /stok (masuk|keluar|habis)|sisa stok|tambah stok|kurang stok|stok opname|barang (masuk|keluar)(?! kota| ke | dikirim| ekspedisi)|sisa barang|persediaan/; // P1-11
const ERP_HPP_RE = /\bhpp\b|biaya pokok|biaya per kilo|margin|untung per kilo|impas|\bbep\b|break even|modal per kilo/;
const ERP_QTY_UNIT_RE = /([\d][\d.,]*)\s*(sak|kg|liter|botol|bungkus|pak|unit|karung|ton)\b/;
function detectErpIntent(
  lower: string,
  laya: { intent: string; confidence: number } | null | undefined,
): "cash" | "stock" | "hpp" | null {
  const t = lower || "";
  // HPP dicek dulu: "biaya per kilo" mengandung kata umum "biaya" milik kas
  if (ERP_HPP_RE.test(t)) return "hpp";
  // P1-9: stok menang atas kas — "catat stok urea masuk 5 sak" milik stok.
  if (ERP_CASH_RE.test(t) && !ERP_STOCK_RE.test(t) && !(/\b(masuk|keluar)\b/.test(t) && ERP_QTY_UNIT_RE.test(t))) return "cash";
  if (ERP_STOCK_RE.test(t)) return "stock";
  // "urea keluar 5 sak": kata masuk/keluar + qty+satuan, tanpa kata "stok"
  // (\bmasuk\b tidak match "masukkan" milik alur daftar lahan)
  if (/\b(masuk|keluar)\b/.test(t) && ERP_QTY_UNIT_RE.test(t)) return "stock";
  if (laya && (laya.confidence || 0) >= 0.5) {
    if (laya.intent === "catat_kas") return "cash";
    if (laya.intent === "catat_stok") return "stock";
    if (laya.intent === "hitung_hpp") return "hpp";
  }
  return null;
}

function parseRupiah(text: string): number | undefined {
  const t = String(text || "").toLowerCase();
  const mult: Record<string, number> = { miliar: 1e9, milyar: 1e9, juta: 1e6, jt: 1e6, ribu: 1e3, rb: 1e3 };
  const m = t.match(/([\d][\d.,]*)\s*(miliar|milyar|juta|jt|ribu|rb)\b/);
  if (m) {
    const n = parseIdNumber(m[1]);
    if (n !== undefined) return Math.round(n * (mult[m[2]] || 1));
  }
  const rp = t.match(/\brp\b\.?\s*([\d][\d.,]*)/);
  if (rp) {
    const n = parseIdNumber(rp[1]);
    if (n !== undefined) return Math.round(n);
  }
  const bare = [...t.matchAll(/[\d][\d.,]*/g)].map((x) => x[0]);
  if (bare.length === 1) {
    const n = parseIdNumber(bare[0]);
    if (n !== undefined) return Math.round(n);
  }
  return undefined;
}

function parseQtySatuan(text: string): { qty?: number; satuan?: string } {
  const m = String(text || "").toLowerCase().match(/([\d][\d.,]*)\s*(sak|kg|kilogram|liter|botol|bungkus|pak|unit|karung|ton)\b/);
  if (!m) return {};
  const qty = parseIdNumber(m[1]);
  if (qty === undefined) return {};
  const unitMap: Record<string, string> = { kilogram: "kg", karung: "sak" };
  const satuan = unitMap[m[2]] || m[2];
  if (satuan === "ton") return { qty: Math.round(qty * 1000 * 100) / 100, satuan: "kg" };
  return { qty: Math.round(qty * 100) / 100, satuan };
}

function parseKg(text: string): number | undefined {
  const m = String(text || "").toLowerCase().match(/([\d][\d.,]*)\s*(ton|kg|kilo|kwintal|kuintal|kw)\b/);
  if (!m) return undefined;
  const n = parseIdNumber(m[1]);
  if (n === undefined) return undefined;
  const mult = m[2] === "ton" ? 1000 : m[2].startsWith("k") && m[2] !== "kg" && m[2] !== "kilo" ? 100 : 1;
  return Math.round(n * mult * 100) / 100;
}

// Identitas pemilik dari nomor pengirim, atau dari nama/noHp yang disebut di teks (admin)
function matchNameInText(lower: string, name: string): boolean {
  const n = (name || "").toLowerCase().trim();
  if (!n) return false;
  // Nama lengkap disebut utuh, atau >=2 kata khas (>=4 huruf) muncul di teks.
  // Mencegah nama kios panjang ("Kios Pupuk Lengkap ...") tak pernah cocok.
  if (lower.includes(n)) return true;
  const words = n.split(/[^a-z]+/).filter((w) => w.length >= 4);
  return words.filter((w) => lower.includes(w)).length >= 2;
}

function resolveChatFarmer(senderPhone: string | undefined, text: string): FarmerRecord | null {
  const scope = resolveErpScope(senderPhone);
  if (scope.farmerId) return farmersDb.find((f) => f.id === scope.farmerId) || null;
  if (!scope.isAdmin) return null;
  const phoneInText = String(text || "").match(/(\+?62[\d\s\-.]{9,}|08[\d\s\-.]{9,})/);
  if (phoneInText) {
    const norm = normalizePhone(phoneInText[1]);
    const byPhone = farmersDb.find((f) => normalizePhone(f.noHp) === norm);
    if (byPhone) return byPhone;
  }
  const lower = String(text || "").toLowerCase();
  const byName = farmersDb.find((f) => f.nama && f.nama.length >= 4 && matchNameInText(lower, f.nama));
  return byName || null;
}

function resolveChatSupplier(senderPhone: string | undefined, text: string): SupplierRecord | null {
  const scope = resolveErpScope(senderPhone);
  if (scope.supplierId) return suppliersDb.find((s) => s.id === scope.supplierId) || null;
  if (!scope.isAdmin) return null;
  const lower = String(text || "").toLowerCase();
  const byName = suppliersDb.find((s) => s.nama && s.nama.length >= 4 && matchNameInText(lower, s.nama));
  return byName || null;
}

// ---------- ERP Chat: ekstraksi (cerminan extractFarmerFromText) ----------
const CASH_KAT_MAP: Array<[string, RegExp]> = [
  ["Penjualan Panen", /jual|terjual|panen laku|penjualan/],
  ["Subsidi/Bantuan", /subsidi|bantuan|blt/],
  ["Pinjaman", /pinjam|hutang|kredit|kridit/],
  ["Benih", /benih|bibit/],
  ["Pupuk", /pupuk|urea|npk|\bza\b|sp-?36|kcl|organik/],
  ["Pestisida", /pestisida|insektisida|fungisida|herbisida|obat|racun/],
  ["Upah Tenaga", /upah|gaji|buruh|tenaga|borong/],
  ["Sewa Lahan/Alat", /sewa|traktor|bajak/],
  ["Transportasi", /transport|ongkir|bensin|angkut/],
  ["Irigasi/BBM", /irigasi|bbm|solar|pompa|diesel/],
  ["Cicilan", /cicil|angsur/],
];

function extractCashFromText(
  text: string,
  existing: Partial<CashTransaction> = {},
): { extracted: Partial<CashTransaction>; hasMinimumData: boolean } {
  const ext: Partial<CashTransaction> = { ...existing };
  const lower = (text || "").toLowerCase();
  if (/\b(jual|terjual|panen laku|pemasukan|diterima|dapat|terima)\b/.test(lower)) ext.jenis = "MASUK";
  else if (/\b(beli|bayar|pengeluaran|ongkos|biaya|modal)\b/.test(lower)) ext.jenis = "KELUAR";
  for (const [k, re] of CASH_KAT_MAP) {
    if (re.test(lower)) { ext.kategori = k; break; }
  }
  const rp = parseRupiah(text);
  if (rp !== undefined) ext.jumlahRp = rp;
  for (const c of commoditiesDb) {
    if (c.nama && lower.includes(c.nama.toLowerCase())) { ext.komoditas = c.nama; break; }
  }
  const mt = text.match(/\bMT-?\d{4}-?\d+\b/i);
  if (mt) ext.musimTanam = mt[0].toUpperCase().replace(/MT-?(\d{4})-?(\d+)/i, "MT-$1-$2");
  const hasMinimumData = !!ext.jenis && !!ext.kategori && ext.jumlahRp !== undefined;
  return { extracted: ext, hasMinimumData };
}

function extractStockFromText(
  text: string,
  existing: Partial<StockMutation> = {},
): { extracted: Partial<StockMutation>; hasMinimumData: boolean } {
  const ext: Partial<StockMutation> = { ...existing };
  const lower = (text || "").toLowerCase();
  if (/masuk|tambah|datang|beli|restock|kulak/.test(lower)) ext.arah = "MASUK";
  else if (/keluar|jual|terjual|kurang|habis|pakai/.test(lower)) ext.arah = "KELUAR";
  const qs = parseQtySatuan(text);
  if (qs.qty !== undefined) ext.qty = qs.qty;
  if (qs.satuan) {
    ext.satuan = STOCK_SATUAN.includes(qs.satuan) ? qs.satuan : ext.satuan;
  }
  // nama produk: kata kunci produk + maksimal 2 kata lanjutan, buang kata arah/satuan/angka
  const STOP_PRODUK = new Set(["keluar", "masuk", "tambah", "kurang", "sisa", "habis", "stok", "terjual", "kios", "toko", "sak", "kg", "liter", "botol", "bungkus", "pak", "unit", "karung", "ton"]);
  const prodM = lower.match(/(urea|npk|pupuk|benih|bibit|pestisida|insektisida|fungisida|herbisida|obat|traktor|beras|gabah|jagung|cabai|bawang)(?:\s+[a-z]+){0,2}/);
  if (prodM) {
    const words = prodM[0].split(/\s+/).filter((w) => !STOP_PRODUK.has(w) && !/^\d/.test(w));
    if (words.length) {
      const cand = sanitizeText(words.join(" "), 80);
      if (cand.length >= 3) ext.produk = cand;
    }
  }
  const hasMinimumData = !!ext.arah && ext.qty !== undefined && !!ext.satuan && !!ext.produk;
  return { extracted: ext, hasMinimumData };
}

export interface HppChatDraft {
  farmerId?: string;
  komoditas?: string;
  musimTanam?: string;
  volumePanenKg?: number;
  hargaJualPerKg?: number;
}

function extractHppFromText(text: string, existing: HppChatDraft = {}): { extracted: HppChatDraft; hasMinimumData: boolean } {
  const ext: HppChatDraft = { ...existing };
  const lower = (text || "").toLowerCase();
  for (const c of commoditiesDb) {
    if (c.nama && lower.includes(c.nama.toLowerCase())) { ext.komoditas = c.nama; break; }
  }
  const mt = text.match(/\bMT-?\d{4}-?\d+\b/i);
  if (mt) ext.musimTanam = mt[0].toUpperCase().replace(/MT-?(\d{4})-?(\d+)/i, "MT-$1-$2");
  const kg = parseKg(text);
  if (kg !== undefined) ext.volumePanenKg = kg;
  const rp = parseRupiah(text);
  if (rp !== undefined && /jual|harga/.test(lower)) {
    ext.hargaJualPerKg = rp;
  } else if (/jual|harga/.test(lower)) {
    // "jual 6500" tanpa satuan: angka terakhir yang bukan volume = harga jual
    const all = [...lower.matchAll(/[\d][\d.,]*/g)]
      .map((m) => parseIdNumber(m[0]))
      .filter((n): n is number => n !== undefined);
    const cand = all.reverse().find((n) => n !== ext.volumePanenKg);
    if (cand !== undefined) ext.hargaJualPerKg = cand;
  }
  const hasMinimumData = ext.volumePanenKg !== undefined;
  return { extracted: ext, hasMinimumData };
}

function parseIdNumber(raw: string): number | undefined {
  let num = String(raw || "").trim();
  if (!num) return undefined;
  if (num.includes(",")) {
    // "1.500.000,75" / "2,5": titik = ribuan, koma = desimal
    num = num.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(num)) {
    // "1.500.000" / "1.500": grup tepat 3 digit = pemisah ribuan
    num = num.replace(/\./g, "");
  } // satu titik non-ribuan ("1.5") dibiarkan sebagai desimal
  const n = parseFloat(num);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------- ERP Chat: kelengkapan + prompt (cerminan formatIncompleteFarmerPrompt) ----------
function checkCashCompleteness(d: Partial<CashTransaction> & { farmerId?: string }): { isComplete: boolean; missingFields: string[] } {
  const missing: string[] = [];
  if (!d.jenis) missing.push("jenis (MASUK/KELUAR)");
  if (!d.kategori) missing.push("kategori biaya");
  if (d.jumlahRp === undefined) missing.push("nominal rupiah");
  if (!d.farmerId) missing.push("petani pemilik");
  const allowed = d.jenis === "MASUK" ? CASH_KATEGORI_MASUK : d.jenis === "KELUAR" ? CASH_KATEGORI_KELUAR : [];
  if (d.jenis && d.kategori && !allowed.includes(d.kategori)) {
    missing.push(`kategori "${d.kategori}" tidak cocok untuk jenis ${d.jenis}`);
  }
  return { isComplete: missing.length === 0, missingFields: missing };
}

function checkStockCompleteness(d: Partial<StockMutation> & { supplierId?: string }): { isComplete: boolean; missingFields: string[] } {
  const missing: string[] = [];
  if (!d.supplierId) missing.push("kios pemilik");
  if (!d.produk) missing.push("nama produk");
  if (!d.satuan) missing.push("satuan (sak/kg/liter/...)");
  if (!d.arah) missing.push("arah (MASUK/KELUAR)");
  if (d.qty === undefined) missing.push("jumlah");
  return { isComplete: missing.length === 0, missingFields: missing };
}

function checkHppCompleteness(d: HppChatDraft): { isComplete: boolean; missingFields: string[] } {
  const missing: string[] = [];
  if (!d.farmerId) missing.push("petani pemilik");
  if (d.volumePanenKg === undefined) missing.push("volume panen (kg/ton)");
  return { isComplete: missing.length === 0, missingFields: missing };
}

function formatIncompleteErpPrompt(
  kind: "cash" | "stock" | "hpp",
  known: Record<string, any>,
  missing: string[],
): { reply: string; quickReplies: string[] } {
  const knownLines = Object.entries(known)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `• ${k}: *${v}*`)
    .join("\n");
  const ask =
    kind === "cash"
      ? "Contoh: 'catat beli pupuk 2 sak 350 ribu' atau 'jual gabah 13 juta'."
      : kind === "stock"
        ? "Contoh: 'stok urea masuk 50 sak' atau 'urea keluar 5 sak terjual'."
        : "Contoh: 'hitung HPP padi 5200 kg, jual 6500'.";
  return {
    reply:
      `🌾 *Catat, datanya belum lengkap:*\n${knownLines ? knownLines + "\n\n" : ""}` +
      `Mohon dilengkapi: ${missing.map((m) => `*${m}*`).join(", ")}.\n${ask}`,
    quickReplies: ["Batalkan", "Lihat Contoh Format"],
  };
}

function formatSuccessCash(entry: CashTransaction, sum: { saldo: number }): string {
  return (
    `✅ *Kas tercatat (${entry.id}):*\n` +
    `• ${entry.jenis} — ${entry.kategori}\n` +
    `• Nominal: Rp ${entry.jumlahRp.toLocaleString("id-ID")}\n` +
    (entry.komoditas ? `• Komoditas: ${entry.komoditas}\n` : "") +
    `• Saldo kas petani: Rp ${sum.saldo.toLocaleString("id-ID")}`
  );
}

function formatSuccessStock(entry: StockMutation, sisa: number): string {
  return (
    `✅ *Stok tercatat (${entry.id}):*\n` +
    `• ${entry.produk} ${entry.arah} ${entry.qty} ${entry.satuan}\n` +
    `• Sisa stok: ${sisa} ${entry.satuan}`
  );
}

async function handleErpChat(opts: {
  intent: "cash" | "stock" | "hpp";
  message: string;
  senderPhone?: string;
  cashDraft: Partial<CashTransaction>;
  stockDraft: Partial<StockMutation>;
  hppDraft: HppChatDraft;
}): Promise<any | null> {
  const { intent, message, senderPhone } = opts;
  const scope = resolveErpScope(senderPhone);

  if (intent === "cash") {
    if (!scope.isAdmin && !scope.farmerId) {
      return { reply: "⚠️ Nomor ini belum terdaftar sebagai petani/admin. Minta PPL mendaftarkan nomor Anda dulu via menu Admin.", quickReplies: ["Lihat Contoh Format"], isComplete: false };
    }
    const { extracted } = extractCashFromText(message, opts.cashDraft);
    const farmer = resolveChatFarmer(senderPhone, message);
    const merged: any = { ...extracted, farmerId: farmer ? farmer.id : (extracted as any).farmerId };
    const check = checkCashCompleteness(merged);
    if (!check.isComplete) {
      const p = formatIncompleteErpPrompt("cash", {
        Jenis: merged.jenis, Kategori: merged.kategori,
        Nominal: merged.jumlahRp !== undefined ? `Rp ${Number(merged.jumlahRp).toLocaleString("id-ID")}` : undefined,
        Komoditas: merged.komoditas, Petani: farmer ? farmer.nama : undefined,
      }, check.missingFields);
      return { reply: p.reply, quickReplies: p.quickReplies, extractedCash: merged, isComplete: false };
    }
    const r = processCashEntry({ ...merged, senderPhone });
    if (r.status !== 201) {
      return { reply: `⚠️ Gagal mencatat kas: ${r.body.error}`, quickReplies: ["Coba Lagi", "Lihat Contoh Format"], extractedCash: merged, isComplete: false };
    }
    const sum = cashSaldo(cashDb.filter((c) => c.farmerId === merged.farmerId));
    return {
      reply: formatSuccessCash(r.body as CashTransaction, sum),
      quickReplies: ["Lihat Saldo Kas", "Hitung HPP", "Catat Lagi"], extractedCash: {}, savedCash: r.body, isComplete: true,
    };
  }

  if (intent === "stock") {
    if (!scope.isAdmin && !scope.supplierId) {
      return { reply: "⚠️ Nomor ini belum terdaftar sebagai kios/admin. Minta PPL mendaftarkan nomor Anda dulu via menu Admin.", quickReplies: ["Lihat Contoh Format"], isComplete: false };
    }
    const { extracted } = extractStockFromText(message, opts.stockDraft);
    const supplier = resolveChatSupplier(senderPhone, message);
    const merged: any = { ...extracted, supplierId: supplier ? supplier.id : (extracted as any).supplierId };
    const check = checkStockCompleteness(merged);
    if (!check.isComplete) {
      const p = formatIncompleteErpPrompt("stock", {
        Produk: merged.produk, Arah: merged.arah,
        Jumlah: merged.qty !== undefined ? `${merged.qty} ${merged.satuan || ""}`.trim() : undefined,
        Kios: supplier ? supplier.nama : undefined,
      }, check.missingFields);
      return { reply: p.reply, quickReplies: p.quickReplies, extractedStock: merged, isComplete: false };
    }
    const r = processStockEntry({ ...merged, senderPhone });
    if (r.status !== 201) {
      return { reply: `⚠️ Gagal mencatat stok: ${r.body.error}`, quickReplies: ["Coba Lagi", "Lihat Contoh Format"], extractedStock: merged, isComplete: false };
    }
    const sisa = (stockSaldo(merged.supplierId, merged.produk).find((s) => s.satuan === merged.satuan)?.saldo) || 0;
    return {
      reply: formatSuccessStock(r.body as StockMutation, sisa),
      quickReplies: ["Cek Sisa Stok", "Catat Lagi"], extractedStock: {}, savedStock: r.body, isComplete: true,
    };
  }

  // hpp
  if (!scope.isAdmin && !scope.farmerId) {
    return { reply: "⚠️ Nomor ini belum terdaftar sebagai petani/admin. Minta PPL mendaftarkan nomor Anda dulu via menu Admin.", quickReplies: ["Lihat Contoh Format"], isComplete: false };
  }
  const { extracted } = extractHppFromText(message, opts.hppDraft);
  const farmer = resolveChatFarmer(senderPhone, message);
  const merged: HppChatDraft = { ...extracted, farmerId: farmer ? farmer.id : extracted.farmerId };
  const check = checkHppCompleteness(merged);
  if (!check.isComplete) {
    const p = formatIncompleteErpPrompt("hpp", {
      Komoditas: merged.komoditas, Musim: merged.musimTanam,
      "Volume panen": merged.volumePanenKg !== undefined ? `${merged.volumePanenKg} kg` : undefined,
      "Harga jual": merged.hargaJualPerKg !== undefined ? `Rp ${merged.hargaJualPerKg.toLocaleString("id-ID")}/kg` : undefined,
      Petani: farmer ? farmer.nama : undefined,
    }, check.missingFields);
    return { reply: p.reply, quickReplies: p.quickReplies, extractedHpp: merged, isComplete: false };
  }
  const r = processHppGenerate({ ...merged, senderPhone });
  if (r.status !== 201) {
    return { reply: `⚠️ Gagal menghitung HPP: ${r.body.error}`, quickReplies: ["Coba Lagi", "Lihat Contoh Format"], extractedHpp: merged, isComplete: false };
  }
  return {
    reply: formatSuccessHpp(r.body as HppReport),
    quickReplies: ["Hitung Lagi", "Catat Biaya"], extractedHpp: {}, savedHpp: r.body, isComplete: true,
  };
}

function formatSuccessHpp(r: HppReport): string {
  return (
    `✅ *HPP dihitung (${r.id}):*\n` +
    `• Total biaya: Rp ${r.totalBiayaRp.toLocaleString("id-ID")}\n` +
    `• Volume: ${r.volumePanenKg} kg → *HPP Rp ${r.hppPerKg.toLocaleString("id-ID")}/kg*\n` +
    (r.hargaJualPerKg !== undefined
      ? `• Margin: Rp ${(r.marginPerKg || 0).toLocaleString("id-ID")}/kg (${r.marginPersen || 0}%)\n`
      : "") +
    (r.totalPendapatanRp ? `• Pendapatan tercatat: Rp ${r.totalPendapatanRp.toLocaleString("id-ID")}` : "")
  );
}
// Laya intent sidecar (stdlib http, opt-in via LAYA_URL or local auto-daemon). Timeout 1.2s, cooldown 30s saat down.
// Lazy: hanya fetch saat regex belum yakin + cache 60 mnt. Regex hit -> 0ms overhead.
const LAYA_URL = (process.env.LAYA_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, "");
let layaUnavailableUntil = 0;
const layaCache = new Map<string, { v: { intent: string; confidence: number; model?: string; source?: string }; exp: number }>();

let layaProcess: ChildProcess | null = null;
// Kandidat interpreter: env LAYA_PYTHON diutamakan; Windows pakai "python" dulu
// karena alias Store "python3" gagal diam-diam. Fallback otomatis bila spawn gagal.
function layaPythonCandidates(): string[] {
  const env = (process.env.LAYA_PYTHON || "").trim();
  const rest = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  return env ? [env, ...rest.filter((c) => c !== env)] : rest;
}

function startLayaWith(pyScript: string, cmds: string[], startedAt: number = Date.now()) {
  if (!cmds.length) {
    console.log("[Laya Daemon Warning] Tidak ada interpreter Python yang bisa menjalankan sidecar.");
    return;
  }
  const [cmd, ...rest] = cmds;
  let errOut = "";
  try {
    layaProcess = spawn(cmd, [pyScript, "--port", "8787"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
  } catch (err: any) {
    console.log(`[Laya Daemon] ${cmd} gagal (${err?.message}); coba ${rest[0] || "-"}.`);
    startLayaWith(pyScript, rest, Date.now());
    return;
  }

  layaProcess.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[Laya Daemon] ${msg}`);
  });

  layaProcess.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    errOut += msg + "\n";
    if (msg) console.log(`[Laya Daemon Note] ${msg}`);
  });

  layaProcess.on("error", (err: Error) => {
    console.log(`[Laya Daemon] ${cmd} gagal (${err.message}); coba ${rest[0] || "-"}.`);
    startLayaWith(pyScript, rest, Date.now());
  });

  // Alias Store Windows: proses langsung exit dengan pesan Store -> fallback kandidat berikut
  layaProcess.on("exit", (code) => {
    if (code !== 0 && Date.now() - startedAt < 5000 && /microsoft store|was not found/i.test(errOut) && rest.length) {
      console.log(`[Laya Daemon] ${cmd} stub Store; fallback ke ${rest[0]}.`);
      startLayaWith(pyScript, rest, Date.now());
    }
  });

  const cleanup = () => {
    if (layaProcess && !layaProcess.killed) {
      try {
        layaProcess.kill();
      } catch {}
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit();
  });
}

function initLayaDaemon() {
  if (process.env.DISABLE_LAYA_SIDECAR === "true") return;
  try {
    const pyScript = path.join(process.cwd(), "laya_sidecar.py");
    if (!fs.existsSync(pyScript)) return;
    startLayaWith(pyScript, layaPythonCandidates());
  } catch (err: any) {
    console.log(`[Laya Daemon Warning] Failed to start sidecar: ${err.message}`);
  }
}

async function getLayaIntent(message: string): Promise<{ intent: string; confidence: number; model?: string; source?: string } | null> {
  if (!message || !LAYA_URL || Date.now() < layaUnavailableUntil) return null;
  const key = message.slice(0, 200).toLowerCase();
  const hit = layaCache.get(key);
  if (hit) {
    if (Date.now() < hit.exp) return hit.v;
    layaCache.delete(key);
  }
  if (layaCache.size > 2000) {
    for (const [k, v] of layaCache) {
      if (Date.now() > v.exp) layaCache.delete(k);
      if (layaCache.size <= 1500) break;
    }
  }
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1200);
    const res = await fetch(`${LAYA_URL}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message.slice(0, 2000) }),
      signal: c.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`laya ${res.status}`);
    const j: any = await res.json();
    if (!j?.intent) return null;
    const v = {
      intent: String(j.intent),
      confidence: Number(j.confidence || 0),
      model: j.model ? String(j.model) : undefined,
      source: "laya_sidecar",
    };
    layaCache.set(key, { v, exp: Date.now() + 3600000 });
    console.log(`[Laya Decision] Intent: "${v.intent}" (${(v.confidence * 100).toFixed(1)}%) for "${message.slice(0, 30)}..."`);
    return v;
  } catch {
    layaUnavailableUntil = Date.now() + 30000;
    return null;
  }
}

// 1. Targeted & Summarized Context Builder (No massive raw JSON dumps!)
function buildLeanTargetedContext(message: string, isAdmin: boolean) {
  const lower = (message || "").toLowerCase();

  const totalLuas = farmersDb.reduce((acc, f) => acc + (f.luasLahan || 0), 0).toFixed(1);
  const totalPanen = farmersDb.reduce((acc, f) => acc + (f.estimasiHasilTon || 0), 0).toFixed(1);
  const unverified = farmersDb.filter((f) => f.statusVerifikasi !== "Terverifikasi");

  // Aggregate stats per crop
  const cropSummary: Record<string, { count: number; luas: number; ton: number }> = {};
  for (const f of farmersDb) {
    const key = f.komoditas ? f.komoditas.split(" ")[0] : "Lainnya";
    if (!cropSummary[key]) cropSummary[key] = { count: 0, luas: 0, ton: 0 };
    cropSummary[key].count += 1;
    cropSummary[key].luas += f.luasLahan || 0;
    cropSummary[key].ton += f.estimasiHasilTon || 0;
  }
  const cropLine = Object.entries(cropSummary)
    .map(([k, v]) => `${k}: ${v.count} petani (${v.luas.toFixed(1)} Ha, ~${v.ton.toFixed(1)} Ton)`)
    .join(" | ");

  // Targeted on-demand retrieval: only attach specific records if asked!
  const mentionsCabai = lower.includes("cabai") || lower.includes("rawit");
  const mentionsPadi = lower.includes("padi") || lower.includes("beras");
  const mentionsBawang = lower.includes("bawang");
  const mentionsJagung = lower.includes("jagung");
  const mentionsVerifikasi = lower.includes("verifikasi") || lower.includes("pending") || lower.includes("belum");
  const mentionsAll = lower.includes("semua petani") || lower.includes("daftar semua") || lower.includes("rekap semua") || lower.includes("seluruh petani") || lower.includes("direktori");

  const kabList = ["subang", "karawang", "brebes", "kediri", "malang", "blitar", "garut", "cianjur", "nganjuk"];
  const matchedKab = kabList.find((k) => lower.includes(k));

  const matchedFarmer = farmersDb.find((f) => {
    const fn = f.nama.toLowerCase().replace(/^(pak|bu|bapak|ibu)\s+/, "");
    return fn.length > 2 && lower.includes(fn);
  });

  let targetedDetails = "";
  let detailsType = "none";

  if (matchedFarmer) {
    detailsType = "single_farmer";
    targetedDetails = `DATA DETAIL PETANI YANG DITANYAKAN:
- Nama: ${matchedFarmer.nama} (ID: ${matchedFarmer.id})
- Kontak: ${isAdmin ? maskPhone(matchedFarmer.noHp) : "(disembunyikan — hanya admin)"}
- Komoditas: ${matchedFarmer.komoditas} (${matchedFarmer.varietas || "Unggul"})
- Luas: ${matchedFarmer.luasLahan} Ha | Panen: ${matchedFarmer.estimasiPanen} (~${matchedFarmer.estimasiHasilTon} Ton)
- Lokasi: ${matchedFarmer.alamat}, ${matchedFarmer.kabupaten}
- Status: ${matchedFarmer.statusVerifikasi}`;
  } else if (mentionsVerifikasi) {
    detailsType = "unverified_list";
    targetedDetails = `DATA PETANI BELUM DIVERIFIKASI (${unverified.length} orang):
${unverified.map((u) => `• ${u.nama} | ${u.komoditas} ${u.luasLahan} Ha | ${u.kabupaten}`).join("\n") || "Semua sudah terverifikasi."}`;
  } else if (matchedKab) {
    detailsType = `kabupaten_${matchedKab}`;
    const kabFarmers = farmersDb.filter((f) => (f.kabupaten || "").toLowerCase().includes(matchedKab));
    targetedDetails = `DATA PETANI DI KABUPATEN ${matchedKab.toUpperCase()} (${kabFarmers.length} orang):
${kabFarmers.slice(0, 5).map((f) => `• ${f.nama} | ${f.komoditas} ${f.luasLahan} Ha | Panen: ${f.estimasiPanen}`).join("\n")}`;
  } else if (mentionsCabai || mentionsPadi || mentionsBawang || mentionsJagung) {
    const cropName = mentionsCabai ? "Cabai" : mentionsPadi ? "Padi" : mentionsBawang ? "Bawang" : "Jagung";
    detailsType = `crop_${cropName}`;
    const matchedFarmers = farmersDb.filter((f) => (f.komoditas || "").toLowerCase().includes(cropName.toLowerCase()));
    const matchedCom = commoditiesDb.find((c) => c.nama.toLowerCase().includes(cropName.toLowerCase()));
    targetedDetails = `DATA SPESIFIK KOMODITAS ${cropName.toUpperCase()}:
${matchedCom ? `• Harga live TIDAK ada di konteks (data seed basi) — JANGAN sebut angka; arahkan user: "cek harga ${cropName}".` : ""}
• Petani Terdata (${matchedFarmers.length} orang):
${matchedFarmers.slice(0, 5).map((f) => `• ${f.nama} (${f.kabupaten || f.alamat}, ${f.luasLahan} Ha, est. ${f.estimasiHasilTon} Ton, panen ${f.estimasiPanen})`).join("\n")}`;
  } else if (mentionsAll && isAdmin) {
    detailsType = "directory";
    targetedDetails = `DIREKTORI RINGKAS (Total ${farmersDb.length} petani):
${farmersDb.slice(0, 8).map((f) => `• ${f.nama} | ${f.komoditas} ${f.luasLahan} Ha | ${f.kabupaten} | Panen: ${f.estimasiPanen}`).join("\n")}
${farmersDb.length > 8 ? `...dan ${farmersDb.length - 8} petani lainnya tercatat di Google Sheets.` : ""}`;
  }

  // ANTI-BASI: seed commoditiesDb berumur hari/minggu — angka Rp & status trennya
  // PERNAH dikutip LLM sebagai "hari ini" (kasus Rp78.500). Konteks hanya bawa
  // NAMA komoditas; angka pasti selalu via jalur harga live. Aturan prompt no.4
  // di kedua system prompt adalah backstop kedua.
  let marketHighlight = "";
  if (lower.includes("harga") || lower.includes("pasar") || mentionsCabai || mentionsPadi || mentionsBawang || mentionsJagung) {
    marketHighlight = `KOMODITAS PANTAUAN PASAR (nama saja — angka & tren di konteks ini BASI, JANGAN dikutip):
${commoditiesDb.map((c) => `• ${c.nama}`).join("\n")}
Angka rupiah pasti HANYA dari jawaban "cek harga <komoditas>" (jalur live).`;
  } else {
    const anomalies = commoditiesDb.filter((c) => c.statusAnomali !== "NORMAL");
    if (anomalies.length > 0) {
      marketHighlight = `KOMODITAS PANTAUAN: ${anomalies.map((a) => a.nama).join(", ")}. Angka & status tren terkini TIDAK tersedia di konteks ini — JANGAN dikarang; arahkan user bertanya "cek harga <komoditas>".`;
    }
  }

  return {
    summary: `RINGKASAN STATISTIK: ${farmersDb.length} Petani Terdata, Luas ${totalLuas} Ha, Proyeksi Panen ${totalPanen} Ton.\nKomoditas: ${cropLine}.\nBelum Diverifikasi: ${unverified.length} petani.`,
    targetedDetails,
    marketHighlight,
    detailsType,
  };
}

async function callNineRouterChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  modelOverride?: string,
  options?: { signal?: AbortSignal; maxTokens?: number }
): Promise<string> {
  const cfg = getNineRouterConfig();
  if (!cfg.isConfigured) {
    throw new Error("9Router belum dikonfigurasi");
  }

  let model = modelOverride || cfg.model;
  if (model === "combo1") {
    model = "gpt-4.1";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);

  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      controller.abort();
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.key) {
    headers["Authorization"] = `Bearer ${cfg.key}`;
  }

  const doChatCall = async (modelToUse: string) => {
    return fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelToUse,
        messages,
        temperature: 0.2,
        max_tokens: options?.maxTokens || 550,
      }),
      signal: controller.signal,
    });
  };

  try {
    let res = await doChatCall(model);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");

      // Auto-fallback if 9Router mentions available models (e.g. integrator vscode-chat)
      const availableMatch = errText.match(/Available models:\s*\[([^\]]+)\]/i);
      if (availableMatch && availableMatch[1]) {
        const availableModels = availableMatch[1]
          .split(/[\s,]+/)
          .map((m) => m.trim().replace(/['"]/g, ""))
          .filter(Boolean);

        const candidate =
          availableModels.find((m) => m === "gpt-4.1" || m.includes("claude-fable") || m.includes("gpt")) ||
          availableModels[0];

        if (candidate && candidate !== model) {
          console.log(`[9Router] Model ${model} not permitted by gateway, auto-retrying with: ${candidate}`);
          const retryRes = await doChatCall(candidate);
          if (retryRes.ok) {
            const data: any = await retryRes.json();
            const content = data?.choices?.[0]?.message?.content;
            if (content) return content;
          }
        }
      }

      throw new Error(`9Router error ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Respon 9Router kosong atau tidak memiliki format choices[0].message.content");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

// ==========================================
// NVIDIA NIM Provider (OpenAI-compatible /v1/chat/completions)
// Default: z-ai/glm-5.3-flash (gratis s.d. 40 RPM, multimodal teks+gambar).
// Cadangan utama Gemini; gagal -> 9Router -> Gemini -> rule_based.
// ==========================================
function getNimConfig() {
  let url = process.env.NVIDIA_NIM_URL?.trim() || "https://integrate.api.nvidia.com/v1";
  const key = process.env.NVIDIA_NIM_KEY?.trim() || "";
  const model = process.env.NVIDIA_NIM_MODEL?.trim() || "z-ai/glm-5.3-flash";
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) {
    url = `${url}/v1`;
  }
  const isConfigured = Boolean(key && key.length > 10);
  return { url, key, model, isConfigured };
}

async function callNimChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  modelOverride?: string,
  options?: { signal?: AbortSignal; maxTokens?: number; timeoutMs?: number }
): Promise<string> {
  const cfg = getNimConfig();
  if (!cfg.isConfigured) {
    throw new Error("NVIDIA NIM belum dikonfigurasi (NVIDIA_NIM_KEY kosong)");
  }
  const model = modelOverride || cfg.model;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, options?.timeoutMs || 7000));
  if (options?.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeout);
      controller.abort();
    }
    options.signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      controller.abort();
    });
  }
  try {
    const res = await fetch(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: options?.maxTokens || 550,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`NIM error ${res.status}: ${errText.substring(0, 200)}`);
    }
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    // Model reasoning: konten bisa array parts -> gabung teksnya.
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("")
      : "";
    if (!text) {
      throw new Error("Respon NIM kosong atau tanpa choices[0].message.content");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ==========================================
// Meta Model API Provider (Hackathon: Muse Spark via https://api.meta.ai/v1)
// OpenAI-compatible /v1/chat/completions, auth: Bearer META_MODEL_KEY (format LLM|id|secret)
// Dipakai pertama bila dikonfigurasi; gagal -> 9Router -> Gemini -> rule_based.
// ==========================================
function getMetaModelConfig() {
  let url = process.env.META_MODEL_URL?.trim() || "https://api.meta.ai/v1";
  const key = process.env.META_MODEL_KEY?.trim() || "";
  const model = process.env.META_MODEL_MODEL?.trim() || "muse-spark-1.3";

  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) {
    url = `${url}/v1`;
  }

  const isConfigured = Boolean(key && key.length > 10);
  return { url, key, model, isConfigured };
}

async function checkMetaModelHealth(): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
  const cfg = getMetaModelConfig();
  if (!cfg.isConfigured) {
    return { ok: false, message: "META_MODEL_KEY belum dikonfigurasi di environment." };
  }
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${cfg.url}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.key}` },
      signal: controller.signal,
    });
    const latency = Date.now() - startTime;
    if (res.ok) {
      return { ok: true, latencyMs: latency, message: `Terhubung ke Meta Model API (${cfg.model})` };
    }
    return { ok: false, latencyMs: latency, message: `Meta Model API status: ${res.status}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Gagal menghubungi Meta Model API" };
  } finally {
    clearTimeout(timeout);
  }
}

async function callMetaModelChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  modelOverride?: string,
  options?: { signal?: AbortSignal; maxTokens?: number; timeoutMs?: number }
): Promise<string> {
  const cfg = getMetaModelConfig();
  if (!cfg.isConfigured) {
    throw new Error("Meta Model API belum dikonfigurasi (META_MODEL_KEY kosong)");
  }
  const model = modelOverride || cfg.model;
  const controller = new AbortController();
  // Muse Spark selalu reasoning sebelum menjawab -> default 25 dtk; chat oper 7 dtk via options.
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs || 25000);
  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      controller.abort();
    });
  }
  try {
    const res = await fetch(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: options?.maxTokens || 550,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Meta Model API error ${res.status}: ${errText.substring(0, 200)}`);
    }
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Respon Meta Model API kosong atau tidak memiliki format choices[0].message.content");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

// Lazy initialize Gemini client
let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  if (!geminiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      geminiClient = new GoogleGenAI({ apiKey: key });
    }
  }
  return geminiClient;
}

// Helper to invoke Gemini with automatic model fallback & cancellation/token limit support
async function callGeminiGenerate(
  ai: GoogleGenAI,
  contents: any,
  options?: { signal?: AbortSignal; maxOutputTokens?: number; systemInstruction?: string }
): Promise<{ text: string; model: string }> {
  // lite dulu (1.8 dtk, teruji akurat); 3.5 reasoning (~9 dtk) hanya cadangan.
  // Keluarga 2.x/2.0 mati untuk kunci baru (404) -> jangan buang waktu retry.
  const models = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.8-flash"];
  let lastErr: any = null;

  for (const model of models) {
    if (options?.signal?.aborted) {
      throw new Error("AI Generation dibatalkan oleh pengguna (hemat biaya)");
    }
    let timer: any = null;
    try {
      // Pagu khusus Gemini: model reasoning (3.5-flash) memakai jatah output
      // untuk thinking internal; 550 token hanya menyisakan ~20 token teks
      // (finish=MAX_TOKENS di 59 karakter). Prompt "padat" tetap menekan
      // pemakaian aktual; pagu bukan belanja.
      const geminiBudget = Math.max(options?.maxOutputTokens || 550, 2048);
      const callPromise = ai.models.generateContent({
        model,
        contents,
        config: {
          maxOutputTokens: geminiBudget,
          abortSignal: options?.signal,
          temperature: 0.2,
          systemInstruction: options?.systemInstruction,
        },
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout (15s) calling ${model}`)), 15000);
      });
      const res: any = await Promise.race([callPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      // Ekstraksi robust: gabung semua part teks (res.text kadang parsial).
      let text = "";
      try {
        const parts = res?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) text = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
      } catch {}
      if (!text && res && typeof res.text === "string") text = res.text;
      const finish = res?.candidates?.[0]?.finishReason || "?";
      if (text) {
        console.log(`[Gemini] model=${model} chars=${text.length} finish=${finish}`);
        return { text, model };
      }
      lastErr = new Error(`Respons kosong dari ${model} (finish=${finish})`);
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      if (options?.signal?.aborted || err?.name === "AbortError" || err?.message?.includes("Abort")) {
        throw new Error("AI Generation dibatalkan oleh pengguna (hemat biaya)");
      }
      const errMsg = err?.status || err?.message || err;
      console.log(`[Gemini Info] Model ${model} fallback triggered (${errMsg}), trying next available model...`);
    }
  }
  throw lastErr || new Error("All Gemini models failed");
}

// Universal AI Caller with Priority Chain, Cancellation Support & Token Guarding
// ---- F5: ack cepat untuk query berat (anti-abort forwarder 8 dtk) ----
// WA berpacu dengan LLM: bila > ACK_AFTER_MS, balas ack sekarang + jawaban
// asli susulan via sendWaText langsung (masih dalam sesi 24 jam user).
// 7000: jawaban terstruktur LLM p50 ~5-6 dtk; 1 dtk margin ke budget 8 dtk.
const ACK_AFTER_MS = Math.max(1000, Number(process.env.ACK_AFTER_MS || "7000") || 7000);
const ACK_BG_CAP_MS = Math.max(15000, Number(process.env.ACK_BG_CAP_MS || "45000") || 45000);
const ACK_TEXT = "⏳ Mohon izin memproses pertanyaan Anda, mohon tunggu sebentar. Jawabannya akan saya kirim segera setelah siap.";
const ACK_UNKNOWN = "Maaf, saya belum mengetahui hal ini. Terima kasih, ini akan menjadi bahan pengembangan Hai Tani.";
function extractAckReplyText(text: string): string {
  const t = stripCodeFences(String(text || "")).trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (typeof j.reply === "string" && j.reply.trim()) return j.reply.trim().slice(0, 3500);
    } catch { /* jatuh ke teks mentah */ }
  }
  return t.slice(0, 3500);
}
// Susulan ack: kirim jawaban asli (v1 answer-only, tanpa simpan draf/registrasi).
function deliverAckFollowup(kind: "admin" | "petani", phone: string, question: string, p: Promise<{ text: string; provider: string; model: string }>): void {
  const t0 = Date.now();
  p.then(
    async (r) => {
      const extracted = extractAckReplyText(r.text);
      if (!extracted) { try { logFeedback(phone, "TIDAK_TAHU", question, "ack-followup kosong"); } catch {} }
      else if (extracted.includes("belum mengetahui hal ini")) { try { logFeedback(phone, "TIDAK_TAHU", question, "ack-followup jujur"); } catch {} }
      const reply = extracted || ACK_UNKNOWN;
      const sent = await sendWaText(phone, reply).catch((e) => ({ to: phone, ok: false as const, error: String(e).slice(0, 200) }));
      console.log(`[Ack] susulan ${kind} ${maskPhone(phone)} ${sent.ok ? "TERKIRIM" : "GAGAL " + (sent.error || "")} ${Date.now() - t0}ms`);
      try {
        trainingLog({ kind: "chat", channel: "wa", role: kind === "admin" ? "admin" : "petani", phoneHash: hashPhone(phone), in: clipText(`[ack-susulan] ${question}`), out: clipText(reply), provider: String(r.provider || ""), model: String(r.model || ""), ms: Date.now() - t0, intent: "ack_followup" });
      } catch { /* statistik saja */ }
      emitCanonicalEvent({ source: "wa-chat", entity: "ack", entityId: `ack-${Date.now().toString(36)}`, action: "followup", actor: phone, payload: { kind, ok: sent.ok } });
    },
    async (e) => {
      try { logFeedback(phone, "TIDAK_TAHU", question, "ack-followup gagal-LLM"); } catch {}
      const sent = await sendWaText(phone, ACK_UNKNOWN).catch((er) => ({ to: phone, ok: false as const, error: String(er).slice(0, 200) }));
      console.log(`[Ack] susulan ${kind} ${maskPhone(phone)} gagal-LLM (${String((e as any)?.message || e).slice(0, 80)}) kirim-jujur:${sent.ok ? "OK" : "GAGAL"}`);
      emitCanonicalEvent({ source: "wa-chat", entity: "ack", entityId: `ack-${Date.now().toString(36)}`, action: "followup_fail", actor: phone, payload: { kind, error: String((e as any)?.message || e).slice(0, 120) } });
    },
  );
}
async function callUniversalAI(
  systemPrompt: string,
  userPrompt: string,
  history?: Array<{ sender: string; text: string }>,
  options?: { signal?: AbortSignal; maxOutputTokens?: number; timeoutMs?: number }
): Promise<{ text: string; provider: "9router" | "gemini" | "meta" | "nim"; model: string }> {
  if (options?.signal?.aborted) {
    throw new Error("Operasi dibatalkan sebelum pengiriman (hemat token)");
  }

  const metaCfg = getMetaModelConfig();
  const nimCfg = getNimConfig();
  const nineRouterCfg = getNineRouterConfig();
  let nineRouterErr: any = null;
  let nimErr: any = null;
  let metaErr: any = null;

  // Compact conversation history: keep only last 2-3 exchanges, trim length
  const compactHistory = (history || [])
    .slice(-3)
    .map((h) => ({
      sender: h.sender,
      text: (h.text || "").length > 200 ? (h.text || "").slice(0, 200) + "..." : h.text,
    }));

  // Grounding korpus terverifikasi: tanpa hit => prompt utuh tak berubah.
  const refCtxAgro = blokReferensiLLM(userPrompt);
  const userAugmented = refCtxAgro ? `${refCtxAgro}\n\nPERTANYAAN (patuhi blok referensi di atas):\n"${userPrompt}"` : userPrompt;
  // Bangun messages OpenAI-compatible sekali; dipakai Meta, NIM & 9Router
  const chatMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (systemPrompt) {
    chatMessages.push({ role: "system", content: systemPrompt });
  }
  for (const h of compactHistory) {
    chatMessages.push({
      role: h.sender === "bot" ? "assistant" : "user",
      content: h.text,
    });
  }
  chatMessages.push({ role: "user", content: userAugmented });

  // 1. Meta Model API (Muse Spark) bila dikonfigurasi — prioritas untuk hackathon.
  // Gagal-cepat 2.5 dtk: endpoint sering timeout; budget forwarder WA hanya 8 dtk.
  if (metaCfg.isConfigured) {
    try {
      const text = await callMetaModelChat(chatMessages, undefined, {
        signal: options?.signal,
        maxTokens: options?.maxOutputTokens || 550,
        timeoutMs: Math.min(options?.timeoutMs || 7000, 2500),
      });
      console.log(`[AI Dispatcher] Balasan via Meta Model API (${metaCfg.model})`);
      return { text, provider: "meta", model: metaCfg.model };
    } catch (err: any) {
      if (options?.signal?.aborted) throw err;
      metaErr = err;
      console.warn(`[Meta Model API Warning] Pemanggilan Meta gagal (${err.message}). Beralih ke 9Router...`);
    }
  }

  // 2. NVIDIA NIM (GLM) bila dikonfigurasi — cadangan utama saat Gemini gangguan.
  // Batas 6 dtk: NIM yang hang (0 byte, kasus 31 Okt 2026) harus gagal-cepat
  // ke Gemini, bukan menahan rantai.
  if (nimCfg.isConfigured) {
    try {
      const text = await callNimChat(chatMessages, undefined, {
        signal: options?.signal,
        maxTokens: options?.maxOutputTokens || 550,
        timeoutMs: Math.min(options?.timeoutMs || 7000, 6000),
      });
      console.log(`[AI Dispatcher] Balasan via NVIDIA NIM (${nimCfg.model})`);
      return { text, provider: "nim", model: nimCfg.model };
    } catch (err: any) {
      if (options?.signal?.aborted) throw err;
      nimErr = err;
      console.warn(`[NIM Warning] Pemanggilan NIM gagal (${err.message}). Beralih ke 9Router...`);
    }
  }

  // 3. Coba 9Router jika NINEROUTER_URL dikonfigurasi
  if (nineRouterCfg.isConfigured) {
    try {
      const text = await callNineRouterChat(chatMessages, undefined, {
        signal: options?.signal,
        maxTokens: options?.maxOutputTokens || 550,
      });
      console.log(`[AI Dispatcher] Balasan via 9Router (${nineRouterCfg.model})`);
      return { text, provider: "9router", model: nineRouterCfg.model };
    } catch (err: any) {
      if (options?.signal?.aborted) throw err;
      nineRouterErr = err;
      console.warn(`[9Router Warning] Pemanggilan 9Router gagal (${err.message}). Beralih ke Google Gemini...`);
    }
  }

  // 4. Fallback ke Google Gemini API
  const ai = getGemini();
  if (ai) {
    const historyFormatted = compactHistory
      .map((h: any) => `${h.sender === "bot" ? "Kang Tani AI" : "User"}: ${h.text}`)
      .join("\n");

    const contents = [
      {
        role: "user",
        parts: [
          {
            text: `${systemPrompt}\n\n${
              historyFormatted ? `RIWAYAT PERCAKAPAN SINGKAT:\n${historyFormatted}\n\n` : ""
            }PERTANYAAN PENGGUNA:\n"${userAugmented}"`,
          },
        ],
      },
    ];

    const g = await callGeminiGenerate(ai, contents, {
      signal: options?.signal,
      maxOutputTokens: options?.maxOutputTokens || 550,
    });
    console.log(`[AI Dispatcher] Balasan via Google Gemini API (${g.model})`);
    return { text: g.text, provider: "gemini", model: g.model };
  }

  throw new Error(
    metaErr || nimErr || nineRouterErr
      ? `AI gagal (Meta: ${metaErr?.message || "tidak dicoba"}; NIM: ${nimCfg.isConfigured ? nimErr?.message || "tidak dicoba" : "tidak dikonfigurasi"}; 9Router: ${nineRouterCfg.url || nineRouterCfg.key ? nineRouterErr?.message || "tidak dicoba" : "tidak dikonfigurasi"}; Gemini: ${getGemini() ? "gagal" : "tidak tersedia"})`
      : "Tidak ada provider AI yang aktif (META_MODEL_KEY, NVIDIA_NIM_KEY, NINEROUTER_URL, atau GEMINI_API_KEY belum diisi)"
  );
}

// ==========================================
// ERP Fase 5: Kas Tani, Stok Kios, HPP Komoditas (backend API dulu, tanpa chatbot)
// Kontrak RBAC: tulis wajib identitas dikenal (admin ATAU pemilik); baca tanpa
// identitas = mode dashboard (terbuka, konsisten dengan /api/farmers).
// ==========================================
const CASH_KATEGORI_MASUK = ["Penjualan Panen", "Subsidi/Bantuan", "Pinjaman", "Lainnya"];
const CASH_KATEGORI_KELUAR = [
  "Benih", "Pupuk", "Pestisida", "Upah Tenaga", "Sewa Lahan/Alat",
  "Transportasi", "Irigasi/BBM", "Cicilan", "Lainnya",
];
const STOCK_SATUAN = ["kg", "gram", "liter", "ml", "sak", "botol", "bungkus", "pak", "unit"];

// Alias nama sheet Apps Script untuk tulis-balik Lembar 3 (kas) & Lembar 4 (stok).
const CASH_SHEET_ALIASES = new Set(["lembar 3", "lembar3", "kas", "kas tani", "cash", "kas_tani"]);
const STOCK_SHEET_ALIASES = new Set(["lembar 4", "lembar4", "stok", "stok kios", "stock", "stok_kios"]);

function resolveErpScope(senderPhone?: string): { isAdmin: boolean; farmerId: string | null; supplierId: string | null } {
  const norm = normalizePhone(senderPhone);
  if (!norm) return { isAdmin: false, farmerId: null, supplierId: null };
  if (adminsDb.some((a) => a.aktif && normalizePhone(a.noHp) === norm)) return { isAdmin: true, farmerId: null, supplierId: null };
  const farmer = farmersDb.find((f) => normalizePhone(f.noHp) === norm);
  if (farmer) return { isAdmin: false, farmerId: farmer.id, supplierId: null };
  const supplier = suppliersDb.find((s) => normalizePhone(s.kontak) === norm);
  if (supplier) return { isAdmin: false, farmerId: null, supplierId: supplier.id };
  return { isAdmin: false, farmerId: null, supplierId: null };
}

function csvCell(val: any): string {
  if (val === null || val === undefined) return '""';
  let str = String(val).replace(/"/g, '""');
  if (/^[=+\-@]/.test(str)) {
    str = "'" + str;
  }
  return `"${str}"`;
}

// ---------- Auth sesi dashboard (tanpa dep baru; kunci di DATA_DIR, bukan .env) ----------
const SESSION_KEY_FILE = `${DATA_DIR}/.session-key`;
function sessionKey(): Buffer {
  try {
    if (!fs.existsSync(SESSION_KEY_FILE)) {
      fs.writeFileSync(SESSION_KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    return Buffer.from(fs.readFileSync(SESSION_KEY_FILE, "utf-8").trim(), "hex");
  } catch {
    return Buffer.from("tani-ai-dev-fallback-key-32b!!xxxxxxxx".slice(0, 32));
  }
}
const sessions = new Map<string, { adminId: string; exp: number }>();
function mintSession(adminId: string): string {
  const sid = crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", sessionKey()).update(sid).digest("hex");
  sessions.set(sid, { adminId, exp: Date.now() + 12 * 3600e3 });
  return `${sid}.${sig}`;
}
function readSession(req: any): { adminId: string } | null {
  const m = String(req.headers?.cookie || "").match(/tani_sid=([a-f0-9]{32})\.([a-f0-9]{64})/);
  if (!m) return null;
  if (crypto.createHmac("sha256", sessionKey()).update(m[1]).digest("hex") !== m[2]) return null;
  const s = sessions.get(m[1]);
  if (!s || s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  s.exp = Date.now() + 12 * 3600e3;
  return { adminId: s.adminId };
}
function requireSession(roles?: string[]) {
  return (req: any, res: any, next: any) => {
    const s = readSession(req);
    const adm = s ? adminsDb.find((a) => a.id === s.adminId) : undefined;
    if (!adm || !adm.aktif) return res.status(401).json({ error: "Butuh login admin." });
    (req as any).sessionAdmin = adm;
    if (roles && roles.length && !roles.includes(adm.role)) {
      return res.status(403).json({ error: "Peran tidak diizinkan." });
    }
    next();
  };
}

function isValidIsoDate(s: any): boolean {
  if (typeof s !== "string" || !s) return false;
  const t = Date.parse(s);
  return !Number.isNaN(t);
}

function isValidMusim(s: any): boolean {
  if (s === undefined || s === null || s === "") return true;
  return typeof s === "string" && /^MT-\d{4}-\d+$/.test(s.trim());
}

function cashSaldo(rows: CashTransaction[]): { masuk: number; keluar: number; saldo: number; perKategori: Record<string, number> } {
  let masuk = 0;
  let keluar = 0;
  const perKategori: Record<string, number> = {};
  for (const r of rows) {
    if (r.jenis === "MASUK") masuk += r.jumlahRp;
    else keluar += r.jumlahRp;
    perKategori[r.kategori] = (perKategori[r.kategori] || 0) + r.jumlahRp;
  }
  return { masuk, keluar, saldo: masuk - keluar, perKategori };
}

function stockSaldo(supplierId: string, produk?: string): Array<{ produk: string; satuan: string; saldo: number }> {
  const norm = (p: string) => p.toLowerCase().trim();
  const agg = new Map<string, { produk: string; satuan: string; saldo: number }>();
  for (const m of stockDb) {
    if (m.supplierId !== supplierId) continue;
    if (produk && norm(m.produk) !== norm(produk)) continue;
    const key = `${norm(m.produk)}||${m.satuan}`;
    if (!agg.has(key)) agg.set(key, { produk: m.produk, satuan: m.satuan, saldo: 0 });
    const e = agg.get(key)!;
    if (m.arah === "MASUK") e.saldo += m.qty;
    else if (m.arah === "KELUAR") e.saldo -= m.qty;
    else e.saldo += m.qty; // PENYESUAIAN: qty boleh negatif untuk koreksi
  }
  return [...agg.values()];
}

// ---------- ERP: logika tulis bersama (dipakai endpoint REST & chatbot) ----------
function processCashEntry(data: any): { status: number; body: any } {
  const scope = resolveErpScope(data.senderPhone);
  if (!scope.isAdmin && !scope.farmerId) {
    return { status: 403, body: { error: "Identitas pencatat tidak dikenal. Sertakan senderPhone petani/admin terdaftar." } };
  }
  const farmerId = String(data.farmerId || "");
  if (!farmerId || !farmersDb.some((f) => f.id === farmerId)) {
    return { status: 400, body: { error: "farmerId tidak valid atau petani tidak ditemukan." } };
  }
  if (!scope.isAdmin && farmerId !== scope.farmerId) {
    return { status: 403, body: { error: "Petani hanya boleh mencatat kas miliknya sendiri." } };
  }
  const jenis = String(data.jenis || "").toUpperCase();
  if (jenis !== "MASUK" && jenis !== "KELUAR") {
    return { status: 400, body: { error: "jenis harus MASUK atau KELUAR." } };
  }
  const allowedKategori = jenis === "MASUK" ? CASH_KATEGORI_MASUK : CASH_KATEGORI_KELUAR;
  const kategori = String(data.kategori || "");
  if (!allowedKategori.includes(kategori)) {
    return { status: 400, body: { error: `kategori tidak valid untuk ${jenis}. Pilihan: ${allowedKategori.join(", ")}` } };
  }
  const jumlahRp = Number(data.jumlahRp);
  if (!Number.isInteger(jumlahRp) || jumlahRp <= 0) {
    return { status: 400, body: { error: "jumlahRp harus bilangan bulat Rupiah lebih dari 0." } };
  }
  const tanggal = data.tanggal ? String(data.tanggal) : new Date().toISOString().substring(0, 10);
  if (!isValidIsoDate(tanggal)) {
    return { status: 400, body: { error: "tanggal tidak valid (pakai format ISO, mis. 2026-10-28)." } };
  }
  if (!isValidMusim(data.musimTanam)) {
    return { status: 400, body: { error: "musimTanam harus format MT-YYYY-N, mis. MT-2026-1." } };
  }
  const nowMs = Date.now();
  const dupe = cashDb.find(
    (c) =>
      c.farmerId === farmerId &&
      c.jenis === jenis &&
      c.kategori === kategori &&
      c.jumlahRp === jumlahRp &&
      String(c.tanggal).substring(0, 10) === tanggal.substring(0, 10) &&
      nowMs - Date.parse(c.waktuCatat) < 5 * 60 * 1000,
  );
  if (dupe) {
    return { status: 409, body: { error: "Transaksi serupa baru saja dicatat (anti-duplikat 5 menit).", existingId: dupe.id } };
  }
  const record: CashTransaction = {
    id: nextId("KAS", cashDb.map((c) => c.id)),
    farmerId,
    tanggal,
    jenis: jenis as CashTransaction["jenis"],
    kategori,
    jumlahRp,
    komoditas: data.komoditas ? sanitizeText(data.komoditas, 60) : undefined,
    musimTanam: data.musimTanam ? String(data.musimTanam).trim() : undefined,
    catatan: data.catatan ? sanitizeText(data.catatan, 500) : undefined,
    dicatatOleh: data.senderPhone ? String(data.senderPhone) : "dashboard",
    waktuCatat: new Date().toISOString(),
    googleSheetRow: nextSheetRow(
      cashDb.map((c) => c.googleSheetRow),
      cashDb.length,
    ),
    syncStatus: "synced",
  };
  cashDb.unshift(record);
  saveCashToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: data.senderPhone ? "wa-chat" : "dashboard", entity: "cash", entityId: record.id,
    action: "create", actor: data.senderPhone,
    payload: { farmerId: record.farmerId, jenis: record.jenis, kategori: record.kategori, jumlahRp: record.jumlahRp, komoditas: record.komoditas, musimTanam: record.musimTanam },
  });
  return { status: 201, body: record };
}

function processStockEntry(data: any): { status: number; body: any } {
  const scope = resolveErpScope(data.senderPhone);
  if (!scope.isAdmin && !scope.supplierId) {
    return { status: 403, body: { error: "Hanya kios terdaftar atau admin yang boleh mencatat mutasi stok." } };
  }
  const supplierId = String(data.supplierId || "");
  if (!supplierId || !suppliersDb.some((s) => s.id === supplierId)) {
    return { status: 400, body: { error: "supplierId tidak valid atau kios tidak ditemukan." } };
  }
  if (!scope.isAdmin && supplierId !== scope.supplierId) {
    return { status: 403, body: { error: "Kios hanya boleh mencatat stok miliknya sendiri." } };
  }
  const produk = sanitizeText(data.produk, 80);
  if (!produk) {
    return { status: 400, body: { error: "produk wajib diisi." } };
  }
  const satuan = String(data.satuan || "");
  if (!STOCK_SATUAN.includes(satuan)) {
    return { status: 400, body: { error: `satuan tidak valid. Pilihan: ${STOCK_SATUAN.join(", ")}` } };
  }
  const arah = String(data.arah || "").toUpperCase();
  if (arah !== "MASUK" && arah !== "KELUAR" && arah !== "PENYESUAIAN") {
    return { status: 400, body: { error: "arah harus MASUK, KELUAR, atau PENYESUAIAN." } };
  }
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { status: 400, body: { error: "qty harus angka lebih dari 0." } };
  }
  const tanggal = data.tanggal ? String(data.tanggal) : new Date().toISOString().substring(0, 10);
  if (!isValidIsoDate(tanggal)) {
    return { status: 400, body: { error: "tanggal tidak valid (pakai format ISO, mis. 2026-10-28)." } };
  }
  if (arah === "KELUAR") {
    const cur = stockSaldo(supplierId, produk).find((s) => s.satuan === satuan);
    const sisa = cur ? cur.saldo : 0;
    if (sisa - qty < -1e-9) {
      return { status: 400, body: { error: `Stok tidak mencukupi. Sisa ${produk} (${satuan}): ${sisa}.` } };
    }
  }
  const record: StockMutation = {
    id: nextId("STM", stockDb.map((m) => m.id)),
    supplierId,
    produk,
    satuan,
    arah: arah as StockMutation["arah"],
    qty,
    hargaSatuanRp: data.hargaSatuanRp !== undefined ? Math.max(0, Math.floor(Number(data.hargaSatuanRp) || 0)) : undefined,
    tanggal,
    keterangan: data.keterangan ? sanitizeText(data.keterangan, 300) : undefined,
    dicatatOleh: data.senderPhone ? String(data.senderPhone) : "dashboard",
    waktuCatat: new Date().toISOString(),
    googleSheetRow: nextSheetRow(
      stockDb.map((m) => m.googleSheetRow),
      stockDb.length,
    ),
  };
  stockDb.unshift(record);
  saveStockToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: data.senderPhone ? "wa-chat" : "dashboard", entity: "stock", entityId: record.id,
    action: "create", actor: data.senderPhone,
    payload: { supplierId: record.supplierId, produk: record.produk, satuan: record.satuan, arah: record.arah, qty: record.qty },
  });
  return { status: 201, body: record };
}

function processHppGenerate(data: any): { status: number; body: any } {
  const scope = resolveErpScope(data.senderPhone);
  if (!scope.isAdmin && !scope.farmerId) {
    return { status: 403, body: { error: "Identitas tidak dikenal. Sertakan senderPhone petani/admin terdaftar." } };
  }
  const farmerId = String(data.farmerId || "");
  if (!farmerId || !farmersDb.some((f) => f.id === farmerId)) {
    return { status: 400, body: { error: "farmerId tidak valid atau petani tidak ditemukan." } };
  }
  if (!scope.isAdmin && farmerId !== scope.farmerId) {
    return { status: 403, body: { error: "Petani hanya boleh menghitung HPP miliknya sendiri." } };
  }
  const volumePanenKg = Number(data.volumePanenKg);
  if (!Number.isFinite(volumePanenKg) || volumePanenKg <= 0) {
    return { status: 400, body: { error: "volumePanenKg wajib angka lebih dari 0." } };
  }
  const komoditas = data.komoditas ? sanitizeText(data.komoditas, 60) : undefined;
  const musimTanam = data.musimTanam ? String(data.musimTanam).trim() : undefined;
  if (!isValidMusim(musimTanam)) {
    return { status: 400, body: { error: "musimTanam harus format MT-YYYY-N, mis. MT-2026-1." } };
  }
  let rows = cashDb.filter((c) => c.farmerId === farmerId);
  if (komoditas) rows = rows.filter((c) => (c.komoditas || "").toLowerCase() === komoditas.toLowerCase());
  if (musimTanam) rows = rows.filter((c) => c.musimTanam === musimTanam);
  const biayaRows = rows.filter((c) => c.jenis === "KELUAR");
  const totalBiayaRp = biayaRows.reduce((s, c) => s + c.jumlahRp, 0);
  const totalPendapatanRp = rows
    .filter((c) => c.jenis === "MASUK" && c.kategori === "Penjualan Panen")
    .reduce((s, c) => s + c.jumlahRp, 0);
  if (totalBiayaRp === 0) {
    return { status: 400, body: { error: "Belum ada biaya tercatat untuk filter ini. Catat biaya dulu via /api/cash." } };
  }
  const biayaPerKategori: Record<string, number> = {};
  for (const c of biayaRows) {
    biayaPerKategori[c.kategori] = (biayaPerKategori[c.kategori] || 0) + c.jumlahRp;
  }
  const hppPerKg = totalBiayaRp / volumePanenKg;
  const hargaJualPerKg = data.hargaJualPerKg !== undefined ? Number(data.hargaJualPerKg) : undefined;
  if (hargaJualPerKg !== undefined && (!Number.isFinite(hargaJualPerKg) || hargaJualPerKg < 0)) {
    return { status: 400, body: { error: "hargaJualPerKg harus angka 0 atau lebih." } };
  }
  const report: HppReport = {
    id: nextId("HPP", hppDb.map((h) => h.id)),
    farmerId,
    komoditas,
    musimTanam,
    totalBiayaRp,
    totalPendapatanRp,
    biayaPerKategori,
    volumePanenKg,
    hppPerKg: Math.round(hppPerKg * 100) / 100,
    hargaJualPerKg,
    marginPerKg: hargaJualPerKg !== undefined ? Math.round((hargaJualPerKg - hppPerKg) * 100) / 100 : undefined,
    marginPersen:
      hargaJualPerKg !== undefined && hargaJualPerKg > 0
        ? Math.round(((hargaJualPerKg - hppPerKg) / hargaJualPerKg) * 10000) / 100
        : undefined,
    generatedAt: new Date().toISOString(),
    generatedBy: data.senderPhone ? String(data.senderPhone) : "dashboard",
  };
  hppDb.unshift(report);
  saveHppToDisk();
  bumpDataVersion();
  emitCanonicalEvent({
    source: data.senderPhone ? "wa-chat" : "dashboard", entity: "hpp", entityId: report.id,
    action: "generate", actor: data.senderPhone,
    payload: { farmerId: report.farmerId, komoditas: report.komoditas, musimTanam: report.musimTanam, totalBiayaRp: report.totalBiayaRp, volumePanenKg: report.volumePanenKg, hppPerKg: report.hppPerKg },
  });
  return { status: 201, body: report };
}

export function createServerApp() {
  const app = express();
  const json1mb = express.json({ limit: "1mb", verify: (req: any, _res: any, buf: Buffer) => { if (req.url?.startsWith("/api/webhook/whatsapp")) req.rawBody = buf; } });
  // /api/wa-media membawa base64 media (+33% overhead, media s.d. 5MB) -> parser 8MB khusus rute itu.
  app.use("/api/wa-media", express.json({ limit: "8mb" }));
  app.use((req, res, next) => ((req.url || "").startsWith("/api/wa-media") ? next() : json1mb(req, res, next)));
  // ponytail: header minimal tanpa dep; tambah helmet saat production.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  // CORS untuk frontend Vercel -> backend tunnel. Same-origin lokal tak berubah.
  app.use((req: any, res, next) => {
    const origin = String(req.headers?.origin || "");
    let allowed = false;
    try {
      const host = new URL(origin).hostname;
      const extra = String(process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
      allowed = host.endsWith(".vercel.app") || extra.includes(origin) || extra.includes(host);
    } catch { allowed = false; }
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (allowed) {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-tani-forward-secret");
        res.setHeader("Access-Control-Max-Age", "86400");
      }
      return res.status(204).end();
    }
    next();
  });
  // Rate-limit stdlib di jalur tulis. Baca (GET) bebas.
  const writeLimit = rateLimit(60, 60_000);
  app.use((req, _res, next) => (req.method === "POST" ? writeLimit(req as any, _res as any, next) : next()));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    const nineCfg = getNineRouterConfig();
    res.json({
      status: "ok",
      app: "TaniAI - WhatsApp & Google Sheets Agri-Agent",
      version: "1.0.0",
      time: new Date().toISOString(),
      farmersCount: farmersDb.length,
      commoditiesCount: commoditiesDb.length,
      adminsCount: adminsDb.length,
      hasGeminiKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"),
      hasMetaKey: getMetaModelConfig().isConfigured,
      nineRouter: {
        configured: nineCfg.isConfigured,
        model: nineCfg.model,
      },
      meta: {
        configured: getMetaModelConfig().isConfigured,
        model: getMetaModelConfig().model,
      },
      nim: {
        configured: getNimConfig().isConfigured,
        model: getNimConfig().model,
      },
      laya: { url: LAYA_URL, down: Date.now() < layaUnavailableUntil },
    });
  });

  // GET pemakaian jatah gratis WA per nomor (router multi-nomor, admin saja)
  app.get("/api/wa/quota", requireSession(), async (_req, res) => {
    const month = waMonth();
    res.json({
      ok: true,
      month,
      freeQuota: WA_FREE_QUOTA,
      numbers: waNumbers().map((n) => ({
        id: n.id,
        label: n.label,
        sent: waUsage(n.id),
        remaining: Math.max(0, WA_FREE_QUOTA - waUsage(n.id)),
      })),
      stickyUsers: Object.keys(waQuota().sticky).length,
    });
  });

  // GET 9Router Gateway status & model discovery
  app.get("/api/9router/status", requireSession(), async (_req, res) => {
    const cfg = getNineRouterConfig();
    const health = await checkNineRouterHealth();
    let availableModels: string[] = [];

    if (cfg.isConfigured && health.ok) {
      try {
        const headers: Record<string, string> = {};
        if (cfg.key) headers["Authorization"] = `Bearer ${cfg.key}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const mRes = await fetch(`${cfg.url}/v1/models`, { headers, signal: controller.signal });
        clearTimeout(timeout);
        if (mRes.ok) {
          const mData: any = await mRes.json();
          if (Array.isArray(mData?.data)) {
            availableModels = mData.data.map((m: any) => m.id).slice(0, 20);
          }
        }
      } catch {}
    }

    const geminiAvailable = !!getGemini();
    const metaCfg = getMetaModelConfig();
    const metaHealth = metaCfg.isConfigured ? await checkMetaModelHealth() : { ok: false, message: "META_MODEL_KEY belum dikonfigurasi." };
    const activeProvider = metaCfg.isConfigured && metaHealth.ok
      ? "meta"
      : (cfg.isConfigured && health.ok ? "9router" : (geminiAvailable ? "gemini" : "rule_based"));

    res.json({
      configured: cfg.isConfigured,
      url: cfg.url,
      hasKey: Boolean(cfg.key),
      model: cfg.model,
      healthy: health.ok,
      latencyMs: health.latencyMs,
      message: health.message,
      activeProvider,
      availableModels,
      meta: {
        configured: metaCfg.isConfigured,
        model: metaCfg.model,
        healthy: metaHealth.ok,
        latencyMs: (metaHealth as any).latencyMs,
        message: metaHealth.message,
      },
    });
  });

  // GET Meta Model API status & model discovery
  app.get("/api/meta/status", requireSession(), async (_req, res) => {
    const cfg = getMetaModelConfig();
    const health = await checkMetaModelHealth();
    let availableModels: string[] = [];

    if (cfg.isConfigured && health.ok) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const mRes = await fetch(`${cfg.url}/models`, {
          headers: { Authorization: `Bearer ${cfg.key}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (mRes.ok) {
          const mData: any = await mRes.json();
          if (Array.isArray(mData?.data)) {
            availableModels = mData.data.map((m: any) => m.id).slice(0, 20);
          }
        }
      } catch {}
    }

    res.json({
      configured: cfg.isConfigured,
      url: cfg.url,
      hasKey: Boolean(cfg.key),
      model: cfg.model,
      healthy: health.ok,
      latencyMs: health.latencyMs,
      message: health.message,
      availableModels,
    });
  });

  // GET Laya Intent Engine status
  app.get("/api/laya/status", requireSession(), async (_req, res) => {
    const isCircuitOpen = Date.now() < layaUnavailableUntil;
    let sidecarHealthy = false;
    let sidecarData: any = null;
    let latencyMs = 0;

    if (LAYA_URL && !isCircuitOpen) {
      const t0 = Date.now();
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 1500);
        const r = await fetch(`${LAYA_URL}/health`, { signal: c.signal });
        clearTimeout(t);
        latencyMs = Date.now() - t0;
        if (r.ok) {
          sidecarHealthy = true;
          sidecarData = await r.json();
        }
      } catch (e: any) {
        sidecarData = { error: e.message };
      }
    }

    res.json({
      configured: !!LAYA_URL,
      url: LAYA_URL,
      healthy: sidecarHealthy,
      circuitBreakerActive: isCircuitOpen,
      circuitBreakerCooldownRemainingSec: isCircuitOpen
        ? Math.max(0, Math.round((layaUnavailableUntil - Date.now()) / 1000))
        : 0,
      latencyMs,
      sidecarDetails: sidecarData,
      cacheStats: {
        cachedKeysCount: layaCache.size,
        maxKeys: 2000,
        ttlMs: 600000,
      },
      engineSpecs: {
        repo: "https://github.com/NandhaKishorM/laya",
        huggingface: "convaiinnovations/laya",
        primitive: "choice",
        confidenceThreshold: 0.5,
        supportedIntents: ["daftar_lahan", "cek_harga", "hama_pupuk", "supplier", "catat_kas", "catat_stok", "hitung_hpp", "lain"],
        optimizations: [
          "Zero-token non-autoregressive decision (sub-50ms)",
          "Choice primitive avoids noul label sensitivity & score position bias",
          "Confidence-gated routing (AUROC 0.77 vs act_prob 0.30)",
          "Physical CPU core capping for thread affinity",
          "10-min LRU memory cache + 30s automatic circuit breaker",
        ],
      },
    });
  });

  // POST test Laya decision endpoint
  app.post("/api/laya/decide", requireSession(), async (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Text string is required" });
    }
    const t0 = Date.now();
    const layaResult = await getLayaIntent(text);
    const latencyMs = Date.now() - t0;

    res.json({
      text,
      result: layaResult,
      latencyMs,
      source: layaResult ? (layaResult.source || "laya_engine") : "fallback_heuristic",
      layaAvailable: Date.now() >= layaUnavailableUntil && !!LAYA_URL,
    });
  });

  // GET all recognized admin numbers
  app.get("/api/admins", requireSession(), (_req, res) => {
    res.json(adminsDb.map((a) => ({ id: a.id, nama: a.nama, noHp: a.noHp, instansi: a.instansi, role: a.role, izinAkses: a.izinAkses, aktif: a.aktif, waktuTerdaftar: a.waktuTerdaftar, didaftarkanOleh: a.didaftarkanOleh, appointedBy: a.appointedBy })));
  });

  // Syarat pendaftar/pencabut admin: harus admin aktif yang sudah terdaftar.
  // Menutup eskalasi hak akses (pendaftaran admin oleh sembarang pengirim).
  // Pengecualian bootstrap: bila belum ada admin aktif sama sekali.
  function requireRequesterAdmin(body: any, sessionAdmin?: AdminUser): { ok: boolean; error?: string } {
    const activeAdmins = adminsDb.filter((a) => a.aktif);
    if (activeAdmins.length === 0) return { ok: true };
    // Sesi login otoritatif: requesterNoHp tak boleh meminjam identitas admin lain.
    if (sessionAdmin) {
      const claimed = normalizePhone(body?.requesterNoHp);
      if (claimed && claimed !== normalizePhone(sessionAdmin.noHp)) {
        return { ok: false, error: "requesterNoHp tidak cocok dengan sesi login." };
      }
      if (!sessionAdmin.aktif || !findAdmin(sessionAdmin.noHp)) {
        return { ok: false, error: "Sesi login bukan admin aktif." };
      }
      return { ok: true };
    }
    const req = findAdmin(body?.requesterNoHp);
    if (!req) {
      return { ok: false, error: "Hanya admin aktif terdaftar yang boleh menambah/mencabut admin. Sertakan requesterNoHp admin pengesah." };
    }
    return { ok: true };
  }

  // F1: tambah/cabut ADMIN hanya oleh SUPER_ADMIN (nomor Setiawan kanonis).
  function requireSuperAdmin(body: any, sessionAdmin?: AdminUser): { ok: boolean; error?: string } {
    // Sesi login otoritatif: peran dibaca dari sesi, bukan body.
    if (sessionAdmin) {
      const claimed = normalizePhone(body?.requesterNoHp);
      if (claimed && claimed !== normalizePhone(sessionAdmin.noHp)) {
        return { ok: false, error: "requesterNoHp tidak cocok dengan sesi login." };
      }
      if (!sessionAdmin.aktif || sessionAdmin.role !== "SUPER_ADMIN") {
        return { ok: false, error: "Hanya SUPER_ADMIN yang boleh menambah/mencabut admin." };
      }
      return { ok: true };
    }
    const req = findAdmin(body?.requesterNoHp);
    if (!req || !req.aktif || req.role !== "SUPER_ADMIN") {
      return { ok: false, error: "Hanya SUPER_ADMIN yang boleh menambah/mencabut admin." };
    }
    return { ok: true };
  }

  // Identitas pengirim tulis: requesterNoHp (operator dashboard) atau senderPhone (chat/WA).
  function requesterIdentity(body: any): string {
    return String(body?.requesterNoHp || body?.senderPhone || "");
  }

  // Tulis petani/supplier: admin boleh semua; non-admin hanya data miliknya sendiri
  // (noHp/kontak = nomor pengirim) agar swadaftar via chat tetap jalan.
  function requireAdminOrSelf(body: any, selfPhone?: unknown): { ok: boolean; error?: string } {
    const ident = requesterIdentity(body);
    if (findAdmin(ident)) return { ok: true };
    const a = normalizePhone(ident);
    const b = normalizePhone(String(selfPhone ?? ""));
    if (a && b && a === b) return { ok: true };
    return { ok: false, error: "Aksi ini butuh admin aktif (requesterNoHp) atau nomor pemilik data (senderPhone = noHp/kontak)." };
  }

  // Auth sesi dashboard: setup password sekali, login/logout, identitas sesi.
  app.post("/api/auth/setup-password", (req, res) => {
    const { noHp, password } = req.body || {};
    if (!noHp || !String(password || "").trim() || String(password).length < 8) {
      return res.status(400).json({ error: "noHp + password ≥8 karakter wajib." });
    }
    const anyHash = adminsDb.some((a: any) => (a as any).passwordHash);
    const target = findAdmin(noHp);
    if (!target) return res.status(404).json({ error: "Admin tidak dikenal." });
    if ((target as any).passwordHash) return res.status(400).json({ error: "Password sudah diset." });
    if (anyHash) {
      const s = readSession(req);
      const me = s ? adminsDb.find((a) => a.id === s.adminId) : undefined;
      if (!me || !me.aktif || (me.role !== "ADMIN_UTAMA" && me.role !== "SUPER_ADMIN")) {
        return res.status(403).json({ error: "Hanya Admin Utama bersesi boleh mereset password." });
      }
    } else if (!requireRequesterAdmin(req.body, (req as any).sessionAdmin).ok) {
      return res.status(403).json({ error: "Butuh pengesah admin (migrasi satu-kali)." });
    }
    const salt = crypto.randomBytes(8).toString("hex");
    (target as any).passwordHash = `${salt}:${crypto.scryptSync(String(password), salt, 32).toString("hex")}`;
    saveAdminsToDisk();
    return res.json({ success: true });
  });
  app.post("/api/auth/login", (req, res) => {
    const { noHp, password } = req.body || {};
    const adm = findAdmin(noHp);
    const [salt, hash] = String((adm as any)?.passwordHash || "").split(":");
    let ok = false;
    try {
      ok = !!adm && !!salt && !!hash && crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        crypto.scryptSync(String(password || ""), salt, 32),
      );
    } catch { ok = false; }
    if (!ok) return res.status(401).json({ error: "No HP / password salah." });
    const proto1 = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
    const lax1 = proto1 === "https" ? "; SameSite=None; Secure" : "; SameSite=Lax";
    res.setHeader("Set-Cookie", `tani_sid=${mintSession(adm.id)}; HttpOnly${lax1}; Path=/; Max-Age=43200`);
    return res.json({ success: true, nama: adm.nama, role: adm.role });
  });
  app.post("/api/auth/logout", (req, res) => {
    const m = String(req.headers?.cookie || "").match(/tani_sid=([a-f0-9]{32})\./);
    if (m) sessions.delete(m[1]);
    const proto2 = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
    const lax2 = proto2 === "https" ? "; SameSite=None; Secure" : "; SameSite=Lax";
    res.setHeader("Set-Cookie", `tani_sid=; HttpOnly${lax2}; Path=/; Max-Age=0`);
    return res.json({ success: true });
  });
  app.get("/api/auth/me", (req, res) => {
    const s = readSession(req);
    const adm = s ? adminsDb.find((a) => a.id === s.adminId) : undefined;
    if (!adm || !adm.aktif) return res.status(401).json({ error: "Belum login." });
    return res.json({ id: adm.id, nama: adm.nama, role: adm.role, noHp: adm.noHp });
  });

  // POST add new admin phone number
  app.post("/api/admins", requireSession(), (req, res) => {
    const { nama, noHp, instansi, role, izinAkses } = req.body;
    if (!nama || !noHp) {
      return res.status(400).json({ error: "Nama dan nomor WhatsApp wajib diisi." });
    }
    const gate = requireSuperAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    if (String(role || "").toUpperCase() === "SUPER_ADMIN") {
      return res.status(403).json({ error: "SUPER_ADMIN hanya via migrasi server (env SUPER_ADMIN_PHONE)." });
    }

    const existing = findAdmin(noHp);
    if (existing) {
      return res.status(400).json({ error: `Nomor ini sudah terdaftar sebagai admin (${existing.nama})` });
    }

    const newAdmin: AdminUser = {
      id: nextId("ADM", adminsDb.map((a) => a.id)),
      nama: nama.trim(),
      noHp: noHp.trim(),
      instansi: instansi || "Dinas Pertanian / PPL Lapangan",
      role: role || "PETUGAS_PPL",
      izinAkses: izinAkses || ["rekap_data", "ekspor_sheets", "verifikasi_petani"],
      aktif: true,
      waktuTerdaftar: new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }),
      didaftarkanOleh: req.body?.requesterNoHp ? String(req.body.requesterNoHp).trim() : undefined,
      appointedBy: req.body?.requesterNoHp ? String(req.body.requesterNoHp).trim() : undefined,
    };

    adminsDb.push(newAdmin);
    saveAdminsToDisk();
    bumpDataVersion();
    res.status(201).json(newAdmin);
  });

  // DELETE or deactivate admin phone number
  app.delete("/api/admins/:id", requireSession(), (req, res) => {
    const { id } = req.params;
    if (id === "ADM-001") {
      return res.status(403).json({ error: "Super Admin utama tidak dapat dihapus." });
    }
    const target = adminsDb.find((a) => a.id === id);
    if (target && target.role === "SUPER_ADMIN") {
      return res.status(403).json({ error: "Akun SUPER_ADMIN tidak dapat dihapus via API." });
    }
    const gate = requireSuperAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    if (adminsDb.filter((a) => a.aktif).length <= 1 && adminsDb.some((a) => a.id === id && a.aktif)) {
      return res.status(400).json({ error: "Admin aktif terakhir tidak dapat dihapus." });
    }
    const before = adminsDb.length;
    adminsDb = adminsDb.filter((a) => a.id !== id);
    if (adminsDb.length === before) {
      return res.status(404).json({ error: "Admin tidak ditemukan." });
    }
    saveAdminsToDisk();
    bumpDataVersion();
    res.json({ success: true, message: "Nomor admin berhasil dihapus." });
  });

  // GET all registered farmers
  app.get("/api/farmers", requireSession(), (_req, res) => {
    res.json(farmersDb);
  });

  // POST add new farmer
  app.post("/api/farmers", requireSession(), (req, res) => {
    const data = req.body;
    const gateF = requireAdminOrSelf(data, data?.noHp);
    if (!gateF.ok) {
      return res.status(403).json({ error: gateF.error });
    }
    const check = checkFarmerCompleteness(data);
    if (!check.isComplete) {
      return res.status(400).json({
        error: "Data petani belum lengkap. Harap lengkapi seluruh informasi pokok sebelum menyimpan ke database.",
        missingFields: check.missingFields,
      });
    }

    const newFarmer: FarmerRecord = {
      id: nextId("TANI", farmersDb.map((f) => f.id)),
      timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
      nama: data.nama,
      noHp: data.noHp || "+62 8xx-xxxx-xxxx",
      alamat: data.alamat || `Desa Binaan, ${data.kabupaten || "Sentra"}`,
      kabupaten: data.kabupaten || "Subang",
      luasLahan: Number(data.luasLahan) || 1.0,
      luasLahanFormatted: data.luasLahanFormatted || `${data.luasLahan || 1.0} Ha`,
      komoditas: data.komoditas,
      varietas: data.varietas || "Lokal Unggul",
      estimasiPanen: data.estimasiPanen || "November 2026",
      estimasiHasilTon: Number(data.estimasiHasilTon) || Number(((Number(data.luasLahan) || 1) * 6).toFixed(1)),
      statusVerifikasi: data.statusVerifikasi || "Terverifikasi",
      catatanAI: data.catatanAI || "Data dicatat melalui sistem TaniAI.",
      syncStatus: "synced",
      googleSheetRow: nextSheetRow(
        farmersDb.map((f) => f.googleSheetRow),
        farmersDb.length,
      ),
      latitude: data.latitude !== undefined ? Number(data.latitude) : -6.5 + (Math.random() * 0.1 - 0.05),
      longitude: data.longitude !== undefined ? Number(data.longitude) : 107.5 + (Math.random() * 0.1 - 0.05),
      supplierTerhubungId: data.supplierTerhubungId || undefined,
    };
    farmersDb.unshift(newFarmer);
    saveFarmersToDisk();
    bumpDataVersion();
    emitCanonicalEvent({
      source: "dashboard", entity: "farmer", entityId: newFarmer.id,
      action: "create", actor: (req as any).sessionAdmin?.noHp,
      payload: { nama: newFarmer.nama, komoditas: newFarmer.komoditas, luasLahan: newFarmer.luasLahan, kabupaten: newFarmer.kabupaten, statusVerifikasi: newFarmer.statusVerifikasi },
    });
    res.status(201).json(newFarmer);
  });

  // PUT update existing farmer
  app.put("/api/farmers/:id", requireSession(), (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const gate = requireRequesterAdmin(data, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const idx = farmersDb.findIndex((f) => f.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: "Data petani tidak ditemukan." });
    }
    const current = farmersDb[idx];
    const updated: FarmerRecord = {
      ...current,
      nama: data.nama !== undefined ? data.nama : current.nama,
      noHp: data.noHp !== undefined ? data.noHp : current.noHp,
      alamat: data.alamat !== undefined ? data.alamat : current.alamat,
      kabupaten: data.kabupaten !== undefined ? data.kabupaten : current.kabupaten,
      luasLahan: data.luasLahan !== undefined ? Number(data.luasLahan) : current.luasLahan,
      luasLahanFormatted: data.luasLahan !== undefined ? `${data.luasLahan} Ha` : current.luasLahanFormatted,
      komoditas: data.komoditas !== undefined ? data.komoditas : current.komoditas,
      varietas: data.varietas !== undefined ? data.varietas : current.varietas,
      estimasiPanen: data.estimasiPanen !== undefined ? data.estimasiPanen : current.estimasiPanen,
      estimasiHasilTon: data.estimasiHasilTon !== undefined ? Number(data.estimasiHasilTon) : current.estimasiHasilTon,
      statusVerifikasi: data.statusVerifikasi !== undefined ? data.statusVerifikasi : current.statusVerifikasi,
      catatanAI: data.catatanAI !== undefined ? data.catatanAI : current.catatanAI,
      latitude: data.latitude !== undefined ? Number(data.latitude) : current.latitude,
      longitude: data.longitude !== undefined ? Number(data.longitude) : current.longitude,
      supplierTerhubungId: data.supplierTerhubungId !== undefined ? data.supplierTerhubungId : current.supplierTerhubungId,
      syncStatus: "synced",
    };
    farmersDb[idx] = updated;
    saveFarmersToDisk();
    bumpDataVersion();
    res.json(updated);
  });

  // POST verify farmer status
  app.post("/api/farmers/:id/verify", requireSession(), (req, res) => {
    const { id } = req.params;
    const gateV = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gateV.ok) {
      return res.status(403).json({ error: gateV.error });
    }
    const farmer = farmersDb.find((f) => f.id === id);
    if (!farmer) {
      return res.status(404).json({ error: "Petani tidak ditemukan." });
    }
    farmer.statusVerifikasi = "Terverifikasi";
    farmer.catatanAI = `Divalidasi langsung oleh Petugas PPL Lapangan pada ${new Date().toLocaleDateString("id-ID")}. Polygon dan berkas lahan lengkap.`;
    saveFarmersToDisk();
    bumpDataVersion();
    emitCanonicalEvent({
      source: "dashboard", entity: "farmer", entityId: farmer.id,
      action: "verify", actor: (req as any).sessionAdmin?.noHp,
      payload: { nama: farmer.nama, statusVerifikasi: farmer.statusVerifikasi },
    });
    res.json({ success: true, farmer });
  });

  // DELETE farmer by ID
  app.delete("/api/farmers/:id", requireSession(), (req, res) => {
    const { id } = req.params;
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const before = farmersDb.length;
    farmersDb = farmersDb.filter((f) => f.id !== id);
    if (farmersDb.length === before) {
      return res.status(404).json({ error: "Data petani tidak ditemukan." });
    }
    saveFarmersToDisk();
    bumpDataVersion();
    res.json({ success: true, message: `Data petani ${id} berhasil dihapus.` });
  });

  // GET all agricultural suppliers / kiosks / offtakers
  app.get("/api/suppliers", requireSession(), (_req, res) => {
    res.json(suppliersDb);
  });

  // POST add new supplier / saprodi partner
  app.post("/api/suppliers", requireSession(), (req, res) => {
    const data = req.body;
    const gateS = requireAdminOrSelf(data, data?.kontak);
    if (!gateS.ok) {
      return res.status(403).json({ error: gateS.error });
    }
    if (!data.nama) {
      return res.status(400).json({ error: "Nama supplier/kios wajib diisi." });
    }

    const newSupplier = saveSupplierRecord(data, (req as any).sessionAdmin, data?.kontak, "dashboard");
    res.status(201).json(newSupplier);
  });

  // PUT update supplier
  app.put("/api/suppliers/:id", requireSession(), (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const gate = requireRequesterAdmin(data, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const idx = suppliersDb.findIndex((s) => s.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: "Supplier tidak ditemukan." });
    }

    const current = suppliersDb[idx];
    const updated: SupplierRecord = {
      ...current,
      nama: data.nama !== undefined ? data.nama : current.nama,
      kategori: data.kategori !== undefined ? data.kategori : current.kategori,
      kontak: data.kontak !== undefined ? data.kontak : current.kontak,
      alamat: data.alamat !== undefined ? data.alamat : current.alamat,
      kabupaten: data.kabupaten !== undefined ? data.kabupaten : current.kabupaten,
      latitude: data.latitude !== undefined ? Number(data.latitude) : current.latitude,
      longitude: data.longitude !== undefined ? Number(data.longitude) : current.longitude,
      statusKemitraan: data.statusKemitraan !== undefined ? data.statusKemitraan : current.statusKemitraan,
      produkUnggulan: Array.isArray(data.produkUnggulan) ? data.produkUnggulan : current.produkUnggulan,
      stokTersedia: data.stokTersedia !== undefined ? data.stokTersedia : current.stokTersedia,
      radiusLayananKm: data.radiusLayananKm !== undefined ? Number(data.radiusLayananKm) : current.radiusLayananKm,
      jamBuka: data.jamBuka !== undefined ? data.jamBuka : current.jamBuka,
      petaniBinaanCount: data.petaniBinaanCount !== undefined ? Number(data.petaniBinaanCount) : current.petaniBinaanCount,
      catatan: data.catatan !== undefined ? data.catatan : current.catatan,
      syncStatus: "synced",
    };

    suppliersDb[idx] = updated;
    saveSuppliersToDisk();
    bumpDataVersion();
    res.json(updated);
  });

  // DELETE supplier by ID
  app.delete("/api/suppliers/:id", requireSession(), (req, res) => {
    const { id } = req.params;
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const before = suppliersDb.length;
    suppliersDb = suppliersDb.filter((s) => s.id !== id);
    if (suppliersDb.length === before) {
      return res.status(404).json({ error: "Supplier tidak ditemukan." });
    }
    saveSuppliersToDisk();
    bumpDataVersion();
    res.json({ success: true, message: `Data supplier ${id} berhasil dihapus.` });
  });

  // GET CSV export for suppliers (Google Sheets Lembar 2)
  app.get("/api/sheets/suppliers/export.csv", requireSession(), (_req, res) => {
    const headers = [
      "ID Supplier",
      "Waktu Terdaftar",
      "Nama Supplier / Kios",
      "Kategori Usaha",
      "Kontak WhatsApp",
      "Alamat",
      "Kabupaten",
      "Status Kemitraan",
      "Produk Unggulan",
      "Stok Tersedia",
      "Radius Layanan (Km)",
      "Jam Buka",
      "Petani Binaan Terhubung",
      "Latitude",
      "Longitude",
      "Catatan",
    ];

    const rows = suppliersDb.map((s, idx) => [
      s.id,
      s.timestamp || `2026-09-${String(10 + (idx % 15)).padStart(2, "0")} 08:00:00`,
      `"${(s.nama || "").replace(/"/g, '""')}"`,
      `"${(s.kategori || "").replace(/"/g, '""')}"`,
      `"${(s.kontak || "").replace(/"/g, '""')}"`,
      `"${(s.alamat || "").replace(/"/g, '""')}"`,
      `"${(s.kabupaten || "").replace(/"/g, '""')}"`,
      `"${(s.statusKemitraan || "").replace(/"/g, '""')}"`,
      `"${((s.produkUnggulan || []).join("; ")).replace(/"/g, '""')}"`,
      `"${(s.stokTersedia || "").replace(/"/g, '""')}"`,
      s.radiusLayananKm || 25,
      `"${(s.jamBuka || "").replace(/"/g, '""')}"`,
      s.petaniBinaanCount || 10,
      s.latitude,
      s.longitude,
      `"${(s.catatan || "").replace(/"/g, '""')}"`,
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="TaniAI_Suppliers_Database.csv"');
    res.send(csvContent);
  });

  // GET Google Maps Platform API key config
  app.get("/api/config/maps-key", requireSession(), (_req, res) => {
    const apiKey =
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY ||
      "";
    res.json({ apiKey });
  });

  // GET Agronomy Fertilizer Recommendation
  app.get("/api/agronomy/fertilizer", requireSession(), (req, res) => {
    const crop = (req.query.crop as string) || "Padi";
    const ha = parseFloat(req.query.ha as string) || 1.0;
    const result = calculateFertilizerRecommendation(crop, ha);
    res.json(result);
  });

  // POST Audio Transcribe & Entity Extraction (Multimodal AI)
  app.post("/api/audio-transcribe", (req: any, res: any, next: any) => {
    // Gerbang ganda: sesi dashboard ATAU forwarder resmi (voice WA masuk sini).
    const s = readSession(req);
    const adm = s ? adminsDb.find((a) => a.id === s.adminId && a.aktif) : undefined;
    (req as any).sessionAdmin = adm;
    const fs = (process.env.FORWARD_SECRET || "").trim();
    const fwdOk = !!fs && String(req.headers["x-tani-forward-secret"] || "") === fs;
    if (!adm && !fwdOk) return res.status(401).json({ error: "Butuh login admin atau forwarder resmi." });
    next();
  }, async (req, res) => {
    const t0voice = Date.now();
    try {
      const { audioBase64, mimeType, senderPhone } = req.body;
      if (!audioBase64) {
        return res.status(400).json({ error: "audioBase64 is required" });
      }
      const fs = (process.env.FORWARD_SECRET || "").trim();
      const viaFwd = !!fs && String(req.headers["x-tani-forward-secret"] || "") === fs;
      const cleanBase64 = String(audioBase64).replace(/^data:[^;]+;base64,/, "");
      const voiceBuf = Buffer.from(cleanBase64, "base64");
      const mediaPath = trainingSaveMedia("voice", voiceBuf, mimeType || "audio/webm");

      const activeAdmin = findAdmin(senderPhone);
      const farmerHit = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(senderPhone));
      const voiceBase = {
        kind: "voice", channel: viaFwd ? "wa" : "dashboard",
        role: activeAdmin ? "admin" : (farmerHit ? "petani" : "tamu"),
        phoneHash: hashPhone(senderPhone),
        mime: String(mimeType || "audio/webm"), bytes: voiceBuf.length, media: mediaPath,
      };
      const ai = getGemini();

      if (!ai) {
        // Tanpa kunci AI valid: jujur katakan tidak tersedia (jangan data palsu).
        trainingLog({ ...voiceBase, transcript: "", ok: false, error: "kunci AI belum valid", ms: Date.now() - t0voice });
        return res.json({
          transcription: "",
          extracted: {},
          isComplete: false,
          isFallback: true,
          error: "Layanan transkripsi belum tersedia (kunci AI belum valid). Rekaman tidak diproses.",
        });
      }
      const tr = await transcribeAudioBuffer(voiceBuf, mimeType || "audio/webm");
      const mergedExtracted = tr.extracted;
      const check = checkFarmerCompleteness(mergedExtracted);

      trainingLog({
        ...voiceBase, transcript: clipText(tr.transcription || ""),
        extractedKeys: Object.keys(mergedExtracted || {}),
        ok: true, ms: Date.now() - t0voice,
      });
      res.json({
        transcription: tr.transcription || "Audio suara berhasil diproses.",
        extracted: mergedExtracted,
        isComplete: check.isComplete,
        missingFields: check.missingFields,
        isAdmin: !!activeAdmin,
      });
    } catch (err: any) {
      console.error("[Audio Transcribe Error]", err);
      try {
        trainingLog({
          kind: "voice", channel: "unknown",
          phoneHash: hashPhone((req.body || {}).senderPhone),
          transcript: "", ok: false, error: clipText(err?.message || "Internal error", 200),
          ms: Date.now() - t0voice,
        });
      } catch {}
      res.status(500).json({
        error: "Gagal memproses audio suara: " + (err?.message || "Internal error"),
        transcription: "",
        extracted: {},
        isComplete: false,
      });
    }
  });

  // POST media WA dari forwarder: voice ditranskrip lalu dijawab via /api/chat
  // internal; image dianalisis langsung. Media SELALU disimpan ke training store
  // dulu (simpan-dulu), recognition best-effort dengan jawaban jujur saat gagal.
  app.post("/api/wa-media", (req: any, res: any, next: any) => {
    const s = readSession(req);
    const adm = s ? adminsDb.find((a) => a.id === s.adminId && a.aktif) : undefined;
    (req as any).sessionAdmin = adm;
    const fs = (process.env.FORWARD_SECRET || "").trim();
    const fwdOk = !!fs && String(req.headers["x-tani-forward-secret"] || "") === fs;
    if (!adm && !fwdOk) return res.status(401).json({ error: "Butuh login admin atau forwarder resmi." });
    next();
  }, async (req, res) => {
    const t0m = Date.now();
    try {
      const { kind, base64, mimeType, senderPhone, waId, caption, filename } = req.body || {};
      if (kind !== "voice" && kind !== "image" && kind !== "document") {
        return res.status(400).json({ error: "kind harus voice|image|document" });
      }
      if (!base64 || typeof base64 !== "string") {
        return res.status(400).json({ error: "base64 is required" });
      }
      const buf = Buffer.from(base64, "base64");
      if (buf.length === 0 || buf.length > 5 * 1024 * 1024) {
        return res.status(413).json({ error: "ukuran media 1B..5MB" });
      }
      const mediaPath = trainingSaveMedia(kind, buf, mimeType || (kind === "image" ? "image/jpeg" : "audio/ogg"));
      const activeAdmin = findAdmin(senderPhone);
      const farmerHit = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(senderPhone));
      const mBase = {
        kind, channel: "wa",
        role: activeAdmin ? "admin" : (farmerHit ? "petani" : "tamu"),
        phoneHash: hashPhone(senderPhone),
        mime: String(mimeType || ""), bytes: buf.length, media: mediaPath,
        waId: String(waId || ""),
      };
      if (kind === "voice") {
        let tr: { transcription: string; extracted: any };
        try {
          tr = await transcribeAudioBuffer(buf, mimeType || "audio/ogg");
        } catch (err: any) {
          trainingLog({ ...mBase, transcript: "", ok: false, error: clipText(err?.message || "gagal", 200), ms: Date.now() - t0m });
          return res.json({
            ok: false, kind, transcription: "", savedMedia: mediaPath,
            reply: "🎙️ Voice note tersimpan. Transkripsi otomatis belum tersedia saat ini — silakan ketik pesan teks.",
            aiProvider: "rule_based", ms: Date.now() - t0m,
          });
        }
        const transcript = (tr.transcription || "").trim();
        if (!transcript) {
          trainingLog({
            ...mBase, transcript: "",
            extractedKeys: Object.keys(tr.extracted || {}), ok: false, error: "transkripsi kosong", ms: Date.now() - t0m,
          });
          return res.json({
            ok: false, kind, transcription: "", savedMedia: mediaPath,
            reply: "🎙️ Voice note diterima tapi tidak terdengar jelas. Coba kirim ulang dengan suara lebih jelas, atau ketik pesan teks.",
            aiProvider: "rule_based", ms: Date.now() - t0m,
          });
        }
        trainingLog({
          ...mBase, transcript: clipText(transcript),
          extractedKeys: Object.keys(tr.extracted || {}), ok: true, ms: Date.now() - t0m,
        });
        // Teruskan transkrip ke mesin chat via self-call (jawab seperti pesan teks).
        try {
          const port = String(process.env.PORT || "3000");
          const fs = (process.env.FORWARD_SECRET || "").trim();
          const cr = await fetch(`http://127.0.0.1:${port}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-tani-forward-secret": fs },
            body: JSON.stringify({ message: transcript.slice(0, 1000), senderPhone }),
            signal: AbortSignal.timeout(7000),
          });
          const cj: any = await cr.json().catch(() => null);
          const reply = String(cj?.reply || "").trim();
          if (reply) {
            return res.json({
              ok: true, kind, transcription: transcript, savedMedia: mediaPath,
              reply, aiProvider: String(cj.aiProvider || "rule_based"), ms: Date.now() - t0m,
            });
          }
          throw new Error("chat kosong");
        } catch {
          return res.json({
            ok: true, kind, transcription: transcript, savedMedia: mediaPath,
            reply: `🎙️ Transkrip: "${transcript.slice(0, 500)}"\n\nMaaf, layanan jawab sedang sibuk — coba kirim ulang sebagai teks.`,
            aiProvider: "rule_based", ms: Date.now() - t0m,
          });
        }
      }
      // F8: kind === "document" (nota/katalog/laporan PDF/DOCX/XLSX/CSV/TXT).
      if (kind === "document") {
        const namaFile = String(filename || "dokumen");
        let parsed: { text: string; tipe: string };
        try {
          parsed = await parseDocumentBuffer(buf, String(mimeType || ""), namaFile);
        } catch (err: any) {
          const msg = String(err?.message || "");
          trainingLog({ ...mBase, filename: namaFile.slice(0, 200), ok: false, error: clipText(msg || "gagal", 200), ms: Date.now() - t0m });
          return res.json({
            ok: false, kind, savedMedia: mediaPath,
            reply: /belum didukung/.test(msg)
              ? `📄 File *${namaFile.slice(0, 60)}* tersimpan, tapi formatnya belum saya dukung. Kirim sebagai PDF, DOCX, XLSX, CSV, atau TXT ya.`
              : `📄 File *${namaFile.slice(0, 60)}* tersimpan tapi tidak bisa dibaca (mungkin rusak/terproteksi). Coba kirim ulang.`,
            aiProvider: "rule_based", ms: Date.now() - t0m,
          });
        }
        const teks = (parsed.text || "").trim().slice(0, 50000);
        if (!teks) {
          trainingLog({ ...mBase, filename: namaFile.slice(0, 200), tipe: parsed.tipe, ok: false, error: "teks kosong", ms: Date.now() - t0m });
          return res.json({
            ok: false, kind, savedMedia: mediaPath,
            reply: `📄 File *${namaFile.slice(0, 60)}* terbaca tapi kosong (mungkin hasil pindaian/foto). Coba kirim sebagai foto agar saya analisis visual.`,
            aiProvider: "rule_based", ms: Date.now() - t0m,
          });
        }
        const ent = extractDocEntities(teks);
        const rec = logDocument(String(senderPhone || ""), namaFile, parsed.tipe, buf.length, ent, mediaPath);
        trainingLog({ ...mBase, filename: namaFile.slice(0, 200), tipe: parsed.tipe, docId: rec.id, entities: rec.ringkasan.slice(0, 500), ok: true, ms: Date.now() - t0m });
        const kb = buf.length >= 1024 ? `${(buf.length / 1024).toFixed(1)} KB` : `${buf.length} B`;
        const baris = [
          `📄 *Dokumen diterima:* ${namaFile.slice(0, 60)} (${parsed.tipe.toUpperCase()}, ${kb})`,
          ent.komoditas.length ? `• Komoditas: ${ent.komoditas.slice(0, 8).join(", ")}` : "",
          ent.harga.length ? `• Harga disebut: ${ent.harga.slice(0, 5).join(" • ")}` : "",
          ent.saprodi.length ? `• Saprodi/alat: ${ent.saprodi.slice(0, 8).join(", ")}` : "",
          ent.komoditas.length || ent.harga.length || ent.saprodi.length
            ? `Tersimpan sebagai \`${rec.id}\`. Mau saya carikan harga pasar atau buyer untuk komoditas ini?`
            : `Tidak menemukan info komoditas/harga di dalamnya, tapi tersimpan sebagai \`${rec.id}\`.`,
        ].filter(Boolean).join("\n");
        return res.json({
          ok: true, kind, docId: rec.id, tipe: parsed.tipe, entities: ent,
          savedMedia: mediaPath, reply: baris, aiProvider: "rule_based", ms: Date.now() - t0m,
        });
      }
      // kind === "image"
      let analysis = "";
      try {
        analysis = await analyzeImageBuffer(buf, mimeType || "image/jpeg", String(caption || ""));
      } catch (err: any) {
        trainingLog({ ...mBase, caption: String(caption || "").slice(0, 500), analysis: "", ok: false, error: clipText(err?.message || "gagal", 200), ms: Date.now() - t0m });
        return res.json({
          ok: false, kind, analysis: "", savedMedia: mediaPath,
          reply: "🖼️ Foto tersimpan. Analisis gambar belum tersedia saat ini — coba kirim ulang nanti.",
          aiProvider: "rule_based", ms: Date.now() - t0m,
        });
      }
      if (!analysis.trim()) analysis = "🖼️ Foto diterima tapi belum bisa dianalisis. Coba kirim foto yang lebih jelas.";
      // Langkah 2-3 loop agenik: padanan referensi + simpan kasus (bukan one-shot).
      const diagHits = cariReferensiTani(`${analysis} ${String(caption || "")}`, 1);
      const diagText = diagHits.length > 0
        ? `\n\n🔎 *Padanan referensi:* [${diagHits[0].id}] *${diagHits[0].judul}* — ${String(diagHits[0].isi).split(". ")[0]}.\n(Sumber: ${diagHits[0].sumber})\n${PPL_LINE}`
        : `\n\n❓ Belum ada padanan pasti di tabel referensi. Gejalanya di daun tua atau pucuk, dan sejak kapan muncul? Balas detailnya, saya cocokkan lagi.`;
      const diagId = simpanKasusDiagnosa({
        farmerId: (typeof farmerHit !== "undefined" && farmerHit ? (farmerHit as any).id : "") || "",
        senderHash: hashPhone(String(senderPhone || "")),
        mediaPath, ringkasan: clipText(analysis, 500),
        matchIds: diagHits.map((d) => d.id),
        status: diagHits.length > 0 ? "cocok-referensi" : "butuh-info",
      });
      analysis = `${analysis}${diagText}${diagId ? `\n\n🗂️ Kasus tercatat sebagai \`${diagId}\`.` : ""}`;
      trainingLog({ ...mBase, caption: String(caption || "").slice(0, 500), analysis: clipText(analysis), ok: true, ms: Date.now() - t0m });
      return res.json({
        ok: true, kind, analysis, savedMedia: mediaPath,
        reply: analysis, aiProvider: "gemini", ms: Date.now() - t0m,
      });
    } catch (err: any) {
      console.error("[WA Media Error]", err?.message || err);
      return res.status(500).json({ error: "Gagal memproses media: " + (err?.message || "Internal error") });
    }
  });

  // POST lokasi WA dari forwarder: ShareLoc (msg.location Meta) -> koordinat
  // petani. Auth sama seperti /api/wa-media (sesi admin atau forwarder resmi).
  app.post("/api/wa-location", (req: any, res: any, next: any) => {
    const s = readSession(req);
    const adm = s ? adminsDb.find((a) => a.id === s.adminId && a.aktif) : undefined;
    (req as any).sessionAdmin = adm;
    const fs = (process.env.FORWARD_SECRET || "").trim();
    const fwdOk = !!fs && String(req.headers["x-tani-forward-secret"] || "") === fs;
    if (!adm && !fwdOk) return res.status(401).json({ error: "Butuh login admin atau forwarder resmi." });
    next();
  }, async (req, res) => {
    const t0l = Date.now();
    try {
      const { latitude, longitude, name, address, senderPhone, waId } = req.body || {};
      if (!senderPhone || typeof senderPhone !== "string") {
        return res.status(400).json({ error: "senderPhone is required" });
      }
      if (!isValidWaCoords(latitude, longitude)) {
        return res.status(400).json({ error: "latitude -90..90, longitude -180..180, keduanya wajib angka valid" });
      }
      const loc = {
        latitude: Number(latitude),
        longitude: Number(longitude),
        name: sanitizeText(name, 200),
        address: sanitizeText(address, 500),
      };
      const r = applyWaLocationToFarmer(senderPhone, loc, "wa-location");
      // F1: ShareLoc melengkapi onboarding (LOC_ASK -> DONE; pre-consent: simpan saja).
      let locJustDone = false;
      if (!findAdmin(senderPhone)) {
        let u = getUser(senderPhone);
        if (!u) u = createUser(senderPhone);
        u.locLat = Number(loc.latitude.toFixed(6));
        u.locLng = Number(loc.longitude.toFixed(6));
        if (r.label) u.locLabel = r.label;
        u.locMapsUrl = r.mapsUrl;
        u.locAt = new Date().toISOString();
        u.locWeak = r.weak;
        if (u.onboardingState === "LOC_ASK") {
          u.onboardingState = "DONE";
          locJustDone = true;
          emitCanonicalEvent({
            source: "wa-location", entity: "user", entityId: `user-${hashPhone(u.phone).slice(0, 12)}`,
            action: "onboarded", actor: senderPhone, payload: { role: u.role || "PETANI" },
          });
        }
        touchUser(u);
      }
      const activeAdmin = findAdmin(senderPhone);
      const farmerHit = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(senderPhone));
      trainingLog({
        kind: "location", channel: "wa",
        role: activeAdmin ? "admin" : (farmerHit ? "petani" : "tamu"),
        phoneHash: hashPhone(senderPhone),
        lat: Number(loc.latitude.toFixed(6)), lng: Number(loc.longitude.toFixed(6)),
        label: r.label || undefined, mapsUrl: r.mapsUrl, weak: r.weak,
        farmerId: r.farmerId || undefined, waId: String(waId || ""),
        ok: true, ms: Date.now() - t0l,
      });
      const weakNote = r.weak
        ? `\n\n⚠️ Titik terlihat di luar Indonesia — bila kurang tepat, balas dengan nama desa/kabupaten yang benar.`
        : "";
      let reply = r.updated
        ? `📍 *Lokasi diterima!* Koordinat lahan Anda kami perbarui ke ${r.mapsUrl}${r.label ? `\n📌 ${r.label}` : ""}${weakNote}\n\nKetik *bantuan* untuk lanjut.`
        : `📍 *Lokasi diterima!* Titik ${r.mapsUrl} tersimpan.${r.label ? `\n📌 ${r.label}` : ""}${weakNote}\n\nUntuk melengkapi pendaftaran, balas dengan: nama, komoditas, luas lahan, dan desa/kabupaten.`;
      if (locJustDone) {
        const du = getUser(senderPhone);
        if (du) reply = `📍 *Lokasi diterima!* ${r.mapsUrl}${weakNote}\n\n${doneReply(du)}`;
      }
      return res.json({
        ok: true, kind: "location", reply, aiProvider: "rule_based",
        mapsUrl: r.mapsUrl, latitude: Number(loc.latitude.toFixed(6)), longitude: Number(loc.longitude.toFixed(6)),
        weak: r.weak, farmerId: r.farmerId || null, ms: Date.now() - t0l,
      });
    } catch (err: any) {
      console.error("[WA Location Error]", err?.message || err);
      return res.status(500).json({ error: "Gagal memproses lokasi: " + (err?.message || "Internal error") });
    }
  });

  // ============ ERP Fase 5: Kas Tani ============
  // POST catat transaksi kas (tulis wajib identitas dikenal)
  app.post("/api/cash", requireSession(), (req, res) => {
    const r = processCashEntry(req.body || {});
    res.status(r.status).json(r.body);
  });

  // GET daftar transaksi kas (baca: petani difilter miliknya, dashboard semua)
  app.get("/api/cash", requireSession(), (req, res) => {
    const q = req.query as any;
    const scope = resolveErpScope(q.senderPhone);
    let rows = [...cashDb];
    const farmerId = scope.farmerId || q.farmerId;
    if (farmerId) rows = rows.filter((c) => c.farmerId === farmerId);
    if (q.jenis) rows = rows.filter((c) => c.jenis === String(q.jenis).toUpperCase());
    if (q.kategori) rows = rows.filter((c) => c.kategori === q.kategori);
    if (q.komoditas) rows = rows.filter((c) => (c.komoditas || "").toLowerCase() === String(q.komoditas).toLowerCase());
    if (q.musimTanam) rows = rows.filter((c) => c.musimTanam === q.musimTanam);
    if (q.from) rows = rows.filter((c) => String(c.tanggal) >= String(q.from));
    if (q.to) rows = rows.filter((c) => String(c.tanggal) <= String(q.to));
    rows.sort((a, b) => (a.waktuCatat < b.waktuCatat ? 1 : -1));
    res.json(rows);
  });

  // GET ringkasan saldo kas per petani
  app.get("/api/cash/summary", requireSession(), (req, res) => {
    const q = req.query as any;
    const scope = resolveErpScope(q.senderPhone);
    const farmerId = scope.farmerId || q.farmerId;
    if (!farmerId) {
      return res.status(400).json({ error: "Wajib sertakan farmerId (atau senderPhone petani terdaftar)." });
    }
    let rows = cashDb.filter((c) => c.farmerId === farmerId);
    if (q.komoditas) rows = rows.filter((c) => (c.komoditas || "").toLowerCase() === String(q.komoditas).toLowerCase());
    if (q.musimTanam) rows = rows.filter((c) => c.musimTanam === q.musimTanam);
    res.json({ farmerId, count: rows.length, ...cashSaldo(rows) });
  });

  // ============ ERP Fase 5: Stok Kios ============
  // POST catat mutasi stok (kios pemilik atau admin)
  app.post("/api/stock", requireSession(), (req, res) => {
    const r = processStockEntry(req.body || {});
    res.status(r.status).json(r.body);
  });

  // GET daftar mutasi stok
  app.get("/api/stock", requireSession(), (req, res) => {
    const q = req.query as any;
    const scope = resolveErpScope(q.senderPhone);
    let rows = [...stockDb];
    const supplierId = scope.supplierId || q.supplierId;
    if (supplierId) rows = rows.filter((m) => m.supplierId === supplierId);
    if (q.produk) {
      const p = String(q.produk).toLowerCase();
      rows = rows.filter((m) => m.produk.toLowerCase().includes(p));
    }
    rows.sort((a, b) => (a.waktuCatat < b.waktuCatat ? 1 : -1));
    res.json(rows);
  });

  // GET saldo stok per kios (per produk + satuan)
  app.get("/api/stock/saldo", requireSession(), (req, res) => {
    const q = req.query as any;
    const scope = resolveErpScope(q.senderPhone);
    const supplierId = scope.supplierId || q.supplierId;
    if (!supplierId) {
      return res.status(400).json({ error: "Wajib sertakan supplierId (atau senderPhone kios terdaftar)." });
    }
    res.json({ supplierId, saldo: stockSaldo(supplierId, q.produk) });
  });

  // ============ ERP Fase 5: HPP Komoditas ============
  // POST generate laporan HPP dari transaksi kas
  app.post("/api/hpp/generate", requireSession(), (req, res) => {
    const r = processHppGenerate(req.body || {});
    res.status(r.status).json(r.body);
  });

  // GET daftar laporan HPP
  app.get("/api/hpp", requireSession(), (req, res) => {
    const q = req.query as any;
    const scope = resolveErpScope(q.senderPhone);
    let rows = [...hppDb];
    const farmerId = scope.farmerId || q.farmerId;
    if (farmerId) rows = rows.filter((h) => h.farmerId === farmerId);
    if (q.komoditas) {
      rows = rows.filter((h) => (h.komoditas || "").toLowerCase() === String(q.komoditas).toLowerCase());
    }
    res.json(rows);
  });

  // GET ekspor CSV kas tani (Lembar 3)
  app.get("/api/sheets/cash/export.csv", requireSession(), (req, res) => {
    const q = req.query as any;
    const scope = resolveErpScope(q.senderPhone);
    let rows = [...cashDb];
    if (scope.farmerId) rows = rows.filter((c) => c.farmerId === scope.farmerId);
    else if (q.farmerId) rows = rows.filter((c) => c.farmerId === q.farmerId);
    const headers = ["ID", "Farmer ID", "Tanggal", "Jenis", "Kategori", "Jumlah (Rp)", "Komoditas", "Musim Tanam", "Catatan", "Dicatat Oleh", "Waktu Catat"];
    const body = rows.map((c) => [
      csvCell(c.id), csvCell(c.farmerId), csvCell(c.tanggal), csvCell(c.jenis), csvCell(c.kategori),
      c.jumlahRp, csvCell(c.komoditas || ""), csvCell(c.musimTanam || ""), csvCell(c.catatan || ""),
      csvCell(c.dicatatOleh), csvCell(c.waktuCatat),
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="TaniAI_Kas_Tani.csv"');
    res.send("﻿" + [headers.join(","), ...body.map((r) => r.join(","))].join("\n"));
  });

  // GET ekspor CSV stok kios (Lembar 4)
  app.get("/api/sheets/stock/export.csv", requireSession(), (req, res) => {
    const q = req.query as any;
    const scope = resolveErpScope(q.senderPhone);
    let rows = [...stockDb];
    if (scope.supplierId) rows = rows.filter((m) => m.supplierId === scope.supplierId);
    else if (q.supplierId) rows = rows.filter((m) => m.supplierId === q.supplierId);
    const headers = ["ID", "Supplier ID", "Produk", "Satuan", "Arah", "Qty", "Harga Satuan (Rp)", "Tanggal", "Keterangan", "Dicatat Oleh", "Waktu Catat"];
    const body = rows.map((m) => [
      csvCell(m.id), csvCell(m.supplierId), csvCell(m.produk), csvCell(m.satuan), csvCell(m.arah),
      m.qty, m.hargaSatuanRp ?? "", csvCell(m.tanggal), csvCell(m.keterangan || ""),
      csvCell(m.dicatatOleh), csvCell(m.waktuCatat),
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="TaniAI_Stok_Kios.csv"');
    res.send("﻿" + [headers.join(","), ...body.map((r) => r.join(","))].join("\n"));
  });

  // ============ Fitur Impor Berkas Dinas (PDF/DOCX/XLSX) ============
  // Raw data dinas -> parse tabel otomatis -> DB -> dashboard refresh via onRefresh().
  const dinasUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      cb(null, /\.(pdf|docx|xlsx)$/i.test(file.originalname || ""));
    },
  });

  const FARMER_COL_KEYWORDS: Record<string, string[]> = {
    nama: ["nama", "name", "petani"],
    noHp: ["hp", "handphone", "telepon", "telp", "phone", "kontak", "wa", "nomor"],
    komoditas: ["komoditas", "komoditi", "tanaman"],
    varietas: ["varietas", "jenis"],
    luasLahan: ["luas", "hektar", "lahan"],
    alamat: ["alamat", "desa", "dusun", "kecamatan"],
    kabupaten: ["kabupaten", "kota", "kab"],
    estimasiPanen: ["panen", "estimasi"],
    statusVerifikasi: ["status", "verifikasi"],
  };
  const SUPPLIER_COL_KEYWORDS: Record<string, string[]> = {
    nama: ["nama", "name", "toko", "kios"],
    kategori: ["kategori", "jenis"],
    kontak: ["kontak", "hp", "telepon", "telp", "phone", "wa", "nomor"],
    alamat: ["alamat", "desa", "dusun", "kecamatan"],
    kabupaten: ["kabupaten", "kota", "kab"],
    produkUnggulan: ["produk", "unggulan", "komoditas"],
    stokTersedia: ["stok", "sedia", "ready"],
  };

  function splitRowCells(line: string): string[] {
    if (line.includes("\t")) return line.split("\t").map((s) => s.trim());
    const parts = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    return parts.length > 1 ? parts : [line.trim()];
  }

  function detectHeaderRow(rows: string[][], keywords: Record<string, string[]>): number {
    const allKw = new Set(Object.values(keywords).flat().map((k) => k.toLowerCase()));
    let best = -1;
    let bestHits = 0;
    const limit = Math.min(rows.length, 15);
    for (let i = 0; i < limit; i++) {
      if (rows[i].length < 2) continue;
      let hits = 0;
      for (const c of rows[i]) {
        const cl = c.toLowerCase();
        for (const k of allKw) {
          if (cl.includes(k)) { hits++; break; }
        }
      }
      if (hits >= 2 && hits > bestHits) { bestHits = hits; best = i; }
    }
    return best;
  }

  function headerKeywordHits(text: string, keywords: Record<string, string[]>): number {
    const allKw = new Set(Object.values(keywords).flat().map((k) => k.toLowerCase()));
    const cl = text.toLowerCase();
    let hits = 0;
    for (const k of allKw) if (cl.includes(k)) hits++;
    return hits;
  }

  // Ekstraksi pola untuk baris teks tanpa kolom jelas (mis. hasil PDF):
  // telepon + luas + komoditas (gazetteer) + kabupaten (gazetteer), sisa = nama.
  function extractPatternFields(line: string, entity: string): Record<string, string> | null {
    let rest = ` ${line} `;
    const out: Record<string, string> = {};
    const phone = rest.match(/(\+?62[\d\s\-.]{9,}|08[\d\s\-.]{9,})/);
    if (phone) { out.noHp = phone[1].trim(); out.kontak = phone[1].trim(); rest = rest.replace(phone[0], " "); }
    if (entity === "farmers") {
      const luas = rest.match(/([\d][\d.,]*)\s*(hektare|hektar|ha\b|m2|meter persegi)?/i);
      if (luas) { out.luasLahan = luas[0].trim(); rest = rest.replace(luas[0], " "); }
      for (const c of commoditiesDb) {
        if (c.nama && rest.toLowerCase().includes(c.nama.toLowerCase())) {
          out.komoditas = c.nama; rest = rest.replace(new RegExp(c.nama, "i"), " "); break;
        }
      }
      const kabs = [...new Set(farmersDb.map((f) => f.kabupaten).filter(Boolean))];
      for (const k of kabs) {
        if (k.length >= 4 && rest.toLowerCase().includes(k.toLowerCase())) {
          out.kabupaten = k; rest = rest.replace(new RegExp(k, "i"), " "); break;
        }
      }
    } else {
      for (const k of ["pupuk", "urea", "npk", "bibit", "benih", "pestisida", "obat", "alat", "traktor", "padi", "jagung", "cabai", "bawang"]) {
        if (rest.toLowerCase().includes(k)) { out.produkUnggulan = k; break; }
      }
    }
    const nama = rest.replace(/[-–—:|;,.]+/g, " ").replace(/\s+/g, " ").trim();
    if (!nama || /^\d+$/.test(nama)) return null;
    out.nama = nama;
    // Baris diterima bila nama + minimal satu identitas kuat.
    // Luas saja tidak cukup (angka footer/header bisa lolos sebagai luas).
    if (entity === "farmers") {
      if (!out.noHp && !out.komoditas && !out.kabupaten) return null;
    } else {
      if (!out.kontak && !out.produkUnggulan) return null;
    }
    return out;
  }

  function mapDinasColumns(header: string[], keywords: Record<string, string[]>): (string | null)[] {
    return header.map((h) => {
      const hl = h.toLowerCase();
      for (const [field, kws] of Object.entries(keywords)) {
        if (kws.some((k) => hl.includes(k))) return field;
      }
      return null;
    });
  }

  function parseLuasHa(raw: string): number | undefined {
    let t = String(raw || "").toLowerCase();
    const isM2 = /m2|meter persegi/.test(t);
    // Hapus token satuan DULU agar angka satuan (mis. "2" pada "m2") tak menempel ke angka luas
    t = t.replace(/meter persegi|hektare|hektar|m2|\bha\b/g, " ");
    let num = t.replace(/[^0-9,.\-]/g, "");
    if (num.includes(",")) num = num.replace(/\./g, "").replace(",", ".");
    const n = parseFloat(num);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return undefined;
    return isM2 ? Math.round((n / 10000) * 10000) / 10000 : n;
  }

  async function extractDinasTable(buf: Buffer, ext: string): Promise<{ rows: string[][]; source: string }> {
    if (ext === "xlsx") {
      // Parse di worker sekali pakai + batas 20 detik: SheetJS 0.18.5 di npm
      // memuat CVE proto-pollution & ReDoS tanpa patch upstream, jadi berkas
      // crafted tidak boleh menyentuh event loop / prototipe proses utama.
      const { Worker } = await import("worker_threads");
      const b64 = buf.toString("base64");
      const workerPath = path.join(process.cwd(), "lib", "dinas-xlsx-worker.cjs");
      const rows: string[][] = await new Promise((resolve, reject) => {
        let done = false;
        let w: any;
        try {
          w = new Worker(workerPath, { workerData: { b64 } });
        } catch (e) {
          reject(e);
          return;
        }
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          try { w.terminate(); } catch {}
          reject(Object.assign(new Error("Berkas XLSX ditolak: waktu urai habis (kemungkinan berkas crafted)."), { statusCode: 400 }));
        }, 20000);
        w.on("message", (m: any) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          try { w.terminate(); } catch {}
          if (m && m.ok) resolve(m.rows);
          else reject(Object.assign(new Error("Berkas XLSX ditolak: " + (m?.error || "gagal urai")), { statusCode: 400 }));
        });
        w.on("error", (e: any) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          reject(Object.assign(new Error("Berkas XLSX ditolak: " + (e?.message || e)), { statusCode: 400 }));
        });
      });
      return { rows, source: "sheet1" };
    }
    if (ext === "docx") {
      const mammoth: any = await import("mammoth");
      const html = (await mammoth.convertToHtml({ buffer: buf })).value as string;
      const tables: string[][][] = [];
      for (const tm of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
        const trows: string[][] = [];
        for (const rm of tm[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
          const cells = [...rm[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
            m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim(),
          );
          if (cells.length) trows.push(cells);
        }
        if (trows.length) tables.push(trows);
      }
      if (tables.length) {
        tables.sort((a, b) => b.length - a.length);
        return { rows: tables[0], source: "docx-table" };
      }
      // Fallback: baris <tr> tanpa pembungkus <table> (docx minimal)
      const bareRows: string[][] = [];
      for (const rm of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
        const cells = [...rm[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
          m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim(),
        );
        if (cells.length > 1) bareRows.push(cells);
      }
      if (bareRows.length) return { rows: bareRows, source: "docx-rows" };
      const raw = (await mammoth.extractRawText({ buffer: buf })).value as string;
      return { rows: raw.split(/\r?\n/).map((l) => splitRowCells(l)).filter((r) => r.some((c) => c)), source: "docx-text" };
    }
    // pdf: teks per baris -> inferensi kolom
    const pdfMod: any = await import("pdf-parse");
    const parser = new pdfMod.PDFParse({ data: buf });
    const out = await parser.getText();
    const text = typeof out === "string" ? out : String(out?.text ?? "");
    return { rows: text.split(/\r?\n/).map((l: string) => splitRowCells(l)).filter((r) => r.some((c) => c)), source: "pdf-text" };
  }

  app.post(
    "/api/upload",
    requireSession(),
    (req, res, next) => {
      dinasUpload.single("file")(req as any, res as any, (err: any) => {
        if (err) {
          return res.status(400).json({ error: "Berkas ditolak (maks 10 MB, format PDF/DOCX/XLSX)." });
        }
        next();
      });
    },
    async (req, res) => {
      try {
        const body = (req as any).body || {};
        const scope = resolveErpScope(body.senderPhone);
        if (!scope.isAdmin) {
          return res.status(403).json({ error: "Impor berkas hanya untuk admin/PPL terdaftar." });
        }
        const entity = String(body.entity || "farmers");
        if (entity !== "farmers" && entity !== "suppliers") {
          return res.status(400).json({ error: "entity harus farmers atau suppliers." });
        }
        const f = (req as any).file as { buffer: Buffer; originalname: string; size: number } | undefined;
        if (!f || !f.buffer) {
          return res.status(400).json({ error: "Berkas PDF/DOCX/XLSX (maks 10 MB) wajib diunggah pada field file." });
        }
        const ext = (f.originalname.split(".").pop() || "").toLowerCase();
        if (!["pdf", "docx", "xlsx"].includes(ext)) {
          return res.status(400).json({ error: "Format tidak didukung. Pakai PDF, DOCX, atau XLSX." });
        }
        // Arsip berkas mentah untuk audit
        try {
          const upDir = path.join(DATA_DIR, "uploads");
          if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
          const safeName = `${Date.now()}-${f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
          fs.writeFileSync(path.join(upDir, safeName), f.buffer);
        } catch {}
        const { rows, source } = await extractDinasTable(f.buffer, ext);
        const keywords = entity === "farmers" ? FARMER_COL_KEYWORDS : SUPPLIER_COL_KEYWORDS;
        const hi = detectHeaderRow(rows, keywords);
        // Tanpa header tabel jelas -> ekstraksi pola per baris (mis. teks PDF)
        const usePattern = hi < 0;
        const colMap = usePattern ? [] : mapDinasColumns(rows[hi], keywords);
        let inserted = 0;
        const skipped: Array<{ row: number; reason: string }> = [];
        const ids: string[] = [];
        const nowIso = new Date().toISOString();
        for (let i = (usePattern ? 0 : hi + 1); i < rows.length; i++) {
          const cells = rows[i];
          if (!cells.length || cells.every((c) => !c)) continue;
          const rowNo = i + 1;
          let get: (cellsOrField: any, field?: string) => string;
          if (usePattern) {
            const line = cells.join(" ");
            if (/^\s*--.*--\s*$/.test(line) || /^\s*\d+\s+of\s+\d+\s*$/i.test(line)) continue; // footer PDF
            if (headerKeywordHits(line, keywords) >= 2) continue; // baris judul
            const pf = extractPatternFields(line, entity);
            if (!pf) { skipped.push({ row: rowNo, reason: "baris tidak terbaca sebagai data" }); continue; }
            get = (c: any, f?: string) => pf[f ?? c] || "";
          } else {
            get = (c: any, f?: string) => {
              const field = f ?? c;
              const idx = colMap.indexOf(field);
              return idx >= 0 ? (cells[idx] || "").trim() : "";
            };
          }
          if (entity === "farmers") {
            const nama = sanitizeText(get(cells, "nama"), 100);
            if (!nama) { skipped.push({ row: rowNo, reason: "nama kosong" }); continue; }
            const noHp = get(cells, "noHp") || "+62 8xx-xxxx-xxxx";
            const dup = farmersDb.find(
              (x) => x.nama.toLowerCase() === nama.toLowerCase() && normalizePhone(x.noHp) === normalizePhone(noHp),
            );
            if (dup) { skipped.push({ row: rowNo, reason: `duplikat ${dup.id}` }); continue; }
            const luas = parseLuasHa(get(cells, "luasLahan"));
            const rec: FarmerRecord = {
              id: nextId("TANI", farmersDb.map((x) => x.id)),
              timestamp: nowIso.replace("T", " ").substring(0, 19),
              nama,
              noHp,
              alamat: sanitizeText(get(cells, "alamat"), 200) || "Impor berkas dinas",
              kabupaten: sanitizeText(get(cells, "kabupaten"), 60) || "Subang",
              luasLahan: luas ?? 0,
              luasLahanFormatted: luas ? `${luas} Ha` : "Belum diukur",
              komoditas: sanitizeText(get(cells, "komoditas"), 60) || "Belum diketahui",
              varietas: sanitizeText(get(cells, "varietas"), 60) || "Lokal Unggul",
              estimasiPanen: sanitizeText(get(cells, "estimasiPanen"), 60) || "-",
              estimasiHasilTon: 0,
              statusVerifikasi: "Menunggu Verifikasi",
              catatanAI: `Impor berkas ${f.originalname} — menunggu verifikasi PPL.`,
              syncStatus: "synced",
              googleSheetRow: nextSheetRow(
                farmersDb.map((x) => x.googleSheetRow),
                farmersDb.length,
              ),
              latitude: -6.5 + (Math.random() * 0.1 - 0.05),
              longitude: 107.5 + (Math.random() * 0.1 - 0.05),
            };
            farmersDb.unshift(rec);
            ids.push(rec.id);
            inserted++;
          } else {
            const nama = sanitizeText(get(cells, "nama"), 100);
            if (!nama) { skipped.push({ row: rowNo, reason: "nama kosong" }); continue; }
            const kontak = get(cells, "kontak") || "-";
            const dup = suppliersDb.find(
              (x) => x.nama.toLowerCase() === nama.toLowerCase() && x.kontak === kontak,
            );
            if (dup) { skipped.push({ row: rowNo, reason: `duplikat ${dup.id}` }); continue; }
            const rec: SupplierRecord = {
              id: nextId("SUP", suppliersDb.map((x) => x.id)),
              nama,
              kategori: "Pupuk & Saprodi",
              kontak,
              alamat: sanitizeText(get(cells, "alamat"), 200) || "Impor berkas dinas",
              kabupaten: sanitizeText(get(cells, "kabupaten"), 60) || "Subang",
              latitude: -7.0 + (Math.random() * 0.1 - 0.05),
              longitude: 108.5 + (Math.random() * 0.1 - 0.05),
              statusKemitraan: "Mitra Aktif",
              produkUnggulan: get(cells, "produkUnggulan")
                ? get(cells, "produkUnggulan").split(/[,;/|]/).map((s) => s.trim()).filter(Boolean)
                : [],
              stokTersedia: sanitizeText(get(cells, "stokTersedia"), 60) || undefined,
              googleSheetRow: nextSheetRow(
                suppliersDb.map((x) => x.googleSheetRow),
                suppliersDb.length,
              ),
            };
            suppliersDb.unshift(rec);
            ids.push(rec.id);
            inserted++;
          }
        }
        const usable = inserted > 0 || skipped.some((s) => s.reason !== "baris tidak terbaca sebagai data");
        if (!usable) {
          return res.status(400).json({
            error: "Tidak ada baris data yang terbaca. Pastikan berkas memuat tabel berjudul kolom (mis. Nama, No HP, Komoditas, Luas, Kabupaten) atau baris teks berisi nama + nomor HP/luas.",
            source,
          });
        }
        if (entity === "farmers") saveFarmersToDisk();
        else saveSuppliersToDisk();
        bumpDataVersion();
        res.status(201).json({
          filename: f.originalname,
          entity,
          source,
          inserted,
          skipped,
          ids,
        });
      } catch (err: any) {
        console.error("[Upload Error]", err?.message);
        const code = err?.statusCode === 400 ? 400 : 500;
        res.status(code).json({ error: code === 400 ? err.message : "Gagal mengurai berkas: " + (err?.message || "Internal error") });
      }
    },
  );

  // GET market commodities & anomaly prices
  app.get("/api/commodities", (_req, res) => {
    res.json(commoditiesDb);
  });

  app.get("/api/harga-pasar", async (req, res) => {
    try {
      const sumber = String((req.query as any)?.sumber || "siska").toLowerCase();
      if (sumber === "buah") {
        const b = await fetchHargaBuah();
        res.json({
          sumber: "InfoPangan DKI Jakarta + Input Admin",
          tanggal: b.tanggal,
          live: b.live,
          count: b.daftar.length,
          daftar: b.daftar,
        });
        return;
      }
      if (sumber === "mantung" || sumber === "semua") {
        const mt = await fetchHargaMantung();
        if (sumber === "mantung") {
          res.json({
            sumber: "Pasar Mantung Kab. Malang",
            tanggal: mt.tanggal,
            live: mt.live,
            count: mt.daftar.length,
            daftar: mt.daftar,
          });
          return;
        }
        const s = await fetchHargaPasar();
        res.json({
          sumber: "SISKAPERBAPO Disperindag Jatim + Pasar Mantung Kab. Malang",
          siska: { tanggal: s.tanggal, live: s.live, count: s.daftar.length, daftar: s.daftar },
          mantung: { tanggal: mt.tanggal, live: mt.live, count: mt.daftar.length, daftar: mt.daftar },
        });
        return;
      }
      const { tanggal, daftar, live } = await fetchHargaPasar();
      res.json({
        sumber: "SISKAPERBAPO Disperindag Jatim",
        tanggal,
        live,
        count: daftar.length,
        daftar,
      });
    } catch (e: any) {
      res.status(502).json({ error: "Gagal mengambil harga pasar", detail: String(e?.message || e) });
    }
  });

  // Harga buah input admin (digabung sumber live di ?sumber=buah).
  app.get("/api/fruit-prices", requireSession(), (_req, res) => {
    res.json(fruitPricesDb);
  });
  app.post("/api/fruit-prices", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const nama = String(req.body?.nama || "").trim().slice(0, 60);
    const satuan = String(req.body?.satuan || "").trim().slice(0, 12) || "kg";
    const harga = Number(req.body?.harga) || 0;
    const pasar = String(req.body?.pasar || "").trim().slice(0, 60);
    if (!nama || harga <= 0) {
      return res.status(400).json({ error: "nama + harga (>0) wajib." });
    }
    const dupe = fruitPricesDb.some((r) => r.nama.toLowerCase() === nama.toLowerCase());
    if (dupe) {
      return res.status(409).json({ error: "Buah ini sudah ada. Hapus dulu untuk ganti harga." });
    }
    const rec: FruitPrice = { id: nextFruitId(), nama, satuan, harga, pasar: pasar || undefined, waktuCatat: new Date().toISOString() };
    fruitPricesDb.unshift(rec);
    saveFruitToDisk();
    bumpDataVersion();
    res.json(rec);
  });
  app.delete("/api/fruit-prices/:id", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const id = String(req.params.id || "").toUpperCase();
    const ix = fruitPricesDb.findIndex((r) => r.id.toUpperCase() === id);
    if (ix < 0) {
      return res.status(404).json({ error: "Baris buah tidak ditemukan." });
    }
    const [gone] = fruitPricesDb.splice(ix, 1);
    saveFruitToDisk();
    bumpDataVersion();
    res.json({ deleted: gone.id });
  });

  // Kemitraan: daftar penawaran buyer (baca; tulis hanya catatan admin).
  app.get("/api/offers", requireSession(), (_req, res) => {
    res.json(offersDb);
  });
  app.patch("/api/offers/:id", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const id = String(req.params.id || "").toUpperCase();
    const o = offersDb.find((x) => x.id.toUpperCase() === id);
    if (!o) {
      return res.status(404).json({ error: "Penawaran tidak ditemukan." });
    }
    // Status terminal: field pemicu-eval (spesifikasi) tak boleh berubah pada DEAL/BATAL; catatan/followup murni tetap boleh.
    if ((o.status === "DEAL" || o.status === "BATAL") && req.body?.spesifikasi !== undefined) {
      return res.status(409).json({ error: `Penawaran ${o.id} sudah ${o.status} - spesifikasi tak bisa diubah.` });
    }
    // Status/lines milik mesin negosiasi chat; admin hanya boleh mencatat + spek.
    if (req.body?.namaBuyer !== undefined) o.namaBuyer = String(req.body.namaBuyer || "").trim().slice(0, 60) || undefined;
    if (req.body?.spesifikasi !== undefined) {
      o.spesifikasi = String(req.body.spesifikasi || "").trim().slice(0, 120) || undefined;
      for (const l of o.lines) l.spekOk = undefined;
      evalOffer(o);
    }
    if (req.body?.catatan !== undefined) o.catatan = String(req.body.catatan || "").trim().slice(0, 300) || undefined;
    if (req.body?.followupAt !== undefined) {
      o.followupAt = req.body.followupAt === "now" ? new Date().toISOString() : undefined;
    }
    saveOffersToDisk();
    bumpDataVersion();
    res.json(o);
  });

  const NEED_KAT = ["PUPUK", "OBAT", "BIBIT", "LAINNYA"];
  const NEED_ST = ["BARU", "DIHUBUNGKAN", "TERPENUHI", "BATAL"];
  app.get("/api/farmer-needs", requireSession(), (_req, res) => {
    res.json(needsDb);
  });
  app.post("/api/farmer-needs", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const farmerId = String(req.body?.farmerId || "").trim();
    const kategori = String(req.body?.kategori || "").toUpperCase();
    const item = String(req.body?.item || "").trim().slice(0, 80);
    const jumlah = String(req.body?.jumlah || "").trim().slice(0, 30) || undefined;
    const catatan = String(req.body?.catatan || "").trim().slice(0, 300) || undefined;
    if (!farmersDb.some((f) => f.id === farmerId)) {
      return res.status(400).json({ error: "farmerId tidak dikenal." });
    }
    if (!NEED_KAT.includes(kategori) || !item) {
      return res.status(400).json({ error: "kategori (PUPUK/OBAT/BIBIT/LAINNYA) + item wajib." });
    }
    const now = new Date().toISOString();
    const rec: FarmerNeed = { id: nextNeedId(), farmerId, kategori: kategori as NeedKategori, item, jumlah, status: "BARU", catatan, createdAt: now, updatedAt: now };
    needsDb.unshift(rec);
    saveNeedsToDisk();
    bumpDataVersion();
    res.json(rec);
  });
  app.patch("/api/farmer-needs/:id", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const id = String(req.params.id || "").toUpperCase();
    const n = needsDb.find((x) => x.id.toUpperCase() === id);
    if (!n) {
      return res.status(404).json({ error: "Kebutuhan tidak ditemukan." });
    }
    if (req.body?.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (!NEED_ST.includes(st)) {
        return res.status(400).json({ error: "status tidak dikenal." });
      }
      n.status = st as NeedStatus;
    }
    if (req.body?.supplierId !== undefined) {
      const sid = String(req.body.supplierId || "").trim();
      if (sid && !suppliersDb.some((s) => s.id === sid)) {
        return res.status(400).json({ error: "supplierId tidak dikenal." });
      }
      n.supplierId = sid || undefined;
      if (sid && n.status === "BARU") n.status = "DIHUBUNGKAN";
    }
    if (req.body?.item !== undefined) {
      const item = String(req.body.item || "").trim().slice(0, 80);
      if (!item) {
        return res.status(400).json({ error: "item tidak boleh kosong." });
      }
      n.item = item;
    }
    if (req.body?.jumlah !== undefined) n.jumlah = String(req.body.jumlah || "").trim().slice(0, 30) || undefined;
    if (req.body?.catatan !== undefined) n.catatan = String(req.body.catatan || "").trim().slice(0, 300) || undefined;
    n.updatedAt = new Date().toISOString();
    saveNeedsToDisk();
    bumpDataVersion();
    res.json(n);
  });
  app.delete("/api/farmer-needs/:id", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const id = String(req.params.id || "").toUpperCase();
    const ix = needsDb.findIndex((r) => r.id.toUpperCase() === id);
    if (ix < 0) {
      return res.status(404).json({ error: "Kebutuhan tidak ditemukan." });
    }
    const [gone] = needsDb.splice(ix, 1);
    saveNeedsToDisk();
    bumpDataVersion();
    res.json({ deleted: gone.id });
  });

  // POST simulate or update commodity price
  app.post("/api/commodities/update", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const { id, hargaBaru, penyebab } = req.body;
    const item = commoditiesDb.find((c) => c.id === id);
    if (!item) {
      return res.status(404).json({ error: "Komoditas tidak ditemukan" });
    }

    const hargaLama = item.hargaSekarang;
    const baru = Number(hargaBaru) || hargaLama;
    const perubahan = ((baru - item.hargaKemarin) / item.hargaKemarin) * 100;

    item.hargaKemarin = hargaLama;
    item.hargaSekarang = baru;
    item.perubahanPersen = Number(perubahan.toFixed(2));
    item.tanggalUpdate = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });

    // Evaluate anomaly thresholds (+/- 15%)
    if (item.perubahanPersen >= 20) {
      item.statusAnomali = "LONJAKAN_EKSTREM";
      item.pesanAnomali = `Lonjakan ekstrem (+${item.perubahanPersen}%) akibat fluktuasi pasokan dan cuaca. ${penyebab || ""}`;
    } else if (item.perubahanPersen <= -20) {
      item.statusAnomali = "PENURUNAN_DRASTIS";
      item.pesanAnomali = `Penurunan drastis (${item.perubahanPersen}%) di bawah acuan pasar. ${penyebab || ""}`;
    } else if (Math.abs(item.perubahanPersen) >= 10) {
      item.statusAnomali = "PERINGATAN_FLUKTUASI";
      item.pesanAnomali = `Perubahan harga signifikan (${item.perubahanPersen}%). Pantau ketat dinamika pasar.`;
    } else {
      item.statusAnomali = "NORMAL";
      item.pesanAnomali = "Kondisi harga relatif stabil dalam rentang normal.";
    }

    // Append to trend
    item.tren7Hari.push({
      tanggal: new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short" }),
      harga: baru,
    });
    if (item.tren7Hari.length > 7) {
      item.tren7Hari.shift();
    }

    bumpDataVersion();
    res.json(item);
  });

  // POST jalankan detektor EWS sekarang atas data cache (admin).
  app.post("/api/notifications/scan", requireSession(), (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const daftar = (pasarCache?.daftar || []) as PasarPrice[];
    const before = notificationsDb.length;
    try {
      detectPriceAnomalies(daftar);
    } catch (e: any) {
      return res.status(502).json({ error: "Deteksi gagal", detail: String(e?.message || e) });
    }
    res.json({
      ok: true,
      scanned: daftar.length,
      cacheAt: pasarCache ? new Date(pasarCache.at).toISOString() : null,
      baru: notificationsDb.length - before,
      anomali: commoditiesDb
        .filter((c) => c.statusAnomali !== "NORMAL")
        .map((c) => ({ nama: c.nama, status: c.statusAnomali, pct: c.perubahanPersen, harga: c.hargaSekarang, kemarin: c.hargaKemarin })),
    });
  });

  // POST broadcast anomaly notification to farmers
  app.post("/api/notifications/broadcast", requireSession(), async (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const { komoditasId } = req.body;
    const commodity = commoditiesDb.find((c) => c.id === komoditasId);
    if (!commodity) {
      return res.status(404).json({ error: "Komoditas tidak ditemukan" });
    }

    // Find farmers growing this commodity
    const matchingFarmers = farmersDb.filter((f) =>
      f.komoditas.toLowerCase().includes(commodity.nama.toLowerCase().split(" ")[0])
    );

    const isSurge = commodity.statusAnomali === "LONJAKAN_EKSTREM";
    const alertMessage = isSurge
      ? `📢 [TaniAI ALERT HARGA PASAR]\nBpk/Ibu Petani ${commodity.nama}, harga pasar melonjak tinggi mencapai Rp ${commodity.hargaSekarang.toLocaleString("id-ID")}/kg (+${commodity.perubahanPersen}%).\n💡 Rekomendasi: ${commodity.rekomendasiPetani}`
      : `⚠️ [TaniAI PERINGATAN PASAR]\nBpk/Ibu Petani ${commodity.nama}, harga pasar mengalami pelemahan di Rp ${commodity.hargaSekarang.toLocaleString("id-ID")}/kg (${commodity.perubahanPersen}%).\n💡 Rekomendasi: ${commodity.rekomendasiPetani}`;

    const newNotif: AnomalyNotification = {
      id: `notif-${Date.now()}`,
      komoditas: commodity.nama,
      tipeAnomali: commodity.statusAnomali as any,
      pesanPeringatan: alertMessage,
      waktuKirim: new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) + ", " + new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) + " WIB",
      jumlahPetaniTerdampak: Math.max(matchingFarmers.length, 1),
      status: "Terkirim",
      targetPetaniNames: matchingFarmers.length > 0 ? matchingFarmers.map((f) => f.nama) : ["Seluruh Petani Terdaftar"],
    };

    notificationsDb.unshift(newNotif);
    // viaWa=true → teks (butuh jendela 24 jam; di luar itu 131047).
    // viaWa="template" → template statis pembuka jendela (terkirim kapan pun).
    let wa: { attempted: number; sent: number; failed: { nama: string; to: string; errorCode?: number; error?: string }[] } | { attempted: 0; reason: string } = { attempted: 0, reason: "viaWa tidak diminta" };
    if (req.body?.viaWa === true) {
      if (matchingFarmers.length > 0) {
        wa = await broadcastWaText(matchingFarmers.map((f) => ({ nama: f.nama, noHp: f.noHp })), alertMessage);
      } else {
        wa = { attempted: 0, reason: "tanpa petani target bernomor" };
      }
    } else if (req.body?.viaWa === "template") {
      if (matchingFarmers.length > 0) {
        wa = await broadcastWaTemplate(matchingFarmers.map((f) => ({ nama: f.nama, noHp: f.noHp })), WA_OPENER_TEMPLATE, "id", []);
      } else {
        wa = { attempted: 0, reason: "tanpa petani target bernomor" };
      }
    }
    res.json({ success: true, notification: newNotif, recipientsCount: newNotif.jumlahPetaniTerdampak, wa });
  });

  // GET notifications list
  app.get("/api/notifications", requireSession(), (_req, res) => {
    res.json(notificationsDb);
  });

  // GET ringkasan aktivitas terakhir (umpan dasbor admin)
  app.get("/api/aktivitas", requireSession(), (_req, res) => {
    const teks = (e: any): string => {
      const p = e?.payload || {};
      const nama = p.nama || p.noHp || p.komoditas || e?.entityId || "";
      const id = nama ? ` ${nama}` : "";
      switch (`${e?.entity}:${e?.action}`) {
        case "offer:deal": return `Kesepakatan${id}`;
        case "offer:create": return `Penawaran baru${id}`;
        case "commodity:price": return `Update harga${id}`;
        case "farmer:create": return `Petani terdaftar${id}`;
        case "farmer:update": return `Data petani diubah${id}`;
        case "user:create": return `Pendaftaran${id}`;
        case "cash:create": return `Kas tercatat${id}`;
        default:
          break;
      }
      switch (e?.action) {
        case "deal": return `Kesepakatan${id}`;
        case "flagged": return `Perlu perhatian${id}`;
        case "followup": return `Tindak lanjut${id}`;
        case "followup_fail": return `Tindak lanjut gagal${id}`;
        case "ack": return `Konfirmasi${id}`;
        case "budget": return `Anggaran${id}`;
        case "close": return `Penutupan${id}`;
        case "onboarded_weak": return `Pendaftaran parsial${id}`;
        case "loc_draft": return `Draf lokasi${id}`;
        case "create": return `${e?.entity || "Data"} baru${id}`;
        case "update": return `${e?.entity || "Data"} diubah${id}`;
        default: return `${e?.action || "?"}${id}`;
      }
    };
    res.json(
      (Array.isArray(eventsDb) ? eventsDb : [])
        .slice(0, 25)
        .map((e: any) => ({ ts: e?.ts || "", aksi: String(e?.action || ""), teks: teks(e) })),
    );
  });

  // GET strategic recommendations
  app.get("/api/strategic-recommendation", (_req, res) => {
    res.json(latestRecommendation);
  });

  // POST generate strategic recommendation via AI with smart caching
  app.post("/api/strategic-recommendation/generate", requireSession(), async (req, res) => {
    const nineCfg = getNineRouterConfig();
    const ai = getGemini();

    const totalLuasNum = farmersDb.reduce((acc, f) => acc + (f.luasLahan || 0), 0);
    const totalEstimasiPanenTon = farmersDb.reduce((acc, f) => acc + (f.estimasiHasilTon || 0), 0);
    const currentDataHash = `${farmersDb.length}_${totalLuasNum.toFixed(1)}_${totalEstimasiPanenTon.toFixed(1)}_${commoditiesDb.map((c) => `${c.id}:${c.hargaSekarang}`).join(",")}`;

    const forceRefresh = Boolean(req.body?.forceRefresh);
    const isRecent = latestRecommendation && Date.now() - lastRecommendationGeneratedAt < 1800000;

    // Pillar 3: Reuse existing result if data hasn't changed! (Gunakan kembali hasil yang ada)
    if (!forceRefresh && latestRecommendation && latestRecommendationDataHash === currentDataHash && isRecent) {
      console.log("[AI Optimization] ⚡ Menggunakan hasil rekomendasi tersimpan (data belum berubah - hemat 100% token)");
      totalCacheHits++;
      totalTokensSavedEstimate += 1200;
      return res.json({
        ...latestRecommendation,
        fromCache: true,
        cachedAt: new Date(lastRecommendationGeneratedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
        cacheNotice: "Laporan dimuat dari cache tersimpan (data belum berubah - 0 token terpakai).",
      });
    }

    // Pillar 1: Lean Aggregated Summary (Send only necessary metrics, DO NOT dump raw farmer records!)
    const cropStats: Record<string, { count: number; luas: number; ton: number }> = {};
    for (const f of farmersDb) {
      const key = f.komoditas ? f.komoditas.split(" ")[0] : "Lainnya";
      if (!cropStats[key]) cropStats[key] = { count: 0, luas: 0, ton: 0 };
      cropStats[key].count++;
      cropStats[key].luas += f.luasLahan || 0;
      cropStats[key].ton += f.estimasiHasilTon || 0;
    }

    const leanSummaryContext = {
      totalPetani: farmersDb.length,
      totalLuasLahanHa: totalLuasNum.toFixed(1),
      totalEstimasiPanenTon: totalEstimasiPanenTon.toFixed(1),
      distribusiKomoditas: cropStats,
      anomaliPasar: commoditiesDb
        .filter((c) => c.statusAnomali !== "NORMAL")
        .map((c) => ({
          nama: c.nama,
          harga: c.hargaSekarang,
          perubahanPersen: c.perubahanPersen,
          status: c.statusAnomali,
        })),
    };

    if (!nineCfg.isConfigured && !ai) {
      // Fallback structured recommendation
      const fallback: StrategicRecommendation = {
        ...INITIAL_STRATEGIC_RECOMMENDATION,
        id: `strat-${Date.now()}`,
        tanggal: new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }),
        fromCache: false,
      };
      latestRecommendation = fallback;
      latestRecommendationDataHash = currentDataHash;
      lastRecommendationGeneratedAt = Date.now();
      return res.json(fallback);
    }

    try {
      const prompt = `Anda adalah Senior Agricultural Data Scientist & Ahli Ekonomi Pertanian Indonesia.
Tugas Anda adalah menganalisis ringkasan data spasial komoditas berikut secara padat, tajam, dan efisien:

DATA AGREGAT PERTANIAN:
${JSON.stringify(leanSummaryContext, null, 2)}

Buatkan laporan rekomendasi strategis dalam format JSON dengan struktur:
{
  "judul": "Judul Laporan Strategis singkat & tajam",
  "urgensi": "Tinggi" | "Sedang" | "Rendah",
  "ringkasanEksekutif": "1 paragraf ringkasan eksekutif padat untuk pengambil kebijakan",
  "analisisOversupplyShortage": ["analisis poin 1", "analisis poin 2"],
  "rekomendasiAgronomi": ["rekomendasi poin 1", "rekomendasi poin 2"],
  "rekomendasiKebijakanHarga": ["kebijakan harga 1", "kebijakan harga 2"],
  "rekomendasiRantaiPasok": ["logistik/rantai pasok 1", "logistik/rantai pasok 2"],
  "dataScientistNotes": "Catatan singkat metodologi analitik"
}

ATURAN HEMAT BIAYA: Berikan respon HANYA dalam JSON valid, padat, dan tanpa uraian bertele-tele.`;

      const aiRes = await callUniversalAI(
        "Anda adalah Senior Agricultural Data Scientist Indonesia. Berikan output analisis padat dan efisien.",
        prompt,
        undefined,
        { maxOutputTokens: 850 }
      );
      const responseText = aiRes.text;
      let parsed: any = {};
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
      } catch (err) {
        console.warn("Could not parse JSON recommendation, using latest:", err);
        parsed = {};
      }

      const generated: StrategicRecommendation = {
        id: `strat-${Date.now()}`,
        tanggal: new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }),
        judul: parsed.judul || "Laporan Rekomendasi Strategis Pertanian",
        urgensi: parsed.urgensi || "Tinggi",
        ringkasanEksekutif: parsed.ringkasanEksekutif || "",
        analisisOversupplyShortage: parsed.analisisOversupplyShortage || [],
        rekomendasiAgronomi: parsed.rekomendasiAgronomi || [],
        rekomendasiKebijakanHarga: parsed.rekomendasiKebijakanHarga || [],
        rekomendasiRantaiPasok: parsed.rekomendasiRantaiPasok || [],
        dataScientistNotes: parsed.dataScientistNotes || "",
        fromCache: false,
        cachedAt: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
      };

      latestRecommendation = generated;
      latestRecommendationDataHash = currentDataHash;
      lastRecommendationGeneratedAt = Date.now();
      res.json(generated);
    } catch (err: any) {
      console.error("Gemini strategic generation error:", err);
      res.json(latestRecommendation);
    }
  });

  // Handler for Agronomy Fertilizer Recommendations
  function handleAgronomyFertilizerQuery(
    message: string,
    currentDraft: Partial<FarmerRecord> = {}
  ): { reply: string; quickReplies: string[] } | null {
    const lower = (message || "").toLowerCase();
    const hasFertilizerIntent =
      lower.includes("pupuk") ||
      lower.includes("dosis") ||
      lower.includes("pemupukan") ||
      lower.includes("urea") ||
      lower.includes("phonska") ||
      lower.includes("npk") ||
      lower.includes("takaran");

    // P0-1: "cek harga pupuk urea" = pertanyaan HARGA -> lolos ke cabang harga.
    if (/harga|berapa|cari harga|info harga|cek harga/.test(lower) && !/dosis|takaran|pemupukan|jadwal|fase|kapan|bagaimana|cara memupuk/.test(lower)) return null;
    if (!hasFertilizerIntent) return null;

    // Determine commodity
    let crop = currentDraft.komoditas || "";
    if (lower.includes("padi") || lower.includes("beras")) crop = "Padi";
    else if (lower.includes("jagung")) crop = "Jagung Hibrida";
    else if (lower.includes("cabai") || lower.includes("cabe")) crop = "Cabai Rawit";
    else if (lower.includes("bawang")) crop = "Bawang Merah";
    else if (lower.includes("kedelai")) crop = "Kedelai";
    else if (!crop) crop = "Padi";

    // Determine area in Ha
    let areaHa = currentDraft.luasLahan || 1.0;
    const haMatch = lower.match(/(\d+(?:[.,]\d+)?)\s*(?:ha|hektar)/i);
    if (haMatch && haMatch[1]) {
      areaHa = parseFloat(haMatch[1].replace(",", "."));
    } else {
      const m2Match = lower.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|meter)/i);
      if (m2Match && m2Match[1]) {
        areaHa = parseFloat(m2Match[1].replace(",", ".")) / 10000;
      }
    }

    const fert = calculateFertilizerRecommendation(crop, areaHa);

    const pupukLines = fert.pupuk
      .map(
        (p) =>
          `• *${p.jenis}*: *${p.totalKg.toLocaleString("id-ID")} kg* (~${p.totalKarung50kg} Zak @50kg)\n  _${p.keterangan}_`
      )
      .join("\n");

    const jadwalLines = fert.jadwalAplikasi
      .map((j) => `📍 *${j.fase}* (${j.waktuHST}):\n  - ${j.komposisi}\n  - _Aplikasi:_ ${j.caraAplikasi}`)
      .join("\n\n");

    const tipsLines = fert.catatanKhusus.map((t) => `✓ ${t}`).join("\n");

    const reply =
      `🌾 *Rekomendasi Dosis Pemupukan Berimbang Standar Balitbangtan RI*\n\n` +
      `Bpk/Ibu, berikut rekomendasi kebutuhan pupuk berimbang untuk komoditas *${fert.komoditas}* pada luasan lahan *${fert.luasLahanHa} Ha (${fert.luasLahanM2.toLocaleString("id-ID")} m²)*:\n\n` +
      `📦 *Total Kebutuhan Pupuk:*\n${pupukLines}\n\n` +
      `📅 *Jadwal & Fase Pemupukan:*\n${jadwalLines}\n\n` +
      `💡 *Petunjuk Agronomi Lapangan:*\n${tipsLines}\n\n` +
      `💡 *Catatan:* Dosis dapat disesuaikan dengan uji tanah (PUTS) setempat. Bapak/Ibu juga dapat mencetak Surat Registrasi Lahan & Petani lengkap dengan tabel dosis ini.` + rujukanPupuk(crop);

    return {
      reply,
      quickReplies: [
        `Cetak Kartu Tani (${fert.luasLahanHa} Ha)`,
        "Konsultasi Hama & Penyakit",
        "Cek Harga Pasar Terkini",
        "Daftarkan Lahan ke Sheets",
      ],
    };
  }

  // Handler for Natural Language Analytics & Aggregations
  function handleNaturalLanguageAnalyticsQuery(
    message: string,
    isAdmin: boolean
  ): { reply: string; quickReplies: string[] } | null {
    if (!isAdmin) return null;
    const lower = (message || "").toLowerCase();

    // Registrasi ("mendaftarkan petani") mengandung "daftar"+"petani" — jangan
    // biarkan analitik menyergapnya. Kecuali ada kualifikasi listing eksplisit.
    if (isRegistrationQuery(lower) && !isListingQuery(lower)) return null;

    const isAnalyticsIntent = isAnalyticsQuery(lower);

    if (!isAnalyticsIntent) return null;

    const totalLuas = farmersDb.reduce((acc, f) => acc + (f.luasLahan || 0), 0);
    const totalPanen = farmersDb.reduce((acc, f) => acc + (f.estimasiHasilTon || 0), 0);
    const totalPetani = farmersDb.length;

    // Filter by Commodity
    let targetCrop = "";
    if (lower.includes("padi") || lower.includes("beras")) targetCrop = "Padi";
    else if (lower.includes("jagung")) targetCrop = "Jagung";
    else if (lower.includes("cabai") || lower.includes("cabe")) targetCrop = "Cabai";
    else if (lower.includes("bawang")) targetCrop = "Bawang";

    // Filter by Region
    let targetKab = "";
    const kabList = ["subang", "karawang", "indramayu", "magetan", "kediri", "brebes", "cianjur", "bogor", "garut", "majalengka"];
    for (const k of kabList) {
      if (lower.includes(k)) {
        targetKab = k;
        break;
      }
    }

    // Filter by Verification Status
    const isUnverifiedQuery =
      lower.includes("belum verifikasi") ||
      lower.includes("menunggu verifikasi") ||
      lower.includes("unverified") ||
      lower.includes("belum diverifikasi");

    if (isUnverifiedQuery) {
      const unverified = farmersDb.filter((f) => f.statusVerifikasi !== "Terverifikasi");
      if (unverified.length === 0) {
        return {
          reply: `🟢 *Seluruh Data Petani Telah Terverifikasi!*\n\nSemua ${totalPetani} data petani di Google Sheets saat ini berstatus *Terverifikasi* resmi oleh petugas dinas dan PPL lapangan.`,
          quickReplies: ["Rekap Total Panen", "Cek Anomali Pasar", "Ekspor ke Sheets"],
        };
      }

      const listText = unverified
        .map(
          (f, i) =>
            `${i + 1}. *${f.nama}* (${f.komoditas}, ${f.luasLahan} Ha) di ${f.kabupaten || f.alamat} - _${f.statusVerifikasi}_\n   Catatan: ${f.catatanAI || "Menunggu tinjauan PPL"}`
        )
        .join("\n\n");

      return {
        reply: `📋 *Daftar Petani Menunggu Verifikasi Lapangan (${unverified.length} Petani):*\n\n${listText}\n\n💡 Admin dapat memverifikasi langsung melalui tombol aksi atau di tab Google Sheets.`,
        quickReplies: ["Verifikasi Semua", "📊 Rekap Semua Petani", "⚠️ Cek Belum Verifikasi"],
      };
    }

    let filtered = [...farmersDb];
    if (targetCrop) {
      filtered = filtered.filter((f) => f.komoditas.toLowerCase().includes(targetCrop.toLowerCase()));
    }
    if (targetKab) {
      filtered = filtered.filter(
        (f) =>
          (f.kabupaten && f.kabupaten.toLowerCase().includes(targetKab)) ||
          (f.alamat && f.alamat.toLowerCase().includes(targetKab))
      );
    }

    const fLuas = filtered.reduce((acc, f) => acc + (f.luasLahan || 0), 0);
    const fPanen = filtered.reduce((acc, f) => acc + (f.estimasiHasilTon || 0), 0);

    const scopeTitle = [
      targetCrop ? `Komoditas *${targetCrop}*` : "Seluruh Komoditas",
      targetKab ? `Wilayah *${targetKab.toUpperCase()}*` : "Seluruh Sentra",
    ].join(" di ");

    const farmerSummaryList = filtered
      .slice(0, 5)
      .map((f) => `• *${f.nama}*: ${f.luasLahan} Ha, est. ${f.estimasiHasilTon} Ton (${f.statusVerifikasi})`)
      .join("\n");

    const reply =
      `📊 *Laporan Agregasi Spasial Pertanian Real-Time*\n` +
      `Cakupan: ${scopeTitle}\n\n` +
      `• *Jumlah Petani Terdata:* *${filtered.length} Petani*\n` +
      `• *Total Luas Lahan:* *${fLuas.toFixed(1)} Hektar* (${(fLuas * 10000).toLocaleString("id-ID")} m²)\n` +
      `• *Proyeksi Total Panen:* *${fPanen.toFixed(1)} Ton*\n` +
      `• *Rata-rata Produktivitas:* *${filtered.length > 0 ? (fPanen / Math.max(fLuas, 0.1)).toFixed(1) : 0} Ton/Ha*\n` +
      `• *Kontribusi Terhadap Total Nasional:* *${((fLuas / Math.max(totalLuas, 1)) * 100).toFixed(1)}%*\n\n` +
      (filtered.length > 0 ? `🌾 *Sampel Petani Terdaftar:*\n${farmerSummaryList}\n\n` : "") +
      `Seluruh data di atas tercatat di database Hai Tani (${filtered.length} petani). Arsip spreadsheet tersedia via tombol Unduh Data CSV.`;

    return {
      reply,
      quickReplies: [
        "Buka Database Google Sheets",
        "Unduh Data CSV",
        "Cek Anomali Harga Pasar",
        "Rekomendasi Pemupukan",
      ],
    };
  }

  // ============ F1: Onboarding ToS + peran + ShareLoc + anti-spam ============
  // Presedensi router: batalkan > spam > onboarding > ERP > ... (keputusan F0).
  // Admin (termasuk SUPER_ADMIN) bebas onboarding + spam.
  const TOS_VERSION = "2026-10-31a";
  const TOS_TEXT_FINAL =
    "🌾 *Selamat datang di hAI Tani!* Saya asisten AI pertanian + pencatatan usaha tani via WA.\n\n" +
    "⚠️ *Syarat & Ketentuan:*\n" +
    "1. Jawaban AI bersifat rekomendasi, bukan pengganti PPL/penyuluh. Saran & perhitungan bisa tidak akurat sepenuhnya.\n" +
    "2. Seluruh chat & data yang Anda kirim (nama, lahan, lokasi, transaksi) DICATAT dan disimpan permanen untuk layanan, verifikasi, serta pengembangan & pelatihan AI hAI Tani. Data dikunci dan tidak dihapus.\n" +
    "3. Harga pasar bersumber SISKAPERBAPO & Pasar Mantung, dapat berubah sewaktu-waktu.\n\n" +
    "Dengan mengetik *SETUJU*, Anda menyetujui Syarat & Ketentuan ini.";
  const ROLE_ASK_TEXT =
    "Terima kasih! 🙏 Anda mendaftar sebagai:\n*1. Petani* | *2. Buyer/Pembeli Hasil Tani* | *3. Supplier/Saprodi*\n\nBalas angka atau namanya.";
  const LOC_ASK_TEXT =
    "Satu langkah lagi 📍. Kirim *Share Location* kebun/rumah (klik 📎 > Lokasi > Kirim lokasi saat ini) agar kami verifikasi wilayah & carikan harga/pembeli terdekat.\n\nAtau balas nama desa/kabupaten (verifikasi lemah, bisa dilengkapi nanti).";
  function doneReply(u: UserRecord): string {
    const roleName = (u.role as string) === "BUYER" ? "Buyer/Pembeli Hasil Tani" : u.role === "SUPPLIER" ? "Supplier/Saprodi" : "Petani";
    const locLine = u.locMapsUrl ? `Lokasi: ${u.locMapsUrl}` : u.locLabel ? `Lokasi: ${u.locLabel}` : "Lokasi: belum ada";
    const weakNote = u.onboardingState === "DONE_WEAK" ? "\n\n💡 Kirim *Share Location* kapan saja untuk verifikasi penuh." : "";
    return `✅ Pendaftaran selesai! Peran: *${roleName}*.\n${locLine}${weakNote}\n\nKetik *bantuan* untuk mulai.`;
  }
  function getUser(phone?: string): UserRecord | undefined {
    const key = normalizePhone(phone);
    if (!key) return undefined;
    return usersDb.find((u) => normalizePhone(u.phone) === key);
  }
  function createUser(phone: string): UserRecord {
    const now = new Date().toISOString();
    const u: UserRecord = {
      phone: normalizePhone(phone) || String(phone || ""),
      onboardingState: "NEW", tier: "FREE", status: "ACTIVE",
      createdAt: now, updatedAt: now,
    };
    usersDb.push(u);
    if (usersDb.length > 5000) usersDb.splice(0, usersDb.length - 5000);
    saveUsersToDisk();
    return u;
  }
  // Memori konsultan agronomi: profil dibaca tiap chat, ditulis otomatis.
  function ensureMemory(u: UserRecord): UserMemory {
    if (!u.memory) u.memory = {};
    return u.memory;
  }
  function linkFarmerMemory(u: UserRecord): FarmerRecord | undefined {
    const me = normalizePhone(u.phone);
    if (!me) return undefined;
    const f = farmersDb.find((x) => normalizePhone(x.noHp) === me);
    if (!f) return undefined;
    const m = ensureMemory(u);
    const ids = new Set(m.farmerIds || []);
    ids.add(f.id);
    m.farmerIds = [...ids];
    const now = new Date().toISOString();
    m.lahan = { kabupaten: f.kabupaten || f.alamat || undefined, luasHa: f.luasLahan || undefined, kondisi: m.lahan?.kondisi, updatedAt: now };
    try {
      const rows = komoditasDb.filter((k) => k.farmerId === f.id).slice(-5);
      if (rows.length > 0) m.polaTanam = rows.map((k) => ({ komoditas: k.komoditas, musimTanam: k.musimTanam, luasHa: k.luasHa, status: k.status, updatedAt: now }));
    } catch {}
    u.updatedAt = now;
    saveUsersToDisk();
    return f;
  }
  function logActivity(u: UserRecord, kind: string, ringkas: string): void {
    const m = ensureMemory(u);
    const list = m.aktivitas || [];
    list.unshift({ ts: new Date().toISOString(), kind: String(kind || "chat").slice(0, 24), ringkas: String(ringkas || "").slice(0, 80) });
    m.aktivitas = list.slice(0, 20);
    touchUser(u);
  }
  function memoryLineFor(u: UserRecord | undefined): string {
    if (!u) return "";
    const parts: string[] = [];
    const m = u.memory;
    const f = farmersDb.find((x) => normalizePhone(x.noHp) === normalizePhone(u.phone));
    if (f) parts.push(`petani ${f.nama} (${f.id}): ${f.komoditas || "-"}${f.luasLahan ? ` ${f.luasLahan}Ha` : ""}${f.kabupaten ? ` ${f.kabupaten}` : ""}`);
    if (m?.polaTanam?.length) parts.push(`pola tanam: ${m.polaTanam.map((p) => `${p.komoditas}${p.musimTanam ? ` ${p.musimTanam}` : ""} (${p.status || "?"})`).join("; ")}`);
    try {
      const dg = readJsonSafe<any[]>(DIAGNOSA_FILE, [], "diagnosa_db.json");
      const mine = (Array.isArray(dg) ? dg : []).find((d) => f && d?.farmerId === f.id);
      if (mine?.ringkasan) parts.push(`kasus tanaman terakhir ${mine.id}: ${String(mine.ringkasan).slice(0, 120)}`);
    } catch {}
    if (m?.aktivitas?.length) {
      const kinds: Record<string, number> = {};
      m.aktivitas.forEach((a) => { kinds[a.kind] = (kinds[a.kind] || 0) + 1; });
      parts.push(`aktivitas: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}x`).join(", ")}`);
    }
    if (parts.length === 0) return "";
    return `[PROFIL USER — rujuk seperlunya, jangan tempel mentah: ${parts.join(" | ")}]`;
  }
  function touchUser(u: UserRecord): void {
    u.updatedAt = new Date().toISOString();
    saveUsersToDisk();
  }
  // F6: sodoran proaktif 1x/24 jam pada balasan santai (WA petani).
  // Dipanggil dari wrapper res.json dengan konteks request eksplisit.
  function maybeAppendNudge(body: any, ctx: { message: unknown; senderPhone: unknown; effPhone: unknown; isAdmin: boolean }): void {
    if (!body || typeof body.reply !== "string" || !body.reply) return;
    if ((body as any).ackPending) return;
    if (ctx.isAdmin) return;
    if (NUDGE_SKIPMSG_RE.test(String(ctx.message || "").toLowerCase())) return;
    const u = getUser(String(ctx.effPhone || ctx.senderPhone || ""));
    if (!u || (u.onboardingState !== "DONE" && u.onboardingState !== "DONE_WEAK")) return;
    if (u.status === "BLOCKED" || u.nudgeOptOut || u.pendingAsk) return;
    const now = Date.now();
    if (u.lastNudgeAt && now - Date.parse(u.lastNudgeAt) < NUDGE_EVERY_MS) return;
    const mePhone = normalizePhone(String(ctx.effPhone || ctx.senderPhone || ""));
    const farmer = farmersDb.find((f) => normalizePhone(f.noHp) === mePhone);
    if (!farmer) return;
    // Draf terbuka = tengah alur lain -> jangan sodori.
    try {
      const wd: any = getWaDraft(String(ctx.senderPhone || ""));
      const parts = [wd?.farmer, wd?.supplier, wd?.cash, wd?.stock, wd?.hpp];
      if (parts.some((d) => d && typeof d === "object" && Object.keys(d).length > 0)) return;
    } catch { /* lanjut tanpa info draf */ }
    const pick = pickNudgeTarget(farmer.id);
    // Digest order: pesanan OPEN/SEBAGIAN yang menunggu harga petani ini.
    const myOpenNdg = offersDb.filter((x) => (x.status === "OPEN" || x.status === "SEBAGIAN") && x.lines.some((l) => l.farmerId === farmer.id && !Number(l.hargaPetaniPerKg))).slice(-3);
    if (!pick && myOpenNdg.length === 0) return;
    const at = new Date().toISOString();
    if (pick) body.reply += pick.text;
    if (myOpenNdg.length > 0) body.reply += `\n\nAda *${myOpenNdg.length} pesanan* menunggu harga Anda:\n` + myOpenNdg.map((x) => `- *${x.id}*: ${x.komoditas} ${fmtKg(Number(x.qtyKg) || 0)}${Number(x.budgetPerKg) ? `, budget ${fmtRp(Number(x.budgetPerKg))}/kg` : ""} — balas "jual ${x.komoditas} <harga>"`).join("\n");
    u.lastNudgeAt = at;
    if (pick) u.pendingAsk = { kind: "NUDGE", offerId: "", ts: at, nudge: { komoditasId: pick.kmd.id, field: "harga" } };
    touchUser(u);
    console.log(`[Nudge] sodor ${pick ? pick.kmd.komoditas : "-"} + ${myOpenNdg.length} order ke ${maskPhone(mePhone)}`);
  }
  // Telemetri tier pasif (rencana; TANPA enforcement sampai F9).
  function bumpDailyChats(u: UserRecord): void {
    const today = new Date().toISOString().slice(0, 10);
    if (u.lastChatDate !== today) {
      u.lastChatDate = today;
      u.dailyChats = 0;
    }
    u.dailyChats = (u.dailyChats || 0) + 1;
    u.lastInboundAt = new Date().toISOString(); // jendela 24 jam Meta utk notifikasi order
    u.updatedAt = new Date().toISOString();
    saveUsersToDisk();
  }
  function isSuperAdminPhone(phone?: string): boolean {
    const hit = findAdmin(phone);
    return !!hit && hit.role === "SUPER_ADMIN";
  }
  // ---- Anti-spam per nomor (in-memory windows + skor persisten) ----
  const spamTimes = new Map<string, number[]>();
  const spamTexts = new Map<string, Array<{ t: number; norm: string }>>();
  const INJECT_RE = /abaikan (semua )?instruksi|jailbreak|prompt.{0,20}(bocor|asli|sistem)|minta (kunci|token|api[\s_-]?key|password|sandi)|ungkapkan (instruksi|sistem)/i;
  function checkSpam(phone: string, message: string): { verdict: "ok" | "cooldown" | "blocked"; user: UserRecord } {
    let user = getUser(phone);
    if (!user) user = createUser(phone);
    const now = Date.now();
    if (user.status === "BLOCKED") return { verdict: "blocked", user };
    if ((user.spamCooldownUntil || 0) > now) {
      recordSpamHit(user, phone, message, now);
      return { verdict: (String(user.status) === "BLOCKED") ? "blocked" : "cooldown", user };
    }
    recordSpamHit(user, phone, message, now);
    if (String(user.status) === "BLOCKED") return { verdict: "blocked", user };
    if ((user.spamCooldownUntil || 0) > now) return { verdict: "cooldown", user };
    return { verdict: "ok", user };
  }
  function recordSpamHit(user: UserRecord, phone: string, message: string, now: number): void {
    const key = normalizePhone(phone) || phone;
    const times = (spamTimes.get(key) || []).filter((t) => now - t < 5 * 60 * 1000);
    times.push(now);
    spamTimes.set(key, times);
    const norm = String(message || "").toLowerCase().trim().slice(0, 200);
    const texts = (spamTexts.get(key) || []).filter((e) => now - e.t < 10 * 60 * 1000);
    texts.push({ t: now, norm });
    spamTexts.set(key, texts);
    const sameCount = texts.filter((e) => e.norm === norm).length;
    const unstructured = String(message || "").length > 1000 && !String(message || "").includes("\n");
    let hits = 0;
    if (times.length > 20) hits += 2;
    if (norm && sameCount >= 5) hits += 2;
    if (INJECT_RE.test(String(message || ""))) hits += 1;
    if (unstructured) hits += 1;
    if (hits <= 0) return;
    user.spamScore = (user.spamScore || 0) + hits;
    user.spamCooldownUntil = now + 60 * 1000;
    // F1b: TANPA blokir otomatis. Skor>=3 -> FLAG + notif nomor ASLI ke super
    // admin; keputusan biarkan/blokir di tangan super admin (via chat).
    if (user.spamScore >= 3 && user.status !== "FLAGGED" && user.status !== "BLOCKED") {
      user.status = "FLAGGED";
      user.blockReason = `spam skor ${user.spamScore}`;
      emitCanonicalEvent({
        source: "wa-chat", entity: "user", entityId: `user-${hashPhone(phone).slice(0, 12)}`,
        action: "flagged", actor: phone, payload: { reason: user.blockReason },
      });
      const rawDigits = String(phone || "").replace(/\D/g, "");
      if (!/^62700/.test(rawDigits)) {
        const sample = String(message || "").trim().slice(0, 80);
        sendWaText(SUPER_ADMIN_PHONE,
          `🚩 Anti-spam FLAG: nomor ${rawDigits} (skor ${user.spamScore}). Contoh: "${sample}".\nBalas "blokir ${rawDigits}" atau "izinkan ${rawDigits}".`
        ).catch(() => {});
      }
    }
    touchUser(user);
  }
  const BARE_CANCEL_RE = /^\s*batal(kan|in)?\s*(semuanya|semua|aja|saja|dulu|deh|dong)?\s*[!.\s]*$/i;
  // F1b: moderasi super admin via chat ("blokir 08xx" / "izinkan 08xx" / "tier 08xx tumbuh").
  // Return objek respons = ditangani; null = bukan perintah moderasi.
  function handleSuperAdminModeration(message: string, effPhone?: string): any {
    if (!isSuperAdminPhone(effPhone)) return null;
    const t = String(message || "").trim();
    const mBlock = t.match(/^(blokir|blockir)\s+(\+?[0-9][0-9\s\-.]{8,})$/i);
    const mAllow = t.match(/^(izinkan|buka blokir|unblock)\s+(\+?[0-9][0-9\s\-.]{8,})$/i);
    const mTier = t.match(/^tier\s+(\+?[0-9][0-9\s\-.]{8,})\s+(tunas|tumbuh|panen|free)\s*$/i);
    if (!mBlock && !mAllow && !mTier) return null;
    const digits = (mBlock ? mBlock[2] : mTier ? (mTier as RegExpMatchArray)[1] : (mAllow as RegExpMatchArray)[2]).replace(/\D/g, "");
    const norm = normalizePhone(digits);
    let u = usersDb.find((x) => normalizePhone(x.phone) === norm);
    if (mBlock) {
      if (!u && norm.length >= 10 && norm.length <= 16) u = createUser(digits);
      if (!u) return { reply: "Nomor tidak valid.", quickReplies: [], extracted: {}, isComplete: true, isAdminAction: true, aiProvider: "rule_based" };
      u.status = "BLOCKED";
      u.blockedAt = new Date().toISOString();
      u.blockReason = "manual super admin";
      u.blockNoticed = false;
      touchUser(u);
      return { reply: `🚫 Nomor ${digits} DIBLOKIR. Balas "izinkan ${digits}" untuk membuka.`, quickReplies: [], extracted: {}, isComplete: true, isAdminAction: true, aiProvider: "rule_based" };
    }
    if (mTier) {
      if (!u) return { reply: "Nomor tidak ditemukan di database user.", quickReplies: [], extracted: {}, isComplete: true, isAdminAction: true, aiProvider: "rule_based" };
      const nt = String((mTier as RegExpMatchArray)[2] || "FREE").toUpperCase();
      (u as any).tier = nt;
      (u as any).paidAt = nt === "FREE" || nt === "TUNAS" ? undefined : new Date().toISOString();
      touchUser(u);
      return { reply: `✅ Tier ${digits} -> *${nt}* (komisi ${TIER_COMMISSION_PCT[nt] ?? 5}%).`, quickReplies: [], extracted: {}, isComplete: true, isAdminAction: true, aiProvider: "rule_based" };
    }
    if (!u) return { reply: "Nomor tidak ditemukan di database user.", quickReplies: [], extracted: {}, isComplete: true, isAdminAction: true, aiProvider: "rule_based" };
    u.status = "ACTIVE";
    u.spamScore = 0;
    u.spamCooldownUntil = 0;
    u.blockNoticed = false;
    touchUser(u);
    return { reply: `✅ Nomor ${digits} dibuka kembali (ACTIVE, skor spam direset).`, quickReplies: [], extracted: {}, isComplete: true, isAdminAction: true, aiProvider: "rule_based" };
  }
  function cancelOnboardingReply(user: UserRecord, isAdmin: boolean): any {
    user.onboardingState = "NEW";
    user.onboardingTries = 0;
    touchUser(user);
    return {
      reply: "Onboarding dibatalkan. Ketik apa pun untuk mengulang dari Syarat & Ketentuan.",
      quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "Daftarkan Petani"] : ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
      extracted: {}, extractedSupplier: {}, extractedCash: {}, extractedStock: {}, extractedHpp: {},
      clearFarmerDraft: true, clearSupplierDraft: true, clearErpDrafts: true,
      isComplete: true, isAdminAction: isAdmin, aiProvider: "rule_based",
    };
  }
  function parseRoleInput(lower: string): UserRole | undefined {
    const t = (lower || "").trim();
    if (/^1\b|petani|\btani\b/.test(t)) return "PETANI";
    if (/^2\b|tengkulak|pengepul|offtaker|off-taker|buyer|pembeli|penampung|penadah/.test(t)) return "BUYER";
    if (/^3\b|supplier|toko|saprodi|kios|pupuk|obat|agen/.test(t)) return "SUPPLIER";
    return undefined;
  }
  const SMALLTALKISH_RE = /^(halo+|hai+|hi+|pagi|siang|sore|malam|makasih|terima kasih|thanks?|ok+|oke+|siap|baik|test|tes|ping|assalamu'?alaikum|punten)[?!.\s]*$/i;
  const FUNCTIONAL_RE = /daftar|harga|cek |cek$|status|bantuan|help|menu|manfaat|benefit|hama|penyakit|pupuk|dosis|kas\b|stok|hpp|rekap|verifikasi|komoditas|panen|cuaca|butuh|jual|beli|cari|order|pesan/i; // P1-24
  function completeOnboardingWeak(user: UserRecord, label: string, draft?: any): void {
    user.role = user.role || "PETANI";
    const dLat = Number(draft?.latitude);
    const dLng = Number(draft?.longitude);
    if (Number.isFinite(dLat) && Number.isFinite(dLng) && isValidWaCoords(dLat, dLng)) {
      user.locLat = Number(dLat.toFixed(6));
      user.locLng = Number(dLng.toFixed(6));
      user.locMapsUrl = waLocationMapsUrl(user.locLat, user.locLng);
      user.locAt = new Date().toISOString();
    }
    if (label) {
      user.locLabel = label.slice(0, 200);
      user.locAt = user.locAt || new Date().toISOString();
    }
    user.locWeak = !(user.locLat !== undefined && user.locLng !== undefined);
    user.onboardingState = "DONE_WEAK";
    touchUser(user);
    emitCanonicalEvent({
      source: "wa-chat", entity: "user", entityId: `user-${hashPhone(user.phone).slice(0, 12)}`,
      action: "onboarded_weak", actor: user.phone, payload: { role: user.role },
    });
  }
  // Return objek respons = tangani di sini; null = DONE, lanjut alur normal.
  function handleOnboarding(message: string, user: UserRecord, ctx: { isAdmin: boolean; currentDraft?: any }): any {
    if (ctx.isAdmin) return null;
    const lower = String(message || "").toLowerCase().trim();
    if (user.status === "BLOCKED") {
      if (!user.blockNoticed) {
        user.blockNoticed = true;
        touchUser(user);
        return { reply: "Nomor ini dibatasi sementara karena aktivitas mencurigakan. Hubungi PPL/dinas untuk membuka blokir.", quickReplies: [], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based" };
      }
      return { reply: "", quickReplies: [], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based" };
    }
    if (user.onboardingState === "DONE" || user.onboardingState === "DONE_WEAK") return null;
    // Rekognisi: nomor terdaftar di database petani langsung disapa nama —
    // tanpa diminta lengkapi data. SETUJU tetap wajib (gate TOS).
    if (user.onboardingState !== "DECLINED" && !user.memory?.lastWelcomeBackAt && !/langganan|harga|cek |cek$|berapa|bantuan|help|menu|manfaat|benefit|program|tentang/.test(lower)) {
      const legacy = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(user.phone));
      if (legacy) {
        linkFarmerMemory(user);
        ensureMemory(user).lastWelcomeBackAt = new Date().toISOString();
        user.onboardingState = "TOS_SENT";
        user.onboardingTries = 0;
        touchUser(user);
        return { reply: `👋 Selamat datang kembali, *${legacy.nama}*!\nNomor ini terdaftar sebagai petani (${legacy.komoditas || "-"}${legacy.luasLahan ? `, ${legacy.luasLahan} Ha` : ""}${legacy.kabupaten ? `, ${legacy.kabupaten}` : ""}).\n\nBalas *SETUJU* untuk lanjut ke layanan penuh.`, quickReplies: ["SETUJU"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
      }
    }
    if (user.onboardingState === "DECLINED") {
      if (/\bsetuju\b/.test(lower) && !/tidak setuju|gak setuju|nggak setuju/.test(lower)) {
        user.tosVersion = TOS_VERSION;
        user.tosAt = new Date().toISOString();
        user.status = "ACTIVE";
        user.declineNoticed = false;
        const legacyFarmer = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(user.phone));
        if (legacyFarmer) {
          user.role = "PETANI";
          user.onboardingState = "DONE_WEAK";
          touchUser(user);
          return { reply: doneReply(user), quickReplies: ["Cek Harga Pasar Hari Ini", "Daftarkan Lahan Saya"], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based" };
        }
        user.onboardingState = "ROLE_ASK";
        user.onboardingTries = 0;
        touchUser(user);
        return { reply: ROLE_ASK_TEXT, quickReplies: ["Petani", "Buyer", "Supplier"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
      }
      if (/harga|cek |cek$|berapa|bantuan|help|menu|manfaat|benefit|program|tentang|langganan/.test(lower)) return null;
      if (!user.declineNoticed) {
        user.declineNoticed = true;
        touchUser(user);
        return { reply: "Layanan penuh butuh persetujuan Syarat & Ketentuan. Balas *SETUJU* untuk lanjut, atau tanya harga pasar & info program saja.", quickReplies: ["Cek Harga Pasar Hari Ini"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
      }
      return { reply: "", quickReplies: [], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based" };
    }
    if (BARE_CANCEL_RE.test(String(message || ""))) return cancelOnboardingReply(user, ctx.isAdmin);
    if (user.onboardingState === "NEW") {
      user.onboardingState = "TOS_SENT";
      user.onboardingTries = 0;
      touchUser(user);
      return { reply: TOS_TEXT_FINAL, quickReplies: ["SETUJU"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
    }
    if (user.onboardingState === "TOS_SENT") {
      // Tolak dicek DULU: "tidak setuju" mengandung kata "setuju".
      if (/tidak setuju|gak setuju|nggak setuju|^tolak\b|menolak|tidak mau/.test(lower)) {
        user.onboardingState = "DECLINED";
        user.status = "DECLINED";
        touchUser(user);
        return { reply: "Baik, kami catat. Tanpa persetujuan, layanan terbatas pada info harga pasar & program. Balas *SETUJU* kapan saja untuk membuka layanan penuh.", quickReplies: ["Cek Harga Pasar Hari Ini"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
      }
      if (/\bsetuju\b/.test(lower)) {
        user.tosVersion = TOS_VERSION;
        user.tosAt = new Date().toISOString();
        const legacyFarmer = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(user.phone));
        if (legacyFarmer) {
          user.role = "PETANI";
          user.locLabel = String(legacyFarmer.alamat || legacyFarmer.kabupaten || "").slice(0, 200) || undefined;
          user.locAt = new Date().toISOString();
          user.locWeak = true;
          user.onboardingState = "DONE_WEAK";
          touchUser(user);
          return { reply: `✅ Selamat datang kembali, *${legacyFarmer.nama}*!\nStatus petani terverifikasi: *${legacyFarmer.statusVerifikasi}*.\n\n${doneReply(user)}`, quickReplies: ["Cek Harga Pasar Hari Ini", "Cek Status Lahan Saya"], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based" };
        }
        user.onboardingState = "ROLE_ASK";
        user.onboardingTries = 0;
        touchUser(user);
        return { reply: ROLE_ASK_TEXT, quickReplies: ["Petani", "Buyer", "Supplier"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
      }
      user.onboardingTries = (user.onboardingTries || 0) + 1;
      touchUser(user);
      if (/langganan/.test(lower)) return null; // info harga publik -> cabang 0e-tier
      const short = user.onboardingTries >= 2;
      return { reply: short ? "Balas *SETUJU* untuk menyetujui Syarat & Ketentuan, atau *TOLAK*." : `${TOS_TEXT_FINAL}\n\n_Balas *SETUJU* untuk lanjut, atau *TOLAK*._`, quickReplies: ["SETUJU"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
    }
    if (user.onboardingState === "ROLE_ASK") {
      const role = parseRoleInput(lower);
      if (role) {
        user.role = role;
        // ShareLoc sudah masuk duluan (via /api/wa-location) -> langsung DONE.
        if (user.locLat !== undefined && user.locLng !== undefined) {
          user.onboardingState = "DONE";
          user.locWeak = false;
          touchUser(user);
          return { reply: doneReply(user), quickReplies: ["Cek Harga Pasar Hari Ini", "Daftarkan Lahan Saya"], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based" };
        }
        user.onboardingState = "LOC_ASK";
        user.onboardingTries = 0;
        touchUser(user);
        return { reply: LOC_ASK_TEXT, quickReplies: [], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
      }
      user.onboardingTries = (user.onboardingTries || 0) + 1;
      touchUser(user);
      return { reply: user.onboardingTries >= 2 ? "Balas *1*, *2*, atau *3*." : `${ROLE_ASK_TEXT}\n\n_Balas angka atau namanya._`, quickReplies: ["Petani", "Buyer", "Supplier"], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
    }
    // LOC_ASK: ShareLoc via /api/wa-location (DONE) atau alamat teks (DONE_WEAK).
    if (SMALLTALKISH_RE.test(String(message || "").trim())) {
      return { reply: LOC_ASK_TEXT, quickReplies: [], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
    }
    if (FUNCTIONAL_RE.test(String(message || ""))) {
      completeOnboardingWeak(user, "", ctx.currentDraft);
      return null; // pesan fungsional tetap dilayani alur normal
    }
    const label = String(message || "").trim().slice(0, 200);
    if (label.length >= 4) {
      completeOnboardingWeak(user, label, ctx.currentDraft);
      return { reply: doneReply(user), quickReplies: ["Cek Harga Pasar Hari Ini", "Daftarkan Lahan Saya"], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based" };
    }
    return { reply: LOC_ASK_TEXT, quickReplies: [], extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based" };
  }

  // POST Chatbot endpoint (Kang Tani AI) with Role-Based Access Control (RBAC) & Cost Optimization
  app.post("/api/chat", async (req, res) => {
    const raw = req.body || {};
    const message = sanitizeText(raw.message, 2000);
    const chatT0 = Date.now();
    let loggedIntent = "";
    let { history, currentDraft, currentSupplierDraft, currentCashDraft, currentStockDraft, currentHppDraft, senderPhone } = raw;
    const ai = getGemini();

    // Gerbang ganda: sesi dashboard ATAU forwarder resmi. Self-assert mentah ditolak.
    const fwdSecret = (process.env.FORWARD_SECRET || "").trim();
    const fwdOk = !!fwdSecret && String(req.headers["x-tani-forward-secret"] || "") === fwdSecret;
    const sessAdm = (() => {
      const s = readSession(req);
      return s ? adminsDb.find((a) => a.id === s.adminId && a.aktif) : undefined;
    })();
    if (!sessAdm && !fwdOk) {
      console.log(`[Chat Gate] 401 non-sesi/non-forwarder (phone=${senderPhone || "?"} msg=${String(message || "").slice(0, 60)})`);
      return res.status(401).json({ reply: "Sesi dashboard berakhir atau pemanggil tak dikenal.", isComplete: true });
    }
    const effPhone = sessAdm ? sessAdm.noHp : senderPhone; // sesi: identitas = admin login

    const activeAdmin = findAdmin(effPhone);
    const isAdmin = !!activeAdmin;

    // WA stateless: injeksikan draf server per pengirim + rekam draf balasan.
    // Dashboard (sesi) tak tersentuh: tetap draf sisi klien.
    if (!sessAdm && fwdOk) {
      const wd = getWaDraft(senderPhone);
      if (!currentDraft) currentDraft = wd.farmer;
      if (!currentSupplierDraft) currentSupplierDraft = wd.supplier;
      if (!currentCashDraft) currentCashDraft = wd.cash;
      if (!currentStockDraft) currentStockDraft = wd.stock;
      if (!currentHppDraft) currentHppDraft = wd.hpp;
      const origJson = res.json.bind(res);
      res.json = ((body: any) => {
        try { saveWaDraft(senderPhone, body); } catch {}
        try { maybeAppendNudge(body, { message, senderPhone, effPhone, isAdmin }); } catch (err) { console.error("[Nudge] gagal:", (err as any)?.message || err); }
        try {
          // F7: jawaban jujur-tidak-tahu dari LLM -> log TIDAK_TAHU (sekali,
          // bukan dari cache).
          const ap = (body as any)?.aiProvider;
          if (typeof body?.reply === "string" && body.reply.includes("belum mengetahui hal ini") && ap !== "cache") {
            logFeedback(String(senderPhone || ""), "TIDAK_TAHU", String(message || ""), `via-${ap || "llm"}`);
          }
        } catch (err) { console.error("[Feedback] autolog gagal:", (err as any)?.message || err); }
        try {
          // F4: tempel info toko mitra ke jawaban konsultasi obat/pupuk/saprodi
          // (LLM saja; rule_based/fast/ack/cache/analytics dilewati).
          const ap4 = (body as any)?.aiProvider;
          if (typeof body?.reply === "string" && !/toko mitra/i.test(body.reply)
            && ap4 !== "ack_pending" && ap4 !== "cache" && ap4 !== "fast_path"
            && ap4 !== "rule_based" && ap4 !== "analytics_engine"
            && /(obat|pupuk|hama|wereng|penyakit|fungisida|insektisida|herbisida|pestisida|saprodi)/i.test(String(message || ""))
            && /(apa|mana|bagus|rekomendasi|dosis|cocok|beli|harga|merek|merk|cari)/i.test(String(message || ""))) {
            const hits = matchProducts(`${message} ${body.reply}`, 2);
            if (hits.length > 0) {
              body.reply += `\n\n🛒 *Tersedia di toko mitra:*\n${hits.map(productLine).join("\n")}\nKetik *katalog* untuk semua produk, atau lapor: *sudah beli <nama>*.`;
            }
          }
        } catch (err) { console.error("[Affiliate] tempel gagal:", (err as any)?.message || err); }
        const out = origJson(body);
        try {
          const farmerHit = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(senderPhone));
          trainingLog({
            kind: "chat", channel: "wa",
            role: isAdmin ? "admin" : (farmerHit ? "petani" : "tamu"),
            phoneHash: hashPhone(senderPhone),
            in: clipText(message), out: clipText(body?.reply),
            provider: String(body?.aiProvider || ""), model: String(body?.aiModel || ""),
            ms: Date.now() - chatT0, intent: loggedIntent,
            ok: !body?.error, err: body?.error ? clipText(body.error, 200) : undefined,
          });
        } catch {}
        try {
          // Memori otomatis: tiap chat WA dicatat ke profil user + tautkan petani.
          const mu = getUser(String(senderPhone || ""));
          if (mu) {
            linkFarmerMemory(mu);
            logActivity(mu, String(loggedIntent || (body as any)?.aiProvider || "chat"), String(message || ""));
          }
        } catch {}
        return out;
      }) as any;
    }

    // F1b: perintah moderasi super admin (pola ketat; non-perintah lolos).
    if (isAdmin) {
      const mod = handleSuperAdminModeration(message, String(effPhone || senderPhone || ""));
      if (mod) return res.json(mod as any);
    }

    // F1: spam -> onboarding (admin bebas; identitas tak wajar dilewati = perilaku lama).
    const f1Key = normalizePhone(String(effPhone || senderPhone || ""));
    if (!isAdmin && f1Key.length >= 10 && f1Key.length <= 16) {
      const spam = checkSpam(String(effPhone || senderPhone || ""), message);
      if (spam.verdict === "cooldown") {
        return res.json({
          reply: "⏳ Pelan-pelan ya Bpk/Ibu, kirim pesan lagi dalam semenit.",
          quickReplies: [], extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based",
        } as any);
      }
      bumpDailyChats(spam.user);
      const ob = handleOnboarding(message, spam.user, { isAdmin, currentDraft });
      if (ob) return res.json(ob as any);
    }

    // 0a-commodity (F2). Daftar milikku | tambah komoditas | panen selesai.
    // Ditempatkan awal agar tak disergap cabang pendaftaran/estimasi.
    {
      const lowerC = String(message || "").toLowerCase();
      const isList = /komoditas\s+(saya|ku|gue|kita)|daftar komoditas|list komoditas|komoditas milik|komoditasku/.test(lowerC);
      const mAdd = lowerC.match(/tambah\s+komoditas\s+(.+)/);
      const mClose = lowerC.match(/(panen selesai|tutup komoditas|selesai panen)\s+(.+)/);
      if (isList || mAdd || mClose) {
        const idAsk = String(message || "").match(/TANI-\d+/i);
        let farmer: FarmerRecord | undefined;
        if (isAdmin && idAsk) {
          farmer = farmersDb.find((f) => f.id.toUpperCase() === idAsk[0].toUpperCase());
        } else if (!isAdmin || !idAsk) {
          farmer = farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(String(effPhone || senderPhone || "")));
        }
        const needReg = `ⓘ Nomor ini belum terdaftar sebagai petani. Daftarkan lahan dulu via "daftar".`;
        if (!farmer) {
          return res.json({
            reply: (isAdmin && !idAsk) ? `Sertakan ID petani, mis. "komoditas TANI-013".` : needReg,
            quickReplies: [], extracted: {}, isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
          } as any);
        }
        const rows = komoditasDb.filter((k) => k.farmerId === farmer!.id);
        if (isList) {
          if (rows.length === 0) {
            return res.json({
              reply: `ⓘ *${farmer.nama}* belum punya riwayat komoditas. Tambah via "tambah komoditas <nama> <luas>".`,
              quickReplies: [], extracted: {}, isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
            } as any);
          }
          const lines = rows.map((k, i) => {
            const det: string[] = [];
            if (Number(k.luasHa) > 0) det.push(`${k.luasHa} Ha`);
            if (k.varietas) det.push(k.varietas);
            if (k.estimasiPanen) det.push(`panen ${k.estimasiPanen}`);
            if (Number(k.estimasiHasilTon) > 0) det.push(`~${k.estimasiHasilTon} ton`);
            if (Number(k.stokSiapJualTon) > 0) det.push(`stok ${fmtKg(Number(k.stokSiapJualTon) * 1000)}`);
            if (Number(k.hargaMintaPerKg) > 0) det.push(`minta ${fmtRp(Number(k.hargaMintaPerKg))}/kg`);
            return `${i + 1}. *${k.komoditas}* (${k.status})${det.length ? ` — ${det.join(", ")}` : ""} [\`${k.id}\`]`;
          });
          return res.json({
            reply: `🌾 *Komoditas ${farmer.nama}* (${farmer.id}):\n${lines.join("\n")}\n\nTambah: "tambah komoditas <nama> <luas>". Tutup musim: "panen selesai <nama>".`,
            quickReplies: [], extracted: {}, isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
          } as any);
        }
        if (mAdd) {
          const parsed = extractFarmerFromText(mAdd[1] || "", {});
          let kom = String(parsed.extracted.komoditas || "").trim();
          if (!kom) {
            // Fallback: 1-3 kata alfa sisa setelah buang pola angka/satuan/bulan.
            const clean = String(mAdd[1] || "")
              .replace(/\d+(?:[.,]\d+)?\s*(ha|hektar|h\b|m2|m²|are|ru|ubin|ton|kg|kwintal|kuintal)/gi, " ")
              .replace(/varietas\s+[a-z0-9\- ]+/gi, " ")
              .replace(/hasil\s+\d+(?:[.,]\d+)?\s*\w*/gi, " ")
              .replace(/[^a-zA-Z ]/g, " ").replace(/\s+/g, " ").trim();
            const words = clean.split(" ").filter(Boolean);
            if (words.length >= 1 && words.length <= 3) kom = words.slice(0, 3).join(" ");
          }
          if (!kom) {
            return res.json({
              reply: `Komoditas apa yang ditambah? Contoh: "tambah komoditas jagung 0,5 ha".`,
              quickReplies: [], extracted: {}, isComplete: false, isAdminAction: !!isAdmin, aiProvider: "rule_based",
            } as any);
          }
          const rec = appendCommodity(farmer.id, {
            komoditas: kom,
            varietas: parsed.extracted.varietas || "",
            luasHa: Number(parsed.extracted.luasLahan) || 0,
            estimasiPanen: parsed.extracted.estimasiPanen || "",
            estimasiHasilTon: Number(parsed.extracted.estimasiHasilTon) || 0,
          });
          syncLegacyCommodityFields(farmer);
          saveFarmersToDisk();
          const n = komoditasDb.filter((k) => k.farmerId === farmer!.id).length;
          return res.json({
            reply: `✅ Komoditas *${rec.komoditas}* ditambahkan untuk *${farmer.nama}* (\`${rec.id}\`, AKTIF). Total ${n} komoditas.\nKetik "komoditas saya" untuk daftar.`,
            quickReplies: ["Komoditas Saya", "Cek Harga Pasar Hari Ini"], extracted: {}, isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
          } as any);
        }
        // mClose: tutup musim (SELESAI) berdasar nama (substring, terbaru menang).
        const want = String(mClose![2] || "").toLowerCase().trim();
        const cands = rows.filter((k) => k.status === "AKTIF" && k.komoditas.toLowerCase().includes(want));
        const target = cands[cands.length - 1];
        if (!target) {
          const aktif = rows.filter((k) => k.status === "AKTIF").map((k) => k.komoditas).join(", ") || "-";
          return res.json({
            reply: `ⓘ Tidak ada komoditas AKTIF bernama "${mClose![2].trim()}" untuk *${farmer.nama}*. Yang AKTIF: ${aktif}.`,
            quickReplies: [], extracted: {}, isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
          } as any);
        }
        target.status = "SELESAI";
        target.updatedAt = new Date().toISOString();
        saveKomoditasToDisk();
        emitCanonicalEvent({
          source: "wa-chat", entity: "commodity", entityId: target.id,
          action: "close", actor: senderPhone,
          payload: { farmerId: farmer.id, komoditas: target.komoditas },
        });
        syncLegacyCommodityFields(farmer);
        saveFarmersToDisk();
        return res.json({
          reply: `✅ Musim *${target.komoditas}* (\`${target.id}\`) ditandai SELESAI untuk *${farmer.nama}*. Sukses panennya! 🌾`,
          quickReplies: ["Komoditas Saya"], extracted: {}, isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
        } as any);
      }
    }

    // 0z. Fast-path smalltalk: 0ms, tanpa LLM/Laya (salam, identitas, makasih, bantuan).
    // P1-1/P1-25: jawaban deal ("oke"/"siap") milik pendingAsk, bukan smalltalk.
    const dealPendingP11 = ["KONFIRM_DEAL", "SPEK_OK"].includes(String(usersDb.find((x) => { try { return normalizePhone(x.phone) === normalizePhone(effPhone || ""); } catch { return false; } })?.pendingAsk?.kind || ""));
    const hasOpenDraft = [currentDraft, currentCashDraft, currentStockDraft, currentHppDraft, currentSupplierDraft]
      .some((d) => d && typeof d === "object" && Object.keys(d).length > 0) || dealPendingP11;
    const topIntent = detectTopIntent(message, isAdmin, activeAdmin, effPhone, hasOpenDraft);
    loggedIntent = topIntent;
    console.log(`[ChatRoute] intent=${topIntent} admin=${isAdmin} len=${String(message || "").length}`);
    const fast = handleFastSmalltalk(message, isAdmin, activeAdmin, effPhone, hasOpenDraft);
    if (fast) return res.json({ ...fast, aiProvider: "fast_path" } as any);

    // Laya intent lazy: regex dulu (0ms), sidecar hanya saat regex miss.
    // Null saat sidecar mati -> regex tetap jalan.
    let _chatLaya: { intent: string; confidence: number } | null | undefined;
    const chatLaya = async () => {
      if (_chatLaya !== undefined) return _chatLaya;
      _chatLaya = await getLayaIntent(message);
      return _chatLaya;
    };

    // 0. Cancellation controller: stops AI generation immediately if client aborts or cancels
    const clientAbortController = new AbortController();
    let isClientAborted = false;
    res.on("close", () => {
      if (!res.writableEnded && (req.destroyed || req.socket?.destroyed)) {
        isClientAborted = true;
        clientAbortController.abort();
        console.log("[AI Cost Optimizer] 🛑 Koneksi dibatalkan/ditutup oleh klien -> eksekusi AI dihentikan segera demi menghemat token & biaya.");
      }
    });

    // 0a-cancel. Batalkan telanjang ("batalkan", "batalkan semuanya"): bersihkan
    // SEMUA draf (petani/supplier/kas/stok/HPP) sekaligus. Tanpa ini, cancel
    // per-tipe berhenti di tipe pertama dan sisa draf menahan smalltalk via
    // hasOpenDraft. Cancel bertipe ("batalkan kas") tetap ke cabang masing-masing.
    {
      const bareCancel = /^\s*batal(kan|in)?\s*(semuanya|semua|aja|saja|dulu|deh|dong)?\s*[!.\s]*$/i.test(message || "");
      if (bareCancel) {
        const cancelUser = getUser(String(effPhone || senderPhone || ""));
        if (cancelUser?.pendingAsk) {
          cancelUser.pendingAsk = undefined;
          touchUser(cancelUser);
        }
        return res.json({
          reply: hasOpenDraft
            ? "Baik, semua draf dibatalkan (pendaftaran petani/supplier/kas/stok/HPP). Ketik *daftar* atau *catat kas* kapan pun untuk memulai lagi."
            : "Tidak ada draf terbuka yang perlu dibatalkan. Ketik *bantuan* untuk melihat perintah yang tersedia.",
          quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "Daftarkan Petani"] : ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
          extracted: {}, extractedSupplier: {}, extractedCash: {}, extractedStock: {}, extractedHpp: {},
          clearFarmerDraft: true, clearSupplierDraft: true, clearErpDrafts: true,
          isComplete: true, isAdminAction: isAdmin, aiProvider: "rule_based",
        } as any);
      }
    }

    // 0b-negotiator (F3). Buyer butuh -> stok jujur -> tanya harga ke petani
    // -> cocok vs budget -> deal + komisi kas. SEBELUM cabang ERP/harga/
    // estimasi agar "stok X N kg" tak disergap estimasi panen/stok saprodi.
    // Prioritas: (1) jawaban pendingAsk, (2) cek/batal, (3) demand buyer,
    // (4) lapor stok petani, (5) harga jual petani, (6) budget, (7) deal.
    {
      const lowerN = String(message || "").toLowerCase();
      const mePhone = normalizePhone(String(effPhone || senderPhone || ""));
      const meFarmer = farmersDb.find((f) => normalizePhone(f.noHp) === mePhone);
      // Admin lewat tanpa UserRecord (F1); negosiasi eksplisit tetap jalan.
      const negoUser: UserRecord | undefined = getUser(mePhone);
      const clearAsk = () => {
        if (negoUser?.pendingAsk) {
          negoUser.pendingAsk = undefined;
          touchUser(negoUser);
        }
      };
      const nogoReply = (reply: string, qr: string[] = []) => res.json({
        reply, quickReplies: qr, extracted: {}, isComplete: true,
        isAdminAction: !!isAdmin, aiProvider: "rule_based",
      } as any);
      const setAsk = (u: UserRecord, kind: "HARGA_JUAL" | "BUDGET" | "KONFIRM_DEAL" | "SPEK_OK", offerId: string) => {
        u.pendingAsk = { kind, offerId, ts: new Date().toISOString() };
        touchUser(u);
      };
      const myOpenOffer = (asBuyer: boolean): Offer | undefined => {
        const mine = offersDb.filter((o) => o.status !== "DEAL" && o.status !== "BATAL"
          && (asBuyer ? normalizePhone(o.buyerPhone) === mePhone
            : !!meFarmer && o.lines.some((l) => l.farmerId === meFarmer!.id)));
        return mine[mine.length - 1];
      };
      const stockListText = (cands: FarmerCommodity[], kom: string, qty: number): string => {
        if (cands.length === 0) {
          return `Belum ada petani yang lapor stok *${kom}* ready. Permintaan dicatat — petani akan kami tanyai saat mereka lapor stok.`;
        }
        const total = cands.reduce((a, k) => a + Number(k.stokSiapJualTon || 0) * 1000, 0);
        const list = cands.slice(0, 10).map((k) => {
          const f = farmersDb.find((x) => x.id === k.farmerId);
          return `• ${f ? f.nama : k.farmerId}: siap ${fmtKg(Number(k.stokSiapJualTon) * 1000)}`;
        }).join("\n");
        return `Stok ready saat ini (total ${fmtKg(total)}):\n${list}` +
          (total < qty ? `\n\n⚠️ Total stok (${fmtKg(total)}) kurang dari kebutuhan (${fmtKg(qty)}). Kami tanyakan harga ke petani — yang cocok kami agregasi.` : "");
      };
      const composeBuyerFit = (o: Offer, ev: { cocokKg: number; overLines: OfferLine[]; waitingPrice: number }): string => {
        const need = Number(o.qtyKg) || 0;
        if (o.status === "COCOK") {
          if (negoUser) setAsk(negoUser, "KONFIRM_DEAL", o.id);
          const alloc = o.lines.filter((l) => Number(l.alokasiKg) > 0).map((l) => {
            const f = farmersDb.find((x) => x.id === l.farmerId);
            return `• ${f ? f.nama : l.farmerId}: ${fmtKg(Number(l.alokasiKg))} @ ${fmtRp(Number(l.hargaPetaniPerKg))}/kg`;
          }).join("\n");
          const toFarmers = o.lines.reduce((a, l) => a + (Number(l.alokasiKg) || 0) * Number(l.hargaPetaniPerKg || 0), 0);
          return `🤝 *COCOK! ${o.id}* — ${fmtKg(need)} ${o.komoditas} terpenuhi penuh:\n${alloc}\n\n` +
            `• Anda bayar: ${fmtRp(Number(o.budgetPerKg) * need)} (${fmtRp(Number(o.budgetPerKg))}/kg)\n` +
            `• Diterima petani: ${fmtRp(toFarmers)}\n` +
            `• *Komisi Hai Tani: ${fmtRp(Number(o.spreadTotalRp) || 0)}*\n\n` +
            `Balas *"deal oke"* untuk konfirmasi, atau *"batal ${o.id}"*.`;
        }
        if (o.status === "SEBAGIAN") {
          return `⚠️ *${o.id} SEBAGIAN*: baru ${fmtKg(ev.cocokKg)} dari ${fmtKg(need)} yang masuk budget ${fmtRp(Number(o.budgetPerKg))}/kg.\n` +
            `Ketik "cek penawaran" untuk rincian, tambah budget ("budget 9000"), atau tunggu petani lain.`;
        }
        let why = "";
        if (ev.overLines.length > 0) {
          why += ev.overLines.map((l) => {
            const f = farmersDb.find((x) => x.id === l.farmerId);
            return `• ${f ? f.nama : l.farmerId} minta ${fmtRp(Number(l.hargaPetaniPerKg))}/kg — di atas budget ${fmtRp(Number(o.budgetPerKg))}/kg.`;
          }).join("\n") + "\n";
        }
        if (ev.waitingPrice > 0) why += `• ${ev.waitingPrice} petani belum pasang harga — menunggu.\n`;
        if (!why) why = "• Belum ada petani yang lapor stok.\n";
        return `📝 *${o.id}*: budget ${fmtRp(Number(o.budgetPerKg))}/kg tercatat, belum ada yang cocok.\n${why}Ketik "cek penawaran" kapan pun untuk update.`;
      };
      const farmerFitText = (o: Offer, fr: FarmerRecord): string => {
        const ln = o.lines.find((l) => l.farmerId === fr.id);
        const myP = Number(ln?.hargaPetaniPerKg) || 0;
        const b = Number(o.budgetPerKg) || 0;
        if (b > 0 && myP > 0 && myP <= b && Number(ln?.alokasiKg) > 0) {
          return `✅ Harga Anda ${fmtRp(myP)}/kg *MASUK* budget buyer (${fmtRp(b)}/kg) untuk *${o.id}*.\n` +
            `Alokasi dari stok Anda: ${fmtKg(Number(ln!.alokasiKg))}. Menunggu konfirmasi deal buyer — ketik "cek penawaran" untuk update.`;
        }
        if (b > 0 && myP > b) {
          return `✅ Harga Anda ${fmtRp(myP)}/kg tercatat untuk *${o.id}*, tapi di atas budget buyer (${fmtRp(b)}/kg).\n` +
            `Sudah kami teruskan — buyer boleh menaikkan budget. Ketik "cek penawaran" untuk update.`;
        }
        if (b > 0 && myP > 0 && myP <= b) {
          return `✅ Harga Anda ${fmtRp(myP)}/kg *MASUK* budget buyer (${fmtRp(b)}/kg) untuk *${o.id}*, tapi belum dapat alokasi (stok Anda habis atau kebutuhan sudah dipenuhi petani lain).\n` +
            `Ketik "cek penawaran" untuk update.`;
        }
        return `✅ Harga ${fmtRp(myP)}/kg tercatat untuk *${o.id}*.\n` +
          `Budget buyer belum ada — sudah kami mintakan. Ketik "cek penawaran" untuk update.`;
      };
      const doBudget = (o: Offer, price: number): string => {
        o.budgetPerKg = price;
        o.budgetAt = new Date().toISOString();
        const ev = evalOffer(o);
        saveOffersToDisk();
        emitCanonicalEvent({
          source: "wa-chat", entity: "offer", entityId: o.id,
          action: "budget", actor: mePhone,
          payload: { budgetPerKg: price, status: o.status },
        });
        return composeBuyerFit(o, ev);
      };
      const doFarmerPrice = (o: Offer, price: number, spek?: boolean): string => {
        let line = o.lines.find((l) => l.farmerId === meFarmer!.id);
        if (!line) {
          const cand = findStockCandidates(o.komoditas).find((k) => k.farmerId === meFarmer!.id);
          if (!cand) return `ⓘ Stok ${o.komoditas} Anda 0 — laporkan dulu via "stok ${o.komoditas} <qty>".`;
          line = { farmerId: meFarmer!.id, komoditasId: cand.id, stokKg: Math.round(Number(cand.stokSiapJualTon) * 1000) };
          o.lines.push(line);
        }
        line.hargaPetaniPerKg = price;
        line.hargaAt = new Date().toISOString();
        if (spek !== undefined) line.spekOk = spek;
        const krow = komoditasDb.find((x) => x.id === line!.komoditasId);
        if (krow) {
          krow.hargaMintaPerKg = price;
          krow.hargaMintaAt = line.hargaAt;
          krow.updatedAt = line.hargaAt;
          saveKomoditasToDisk();
        }
        evalOffer(o);
        saveOffersToDisk();
        emitCanonicalEvent({
          source: "wa-chat", entity: "offer", entityId: o.id,
          action: "price", actor: mePhone,
          payload: { farmerId: meFarmer!.id, hargaPetaniPerKg: price, status: o.status },
        });
        return farmerFitText(o, meFarmer!);
      };
      const doDeal = (o: Offer): string => {
        // Validasi-ulang stok live sebelum DEAL: tolak dengan pesan jelas bila kurang (tanpa clamp diam-diam).
        const pakaiPerKmd = new Map<string, number>();
        for (const l of o.lines) {
          const kg = Number(l.alokasiKg) || 0;
          if (kg > 0 && l.komoditasId) pakaiPerKmd.set(l.komoditasId, (pakaiPerKmd.get(l.komoditasId) || 0) + kg);
        }
        const kurang: string[] = [];
        for (const [kmdId, pakai] of pakaiPerKmd) {
          const k = komoditasDb.find((x) => x.id === kmdId);
          const liveKg = Math.round(Number(k?.stokSiapJualTon || 0) * 1000);
          if (liveKg < pakai) {
            const fn = farmersDb.find((x) => x.id === (k ? k.farmerId : ""));
            kurang.push(`${fn ? fn.nama : kmdId}: butuh ${fmtKg(pakai)}, stok live tinggal ${fmtKg(liveKg)}`);
          }
        }
        if (kurang.length > 0) {
          return `*${o.id} belum bisa DEAL* - stok live berkurang sejak alokasi:\n${kurang.join("\n")}\n\nKetik "cek penawaran" untuk alokasi terbaru.`;
        }
        const { kasId, spread, tierTxt } = finalizeOfferDeal(o, mePhone);
        clearOfferAsks(o.id);
        const kasTxt = kasId ? ` Komisi ${fmtRp(spread)}${tierTxt} masuk kas Hai Tani (\`${kasId}\`).` : " Tanpa selisih komisi.";
        return `✅ *DEAL ${o.id}!* ${fmtKg(Number(o.qtyKg))} ${o.komoditas} — buyer ${fmtRp(Number(o.budgetPerKg))}/kg.${kasTxt}\n\n${offerStatusText(o, "buyer")}`;
      };

      // (0) F6-tarikan: admin reset + petani lapor/minta pengingat harga
      // (eksplisit, tanpa gerbang 24 jam). Sebelum blok pendingAsk.
      const mNudgeReset = String(message || "").match(/^\s*reset pengingat\s+(TANI-\d+)\s*$/i);
      if (mNudgeReset && isAdmin) {
        const fr = farmersDb.find((f) => f.id.toUpperCase() === mNudgeReset[1].toUpperCase());
        const fu = fr ? getUser(fr.noHp) : undefined;
        if (!fr || !fu) return nogoReply(`ⓘ Petani ${mNudgeReset[1].toUpperCase()} / nomornya tidak ditemukan.`);
        fu.lastNudgeAt = undefined;
        fu.nudgeOptOut = undefined;
        if (fu.pendingAsk?.kind === "NUDGE") fu.pendingAsk = undefined;
        touchUser(fu);
        return nogoReply(`✅ Pengingat harga untuk *${fr.nama}* (${fr.id}) direset — sodoran berikutnya aktif lagi.`);
      }
      if (/^\s*(lapor harga|minta pengingat|aktifkan pengingat)\s*$/i.test(String(message || ""))) {
        if (!meFarmer) return nogoReply(`ⓘ Nomor ini belum terdaftar sebagai petani.`);
        if (/minta pengingat|aktifkan pengingat/i.test(String(message || "")) && negoUser) {
          negoUser.nudgeOptOut = undefined;
          touchUser(negoUser);
        }
        if (negoUser?.pendingAsk && negoUser.pendingAsk.kind !== "NUDGE") {
          return nogoReply(`ⓘ Masih ada pertanyaan terbuka (${negoUser.pendingAsk.offerId || "negosiasi"}). Selesaikan atau "batalkan" dulu.`);
        }
        const pick = pickNudgeTarget(meFarmer.id);
        if (!pick) return nogoReply(`ⓘ *${meFarmer.nama}* belum punya komoditas AKTIF.`);
        const at = new Date().toISOString();
        if (negoUser) {
          negoUser.pendingAsk = { kind: "NUDGE", offerId: "", ts: at, nudge: { komoditasId: pick.kmd.id, field: "harga" } };
          touchUser(negoUser);
        }
        return nogoReply(pick.text.trimStart());
      }
      // F6: tangani jawaban sodoran. Return string = tangani; null = bukan
      // jawaban -> panggil-callback melepas & meloloskan sebagai obrolan biasa.
      const handleNudgeAnswer = (): string | null => {
        if (!meFarmer || !negoUser) return "ⓘ Nomor ini tidak terdaftar sebagai petani.";
        const t = lowerN.trim();
        if (/stop|berhenti|jangan tanya|jangan ganggu|brisik|berisik|ganggu/.test(t)) {
          negoUser.nudgeOptOut = true;
          clearAsk();
          touchUser(negoUser);
          return "Siap, dimengerti. Saya tidak akan tanya-tanya proaktif lagi. 🙏\n(Ketik \"minta pengingat\" kapan pun bila berubah pikiran.)";
        }
        if (/^(skip|lewati|nanti|sudah|belum|tidak|gak|nggak)\b/.test(t) && !/\d/.test(t)) {
          clearAsk();
          return "Siap, lain kali saja. 👍";
        }
        const nx = negoUser?.pendingAsk?.nudge;
        const kmd = nx ? komoditasDb.find((k) => k.id === nx.komoditasId) : undefined;
        if (!kmd) { clearAsk(); return null; }
        const saySama = /^(masih\s+)?sama(\s|$|[.,!])/.test(t);
        const price = saySama ? Number(kmd.hargaMintaPerKg) || 0 : parseRpPerKg(String(message || ""));
        if (price === undefined || !(price > 0)) {
          if (saySama) {
            return `ⓘ Belum ada harga *${kmd.komoditas}* yang tercatat — balas angkanya, mis. "8000".`;
          }
          return null;
        }
        const nowP = new Date().toISOString();
        kmd.hargaMintaPerKg = price;
        kmd.hargaMintaAt = nowP;
        kmd.updatedAt = nowP;
        saveKomoditasToDisk();
        // Teruskan ke penawaran OPEN yang menunggu harga petani ini.
        const applied: string[] = [];
        for (const o of offersDb) {
          if (o.status !== "OPEN" && o.status !== "SEBAGIAN") continue;
          if (!komMatch(o.komoditas, kmd.komoditas)) continue;
          const ln = o.lines.find((l) => l.farmerId === meFarmer!.id && !Number(l.hargaPetaniPerKg));
          if (!ln) continue;
          ln.hargaPetaniPerKg = price;
          ln.hargaAt = nowP;
          evalOffer(o);
          applied.push(o.id);
        }
        if (applied.length > 0) saveOffersToDisk();
        clearAsk();
        const base = saySama
          ? `✅ Siap, harga *${kmd.komoditas}* tetap ${fmtRp(price)}/kg. Makasih update-nya! 🙏`
          : `✅ Makasih! Harga jual *${kmd.komoditas}* tercatat: ${fmtRp(price)}/kg.`;
        return applied.length > 0 ? `${base}\nDipakai juga untuk penawaran ${applied.join(", ")} yang menunggu.` : base;
      };
      // (1n) F6: jawaban sodoran lebih dulu (longgar — tak berpola dilepas).
      {
        const paN = negoUser?.pendingAsk;
        const msgN = String(message || "");
        // P0-5/P1-13: harga + awalan sopan ("tolong batal OFR-3") lolos pending.
        const EXN = /cek penawaran|status penawaran|info penawaran|penawaran saya|cek harga|info harga|daftar harga|berapa harga|harga .*berapa|^\s*batal\s+OFR|^\s*OFR-\d+\s*$|komoditas saya|kebutuhan saya|kebutuhanku|status kebutuhan|^\s*bantuan\s*$|(?:tolong|mohon|minta|coba|kak|min)\W+(batal OFR|bantuan|cek (harga|penawaran)|lihat (harga|penawaran)|status (penawaran|kebutuhan))/i;
        const STN = /\b(stok|ready|siap|tersedia)\b[^]*?\d+\s*(ton|kuintal|kwintal|kilogram|kg|kilo|sak|karung|bungkus|pak|botol|liter)\b/i; // P1-14
        const DMN = /\b(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\b[^]*?\d+\s*(ton|kuintal|kwintal|kilogram|kg|kilo)\b/i;
        if (paN && paN.kind === "NUDGE" && !EXN.test(msgN) && !STN.test(msgN) && !DMN.test(msgN)) {
          const nres = handleNudgeAnswer();
          if (nres) return nogoReply(nres);
          clearAsk();
        }
      }

      // (1) Jawaban pendingAsk. Perintah eksplisit (cek/batal/daftar/stok/
      // demand baru) lolos agar user tak terjebak tak bisa cek status atau
      // lapor stok saat menunggu (jebakan OFR basi, 31 Okt 2026).
      const pa = negoUser?.pendingAsk;
      // P0-5/P1-13: harga + awalan sopan ("tolong batal OFR-3") lolos pending.
      const EXPLICIT_RE = /cek penawaran|status penawaran|info penawaran|penawaran saya|cek harga|info harga|daftar harga|berapa harga|harga .*berapa|^\s*batal\s+OFR|^\s*OFR-\d+\s*$|komoditas saya|kebutuhan saya|kebutuhanku|status kebutuhan|^\s*bantuan\s*$|(?:tolong|mohon|minta|coba|kak|min)\W+(batal OFR|bantuan|cek (harga|penawaran)|lihat (harga|penawaran)|status (penawaran|kebutuhan))/i;
      const STOCKCMD_RE = /\b(stok|ready|siap|tersedia)\b[^]*?\d+\s*(ton|kuintal|kwintal|kilogram|kg|kilo|sak|karung|bungkus|pak|botol|liter)\b/i; // P1-14
      const DEMANDCMD_RE = /\b(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\b[^]*?\d+\s*(ton|kuintal|kwintal|kilogram|kg|kilo|sak|karung|bungkus|pak|botol|liter)\b/i;
      // P1-17: "spesifikasi: ..." & "ubah spek ..." lolos pending ke mSpek.
      const SPEKCMD_RE = /^\s*spek\b|^\s*spesifikasi\b|\bubah\s+spek/i;
      const msgStr = String(message || "");
      if (pa && (pa.kind === "HARGA_JUAL" || pa.kind === "BUDGET" || pa.kind === "KONFIRM_DEAL" || pa.kind === "SPEK_OK") && !EXPLICIT_RE.test(msgStr) && !STOCKCMD_RE.test(msgStr) && !DEMANDCMD_RE.test(msgStr) && !SPEKCMD_RE.test(msgStr)) {
        const o = offersDb.find((x) => x.id === pa.offerId && x.status !== "DEAL" && x.status !== "BATAL");
        if (!o) {
          clearAsk();
        } else if (pa.kind === "KONFIRM_DEAL") {
          if (/deal oke|oke deal|^\s*deal\s*$|^\s*oke\s*$/i.test(String(message || ""))) {
            if (o.status !== "COCOK") {
              return nogoReply(`ⓘ ${o.id} belum COCOK (status: ${o.status}). Ketik "cek penawaran" untuk update.`);
            }
            return nogoReply(doDeal(o), ["Cek Penawaran", "Cek Harga Pasar Hari Ini"]);
          }
          const raise = /budget/.test(lowerN) ? parseRpPerKg(String(message || "")) : undefined;
          if (raise !== undefined) {
            clearAsk();
            return nogoReply(doBudget(o, raise));
          }
          if (!/^\s*batal/i.test(String(message || ""))) {
            return nogoReply(`ⓘ Balas *"deal oke"* untuk konfirmasi ${o.id}, atau *"batal ${o.id}"* untuk membatalkan.`);
          }
        } else {
          const price = parseRpPerKg(String(message || ""));
          if (pa.kind === "SPEK_OK") {
            if (!meFarmer) { clearAsk(); return nogoReply(`ⓘ Nomor ini tidak terdaftar sebagai petani.`); }
            const t = lowerN;
            const sline = o.lines.find((l) => l.farmerId === meFarmer!.id);
            const wrapSpek = (ok: boolean, txt: string) => {
              if (sline) sline.spekOk = ok;
              evalOffer(o);
              saveOffersToDisk();
              clearAsk();
              emitCanonicalEvent({
                source: "wa-chat", entity: "offer", entityId: o.id,
                action: "spek", actor: mePhone,
                payload: { farmerId: meFarmer!.id, spekOk: ok, status: o.status },
              });
              return nogoReply(txt);
            };
            if (/tidak|nggak|gak\b|tidak bisa|belum bisa/.test(t)) {
              return wrapSpek(false, `📝 Dicatat: stok Anda *tidak* memenuhi spek "${o.spesifikasi}" untuk *${o.id}*. Baris Anda dikeluarkan dari alokasi — penawaran lanjut dengan petani lain.`);
            }
            if (/sanggup|bisa|iya|\bya\b|^ok\b|siap/.test(t)) {
              return wrapSpek(true, `✅ Siap! Spek "${o.spesifikasi}" *sanggup* dipenuhi untuk *${o.id}*. ${Number(o.budgetPerKg) ? `Status: ${o.status}.` : "Menunggu budget buyer."} Ketik "cek penawaran" untuk update.`);
            }
            return nogoReply(`ⓘ Balas *"sanggup"* bila spek "${o.spesifikasi}" bisa dipenuhi, atau *"tidak"*.`);
          }
          if (price === undefined) {
            return nogoReply(pa.kind === "HARGA_JUAL"
              ? `ⓘ Balas angka harga saja, mis. "8000" atau "8,5rb per kg".`
              : `ⓘ Balas angka budget saja, mis. "8000" atau "8,5rb per kg".`);
          }
          clearAsk();
          if (pa.kind === "HARGA_JUAL") {
            if (!meFarmer) return nogoReply(`ⓘ Nomor ini tidak terdaftar sebagai petani.`);
            const ht = lowerN;
            let spek: boolean | undefined;
            if (o.spesifikasi) {
              if (/tidak|nggak|gak\b|tidak bisa/.test(ht)) spek = false;
              else if (/sanggup|bisa penuhi|^bisa\b|iya|\bya\b/.test(ht)) spek = true;
            }
            const resp = doFarmerPrice(o, price, spek);
            if (o.spesifikasi && spek === true) {
              return nogoReply(resp + `\n✅ Spek "${o.spesifikasi}" tercatat sanggup.`);
            }
            if (o.spesifikasi && spek === false) {
              return nogoReply(resp + `\n📝 Spek "${o.spesifikasi}" tercatat tidak dipenuhi — baris Anda keluar dari alokasi.`);
            }
            if (o.spesifikasi && spek === undefined && negoUser) {
              setAsk(negoUser, "SPEK_OK", o.id);
              return nogoReply(resp + `\n\n❓ Spek buyer: "${o.spesifikasi}". Balas *"sanggup"* atau *"tidak"*.`);
            }
            return nogoReply(resp);
          }
          return nogoReply(doBudget(o, price));
        }
      }

      // (2) Cek / batal penawaran.
      const mStatusId = lowerN.match(/\bOFR-(\d+)\b/i);
      if (/cek penawaran|status penawaran|info penawaran|penawaran saya/.test(lowerN)
        || (mStatusId && /status|cek|info/.test(lowerN)) || /^\s*OFR-\d+\s*$/i.test(String(message || ""))) {
        let o: Offer | undefined;
        if (mStatusId) o = offersDb.find((x) => x.id.toUpperCase() === mStatusId[0].toUpperCase());
        if (!o) o = myOpenOffer(true) || myOpenOffer(false);
        if (!o) {
          const last = [...offersDb].reverse().find((x) => normalizePhone(x.buyerPhone) === mePhone
            || (!!meFarmer && x.lines.some((l) => l.farmerId === meFarmer!.id)));
          if (!last) {
            return nogoReply(`ⓘ Belum ada penawaran. Buyer: "butuh <komoditas> <qty>" (mis. "butuh kentang 2 ton").\nPetani: laporkan stok via "stok <komoditas> <qty>".`);
          }
          return nogoReply(offerStatusText(last, normalizePhone(last.buyerPhone) === mePhone ? "buyer" : "farmer"));
        }
        return nogoReply(offerStatusText(o, normalizePhone(o.buyerPhone) === mePhone ? "buyer" : "farmer"));
      }
      // P1-13: toleran awalan sopan ("tolong batal OFR-3").
      const mBatal = String(message || "").match(/^\s*(?:tolong|mohon|coba)?\s*batal\s+(OFR-\d+)\s*[?.]*$/i);
      if (mBatal) {
        const o = offersDb.find((x) => x.id.toUpperCase() === mBatal[1].toUpperCase());
        if (!o) return nogoReply(`ⓘ ${mBatal[1].toUpperCase()} tidak ditemukan.`);
        const mine = normalizePhone(o.buyerPhone) === mePhone
          || (!!meFarmer && o.lines.some((l) => l.farmerId === meFarmer!.id)) || isAdmin;
        if (!mine) return nogoReply(`ⓘ Hanya buyer/petani terkait atau admin yang bisa membatalkan ${o.id}.`);
        if (o.status === "DEAL") return nogoReply(`ⓘ ${o.id} sudah DEAL — tak bisa dibatalkan via chat. Hubungi admin.`);
        o.status = "BATAL";
        o.updatedAt = new Date().toISOString();
        saveOffersToDisk();
        clearOfferAsks(o.id);
        emitCanonicalEvent({
          source: "wa-chat", entity: "offer", entityId: o.id,
          action: "cancel", actor: mePhone, payload: { status: "BATAL" },
        });
        return nogoReply(`✅ ${o.id} dibatalkan.`);
      }

      // (2b) Spek buyer ("spek OFR-003: ukuran besar" / "spek: ..."). "-" menghapus.
      // P1-17b: "spek" BUKAN prefix "spesifikasi" — dua alternatif eksplisit.
      const mSpek = String(message || "").match(/^\s*(?:spek|spesifikasi)\s*(?:(OFR-\d+)\s*:|:)?\s*(.+?)\s*$/i);
      if (mSpek && !/^\s*(?:spek|spesifikasi)\s*$/i.test(String(message || ""))) {
        const spekTxt = String(mSpek[2] || "").replace(/[\r\n"“”]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
        let oS: Offer | undefined;
        if (mSpek[1]) oS = offersDb.find((x) => x.id.toUpperCase() === mSpek[1].toUpperCase());
        if (!oS) oS = myOpenOffer(true);
        if (!oS) return nogoReply(`ⓘ Tidak ada penawaran terbuka milik Anda. Buat dulu via "butuh <komoditas> <qty>".`);
        if (/^OFR-\d+$/i.test(spekTxt)) return nogoReply(`ⓘ Format: "spek ${oS.id}: <ukuran, potongan, kemasan>" atau "spek: <teks>". "-" menghapus.`);
        if (normalizePhone(oS.buyerPhone) !== mePhone && !isAdmin) return nogoReply(`ⓘ Hanya buyer ${oS.id} atau admin yang bisa ubah spek.`);
        if (oS.status === "DEAL" || oS.status === "BATAL") return nogoReply(`ⓘ ${oS.id} sudah ${oS.status} — spek tak bisa diubah.`);
        if (!spekTxt || spekTxt === "-") {
          oS.spesifikasi = undefined;
          for (const l of oS.lines) l.spekOk = undefined;
          evalOffer(oS);
          saveOffersToDisk();
          return nogoReply(`✅ Spek *${oS.id}* dihapus — semua baris kembali dinilai normal.`);
        }
        oS.spesifikasi = spekTxt;
        for (const l of oS.lines) l.spekOk = undefined;
        evalOffer(oS);
        saveOffersToDisk();
        emitCanonicalEvent({
          source: "wa-chat", entity: "offer", entityId: oS.id,
          action: "spek", actor: mePhone,
          payload: { spesifikasi: spekTxt, status: oS.status },
        });
        return nogoReply(`✅ Spek *${oS.id}* dicatat: "${spekTxt}".\nPetani diminta verifikasi sanggup/tidak saat pasang harga.`);
      }

      // (3) Demand buyer baru ("butuh kentang 2 ton"). Saprodi lolos ke ERP.
      const SAPRODI_RE = /urea|npk|pupuk|pestisida|herbisida|fungisida|insektisida|\bobat\b|benih|bibit|alsintan|traktor/;
      const mNeed = lowerN.match(/\b(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\b\s+(.+?)\s+(\d+(?:[.,]\d+)?\s*(?:ton|kuintal|kwintal|kilogram|kg|kilo))\b/i);
      // P1-18: dihitung di muka agar "komoditas semu" bisa mengalahkan if (blok inline: return null = hang!).
      const komNeedPre = String(mNeed?.[2] || "").replace(/\b(di|ke|dari|untuk|dong|ya|nih)\b/gi, " ").replace(/[^a-z\s]/gi, " ").replace(/\s+/g, " ").trim();
      // P1-2: gerakan/inventaris kios ("stok padi keluar 50 kg ... kios ...")
      // milik ERP-stok, bukan order. (4) punya guard sepadan; (3b)/(3d) butuh
      // verba demand sehingga tak terpicu frasa stok.
      if (mNeed && !/keluar|masuk|kios|toko|gudang/.test(lowerN) && !/^(info|harga|daftar|cara|tanya|berapa|list|katalog)\b/i.test(komNeedPre)) {
        const kom = komNeedPre;
        // P1-18: "perlu info harga 5 kg beras" — komoditas semu, bukan order.
        // (P1-18 dikecualikan pada kondisi if: return null di blok inline = hang.)
        const qty = parseQtyKg(mNeed[3] || "");
        const mSpekInline = String(message || "").match(/(?:spek|spesifikasi)\s*:\s*(.+?)\s*$/i);
        const spekBaru = mSpekInline
          ? String(mSpekInline[1] || "").replace(/[\r\n"“”]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
          : "";
        if (kom.length >= 3 && qty !== undefined && !SAPRODI_RE.test(kom)) {
          const now = new Date().toISOString();
          const cands = findStockCandidates(kom, meFarmer?.id);
          const reuse = offersDb.find((x) => x.status !== "DEAL" && x.status !== "BATAL"
            && normalizePhone(x.buyerPhone) === mePhone && komMatch(x.komoditas, kom));
          if (reuse) {
            reuse.qtyKg = qty;
            if (spekBaru) {
              reuse.spesifikasi = spekBaru;
              for (const l of reuse.lines) l.spekOk = undefined;
            }
            for (const k of cands.slice(0, 10)) {
              const ln = reuse.lines.find((l) => l.farmerId === k.farmerId);
              if (ln) { ln.stokKg = Math.round(Number(k.stokSiapJualTon) * 1000); ln.komoditasId = k.id; }
              else reuse.lines.push({ farmerId: k.farmerId, komoditasId: k.id, stokKg: Math.round(Number(k.stokSiapJualTon) * 1000) });
            }
            const ev = evalOffer(reuse);
            saveOffersToDisk();
            await notifyFarmersNewOrder(reuse).catch(() => {});
            if (!Number(reuse.budgetPerKg) && negoUser) setAsk(negoUser, "BUDGET", reuse.id);
            return nogoReply(`🤝 *${reuse.id} diperbarui:* butuh *${kom}* ${fmtKg(qty)}.\n\n${stockListText(cands, kom, qty)}\n\n` +
              (spekBaru ? `Spek: ${spekBaru}.\n\n` : "") +
              (Number(reuse.budgetPerKg) ? composeBuyerFit(reuse, ev) : `💰 *Budget Anda berapa per kg?* Balas mis. "budget 8000".`),
              ["Cek Penawaran"]);
          }
          const o: Offer = {
            id: nextId("OFR", offersDb.map((x) => x.id)),
            buyerPhone: mePhone,
            komoditas: kom,
            qtyKg: qty,
            spesifikasi: spekBaru || undefined,
            status: "OPEN",
            lines: [],
            createdAt: now,
            updatedAt: now,
          };
          for (const k of cands.slice(0, 10)) {
            o.lines.push({ farmerId: k.farmerId, komoditasId: k.id, stokKg: Math.round(Number(k.stokSiapJualTon) * 1000) });
          }
          offersDb.push(o);
          saveOffersToDisk();
          emitCanonicalEvent({
            source: "wa-chat", entity: "offer", entityId: o.id,
            action: "create", actor: mePhone,
            payload: { komoditas: kom, qtyKg: qty, kandidat: o.lines.length, ...(spekBaru ? { spesifikasi: spekBaru } : {}) },
          });
          await notifyFarmersNewOrder(o).catch(() => {});
          if (negoUser) setAsk(negoUser, "BUDGET", o.id);
          return nogoReply(
            `🤝 *Permintaan dicatat: ${o.id}*\nButuh *${kom}* ${fmtKg(qty)}.${spekBaru ? `\nSpek: ${spekBaru}.` : ""}\n\n${stockListText(cands, kom, qty)}\n\n💰 *Budget Anda berapa per kg?* Balas mis. "budget 8000".`,
            ["Cek Penawaran"]);
        }
      }

      // (3b) Demand saprodi dari chat ("butuh pupuk urea 2 sak"): siapa pun yang
      // chat mencari input dicatat sebagai kebutuhan (konteks buyer), bukan OFR.
      const mNeedInput = lowerN.match(/\b(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\b\s+(.+?)\s+(\d+(?:[.,]\d+)?\s*(?:sak|karung|bungkus|pak|botol|liter|kg|kilo|ton))\b/i);
      // P1-20: penanda harga ("seharga 300 ribu") = catatan harga, bukan kas.
      if (mNeedInput && !/sudah beli|\bkas\b|catat|keluar|masuk|bayar|utang|hutang|piutang/.test(lowerN)) {
        const itemRaw = String(mNeedInput[2] || "").replace(/\b(di|ke|dari|untuk|dong|ya|nih)\b/gi, " ").replace(/[^a-z\s]/gi, " ").replace(/\s+/g, " ").trim();
        const jumlahRaw = String(mNeedInput[3] || "").trim();
        const kat = /pupuk|urea|npk|phonska|\bza\b|sp-?36|kcl|dolomit|kompos/.test(itemRaw) ? "PUPUK"
          : /obat|hama|pestisida|herbisida|fungisida|insektisida|wereng|ulat/.test(itemRaw) ? "OBAT"
          : /benih|bibit|seed/.test(itemRaw) ? "BIBIT"
          : /alsintan|traktor|sprayer|cangkul/.test(itemRaw) ? "LAINNYA" : "";
        // P1-19: "butuh obat 2 botol untuk anak" = obat manusia, bukan saprodi.
        const isHumanMedP119 = kat === "OBAT" && /anak|bayi|balita|demam|batuk|pilek|flu|istri|suami|keluarga|orang tua/.test(lowerN);
        if (itemRaw.length >= 3 && kat && !isHumanMedP119) {
          if (!meFarmer) {
            return nogoReply(`📝 Untuk mencatat kebutuhan *${itemRaw}* (${kat}), nomor ini perlu terdaftar sebagai petani dulu. Ketik *daftar* — 1 menit saja.`);
          }
          const nowN = new Date().toISOString();
          const open = needsDb.find((x) => x.farmerId === meFarmer!.id && (x.status === "BARU" || x.status === "DIHUBUNGKAN") && x.item.toLowerCase() === itemRaw.toLowerCase());
          if (open) {
            open.jumlah = jumlahRaw;
            open.updatedAt = nowN;
            saveNeedsToDisk();
            return nogoReply(`📝 *${open.id} diperbarui:* butuh *${open.item}* ${jumlahRaw} (${kat}). Status: ${open.status} — sedang kami carikan dari toko mitra.`);
          }
          const priceNote = (lowerN.match(/seharga[^.,;!?]{0,40}|\brp\s*[\d.,]+\s*(rb|ribu|juta|jt)?/i) || [""])[0].trim();
          const rec: FarmerNeed = { id: nextNeedId(), farmerId: meFarmer!.id, kategori: kat as NeedKategori, item: itemRaw, jumlah: jumlahRaw, status: "BARU", catatan: priceNote ? sanitizeText(`info harga: ${priceNote}`, 300) : undefined, createdAt: nowN, updatedAt: nowN };
          needsDb.unshift(rec);
          saveNeedsToDisk();
          return nogoReply(`📝 *Kebutuhan dicatat: ${rec.id}*\nButuh *${itemRaw}* ${jumlahRaw} (${kat}).\n\nKami carikan dari toko pertanian mitra terdekat — ketik "kebutuhan saya" untuk memantau status.`);
        }
      }

      // (3c) Status kebutuhan input ("kebutuhan saya").
      if (/^\s*(kebutuhan saya|kebutuhanku|status kebutuhan)\s*$/i.test(String(message || ""))) {
        if (!meFarmer) return nogoReply(`ⓘ Nomor ini belum terdaftar sebagai petani.`);
        const mine = needsDb.filter((x) => x.farmerId === meFarmer!.id).slice(0, 10);
        if (mine.length === 0) return nogoReply(`ⓘ Belum ada kebutuhan tercatat. Contoh: "butuh pupuk urea 2 sak".`);
        return nogoReply(`📝 *Kebutuhan Anda:*\n` + mine.map((x, i) => `${i + 1}. *${x.item}*${x.jumlah ? ` ${x.jumlah}` : ""} (${x.kategori}) — ${x.status} [\`${x.id}\`]`).join("\n"));
      }

      // (3d) Demand tanpa jumlah ("beli agave", "butuh kentang"): tanya balik
      // formatnya, jangan lempar ke LLM. Berlaku semua peran termasuk admin.
      // "cari <saprodi>" dibiarkan lolos ke pencarian katalog toko (0d).
      if (/^\s*(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\s*[?.]*$/i.test(lowerN)) {
        return nogoReply(`Mau beli/butuh apa, Bpk/Ibu? Sebutkan komoditas + jumlahnya.\n\n• Hasil panen: *"butuh kentang 2 ton"* (+ spek opsional: *"spek: daun lebar"*)\n• Saprodi: *"butuh pupuk urea 2 sak"*`, ["Cek Harga Pasar Hari Ini", "Bantuan"]);
      }
      const mWantNoQty = lowerN.match(/\b(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\b\s+(.+)/i);
      // P0-3/P1-29: kata-benda ("pesan saya belum dibaca", "perlu bantuan admin")
      // & frasa gerak ("perlu ke pasar bawa 2 karung") BUKAN niat beli. P1-20:
      // penanda harga (ribu/juta/rp) diizinkan sbg catatan harga, bukan kas.
      if (mWantNoQty && !/sudah beli|\bkas\b|catat|keluar|masuk|bayar|utang|hutang|piutang/.test(lowerN) && !/pesan saya|belum dibaca|bantuan|bantu\b|tolong|ke pasar|bawa\b|antar|kirim|pulang|pergi\b|stok|habis|kosong|kios|toko|tersedia|ready/.test(lowerN)) {
        const verbQ = String(mWantNoQty[1] || "").toLowerCase();
        const komQ = String(mWantNoQty[2] || "").replace(/\b(di|ke|dari|untuk|dong|ya|nih|tolong)\b/gi, " ").replace(/[^a-z\s]/gi, " ").replace(/\s+/g, " ").trim();
        const isSaprodiQ = SAPRODI_RE.test(komQ);
        if (/^(cari|carikan|nyari)$/.test(verbQ) && isSaprodiQ) {
          // Niat browse katalog -> lolos ke 0d-affiliate.
        // P1-18 (3d): "butuh info harga beras" — komoditas semu -> lolos ke harga.
        } else if (komQ.length >= 3 && !/^(info|harga|daftar|cara|tanya|berapa|list|katalog)\b/.test(komQ) && !(/\bobat\b|pestisida|herbisida|fungisida|insektisida/.test(komQ) && /anak|bayi|balita|demam|batuk|pilek|flu|istri|suami|keluarga/.test(komQ))) { // P1-19b
          // P1-16: "order gabah 50" — angka tanpa satuan -> tanya SATUAN saja.
          const bareDigits = String(mWantNoQty[2] || "").match(/\d+(?:[.,]\d+)?/);
          if (bareDigits) {
            return nogoReply(
              `Siap! *${komQ}* ${bareDigits[0]} — satuannya apa? Balas lengkap ya, mis. *"butuh ${komQ} ${bareDigits[0]} kg"* (atau sak/ton/liter).`,
              ["Cek Harga Pasar Hari Ini", "Bantuan"]);
          }
          return nogoReply(
            isSaprodiQ
              ? `Mau butuh *${komQ}* berapa banyak? Balas mis. *"butuh ${komQ} 2 sak"*.`
              : `Mau beli *${komQ}* berapa banyak? Balas mis. *"butuh ${komQ} 5 kg"* (tambah *"spek: ..."* bila ada syarat ukuran/potongan).`,
            ["Cek Harga Pasar Hari Ini", "Bantuan"]);
        }
      }

      // (4) Lapor stok petani ("stok kentang 1,3 ton"). Bukan KMD-nya -> lolos
      // ke ERP/estimasi. Nol eksplisit ("stok X 0 kg") = kosongkan stok.
      // P0-4/P1-28/P1-2: "ada beras 5 kg di rumah untuk makan", "siap antar 5 kg",
      // "stok keluar ... kios" BUKAN lapor stok jual -> lolos ke ERP/LLM.
      if (meFarmer && /\b(stok|ready|siap|tersedia|ada)\b/.test(lowerN) && !/untuk (makan|sendiri|keluarga)|di rumah|buat makan|stok habis|tidak ada|tak ada|nggak ada|gak ada|antar|kirim|diantar|dikirim|besok|lusa|keluar|masuk|kios|toko|gudang/i.test(lowerN)) {
        const mQty = lowerN.match(/(\d+(?:[.,]\d+)?)\s*(ton|kuintal|kwintal|kilogram|kg|kilo|sak|karung|liter|bungkus|pak|botol|t\b|kw\b)/i); // P1-14
        if (mQty) {
          const rawV = Number(mQty[1].replace(/\./g, "").replace(/,/g, "."));
          const uu = mQty[2].toLowerCase();
          const mult = (uu.startsWith("ton") || uu === "t") ? 1000 : (uu.startsWith("ku") || uu.startsWith("kw")) ? 100 : (uu === "sak" || uu === "karung") ? 50 : 1; // P1-14: 1 sak/karung = 50 kg.
          const qtyKg = Number.isFinite(rawV) && rawV >= 0 ? rawV * mult : NaN;
          const cleaned = lowerN
            .replace(/\b(stok|ready|siap|tersedia|ada|panen|hasil|jual|harga|rp|rupiah|per|kg|ton|kuintal|kwintal|kilo|sak|karung|liter|bungkus|pak|botol|dong|ya|nih)\b/gi, " ")
            .replace(/[\d.,]+\s*(rb|ribu)?/gi, " ")
            .replace(/[^a-z\s]/gi, " ").replace(/\s+/g, " ").trim();
          const rows = komoditasDb.filter((k) => k.farmerId === meFarmer!.id && (k.status === "AKTIF" || k.status === "PANEN"));
          const target = [...rows].reverse().find((k) => komMatch(k.komoditas, cleaned));
          if (target && Number.isFinite(qtyKg)) {
            const nowS = new Date().toISOString();
            target.stokSiapJualTon = qtyKg / 1000;
            target.stokUpdatedAt = nowS;
            target.updatedAt = nowS;
            const inlinePrice = /(harga|jual|minta|tawar)/.test(lowerN) ? parseRpPerKg(String(message || "")) : undefined;
            if (inlinePrice !== undefined) {
              target.hargaMintaPerKg = inlinePrice;
              target.hargaMintaAt = nowS;
            }
            saveKomoditasToDisk();
            emitCanonicalEvent({
              source: "wa-chat", entity: "commodity", entityId: target.id,
              action: "update", actor: mePhone,
              payload: { farmerId: target.farmerId, komoditas: target.komoditas, stokSiapJualTon: target.stokSiapJualTon },
            });
            const opens = offersDb.filter((o) => (o.status === "OPEN" || o.status === "SEBAGIAN") && komMatch(o.komoditas, target.komoditas));
            for (const o of opens) {
              let ln = o.lines.find((l) => l.farmerId === meFarmer!.id);
              if (!ln) {
                ln = { farmerId: meFarmer!.id, komoditasId: target.id, stokKg: Math.round(qtyKg) };
                o.lines.push(ln);
              } else {
                ln.stokKg = Math.round(qtyKg);
                ln.komoditasId = target.id;
              }
              if (inlinePrice !== undefined) {
                ln.hargaPetaniPerKg = inlinePrice;
                ln.hargaAt = nowS;
              }
              evalOffer(o);
              o.updatedAt = nowS;
            }
            if (opens.length > 0) saveOffersToDisk();
            // Tanya harga untuk penawaran TERBARU yang belum berharga (basi diabaikan).
            const askPriceFor = inlinePrice === undefined
              ? [...opens].reverse().find((o) => {
                const ln = o.lines.find((l) => l.farmerId === meFarmer!.id);
                return ln && !Number(ln.hargaPetaniPerKg);
              })
              : undefined;
            if (askPriceFor && negoUser) setAsk(negoUser, "HARGA_JUAL", askPriceFor.id);
            let replyT = `✅ Stok *${target.komoditas}* tercatat: siap ${fmtKg(qtyKg)} (${target.id}).` + ((uu === "sak" || uu === "karung") ? ` (asumsi 1 ${uu} = 50 kg)` : "");
            if (opens.length > 0) {
              const o0 = opens[opens.length - 1];
              replyT += `\n\nAda buyer butuh ${fmtKg(Number(o0.qtyKg))} (${o0.id}).` +
                (inlinePrice !== undefined
                  ? ` Harga ${fmtRp(inlinePrice)}/kg tercatat — ${Number(o0.budgetPerKg) ? `status penawaran: ${o0.status}.` : "menunggu budget buyer."}`
                  : ` *Mau jual harga berapa per kg?*` + (o0.spesifikasi ? `\nSpek buyer: "${o0.spesifikasi}". Tambahkan "sanggup" bila bisa penuhi (cth. "8000 sanggup"), atau balas "tidak".` : ""));
            } else {
              replyT += `\n\nBelum ada buyer yang butuh — stok ini otomatis terlihat saat ada permintaan.`;
            }
            return nogoReply(replyT, ["Cek Penawaran"]);
          }
        }
      }

      // (5) Harga jual petani tanpa pending ("jual kentang 8000/kg"). Butuh
      // kata jual eksplisit + offer terbuka; catatan "terjual/laku" milik ERP.
      if (meFarmer && !isAdmin && /(jual|tawar|minta|lepas)/.test(lowerN) && !/terjual|laku|\bkas\b|catat|\bhpp\b|terima|transfer/.test(lowerN)) {
        const price = parseRpPerKg(String(message || ""));
        if (price !== undefined) {
          const o = myOpenOffer(false);
          if (o) {
            const t5 = lowerN;
            let spek5: boolean | undefined;
            if (o.spesifikasi) {
              if (/tidak|nggak|gak\b|tidak bisa/.test(t5)) spek5 = false;
              else if (/sanggup|bisa penuhi|^bisa\b|iya|\bya\b/.test(t5)) spek5 = true;
            }
            const resp5 = doFarmerPrice(o, price, spek5);
            if (o.spesifikasi && spek5 === undefined && negoUser) {
              setAsk(negoUser, "SPEK_OK", o.id);
              return nogoReply(resp5 + `\n\n❓ Spek buyer: "${o.spesifikasi}". Balas *"sanggup"* atau *"tidak"*.`);
            }
            return nogoReply(resp5);
          }
        }
      }

      // (6) Budget buyer ("budget 8000"). Tanpa offer terbuka -> lolos.
      {
        const oB = myOpenOffer(true);
        if (oB && /\bbudget\b/.test(lowerN)) {
          const price = parseRpPerKg(String(message || ""));
          if (price === undefined) return nogoReply(`ⓘ Budget berapa per kg? Balas mis. "budget 8000".`);
          clearAsk();
          return nogoReply(doBudget(oB, price));
        }
      }

      // (7) Konfirmasi deal eksplisit ("deal oke").
      if (/^\s*(deal oke|oke deal|deal|acc deal)\s*$/i.test(String(message || ""))) {
        const o = offersDb.filter((x) => x.status === "COCOK" && normalizePhone(x.buyerPhone) === mePhone).pop();
        if (!o) return nogoReply(`ⓘ Tidak ada penawaran COCOK milik Anda. Ketik "cek penawaran".`);
        return nogoReply(doDeal(o), ["Cek Penawaran", "Cek Harga Pasar Hari Ini"]);
      }
    }

    // 0c-feedback (F7). Saran/komplain eksplisit ("saran: ...") + keluhan
    // implisit (kata komplain + rujukan bot) -> catat FDB + cermin Sheets.
    // SEBELUM cabang ERP/harga/estimasi/LLM. Admin: "lihat saran".
    {
      const msgF = String(message || "");
      const lowerF = msgF.toLowerCase();
      const mExp = msgF.match(/^\s*(saran|masukan|kritik|usulan|keluhan|komplain|lapor)\s*[:\s]+(.{3,500})\s*$/is);
      const mImpl = !mExp
        && /(kecewa|ngawur|bodoh|jelek|buruk|payah|lemot|lambat|error|gagal|tidak membantu|nggak membantu|ngga membantu|bohong|sesat|salah(?! ketik| sambung| nomor))\b/.test(lowerF)
        && /(kamu|kau|bot|ai\b|jawab|aplikasi|hai tani|kang tani|sistem)/.test(lowerF);
      if (mExp || mImpl) {
        const kat: FeedbackKategori = mExp && /keluhan|komplain|lapor/i.test(mExp[1]) ? "KOMPLAIN" : mExp ? "SARAN" : "KOMPLAIN";
        const pesan = mExp ? mExp[2] : msgF;
        const rec = logFeedback(String(effPhone || senderPhone || ""), kat, pesan, "via-chat");
        return res.json({
          reply: kat === "KOMPLAIN"
            ? `🙏 Maaf atas ketidaknyamanannya. Keluhan Anda sudah saya catat (\`${rec.id}\`) untuk perbaikan Hai Tani.`
            : `🙏 Makasih sarannya! Sudah saya catat (\`${rec.id}\`) untuk pengembangan Hai Tani.`,
          quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "Lihat Saran"] : ["Cek Harga Pasar Hari Ini", "Bantuan"],
          extracted: {}, isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
        } as any);
      }
      if (isAdmin && /^\s*lihat (saran|masukan|keluhan|komplain|feedback)\s*$/i.test(msgF)) {
        const rows = feedbackDb.slice(0, 5);
        if (rows.length === 0) {
          return res.json({
            reply: "📭 Belum ada saran/masukan yang tercatat.",
            quickReplies: ["📊 Rekap Semua Petani"], extracted: {},
            isComplete: true, isAdminAction: true, aiProvider: "rule_based",
          } as any);
        }
        const list = rows.map((f) => `• \`${f.id}\` [${f.kategori}] ${f.nama || maskPhone(f.phone)}: ${f.pesan.slice(0, 80)}`).join("\n");
        return res.json({
          reply: `📬 *Saran & Masukan terbaru:*\n${list}`,
          quickReplies: ["📊 Rekap Semua Petani"], extracted: {},
          isComplete: true, isAdminAction: true, aiProvider: "rule_based",
        } as any);
      }
    }

    // 0d-affiliate (F4). Katalog toko mitra + laporan pembelian (komisi 3%) +
    // admin produk. SEBELUM cabang ERP/harga/estimasi/LLM.
    {
      const msgD = String(message || "");
      const affReply = (reply: string, qr: string[]) => res.json({
        reply, quickReplies: qr, extracted: {},
        isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
      } as any);
      const mTambah = isAdmin && msgD.match(/^\s*tambah produk\s*:?\s*(.+)$/is);
      if (mTambah) {
        const parts = mTambah[1].split(";").map((s) => s.trim());
        if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
          return affReply("📝 Format: *tambah produk: <nama> ; <harga> ; <toko> ; <katakunci koma, opsional>*\nContoh: tambah produk: Pupuk Urea 50kg ; 135000 ; Kios Tani Makmur ; urea, pupuk",
            ["Lihat Katalog", "📊 Rekap Semua Petani"]);
        }
        const harga = Number(parts[1].replace(/[^\d]/g, "")) || 0;
        if (harga <= 0) return affReply("⚠️ Harga harus angka > 0 (contoh: 135000).", ["Lihat Katalog"]);
        const tokoKey = parts[2].toLowerCase();
        const tokoHit = suppliersDb.find((s) => s.nama.toLowerCase().includes(tokoKey) || tokoKey.includes(s.nama.toLowerCase()));
        if (!tokoHit) {
          const daftar = suppliersDb.slice(0, 10).map((s) => s.nama).join(", ") || "(belum ada supplier)";
          return affReply(`⚠️ Toko "${parts[2]}" tidak ada di data supplier. Pilihan: ${daftar}`, ["Lihat Katalog"]);
        }
        const keys = (parts[3] || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3);
        const namaL = parts[0].toLowerCase();
        const kat: ProductKategori = /obat|insektisida|fungisida|herbisida|pestisida/.test(namaL + " " + keys.join(" ")) ? "Obat"
          : /pupuk|urea|npk|kcl|phonska/.test(namaL + " " + keys.join(" ")) ? "Pupuk"
          : /bibit|benih/.test(namaL) ? "Benih"
          : /traktor|sprayer|pompa|cangkul|alat/.test(namaL) ? "Alat" : "Saprodi";
        const satuan = /liter|\bl\b/i.test(parts[0]) ? "liter" : /sak/i.test(parts[0]) ? "sak"
          : /botol/i.test(parts[0]) ? "botol" : /kg/i.test(parts[0]) ? "kg" : "pcs";
        const now = new Date().toISOString();
        const p: ProductRecord = {
          id: nextId("PRD", productsDb.map((x) => x.id)),
          supplierId: tokoHit.id, nama: sanitizeText(parts[0], 120), kategori: kat,
          hargaNormal: harga, satuan, kataKunci: keys, aktif: true, waktuCatat: now,
        };
        productsDb.unshift(p);
        saveProductsToDisk();
        bumpDataVersion();
        emitCanonicalEvent({ source: "wa-chat", entity: "product", entityId: p.id, action: "create", actor: effPhone || senderPhone, payload: { supplierId: p.supplierId, hargaNormal: harga } });
        return affReply(`✅ Produk *${p.nama}* tercatat (\`${p.id}\`, ${kat}, Rp${harga.toLocaleString("id-ID")}/${satuan}, ${tokoHit.nama}).\nKomisi afiliasi ${AFFILIATE_PCT}% berlaku tiap laporan pembelian.`,
          ["Lihat Katalog", "📊 Rekap Semua Petani"]);
      }
      const mHapus = isAdmin && msgD.match(/^\s*hapus produk\s+(PRD-\d+)\s*$/i);
      if (mHapus) {
        const p = productsDb.find((x) => x.id.toUpperCase() === mHapus[1].toUpperCase());
        if (!p) return affReply(`⚠️ ${mHapus[1].toUpperCase()} tidak ada di katalog.`, ["Lihat Katalog"]);
        p.aktif = false;
        saveProductsToDisk();
        bumpDataVersion();
        return affReply(`🗑️ *${p.nama}* (\`${p.id}\`) dinonaktifkan dari katalog.`, ["Lihat Katalog"]);
      }
      const mKom = isAdmin && msgD.match(/^\s*komisi diterima\s+(AFF-\d+)\s*$/i);
      if (mKom) {
        const r = receiveCommission(mKom[1].toUpperCase(), String(effPhone || senderPhone || ""));
        if (!r) return affReply(`⚠️ ${mKom[1].toUpperCase()} tidak ditemukan / sudah diterima.`, ["Lihat Katalog"]);
        return affReply(`✅ Komisi *Rp${r.aff.komisiRp.toLocaleString("id-ID")}* (${AFFILIATE_PCT}% ${r.aff.id}) masuk kas \`${r.kasId}\` (Kategori: Komisi Affiliate).`,
          ["Lihat Katalog", "📊 Rekap Semua Petani"]);
      }
      if (isAdmin && /^\s*lihat katalog\s*$/i.test(msgD)) {
        const tertagih = affiliateDb.filter((a) => a.status === "TERCATAT");
        const totKom = tertagih.reduce((n, a) => n + (Number(a.komisiRp) || 0), 0);
        const list = productsDb.slice(0, 15).map((p) => `${p.aktif ? "•" : "○"} \`${p.id}\` ${p.nama} — Rp${Number(p.hargaNormal).toLocaleString("id-ID")} (${supplierName(p.supplierId)})`).join("\n") || "(katalog kosong)";
        return affReply(`🛒 *Katalog toko mitra (${productsDb.filter((p) => p.aktif).length} aktif):*\n${list}\n\n💰 Komisi tertagih: Rp${totKom.toLocaleString("id-ID")} (${tertagih.length} transaksi).`,
          ["📊 Rekap Semua Petani"]);
      }
      if (/^\s*katalog\s*$/i.test(msgD)) {
        const acts = productsDb.filter((p) => p.aktif).slice(0, 10);
        if (acts.length === 0) return affReply("🛒 Katalog toko mitra masih kosong. Admin sedang menyiapkan daftar produk — tanya lagi kapan-kapan ya.", ["Cek Harga Pasar Hari Ini", "Bantuan"]);
        return affReply(`🛒 *Katalog toko mitra:*\n${acts.map(productLine).join("\n")}\n\nLapor setelah beli: *sudah beli <nama produk>* — komisi rujukan tercatat untuk kas Hai Tani.`,
          ["Cek Harga Pasar Hari Ini", "Bantuan"]);
      }
      const mCari = msgD.match(/^\s*cari\s+(.{3,100})$/i);
      if (mCari) {
        const hits = matchProducts(mCari[1], 5);
        if (hits.length === 0) return affReply(`🔍 Tidak ada produk "*${mCari[1].trim()}*" di katalog toko mitra. Ketik *katalog* untuk semua produk.`, ["Katalog", "Bantuan"]);
        return affReply(`🔍 *Hasil cari "${mCari[1].trim()}":*\n${hits.map(productLine).join("\n")}\n\nLapor setelah beli: *sudah beli <nama produk>*.`,
          ["Katalog", "Bantuan"]);
      }
      const mBeli = msgD.match(/^\s*sudah beli\s+(.+)$/is);
      if (mBeli) {
        const teks = mBeli[1];
        const mRp = teks.match(/\brp\.?\s?([\d.]+)/i);
        const hargaLap = mRp ? Number(mRp[1].replace(/[^\d]/g, "")) || 0 : 0;
        const hits = matchProducts(teks, 1);
        if (hits.length === 0) return affReply("⚠️ Produk tidak ada di katalog toko mitra. Ketik *katalog* untuk daftar persis, lalu lapor: *sudah beli <nama>*.", ["Katalog"]);
        const a = logAffiliate(String(effPhone || senderPhone || ""), hits[0], hargaLap);
        return affReply(`🧾 Terima kasih laporannya! Tercatat \`${a.id}\`:\n• ${a.namaProduk} @ ${a.toko}\n• Harga: Rp${a.hargaRp.toLocaleString("id-ID")} → komisi ${AFFILIATE_PCT}% = *Rp${a.komisiRp.toLocaleString("id-ID")}* untuk kas Hai Tani.\n\nSebutkan ke toko bahwa Bpk/Ibu dirujuk Hai Tani ya. 🙏`,
          ["Katalog", "Cek Harga Pasar Hari Ini"]);
      }
    }

    // 0e-kartu (FR-04). Kartu Tanda Registrasi PDF + QR: "kartu saya" (petani
    // terdaftar via no HP pengirim) atau "kartu TANI-016" (khusus admin).
    // SEBELUM cabang ERP/harga/estimasi/LLM.
    {
      const msgK = String(message || "");
      const kartuReply = (reply: string, qr: string[]) => res.json({
        reply, quickReplies: qr, extracted: {},
        isComplete: true, isAdminAction: !!isAdmin, aiProvider: "rule_based",
      } as any);
      const mKartuIdAny = msgK.match(/^\s*kartu\s+(TANI-\d+)\s*$/i);
      if (mKartuIdAny && !isAdmin) {
        return kartuReply("🔒 Melihat kartu petani lain khusus admin/petugas. Ketik *kartu saya* untuk kartu sendiri.", ["Bantuan"]);
      }
      if (mKartuIdAny && isAdmin) {
        const want = mKartuIdAny[1].toUpperCase();
        const f = farmersDb.find((x) => x.id.toUpperCase() === want) || null;
        if (!f) return kartuReply(`⚠️ ${want} tidak ada di data petani.`, ["📊 Rekap Semua Petani"]);
        const base = kartuPublicBase(String((req as any)?.get?.("host") || ""));
        return kartuReply(`🪪 *Kartu Tanda Registrasi ${f.id}*\n• ${f.nama}\n• ${f.komoditas} — ${f.luasLahanFormatted || f.luasLahan + " Ha"}\n• Status: ${f.statusVerifikasi}\n\nUnduh PDF + QR:\n${base}/api/kartu/${encodeURIComponent(f.id)}`,
          ["📊 Rekap Semua Petani"]);
      }
      if (/^\s*(kartu saya|kartu tani saya|cetak kartu)\s*$/i.test(msgK)) {
        const me = normalizePhone(String(effPhone || senderPhone || ""));
        const f = farmersDb.find((x) => normalizePhone(x.noHp) === me) || null;
        // Kartu QR = manfaat tier Tumbuh+ (proposal revenue). FREE/Tunas
        // diarahkan ke info langganan; admin "kartu TANI-xxx" tak berubah.
        const tierK = f ? tierOfPhone(f.noHp || "") : "FREE";
        if (f && tierK !== "TUMBUH" && tierK !== "PANEN" && tierK !== "PAID") {
          return kartuReply(`Kartu registrasi QR adalah manfaat tier *Tumbuh* ke atas.\n\nTier kamu saat ini: *${tierK}* (komisi ${TIER_COMMISSION_PCT[tierK] ?? 5}%).\n\nKetik *langganan* untuk info tier & cara upgrade.`, ["Langganan", "Bantuan"]);
        }
        if (!f) return kartuReply("ℹ️ Nomor ini belum terdaftar sebagai petani. Ketik *daftar* untuk mendaftar, lalu kartu bisa dicetak.", ["Daftar", "Bantuan"]);
        const base = kartuPublicBase(String((req as any)?.get?.("host") || ""));
        return kartuReply(`🪪 *Kartu Tanda Registrasi ${f.id}*\n• ${f.nama}\n• ${f.komoditas} — ${f.luasLahanFormatted || f.luasLahan + " Ha"}\n• Status: ${f.statusVerifikasi}\n\nUnduh PDF + QR:\n${base}/api/kartu/${encodeURIComponent(f.id)}`,
          ["Cek Harga Pasar Hari Ini", "Bantuan"]);
      }
    }

    // 0e-tier (F9). Info langganan + cara bayar: "langganan".
    // Dijangkar penuh agar tak membajak intent fungsional; lolos gate
    // onboarding (allowlist handleOnboarding) agar info harga publik.
    {
      const msgL = String(message || "");
      if (/^\s*(mau\s+|daftar\s+|cara\s+|info\s+|biaya\s+|harga\s+)?langganan\s*\??\s*$/i.test(msgL)) {
        const meL = normalizePhone(String(effPhone || senderPhone || ""));
        const myTier = tierOfPhone(meL);
        const myPct = TIER_COMMISSION_PCT[myTier] ?? 5;
        return res.json({
          reply: `*Langganan Hai Tani*\n\nTier kamu saat ini: *${myTier}* (komisi ${myPct}%).\n\n- *Tunas* — Gratis. Komisi 5% per deal.\n- *Tumbuh* — Rp25rb/bln. Komisi 2% + kartu registrasi QR.\n- *Panen* — Rp75rb/bln. Komisi 0%.\n\n*Cara bayar:* transfer ke rekening Hai Tani (minta nomor rekening ke admin/PPL), lalu kirim bukti transfer di chat ini. Admin verifikasi & tier aktif maks. 1x24 jam.\n\nDasbor harga & peta publik tetap gratis tanpa login.`,
          quickReplies: ["Cek Harga Pasar Hari Ini", "Bantuan"],
          extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based",
        } as any);
      }
    }

    // 0a-benefit. Pertanyaan manfaat/program ("apa benefit setelah terdaftar?",
    // "jelaskan program hai tani"): jawab deterministik dari daftar manfaat
    // resmi (terverifikasi sesuai kemampuan terkirim) — JANGAN templat draf.
    {
      const lowerB = (message || "").toLowerCase();
      const benefitWords = /\bmanfaat\b|\bbenefit\b|\bkeuntungan\b|\bkegunaan\b/.test(lowerB);
      const programWords = /\bprogram\b|\btentang\b|apa itu|itu apa/.test(lowerB);
      const taniWords = /tani|hai|kang|bot|aplikasi|daftar/.test(lowerB);
      const agroWords = /pupuk|hama|wereng|ulat|tikus|penyakit|dosis|tanaman|padi|cabai|bawang|jagung|sawah|lahan/.test(lowerB);
      const benefitHit = (benefitWords && !(agroWords && !taniWords)) || (programWords && taniWords);
      if (benefitHit) {
        const reply = isAdmin
          ? `🌾 *Hai Tani / Kang Tani AI untuk Dinas & PPL:*\n\n` +
            `• 📝 *Pendataan petani via WA* — admin daftarkan petani (teks/voice note), otomatis tersimpan & terverifikasi\n` +
            `• 💹 *Harga pasar LIVE 2 sumber (SISKAPERBAPO + Mantung)* — monitoring per-pasar & per-komoditas untuk stabilisasi\n` +
            `• 📊 *Rekap & agregasi real-time* — total petani, luas, proyeksi panen, sebaran komoditas\n` +
            `• ✅ *Verifikasi & anomali* — daftar belum verifikasi, deteksi anomali harga\n` +
            `• 📣 *Draf broadcast* — siapkan pesan hama/panen untuk petani\n` +
            `• 🧾 *Kas/stok/HPP kios* — catat kas, stok, hitung HPP via chat\n` +
            `• 🛡️ *Data jujur* — estimasi hanya dari petani, duplikat dicek via no HP\n` +
            `• 📥 *Ekspor data* — unduh CSV untuk arsip dinas`
          : `🌾 *Kenapa daftar di Hai Tani (Kang Tani AI)?*\n\n` +
            `• 📝 *Pendaftaran lahan mudah* — cukup chat/voice note/foto: nama, komoditas, luas, lokasi. Tercatat resmi & terverifikasi dinas\n` +
            `• 💹 *Harga pasar LIVE 2 sumber (SISKAPERBAPO Jatim per-pasar + Mantung Malang)* — bandingkan harga sebelum jual agar dapat harga terbaik dari buyer\n` +
            `• 🐛 *Konsultasi hama & penyakit* — sebutkan gejala, dapat saran penanganan\n` +
            `• 🧪 *Takaran pupuk tepat* — dosis urea/NPK per hektar sesuai komoditas\n` +
            `• 📊 *Status lahan tercatat* — data, luas & riwayat panen rapi dalam satu tempat\n` +
            `• 🛡️ *Data tidak dikarang* — yang kosong tetap kosong sampai Anda mengisi\n` +
            `• 🎙️ *Bisa teks, voice note, & foto* — kirim foto tanaman untuk dinilai kondisinya\n\n` +
            `Ketik *daftar* untuk mulai, atau *cek harga <komoditas>* untuk harga hari ini.`;
        return res.json({
          reply,
          quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "Daftarkan Petani"] : ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
          extracted: currentDraft || {}, isComplete: false, isAdminAction: isAdmin, aiProvider: "rule_based",
        } as any);
      }
    }

    // 0a-est. Susulan estimasi panen/hasil ("panen Desember 2026", "hasil 8 ton").
    // Aturan: estimasi HANYA dari user — perintah ini mengisi yang kosong kapan saja.
    {
      const regU = extractFarmerFromText(message, {});
      const hasEst = !!(regU.extracted.estimasiPanen || regU.extracted.estimasiHasilTon);
      const hasOther = !!(regU.extracted.nama || regU.extracted.komoditas || regU.extracted.luasLahan || regU.extracted.kabupaten || regU.extracted.alamat || regU.extracted.noHp);
      const erpish = /stok|kios|gudang|jual|beli|\bkas\b|catat(?!\s+(hasil\s+)?panen)|hpp|tambah stok|kurang/.test((message || "").toLowerCase()); // P1-23
      if (hasEst && !hasOther && !erpish && /panen|hasil|ton|kuintal|kwintal|\bkg\b/.test((message || "").toLowerCase()) && !needsReasoningMsg(message)) {
        const idM = String(message || "").match(/TANI-\d+/i);
        const target = isAdmin && idM
          ? farmersDb.find((f) => f.id.toUpperCase() === idM[0].toUpperCase())
          : farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(effPhone));
        if (!target) {
          return res.json({
            reply: isAdmin && !idM
              ? `Sebutkan ID petani-nya, mis. "update panen TANI-013 Desember 2026".`
              : "Nomor ini belum terdaftar sebagai petani. Ketik *daftar* untuk mendaftar dulu.",
            quickReplies: isAdmin ? ["📊 Rekap Semua Petani"] : ["Daftarkan Lahan Saya"],
            extracted: currentDraft || {}, isComplete: false, isAdminAction: isAdmin, aiProvider: "rule_based",
          } as any);
        }
        const before = `panen: ${target.estimasiPanen || "-"}, hasil: ${Number(target.estimasiHasilTon) > 0 ? target.estimasiHasilTon + " Ton" : "-"}`;
        if (regU.extracted.estimasiPanen) target.estimasiPanen = regU.extracted.estimasiPanen;
        if (regU.extracted.estimasiHasilTon) target.estimasiHasilTon = Number(regU.extracted.estimasiHasilTon);
        saveFarmersToDisk();
        bumpDataVersion();
        enqueueSheetSync("farmer", target.id);
        // F2: susulan estimasi juga memperkaya baris KMD AKTIF terbaru.
        enrichLatestCommodity(target.id, {
          estimasiPanen: regU.extracted.estimasiPanen,
          estimasiHasilTon: Number(regU.extracted.estimasiHasilTon) || undefined,
        });
        const after = `panen: ${target.estimasiPanen || "-"}, hasil: ${Number(target.estimasiHasilTon) > 0 ? target.estimasiHasilTon + " Ton" : "-"}`;
        return res.json({
          reply: `✅ *Estimasi ${target.nama} (${target.id}) diperbarui.*\n• Sebelum: ${before}\n• Sesudah: ${after}`,
          quickReplies: isAdmin ? ["📊 Rekap Semua Petani"] : ["Cek Harga Pasar Hari Ini"],
          extracted: {}, isComplete: true, isAdminAction: isAdmin, aiProvider: "rule_based",
        } as any);
      }
    }

    // 0a-data. "Lihat Data Saya" (pengganti tombol "Buka Database Google Sheets"
    // yang tak punya handler dan memicu halusinasi LLM).
    if (/^📊?\s*lihat data saya\s*[!.\s]*$/i.test(message || "")) {
      if (isAdmin) {
        const total = farmersDb.length;
        const luas = farmersDb.reduce((s, f) => s + (Number(f.luasLahan) || 0), 0);
        const unver = farmersDb.filter((f) => f.statusVerifikasi !== "Terverifikasi").length;
        return res.json({
          reply: `📊 *Rekap Database Petani*\n• Total: *${total} petani*\n• Luas: *${luas.toFixed(1)} Ha*\n• Belum verifikasi: *${unver} petani*\n\nKetik "rekap semua petani" untuk detail, atau buka tab Dashboard.`,
          quickReplies: ["📊 Rekap Semua Petani", "Daftarkan Petani"],
          extracted: {}, isComplete: false, isAdminAction: true, aiProvider: "rule_based",
        });
      }
      const me = resolveChatFarmer(effPhone, message);
      if (!me) {
        return res.json({
          reply: "Nomor ini belum terdaftar sebagai petani. Ketik *daftar* untuk mendaftarkan lahan Anda.",
          quickReplies: ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
          extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based",
        });
      }
      return res.json({
        reply: `🌾 *Data ${me.nama}* (${me.id}):\n• Komoditas: ${me.komoditas}${me.varietas ? ` (${me.varietas})` : ""}\n• Luas: ${me.luasLahanFormatted}\n• Lokasi: ${me.kabupaten || me.alamat}\n• Panen: ${me.estimasiPanen || "Belum diisi"}${Number(me.estimasiHasilTon) > 0 ? ` (~${me.estimasiHasilTon} Ton)` : ""}\n• Verifikasi: ${me.statusVerifikasi}`,
        quickReplies: ["Cek Harga Pasar Hari Ini", "Konsultasi Hama Tanaman"],
        extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based",
      });
    }

    // 0a0. ERP Kas/Stok/HPP intent (deterministik, semua provider AI). Regex dulu
    // (0ms), Laya saat regex miss, draf terbuka untuk jawaban lanjutan. Dieksekusi
    // via fungsi tulis bersama. Diprioritaskan sebelum supplier agar ujaran stok
    // ("urea keluar ... kios ...") tidak dimakan alur pendaftaran kios.
    {
      const erpLower = (message || "").toLowerCase();
      if (/contoh format/i.test(message || "")) {
        return res.json({
          reply: `📝 *Contoh Format Kas/Stok/HPP:*\n\n• Kas masuk: "kas masuk 500000 panen padi"\n• Kas keluar: "kas keluar 150000 beli urea"\n• Stok: "stok urea keluar 50 kg kios tani makmur"\n• HPP: "hitung hpp padi 2 hektar"\n• Saldo: "lihat saldo kas" / "cek sisa stok urea"`,
          quickReplies: ["Catat Kas", "Catat Stok", "Hitung HPP"],
          isComplete: true,
          aiProvider: "rule_based",
        });
      }
      const erpWriteWords = /catat|masuk|keluar|tambah|input|simpan|hitung|keluarkan|masukkan/;
      const erpReadCash = /saldo|cek kas|lihat kas|sisa kas|posisi kas/.test(erpLower) && !erpWriteWords.test(erpLower); // P1-22
      const erpReadStock = /sisa stok|cek stok|stok tersedia|stok saat ini|stok saya|lihat stok|stok berapa|berapa stok|posisi stok/.test(erpLower) && !erpWriteWords.test(erpLower); // P1-12
      if (erpReadCash || erpReadStock) {
        const erpScope = resolveErpScope(effPhone);
        if (erpReadCash) {
          // P1-21: utang/piutang belum punya ledger terpisah — jangan sajikan saldo kas.
          if (/utang|hutang|piutang|pinjam/.test(erpLower)) {
            return res.json({
              reply: `💰 *Saldo utang/piutang belum tercatat terpisah.*\nKas hAI Tani saat ini mencatat arus masuk/keluar saja. Ketik *"cek kas"* untuk saldo kas.`,
              quickReplies: ["Lihat Saldo Kas", "Catat Kas"],
              isComplete: true,
              aiProvider: "rule_based",
            });
          }
          const rows = erpScope.isAdmin || !erpScope.farmerId ? cashDb : cashDb.filter((c) => c.farmerId === erpScope.farmerId);
          const s = cashSaldo(rows);
          return res.json({
            reply: `💰 *Saldo Kas${erpScope.isAdmin ? " (Semua Petani)" : ""}: Rp ${s.saldo.toLocaleString("id-ID")}*\n• Masuk: Rp ${s.masuk.toLocaleString("id-ID")}\n• Keluar: Rp ${s.keluar.toLocaleString("id-ID")}`,
            quickReplies: ["Catat Kas", "Cek Sisa Stok", "Hitung HPP"],
            isComplete: true,
            aiProvider: "rule_based",
          });
        }
        if (erpScope.isAdmin) {
          const linesAdmin: string[] = [];
          for (const sp of suppliersDb.slice(0, 8)) {
            for (const it of stockSaldo(sp.id).filter((x) => x.saldo !== 0).slice(0, 3)) {
              linesAdmin.push(`• ${it.produk}: ${it.saldo} ${it.satuan} (${sp.nama})`);
              if (linesAdmin.length >= 8) break;
            }
            if (linesAdmin.length >= 8) break;
          }
          return res.json({
            reply: linesAdmin.length > 0 ? `📦 *Sisa Stok Kios:*\n${linesAdmin.join("\n")}` : `📦 Belum ada stok tercatat di kios mana pun.`,
            quickReplies: ["Catat Stok", "Lihat Saldo Kas"],
            isComplete: true,
            aiProvider: "rule_based",
          });
        }
        if (!erpScope.supplierId) {
          return res.json({
            reply: `📦 Stok tercatat per kios/supplier. Nomor ini belum terhubung ke data kios — hubungi admin atau sebutkan nama kiosnya.`,
            quickReplies: ["Catat Stok", "🏢 Tambah Supplier"],
            isComplete: true,
            aiProvider: "rule_based",
          });
        }
        const items = stockSaldo(erpScope.supplierId).filter((x) => x.saldo !== 0);
        return res.json({
          reply: items.length > 0 ? `📦 *Sisa Stok:*\n${items.map((it) => `• ${it.produk}: ${it.saldo} ${it.satuan}`).join("\n")}` : `📦 Belum ada stok tercatat untuk kios Anda.`,
          quickReplies: ["Catat Stok", "Lihat Saldo Kas"],
          isComplete: true,
          aiProvider: "rule_based",
        });
      }
      // Lazy-benar: regex dulu (0ms); sidecar hanya saat regex miss.
      let erpIntent = detectErpIntent(erpLower, null);
      let layaErp: { intent: string; confidence: number } | null | undefined = null;
      if (!erpIntent) {
        layaErp = await chatLaya();
        erpIntent = detectErpIntent(erpLower, layaErp);
      }
      const cashDraftIn = (currentCashDraft || {}) as Partial<CashTransaction>;
      const stockDraftIn = (currentStockDraft || {}) as Partial<StockMutation>;
      const hppDraftIn = (currentHppDraft || {}) as HppChatDraft;
      const draftScore = (d: any, keys: string[]) =>
        keys.filter((k) => d && d[k] !== undefined && d[k] !== null && d[k] !== "").length;
      const draftScores: Array<{ kind: "cash" | "stock" | "hpp"; n: number }> = [
        { kind: "cash" as "cash", n: draftScore(cashDraftIn, ["jenis", "kategori", "jumlahRp", "komoditas", "farmerId"]) },
        { kind: "stock" as "stock", n: draftScore(stockDraftIn, ["produk", "satuan", "arah", "qty", "supplierId"]) },
        { kind: "hpp" as "hpp", n: draftScore(hppDraftIn, ["komoditas", "musimTanam", "volumePanenKg", "hargaJualPerKg", "farmerId"]) },
      ].sort((a, b) => b.n - a.n);
      if (!erpIntent && draftScores[0].n > 0) {
        const otherIntent =
          (layaErp && (layaErp.confidence || 0) >= 0.5 &&
            ["daftar_lahan", "supplier", "cek_harga", "hama_pupuk"].includes(layaErp.intent)) ||
          /daftar lahan|tambah (lahan|tani|kios|supplier)|supplier baru|berapa harga|harga .*(hari ini|sekarang|pasar)|cek harga|hama|penyakit|konsultasi|rekap|ringkas|ekspor|peta|webhook/.test(erpLower);
        if (!otherIntent) erpIntent = draftScores[0].kind;
      }
      // P0-6: "catat supplier baru Kios Tani ..." = pendaftaran -> lolos ke 0s.
      // Gerakan stok ("urea keluar 5 sak ... kios ...") tetap milik ERP.
      if (/supplier|suplier|distributor|agen\b/.test(erpLower) && /catat|tambah|daftar|baru|didaftar/.test(erpLower) && !/\b(masuk|keluar)\b/.test(erpLower) && !ERP_QTY_UNIT_RE.test(erpLower)) erpIntent = null;
      if (/^\s*batal/i.test(message || "") && (draftScores[0].n > 0 || erpIntent)) {
        return res.json({
          reply: "Baik, draf kas/stok/HPP dibatalkan. Silakan mulai lagi bila perlu.",
          quickReplies: ["Catat Kas", "Catat Stok", "Hitung HPP"],
          clearErpDrafts: true, isComplete: true, aiProvider: "rule_based",
        } as any);
      }
      if (erpIntent) {
        const erpRes = await handleErpChat({
          intent: erpIntent,
          message,
          senderPhone: effPhone,
          cashDraft: cashDraftIn,
          stockDraft: stockDraftIn,
          hppDraft: hppDraftIn,
        });
        if (erpRes) return res.json({ ...erpRes, aiProvider: erpRes.aiProvider || "rule_based" } as any);
      }
    }

    // 0s. Agricultural Supplier Registration Flow (Chatbot & Database input)
    const hasSupplierDraft =
      currentSupplierDraft &&
      (currentSupplierDraft.nama ||
        currentSupplierDraft.kategori ||
        currentSupplierDraft.alamat ||
        currentSupplierDraft.kabupaten ||
        currentSupplierDraft.kontak);
    const isSupplierRegex = isSupplierIntent(message);
    let isSupplierMsg = isSupplierRegex;
    // Niat beli/butuh bukan pendaftaran supplier: jangan tanya Laya agar verdict
    // "supplier" tak membajak demand buyer ("saya mau beli agave" -> draf supplier).
    if (!isSupplierMsg && !/\b(butuh|cari|carikan|beli|membeli|perlu|butuhin|nyari|order|pesan)\b/i.test(message || "")) {
      const l = await chatLaya();
      isSupplierMsg = l?.intent === "supplier" && (l?.confidence || 0) >= 0.5;
    }
    const lowerMsg = (message || "").toLowerCase();
    const isAddAction =
      lowerMsg.includes("tambah") ||
      lowerMsg.includes("daftarkan") ||
      lowerMsg.includes("daftar") ||
      lowerMsg.includes("input") ||
      lowerMsg.includes("masukkan") ||
      lowerMsg.includes("catat") ||
      lowerMsg.includes("simpan") ||
      lowerMsg.includes("kios") ||
      lowerMsg.includes("supplier");

    if (/^\s*batal/i.test(message || "") && ((currentSupplierDraft && Object.keys(currentSupplierDraft).length > 0) || isSupplierMsg)) {
      return res.json({
        reply: "Baik, draf pendaftaran supplier dibatalkan. Ketik *tambah supplier* kapan pun untuk memulai lagi.",
        quickReplies: ["🏢 Tambah Supplier", "📊 Rekap Semua Petani"],
        extractedSupplier: {}, isComplete: true, isAdminAction: isAdmin, clearSupplierDraft: true, aiProvider: "rule_based",
      } as any);
    }

    if (isSupplierMsg || (hasSupplierDraft && isAddAction)) {
      const reg = extractSupplierFromText(message, currentSupplierDraft || {});
      const merged = { ...(currentSupplierDraft || {}), ...(reg.extracted || {}) };
      const check = checkSupplierCompleteness(merged);

      if (check.isComplete && (isAddAction || isSupplierMsg)) {
        const saved = saveSupplierRecord(merged, activeAdmin, activeAdmin?.noHp || effPhone, "wa-chat");
        return res.json({
          reply: formatSuccessSupplierRegistration(saved, activeAdmin),
          quickReplies: [
            "🏢 Tambah Supplier Lain",
            "📊 Buka Database Sheets",
            "📍 Lihat di Peta GIS",
            "🌾 Daftarkan Lahan Petani",
          ],
          extractedSupplier: saved,
          savedSupplier: saved,
          entityType: "supplier",
          isComplete: true,
          isAdminAction: isAdmin,
          aiProvider: "rule_based",
        });
      } else {
        const inc = formatIncompleteSupplierPrompt(merged, activeAdmin?.nama, isAdmin);
        return res.json({
          reply: inc.reply,
          quickReplies: inc.quickReplies,
          extractedSupplier: merged,
          entityType: "supplier",
          isComplete: false,
          isAdminAction: isAdmin,
          aiProvider: "rule_based",
        });
      }
    }

    // 0a. Agronomy Fertilizer Calculator query intent (accessible for both Farmers and Admins)
    const fertFarmer = !isAdmin ? farmersDb.find((f) => normalizePhone(f.noHp) === normalizePhone(String(effPhone || senderPhone || ""))) : undefined;
    const fertDraft = fertFarmer ? { komoditas: fertFarmer.komoditas, luasLahan: fertFarmer.luasLahan, ...(currentDraft || {}) } : (currentDraft || {});
    const fertResult = handleAgronomyFertilizerQuery(message, fertDraft);
    if (fertResult) {
      const fertMem = fertFarmer ? `📌 Mengingat lahan Bpk/Ibu *${fertFarmer.nama}* (${fertFarmer.komoditas || "-"}${fertFarmer.luasLahan ? `, ${fertFarmer.luasLahan} Ha` : ""}${fertFarmer.kabupaten ? `, ${fertFarmer.kabupaten}` : ""}).\n\n` : "";
      return res.json({
        reply: fertMem + fertResult.reply,
        quickReplies: fertResult.quickReplies,
        extracted: currentDraft || {},
        isComplete: false,
        aiProvider: "agronomy_engine",
      });
    }

    // 0b. Natural Language Analytics Aggregation query (for admin)
    if (isAdmin) {
      const analyticsResult = handleNaturalLanguageAnalyticsQuery(message, true);
      if (analyticsResult) {
        return res.json({
          reply: analyticsResult.reply,
          quickReplies: analyticsResult.quickReplies,
          extracted: currentDraft || {},
          isComplete: false,
          isAdminAction: true,
          aiProvider: "analytics_engine",
        });
      }
    }

    // 0d. Lanjutan draf pendaftaran: draf terbuka + tanpa intent fungsional baru
    // → gabung + prompt checklist (hemat LLM, anti-lupa antar-pesan WA).
    const draftHasAny = currentDraft && (
      currentDraft.nama || currentDraft.noHp || currentDraft.komoditas ||
      currentDraft.luasLahan || currentDraft.alamat || currentDraft.kabupaten
    );
    if (draftHasAny) {
      if (/^\s*batal/i.test(message || "")) {
        return res.json({
          reply: "Baik, draf pendaftaran petani dibatalkan. Ketik *daftar* kapan pun untuk memulai lagi.",
          quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "Daftarkan Petani"] : ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
          extracted: {}, isComplete: true, isAdminAction: isAdmin, clearFarmerDraft: true, aiProvider: "rule_based",
        } as any);
      }
      // Konfirmasi duplikat (aturan user): nomor sama -> tanya Ya/Tidak dulu.
      const pendingId = (currentDraft as any)?._pendingUpdate;
      if (pendingId) {
        const pendExisting = farmersDb.find((f) => f.id === pendingId);
        const sayYes = /^\s*(ya|iya|iyaa+|y|oke|ok|okay|siap|setuju|update|baik|deal)\s*[!.\s]*$/i.test(message || "") || /^\s*ya,?\s*(update|perbarui|ganti)\b/i.test(message || "");
        const sayNo = /tidak|nggak|ngga|enggak|gak\b|jangan|tunda|nanti|ora\b|batal/i.test(message || "");
        if (sayYes && pendExisting) {
          const { _pendingUpdate, ...restPending } = currentDraft || {};
          const rec = saveFarmerRecord(restPending, isAdmin ? activeAdmin : undefined, effPhone);
          return res.json({
            reply: formatSuccessFarmerRegistration(rec, isAdmin ? activeAdmin : undefined) + `\n\n_Data ${pendExisting.id} diperbarui sesuai jawaban._`,
            quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "Daftarkan Petani"] : ["Cek Harga Pasar Hari Ini", "Daftarkan Lahan Lain"],
            extracted: {}, isComplete: true, savedRecord: rec, isAdminAction: isAdmin, clearFarmerDraft: true, aiProvider: "rule_based",
          } as any);
        }
        if (sayNo || !pendExisting) {
          return res.json({
            reply: pendExisting
              ? "Baik, data baru dibatalkan. Data lama tetap utuh.\n_Bila ini orang berbeda, daftarkan dengan nomor HP/WA yang berbeda._"
              : "Data acuan pembanding sudah tidak ada; draf dibatalkan. Ketik *daftar* untuk mengulang.",
            quickReplies: isAdmin ? ["📊 Rekap Semua Petani", "Daftarkan Petani"] : ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
            extracted: {}, isComplete: true, isAdminAction: isAdmin, clearFarmerDraft: true, aiProvider: "rule_based",
          } as any);
        }
        return res.json({
          reply: formatDuplicateAskPrompt(pendExisting, currentDraft) + `\n\n_Balas Ya/Tidak._`,
          quickReplies: ["Ya, update", "Tidak"],
          extracted: currentDraft, isComplete: false, isAdminAction: isAdmin, aiProvider: "rule_based",
        } as any);
      }
      const lwr = (message || "").toLowerCase();
      const hasNewIntent =
        detectErpIntent(lwr, null) || isSupplierIntent(message) ||
        (isAdmin && isAnalyticsQuery(lwr)) ||
        /harga|pasar|anomali|hama|penyakit|wereng|ulat|tikus|keong|sundep|blas|kresek|tungro|pupuk|dosis|pemupukan|urea|phonska|npk|takaran/.test(lwr) ||
        !!handleFastSmalltalk(message, isAdmin, activeAdmin, effPhone, true);
      if (!hasNewIntent) {
        const reg = extractFarmerFromText(message, currentDraft || {});
        const merged = { ...(currentDraft || {}), ...(reg.extracted || {}) };
        const check = checkFarmerCompleteness(merged);
        const needFarmerPhone = isAdmin && !merged.noHp;
        if (check.isComplete && !needFarmerPhone) {
          const dup0d = findDuplicateFarmerByPhone(merged, isAdmin ? activeAdmin : undefined, effPhone);
          if (dup0d) {
            return res.json({
              reply: formatDuplicateAskPrompt(dup0d, merged),
              quickReplies: ["Ya, update", "Tidak"],
              extracted: { ...merged, _pendingUpdate: dup0d.id }, isComplete: false, isAdminAction: isAdmin, aiProvider: "rule_based",
            } as any);
          }
          const rec = saveFarmerRecord(merged, isAdmin ? activeAdmin : undefined, effPhone);
          return res.json({
            reply: formatSuccessFarmerRegistration(rec),
            extracted: rec, isComplete: true, savedRecord: rec, isAdminAction: isAdmin, aiProvider: "rule_based",
            quickReplies: isAdmin
              ? ["📊 Rekap Semua Petani", "Verifikasi Semua", "Daftarkan Lagi"]
              : ["Cek Harga Cabai Hari Ini", "Konsultasi Hama Tanaman", "Daftarkan Lahan Lain"],
          } as any);
        }
        const inc: any = formatIncompleteFarmerPrompt(merged, activeAdmin?.nama, isAdmin);
        if (needFarmerPhone) {
          inc.reply += "\n\n➕ *Admin: cantumkan juga No HP/WA petani* (misal: 0812xxxxxxx).";
        }
        return res.json({ ...inc, isAdminAction: isAdmin, aiProvider: "rule_based" } as any);
      }
    }

    // 0c. Smart Query Cache Lookup (Pillar 3: Reusing Existing Results)
    const cacheKey = getNormalizedCacheKey(isAdmin ? "admin" : "farmer", message);
    const isCacheable = isQuerySafeToCache(message);

    if (isCacheable && aiResponseCache.has(cacheKey)) {
      const cached = aiResponseCache.get(cacheKey)!;
      if (cached.dataVersion === currentDataVersion && Date.now() - cached.timestamp < 7200000) {
        totalCacheHits++;
        totalTokensSavedEstimate += 650;
        console.log(`[AI Cache Hit] ⚡ Menggunakan hasil cache untuk: "${(message || "").substring(0, 30)}..." (0 token digunakan, hemat biaya 100%).`);
        return res.json({
          reply: unwrapNestedReply(cached.reply),
          quickReplies: cached.quickReplies,
          extracted: currentDraft || {},
          isComplete: false,
          isAdminAction: cached.isAdminAction,
          aiProvider: "cache",
          fromCache: true,
          cachedAt: new Date(cached.timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
          tokensUsed: 0,
        });
      }
    }

    // RULE-BASED SECURITY CHECK FOR NON-ADMIN NUMBERS
    if (!isAdmin) {
      const lower = (message || "").toLowerCase();
      const isAddAction =
        lower.includes("tambah") ||
        lower.includes("daftarkan") ||
        lower.includes("daftar") ||
        lower.includes("input") ||
        lower.includes("masukkan") ||
        lower.includes("catat") ||
        lower.includes("simpan");

      // Only check forbidden data-leak keywords if the user is NOT registering / adding data
      if (!isAddAction) {
        const forbiddenAdminKeywords = [
          "rekap semua",
          "rekap data",
          "semua data",
          "seluruh data",
          "minta semua",
          "minta data petani",
          "daftar semua petani",
          "seluruh petani",
          "semua petani",
          "nomor hp petani lain",
          "kontak semua petani",
          "telepon petani lain",
          "buka database dinas",
          "unduh semua data",
          "ekspor database",
          "download database",
        ];

        const isAttemptingAdminAction = forbiddenAdminKeywords.some((keyword) => lower.includes(keyword));

        if (isAttemptingAdminAction) {
          const maskedPhone = effPhone ? effPhone : "nomor Anda";
          return res.json({
            reply: `🔒 *Akses Dibatasi - Perlindungan Privasi Data Petani*\n\nMohon maaf Bpk/Ibu, nomor Anda (*${maskedPhone}*) terdeteksi sebagai *Petani Mitra* (bukan nomor admin resmi).\n\nDemi menjaga kerahasiaan data lahan dan kontak kelompok tani, fitur rekapitulasi database, daftar kontak petani lain, serta penarikan data administratif *hanya dapat diakses oleh Nomor Admin & Petugas PPL Terdaftar* (Dinas Ketahanan Pangan & Pertanian).\n\n💡 *Layanan WhatsApp yang dapat Bapak/Ibu nikmati:* \n1. 🌾 *Daftarkan Lahan Anda* (masuk otomatis ke database Google Sheets resmi)\n2. 📈 *Cek Harga Pasar Terkini* & anomali harga komoditas\n3. 💡 *Konsultasi Hama & Pemupukan*\n4. 📋 *Cek Status Pendaftaran Lahan Sendiri*`,
            extracted: currentDraft || {},
            isComplete: false,
            isRestricted: true,
            quickReplies: [
              "Daftarkan Lahan Saya",
              "Cek Harga Pasar Hari Ini",
              "Konsultasi Hama Tanaman",
              "Cek Anomali Harga Cabai",
            ],
          });
        }
      }
    }

    // IF SENDER IS ADMIN: Build Executive Agricultural Intelligence AI Assistant with Lean Targeted Context
    if (isAdmin) {
      // Harga pasar live LANGSUNG (sebelum AI): budget chat forwarder <=8 dtk,
      // percobaan AI yang gagal (Meta kosong -> 9Router -> fallback) menghabiskan
      // budget sehingga balasan WA tidak terkirim sama sekali.
      const lowerAdminMsgTop = (message || "").toLowerCase();
      const hasHargaWordTop = /harga|anomali|inflasi/.test(lowerAdminMsgTop);
      const hasPasarPriceTop =
        /pasar/.test(lowerAdminMsgTop) &&
        (/berapa/.test(lowerAdminMsgTop) || HARGA_ALIAS.some((a) => a.keys.some((k) => hargaKeyHit(lowerAdminMsgTop, k))));
      if (
        (hasHargaWordTop || hasPasarPriceTop) &&
        (!/daftar|tambah|input|catat|simpan|masukkan/.test(lowerAdminMsgTop) || /daftar harga/.test(lowerAdminMsgTop)) // P0-2
      ) {
        const liveReplyTop = await formatHargaPasarReply(message);
        return res.json({
          reply: liveReplyTop,
          extracted: {},
          isComplete: false,
          isAdminAction: true,
          aiProvider: "rule_based",
          quickReplies: ["🌶️ Detail Petani Cabai", "🧅 Detail Petani Bawang", "📊 Rekap Semua Petani", "📥 Ekspor Sheets"],
        });
      }
      if (isAdmin && /verifikasi semua/i.test(message || "")) {
        const pending = farmersDb.filter((f) => f.statusVerifikasi !== "Terverifikasi");
        for (const f of pending) f.statusVerifikasi = "Terverifikasi";
        if (pending.length > 0) saveFarmersToDisk();
        return res.json({
          reply: pending.length === 0
            ? `🟢 Semua ${farmersDb.length} petani sudah terverifikasi.`
            : `✅ *${pending.length} petani berhasil diverifikasi:*\n${pending.map((f) => `• ${f.nama} (${f.id})`).join("\n")}`,
          quickReplies: ["📊 Rekap Semua Petani", "⚠️ Cek Belum Verifikasi"],
          extracted: {}, isComplete: true, isAdminAction: true, aiProvider: "rule_based",
        });
      }
      const leanContext = buildLeanTargetedContext(message, true);

      const adminSystemInstructions = `Anda adalah "Kang Tani AI - Executive Agricultural Intelligence Assistant", asisten AI resmi untuk dinas pertanian dan petugas PPL.

IDENTITAS ADMIN:
- Nama: ${activeAdmin.nama} (${activeAdmin.role}, ${activeAdmin.instansi})

${leanContext.summary}

${leanContext.targetedDetails ? `${leanContext.targetedDetails}\n` : ""}
${leanContext.marketHighlight ? `${leanContext.marketHighlight}\n` : ""}

BATASAN & ATURAN PANJANG JAWABAN (HEMAT TOKEN):
1. Jawab secara ringkas, to the point, padat informasi (maksimal 2-3 paragraf pendek atau poin WhatsApp).
2. Jika admin mencari petani atau komoditas tertentu, jelaskan data spesifik yang diminta tanpa membeberkan seluruh database.
3. Jika admin meminta draft pesan broadcast WhatsApp, berikan teks siap kirim yang bernas.
4. JANGAN sebut angka harga/Rp spesifik dari konteks (data pasar di konteks bisa basi); untuk info harga, arahkan admin bertanya "cek harga <komoditas>" agar diambil live dari SISKAPERBAPO.
5. Jika tidak mengetahui jawabannya, jawab jujur persis: "Maaf, saya belum mengetahui hal ini. Terima kasih, ini akan menjadi bahan pengembangan Hai Tani." — jangan mengarang.
6. Format output JSON WAJIB:
{
  "reply": "Pesan balasan profesional untuk Admin dalam format WhatsApp (*bold*, bullet points, emojis)",
  "quickReplies": ["3 tombol aksi cepat yang relevan"],
  "isAdminAction": true
}`;

      let aiResult: { text: string; provider: "9router" | "gemini" | "meta" | "nim"; model: string } | null = null;
      try {
        const regPre = extractFarmerFromText(message, currentDraft || {});
        if (isDeterministicFarmerData(message, !!regPre.hasMinimumData)) {
          console.log("[Admin Chat] bypass LLM: data/pendaftaran petani -> deterministik.");
        } else if (!sessAdm && fwdOk && waOutboundConfig().token) {
          // F5: WA berpacu — ack <8 dtk, jawaban asli susulan langsung.
          const p = callUniversalAI(adminSystemInstructions, message, history, { maxOutputTokens: 550, timeoutMs: ACK_BG_CAP_MS });
          // Deadline ack dihitung dari request masuk (chatT0), bukan dari titik
          // race — kerja pra-race (konteks/parsing) tak boleh mendorong ack
          // lewat budget 8dtk forwarder.
          const ackWaitMs = Math.max(500, ACK_AFTER_MS - (Date.now() - chatT0));
          if (Date.now() - chatT0 > 1500) console.log(`[Ack] pra-race lambat ${Date.now() - chatT0}ms :: ${String(message || "").slice(0, 60)}`);
          const w = await Promise.race([
            p.then(
              (v) => ({ tag: "fast" as const, v }),
              (e) => ({ tag: "err" as const, e }),
            ),
            sleepMs(ackWaitMs).then(() => ({ tag: "ack" as const })),
          ]);
          if (w.tag === "fast") {
            aiResult = w.v;
          } else if (w.tag === "ack") {
            console.log(`[Ack] admin ${maskPhone(effPhone || senderPhone)} >${ACK_AFTER_MS}ms -> ack + susulan`);
            emitCanonicalEvent({ source: "wa-chat", entity: "ack", entityId: `ack-${Date.now().toString(36)}`, action: "ack", actor: effPhone || senderPhone, payload: { kind: "admin" } });
            deliverAckFollowup("admin", String(effPhone || senderPhone || ""), String(message || ""), p);
            return res.json({
              reply: ACK_TEXT,
              quickReplies: ["📊 Rekapitulasi Lengkap", "Bantuan"],
              extracted: currentDraft || {},
              isComplete: true,
              isAdminAction: true,
              aiProvider: "ack_pending",
              ackPending: true,
            } as any);
          } else {
            throw w.e;
          }
        } else {
          aiResult = await callUniversalAI(
            adminSystemInstructions,
            message,
            history,
            { signal: clientAbortController.signal, maxOutputTokens: 550, timeoutMs: 7000 }
          );
        }
      } catch (err: any) {
        if (isClientAborted || clientAbortController.signal.aborted) {
          console.log("[Admin Chat] AI dibatalkan oleh pengguna (hemat biaya).");
          if (!res.headersSent) {
            return res.status(499).json({ error: "Permintaan dibatalkan oleh pengguna (hemat token)." });
          }
          return;
        }
        console.log("[Admin Chat] AI provider error, using smart fallback:", err?.message);
      }

      if (aiResult) {
        try {
          const responseText = stripCodeFences(aiResult.text);
          let parsed: any;
          try {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
          } catch {
            parsed = {
              reply: responseText,
              quickReplies: ["📊 Rekapitulasi Lengkap", "🌶️ Analisis Harga Cabai", "📥 Unduh Spreadsheet"],
              isAdminAction: true,
            };
          }

          if (typeof parsed.reply === "string" && parsed.reply.trim().startsWith("{")) {
            try {
              const inner = JSON.parse(parsed.reply.trim());
              if (inner.reply) parsed = { ...parsed, ...inner };
            } catch {
              parsed.reply = unwrapNestedReply(parsed.reply);
            }
          }
          if (typeof parsed.reply !== "string" || !parsed.reply.trim()) {
            throw new Error("LLM balasan kosong");
          }

          parsed.aiProvider = aiResult.provider;
          parsed.aiModel = aiResult.model;

          const lowerAdminMsg = (message || "").toLowerCase();
          const isAddRequest = isAddRegex(lowerAdminMsg);

          const reg = extractFarmerFromText(message, currentDraft || {});
          const merged = { ...(currentDraft || {}), ...scrubUnmentionedEstimates(parsed.extracted, message), ...(reg.extracted || {}) };
          const check = checkFarmerCompleteness(merged);

          // Tolak isComplete palsu: klaim lengkap tanpa satu pun field terisi = abaikan.
          const mergedHasAnyField = !!(merged.nama || merged.noHp || merged.komoditas || merged.luasLahan || merged.alamat || merged.kabupaten);
          // Jaring pengaman: data petani yang lolos ke LLM (mis. dibalut pertanyaan)
          // tetap digabung ke draf; templat draf hanya dipaksa bila tak perlu nalar.
          const regHasAny = !!reg.hasMinimumData;
          const wantsReasoning = needsReasoningMsg(message);
          if ((isAddRequest || regHasAny) && !wantsReasoning || (parsed.isComplete && mergedHasAnyField)) {
            const needFarmerPhone = !merged.noHp;
            if (check.isComplete && !needFarmerPhone) {
              const dupAdmLlm = findDuplicateFarmerByPhone(merged, activeAdmin, activeAdmin.noHp);
              if (dupAdmLlm) {
                parsed.reply = formatDuplicateAskPrompt(dupAdmLlm, merged);
                parsed.quickReplies = ["Ya, update", "Tidak"];
                parsed.extracted = { ...merged, _pendingUpdate: dupAdmLlm.id };
                parsed.isComplete = false;
                delete parsed.savedRecord;
              } else {
                const newRecord = saveFarmerRecord(merged, activeAdmin, activeAdmin.noHp);
                parsed.savedRecord = newRecord;
                parsed.extracted = newRecord;
                parsed.isComplete = true;
                parsed.reply = formatSuccessFarmerRegistration(newRecord, activeAdmin);
              }
            } else {
              // INCOMPLETE: DO NOT save to database! Ask for missing fields politely
              const incomplete = formatIncompleteFarmerPrompt(merged, activeAdmin.nama, true);
              if (!merged.noHp) incomplete.reply += "\n\n➕ *Admin: cantumkan juga No HP/WA petani* (misal: 0812xxxxxxx).";
              parsed.reply = incomplete.reply;
              parsed.quickReplies = incomplete.quickReplies;
              parsed.extracted = merged;
              parsed.isComplete = false;
              delete parsed.savedRecord;
            }
          } else {
            // Data + pertanyaan: jawaban LLM dipertahankan, draf ditempel (tak disimpan).
            parsed.extracted = (isAddRequest || regHasAny) ? merged : {};
            parsed.isComplete = false;
          }

          parsed.isAdminAction = true;
          if (!parsed.quickReplies || !Array.isArray(parsed.quickReplies) || parsed.quickReplies.length === 0) {
            parsed.quickReplies = ["📊 Rekap Semua Petani", "🌶️ Analisis Anomali Cabai", "📥 Siapkan Ekspor Sheets"];
          }

          // Cache non-mutating AI reply for future reuse (Pillar 3)
          if (isCacheable && parsed?.reply && !parsed?.isComplete && isCacheWorthyReply(parsed.reply)) {
            aiResponseCache.set(cacheKey, {
              reply: parsed.reply,
              quickReplies: parsed.quickReplies,
              isAdminAction: true,
              timestamp: Date.now(),
              dataVersion: currentDataVersion,
              provider: "cache",
            });
          }

          return res.json(parsed);
        } catch (err: any) {
          console.log("[Admin Chat] Parsing fallback triggered:", err?.message);
        }
      }

      // Smart Dynamic Fallback for Admin
      const smartFallback = generateSmartAdminFallback(message, activeAdmin, farmersDb, commoditiesDb, currentDraft);
      return res.json({ ...smartFallback, aiProvider: "rule_based" });
    }

    // GENERAL CONVERSATION (Petani Biasa / Non-Admin) with Lean Targeted Context
    if (/status lahan( saya|ku)?\b/i.test(message || "") && !/daftar|tambah|input|catat|simpan/.test((message || "").toLowerCase())) {
      const me = resolveChatFarmer(effPhone, message);
      if (!me) {
        return res.json({
          reply: `Nomor ini belum terdaftar sebagai petani. Ketik *daftar* untuk mendaftarkan lahan Anda.`,
          quickReplies: ["Daftarkan Lahan Saya", "Cek Harga Pasar Hari Ini"],
          extracted: {}, isComplete: false, isAdminAction: false, aiProvider: "rule_based",
        });
      }
      return res.json({
        reply: `🌾 *Status Lahan ${me.nama}* (${me.id}):\n• Komoditas: ${me.komoditas}\n• Luas: ${me.luasLahanFormatted}\n• Lokasi: ${me.kabupaten || me.alamat}\n• Verifikasi: ${me.statusVerifikasi}`,
        quickReplies: ["Cek Harga Pasar Hari Ini", "Konsultasi Hama Tanaman"],
        extracted: {}, isComplete: true, isAdminAction: false, aiProvider: "rule_based",
      });
    }
    const leanContext = buildLeanTargetedContext(message, false);
    const layaDetected = ai ? await chatLaya() : null; // rule path (ai null) tak butuh fetch ~1 dtk

    const systemInstructions = `Anda adalah "Kang Tani AI", asisten digital cerdas, sopan, dan hangat di WhatsApp untuk petani Indonesia.

${layaDetected && layaDetected.confidence >= 0.5 ? `[KLASIFIKASI INTENT LAYA]: Maksud petani terdeteksi = "${layaDetected.intent}" (Confidence: ${(layaDetected.confidence * 100).toFixed(0)}%). Prioritaskan fokus pada topik ini.\n` : ""}${leanContext.summary}
${leanContext.targetedDetails ? `${leanContext.targetedDetails}\n` : ""}
${leanContext.marketHighlight ? `${leanContext.marketHighlight}\n` : ""}
${currentDraft && Object.keys(currentDraft).length > 0 ? `DRAFT DATA TERKUMPUL: ${JSON.stringify(currentDraft)}` : ""}

BATASAN & ATURAN PANJANG JAWABAN (HEMAT TOKEN):
1. Jawab ramah dan ringkas (maksimal 2 paragraf singkat WhatsApp; jawaban obat/hama memakai format aturan 5).
2. Langsung berikan solusi teknis tanpa bertele-tele.
3. Jika petani mendaftarkan lahan, gali data yang belum ada: Nama, No WA, Alamat, Luas Lahan (Ha), Komoditas, Estimasi Panen.
4. JANGAN sebut angka harga/Rp spesifik dari konteks (data pasar di konteks bisa basi); arahkan petani bertanya "cek harga <komoditas>" agar diambil live dari SISKAPERBAPO.
5. REKOMENDASI OBAT/HAMA (format wajib): bila menyarankan pestisida/obat, SELALU dahulukan ALASAN sebelum nama produk, dengan TIGA subjudul persis ini SEBAGAI TEKS BIASA di dalam field "reply" (satu pesan WhatsApp utuh — JANGAN sebagai field JSON terpisah, JANGAN berhenti setelah kalimat pembuka): *Diagnosis:* (gejala->penyebab singkat); *Kenapa obat ini?* (bahan aktif + cara kerja + dosis anjuran label + kenapa cocok untuk kasus spesifik ini); *Rekomendasi:* (nama produk + cara pakai singkat). JANGAN sebut/mengarahkan ke toko tertentu. Bila tidak yakin diagnosisnya, katakan terus terang dan minta foto gejala atau detail tambahan.
6. Jika tidak mengetahui jawabannya, jawab jujur persis: "Maaf, saya belum mengetahui hal ini. Terima kasih, ini akan menjadi bahan pengembangan Hai Tani." — jangan mengarang.
7. Format output JSON:
{
  "reply": "Pesan balasan ramah & padat gaya WhatsApp (*bold*, emoji)",
  "extracted": {
    "nama": "nama jika ada / null",
    "noHp": "nomor wa jika ada / null",
    "alamat": "desa & kecamatan jika ada / null",
    "kabupaten": "kabupaten jika ada / null",
    "luasLahan": 1.5,
    "luasLahanFormatted": "1.5 Ha",
    "komoditas": "komoditas jika ada / null",
    "varietas": "varietas jika ada / null",
    "estimasiPanen": "Bulan Tahun jika ada / null",
    "estimasiHasilTon": 9.5
  },
  "isComplete": true (hanya jika data pokok lengkap),
  "quickReplies": ["2-3 opsi cepat"]
}`;

    if (!ai) {
      // Intelligent rule-based fallback if API key is not yet set
      const lower = (message || "").toLowerCase();
      const regexAdd = isAddRegex(lower);
      // Lazy laya: hanya fetch saat regex miss (0ms saat regex hit).
      let laya: { intent: string; confidence: number } | null = null;
      if (!regexAdd) laya = await chatLaya();
      const isAddIntent = regexAdd || (laya?.intent === "daftar_lahan" && (laya?.confidence || 0) >= 0.5);
      const isPriceIntent =
        lower.includes("harga") ||
        lower.includes("pasar") ||
        lower.includes("anomali") ||
        (laya?.intent === "cek_harga" && (laya?.confidence || 0) >= 0.5);
      const isHamaIntent = laya?.intent === "hama_pupuk" && (laya?.confidence || 0) >= 0.5;

      const reg = extractFarmerFromText(message, currentDraft || {});
      let extracted: Partial<FarmerRecord> = { ...(currentDraft || {}), ...reg.extracted };
      const check = checkFarmerCompleteness(extracted);

      // If user asks to add or provides farmer registration details
      if (isAddIntent) {
        if (check.isComplete) {
          const dupNai = findDuplicateFarmerByPhone(extracted, undefined, effPhone);
          if (dupNai) {
            return res.json({
              reply: formatDuplicateAskPrompt(dupNai, extracted),
              quickReplies: ["Ya, update", "Tidak"],
              extracted: { ...extracted, _pendingUpdate: dupNai.id }, isComplete: false, isAdminAction: false, aiProvider: "rule_based",
            } as any);
          }
          const newRecord = saveFarmerRecord(extracted, undefined, effPhone);
          return res.json({
            reply: formatSuccessFarmerRegistration(newRecord),
            extracted: newRecord,
            isComplete: true,
            savedRecord: newRecord,
            quickReplies: [
              "Cek Harga Cabai Hari Ini",
              "Konsultasi Hama Tanaman",
              "Buka Database Google Sheets",
              "Daftarkan Lahan Lain",
            ],
          });
        } else {
          // Data is not complete yet: DO NOT save to database! Prompt for missing fields.
          const incomplete = formatIncompleteFarmerPrompt(extracted, undefined, false);
          return res.json(incomplete);
        }
      }

      let replyText =
        "🌾 *Salam Berkah Petani!* Saya Kang Tani AI, asisten digital siap melayani konsultasi pertanian dan pendaftaran lahan ke Google Sheets. Boleh tahu nama Bapak/Ibu, luas lahan, dan komoditas apa yang sedang ditanam?";

      if (isPriceIntent) {
        replyText = await formatHargaPasarReply(message);
      } else if (isHamaIntent) {
        replyText = `🌱 *Konsultasi Hama & Pupuk siap!* Ceritakan gejala di lahan (misal: daun menguning, wereng, ulat) + komoditas + luas lahan, nanti Kang Tani kasih takaran dan jadwal aplikasi.`;
      } else if (lower.includes("padi") || lower.includes("cabai") || lower.includes("bawang") || lower.includes("jagung")) {
        const crop = lower.includes("cabai")
          ? "Cabai Rawit Merah"
          : lower.includes("bawang")
          ? "Bawang Merah"
          : lower.includes("jagung")
          ? "Jagung"
          : "Padi";
        extracted.komoditas = crop;
        replyText = `Matur nuwun infonya Pak/Bu! Senang mendengar Bapak/Ibu menanam *${crop}*. Berapa luasan lahan yang ditanam saat ini (misal: 1 Ha atau 5.000 m²), dan di desa/kabupaten mana lokasinya?`;
      } else if (lower.includes("ha") || lower.includes("hektar") || lower.includes("m2") || lower.includes("meter")) {
        const num = parseFloat(lower.match(/\d+(\.\d+)?/)?.[0] || "1.0");
        extracted.luasLahan = num;
        extracted.luasLahanFormatted = `${num} Ha (${num * 10000} m²)`;
        extracted.estimasiHasilTon = Number((num * 6.5).toFixed(1));
        replyText = `Data luasan *${extracted.luasLahanFormatted}* sudah Kang Tani catat. Kapan estimasi panennya (misal: November 2026)? Dan atas nama siapa kami catatkan ke Google Sheets?`;
      } else if (lower.includes("nama") || lower.includes("saya pak") || lower.includes("saya bu")) {
        extracted.nama = message.replace(/(halo|nama saya|saya|pak|bu)/gi, "").trim() || "Pak Petani";
        replyText = `Salam kenal *${extracted.nama}*! Data sementara sudah dicatat. Komoditas apa yang ditanam dan berapa luasan lahannya agar dapat kami verifikasi ke Google Sheets?`;
      }

      return res.json({
        reply: replyText,
        extracted,
        isComplete: false,
        quickReplies: [
          "Cek Harga Cabai Hari Ini",
          "Daftarkan Luas Lahan",
          "Konsultasi Hama Tanaman",
          "Buka Database Google Sheets",
        ],
      });
    }

    // Harga pasar live LANGSUNG untuk petani (cermin admin): tanpa ini, query
    // harga jatuh ke LLM (~4-9 dtk) dan rawan diabort forwarder (kasus nyata:
    // "Cek harga pasar" -> 499, balasan WA tidak terkirim sama sekali).
    {
      const lowerFarmerMsgTop = (message || "").toLowerCase();
      const hasHargaWordTopF = /harga|anomali|inflasi/.test(lowerFarmerMsgTop);
      const hasPasarPriceTopF =
        /pasar/.test(lowerFarmerMsgTop) &&
        (/berapa/.test(lowerFarmerMsgTop) || HARGA_ALIAS.some((a) => a.keys.some((k) => hargaKeyHit(lowerFarmerMsgTop, k))));
      if (
        (hasHargaWordTopF || hasPasarPriceTopF) &&
        (!/daftar|tambah|input|catat|simpan|masukkan/.test(lowerFarmerMsgTop) || /daftar harga/.test(lowerFarmerMsgTop)) // P0-2
      ) {
        const liveReplyTopF = await formatHargaPasarReply(message);
        return res.json({
          reply: liveReplyTopF,
          extracted: {},
          isComplete: false,
          isAdminAction: false,
          aiProvider: "rule_based",
          quickReplies: ["Cek Harga Cabai Hari Ini", "Konsultasi Hama Tanaman", "Daftarkan Lahan Saya"],
        });
      }
    }

    let aiResult: { text: string; provider: "9router" | "gemini" | "meta" | "nim"; model: string } | null = null;
    try {
      const regPreF = extractFarmerFromText(message, currentDraft || {});
      if (isDeterministicFarmerData(message, !!regPreF.hasMinimumData)) {
        console.log("[Petani Chat] bypass LLM: data/pendaftaran petani -> deterministik.");
      } else if (!sessAdm && fwdOk && waOutboundConfig().token) {
        // F5: WA berpacu — ack <8 dtk, jawaban asli susulan langsung.
        const memSysF = memoryLineFor(getUser(String(effPhone || senderPhone || "")));
        const p = callUniversalAI(memSysF ? systemInstructions + "\n\n" + memSysF : systemInstructions, message, history, { maxOutputTokens: 550, timeoutMs: ACK_BG_CAP_MS });
        // Deadline ack dari request masuk (lihat cabang admin).
        const ackWaitMs = Math.max(500, ACK_AFTER_MS - (Date.now() - chatT0));
        if (Date.now() - chatT0 > 1500) console.log(`[Ack] pra-race lambat ${Date.now() - chatT0}ms :: ${String(message || "").slice(0, 60)}`);
        const w = await Promise.race([
          p.then(
            (v) => ({ tag: "fast" as const, v }),
            (e) => ({ tag: "err" as const, e }),
          ),
          sleepMs(ackWaitMs).then(() => ({ tag: "ack" as const })),
        ]);
        if (w.tag === "fast") {
          aiResult = w.v;
        } else if (w.tag === "ack") {
          console.log(`[Ack] petani ${maskPhone(effPhone || senderPhone)} >${ACK_AFTER_MS}ms -> ack + susulan`);
          emitCanonicalEvent({ source: "wa-chat", entity: "ack", entityId: `ack-${Date.now().toString(36)}`, action: "ack", actor: effPhone || senderPhone, payload: { kind: "petani" } });
          deliverAckFollowup("petani", String(effPhone || senderPhone || ""), String(message || ""), p);
          return res.json({
            reply: ACK_TEXT,
            quickReplies: ["Cek Harga Pasar", "Bantuan"],
            extracted: currentDraft || {},
            isComplete: true,
            isAdminAction: false,
            aiProvider: "ack_pending",
            ackPending: true,
          } as any);
        } else {
          throw w.e;
        }
      } else {
        aiResult = await callUniversalAI(
          systemInstructions,
          message,
          history,
          { signal: clientAbortController.signal, maxOutputTokens: 550, timeoutMs: 7000 }
        );
      }
    } catch (error: any) {
      if (isClientAborted || clientAbortController.signal.aborted) {
        console.log("[Petani Chat] AI dibatalkan oleh pengguna (hemat biaya).");
        if (!res.headersSent) {
          return res.status(499).json({ error: "Permintaan dibatalkan oleh pengguna (hemat token)." });
        }
        return;
      }
      console.log("[Chat Info] Universal AI error, serving rule-based fallback reply:", error?.message || "fallback");
    }

    if (aiResult) {
      try {
        const responseText = stripCodeFences(aiResult.text);
        let parsed: any;
        try {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
        } catch {
          parsed = {
            reply: responseText,
            extracted: {},
            isComplete: false,
            quickReplies: ["Daftarkan Lahan", "Cek Harga Pasar", "Konsultasi Pupuk"],
          };
        }

        // If reply is accidentally stringified JSON, unnest it
        if (typeof parsed.reply === "string" && parsed.reply.trim().startsWith("{")) {
          try {
            const inner = JSON.parse(parsed.reply.trim());
            if (inner.reply) {
              parsed = { ...parsed, ...inner };
            }
          } catch {
            parsed.reply = unwrapNestedReply(parsed.reply);
          }
        }
        if (typeof parsed.reply !== "string" || !parsed.reply.trim()) {
          throw new Error("LLM balasan kosong");
        }

        parsed.aiProvider = aiResult.provider;
        parsed.aiModel = aiResult.model;

        // Merge extracted fields with regex extractor and previous draft
        const reg = extractFarmerFromText(message, currentDraft || {});
        const merged = { ...(currentDraft || {}), ...scrubUnmentionedEstimates(parsed.extracted, message), ...(reg.extracted || {}) };
        parsed.extracted = merged;

        const lowerNonAdmin = (message || "").toLowerCase();
        const isAddRequest = isAddRegex(lowerNonAdmin);

        const check = checkFarmerCompleteness(merged);

        // Only save when ALL required fields are complete!
        // Tolak isComplete palsu: klaim lengkap tanpa satu pun field terisi = abaikan.
        const mergedHasAnyField = !!(merged.nama || merged.noHp || merged.komoditas || merged.luasLahan || merged.alamat || merged.kabupaten);
        // Cermin guard admin: pertanyaan ("manfaat setelah terdaftar?") menyimpan
        // jawaban LLM + draf; templat draf hanya dipaksa bila tak perlu nalar.
        const regHasAnyF = !!reg.hasMinimumData;
        const wantsReasoningF = needsReasoningMsg(message);
        if (((isAddRequest || regHasAnyF) && !wantsReasoningF) || (parsed.isComplete && mergedHasAnyField)) {
          if (check.isComplete) {
            const dupFmLlm = findDuplicateFarmerByPhone(merged, undefined, effPhone);
            if (dupFmLlm) {
              parsed.reply = formatDuplicateAskPrompt(dupFmLlm, merged);
              parsed.quickReplies = ["Ya, update", "Tidak"];
              parsed.extracted = { ...merged, _pendingUpdate: dupFmLlm.id };
              parsed.isComplete = false;
              delete parsed.savedRecord;
            } else {
              const newRecord = saveFarmerRecord(merged, undefined, effPhone);
              parsed.savedRecord = newRecord;
              parsed.extracted = newRecord;
              parsed.isComplete = true;
              parsed.reply = formatSuccessFarmerRegistration(newRecord);
            }
          } else {
            // INCOMPLETE DATA: DO NOT save to database yet! Prompt user to complete the missing fields.
            const incomplete = formatIncompleteFarmerPrompt(merged, undefined, false);
            parsed.reply = incomplete.reply;
            parsed.quickReplies = incomplete.quickReplies;
            parsed.extracted = merged;
            parsed.isComplete = false;
            delete parsed.savedRecord;
          }
        }

        // Cache non-mutating response for future query reuse (Pillar 3)
        if (isCacheable && parsed?.reply && !parsed?.isComplete && !parsed?.savedRecord && isCacheWorthyReply(parsed.reply)) {
          aiResponseCache.set(cacheKey, {
            reply: parsed.reply,
            quickReplies: parsed.quickReplies,
            isAdminAction: false,
            timestamp: Date.now(),
            dataVersion: currentDataVersion,
            provider: "cache",
          });
        }

        return res.json(parsed);
      } catch (err: any) {
        console.log("[Chat Info] Error processing AI response, falling back to rule-based:", err?.message);
      }
    }

    // Rule-based fallback response
    console.log("[Chat Info] Serving rule-based fallback reply");
    const lower = (message || "").toLowerCase();
    const regexAdd = isAddRegex(lower);
    // Lazy laya: hanya fetch saat regex miss.
    let layaFb: { intent: string; confidence: number } | null = null;
    if (!regexAdd) layaFb = await chatLaya();
    const isAddRequest = regexAdd || (layaFb?.intent === "daftar_lahan" && (layaFb?.confidence || 0) >= 0.5);
    const isPriceFb =
      lower.includes("harga") ||
      lower.includes("pasar") ||
      (layaFb?.intent === "cek_harga" && (layaFb?.confidence || 0) >= 0.5);

    const reg = extractFarmerFromText(message, currentDraft || {});
    const extracted: Partial<FarmerRecord> = { ...(currentDraft || {}), ...reg.extracted };
    const check = checkFarmerCompleteness(extracted);

    // Guard nalar + data-segar: sapaan/pertanyaan ("tolong bantu saya") tidak
    // dipaksa jadi templat draf; kelanjutan berdata ("2 hektar") tetap lolos
    // karena regFresh-nya berisi — bukan karena warisan draf.
    const regFreshFb = extractFarmerFromText(message, {});
    if ((isAddRequest || regFreshFb.hasMinimumData) && !needsReasoningMsg(message)) {
      if (check.isComplete) {
        const dupFmFb = findDuplicateFarmerByPhone(extracted, undefined, effPhone);
        if (dupFmFb) {
          return res.json({
            reply: formatDuplicateAskPrompt(dupFmFb, extracted),
            quickReplies: ["Ya, update", "Tidak"],
            extracted: { ...extracted, _pendingUpdate: dupFmFb.id }, isComplete: false, isAdminAction: false, aiProvider: "rule_based",
          } as any);
        }
        const newRecord = saveFarmerRecord(extracted, undefined, effPhone);
        return res.json({
          reply: formatSuccessFarmerRegistration(newRecord),
          extracted: newRecord,
          isComplete: true,
          savedRecord: newRecord,
          aiProvider: "rule_based",
          quickReplies: [
            "Cek Harga Cabai Hari Ini",
            "Konsultasi Hama Tanaman",
            "Buka Database Google Sheets",
            "Daftarkan Lahan Lain",
          ],
        });
      } else {
        // INCOMPLETE: DO NOT save to database! Ask for missing fields
        const incomplete = formatIncompleteFarmerPrompt(extracted, undefined, false);
        return res.json({ ...incomplete, aiProvider: "rule_based" });
      }
    }

    // Rule-based fallback response
    let fallbackReply =
      "🌾 *Salam Berkah Petani!* Pesan Bapak/Ibu telah diterima Kang Tani AI. Boleh disampaikan nama lengkap, luas lahan, dan komoditas apa yang sedang ditanam agar kami catat ke Google Sheets?";

    if (isPriceFb) {
      fallbackReply = await formatHargaPasarReply(message);
    } else if (lower.includes("padi") || lower.includes("cabai") || lower.includes("bawang") || lower.includes("jagung")) {
      const crop = lower.includes("cabai")
        ? "Cabai Rawit"
        : lower.includes("bawang")
        ? "Bawang Merah"
        : lower.includes("jagung")
        ? "Jagung Hibrida"
        : "Padi";
      extracted.komoditas = crop;
      fallbackReply = `Matur nuwun infonya Pak/Bu! Senang mendengar Bapak/Ibu menanam *${crop}*. Berapa luasan lahan yang ditanam dan di desa mana lokasinya agar langsung kami sinkronkan ke Google Sheets?`;
    } else if (lower.includes("ha") || lower.includes("hektar") || lower.includes("m2")) {
      const num = parseFloat(lower.match(/\d+(\.\d+)?/)?.[0] || "1.0");
      extracted.luasLahan = num;
      extracted.luasLahanFormatted = `${num} Ha`;
      // ANTI-KARANGAN: tonase tidak dihitung sendiri; tanya user bila perlu.
      fallbackReply = `Data luasan *${num} Hektar* berhasil dicatat. Atas nama Bapak/Ibu siapa pendaftaran lahan ini dicatatkan ke database?`;
    }

    res.json({
      reply: fallbackReply,
      extracted,
      isComplete: false,
      aiProvider: "rule_based",
      quickReplies: [
        "Daftarkan Lahan Baru",
        "Cek Harga Pasar Hari Ini",
        "Buka Database Google Sheets",
      ],
    });
  });

  // Bi-Directional Webhook Receiver for Google Apps Script & External Automation
  app.post("/api/webhook", (req, res) => {
    try {
      // Kunci jembatan Apps Script: bila APPS_SCRIPT_SECRET di-set, tolak
      // pemanggil tanpa secret agar sheet_edit tak bisa dipalsukan dari internet.
      const bridgeSecret = (process.env.APPS_SCRIPT_SECRET || "").trim();
      if (bridgeSecret) {
        const got = String(req.headers["x-apps-script-secret"] || (req.body || {}).appsScriptSecret || "");
        if (got !== bridgeSecret) {
          return res.status(403).json({ error: "Jembatan Apps Script butuh secret yang sah." });
        }
      }
      const payload = req.body || {};
      const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

      // 1. Handling Google Apps Script onEdit Event
      if (payload.event === "sheet_edit") {
        const { row, col, value, sheetName } = payload;
        let detail = `Edit di ${sheetName || "Sheet1"} baris #${row}, kolom #${col}: "${value}"`;
        const sheetKey = String(sheetName || "").toLowerCase().trim();
        const isCashSheet = CASH_SHEET_ALIASES.has(sheetKey);
        const isStockSheet = STOCK_SHEET_ALIASES.has(sheetKey);

        if (!isCashSheet && !isStockSheet && row >= 2 && row - 2 < farmersDb.length) {
          const idx = row - 2;
          const farmer = farmersDb[idx];

          // Map column:
          // 3: Nama, 4: NoHp, 5: Alamat, 6: Kabupaten, 7: LuasLahan, 8: Komoditas, 9: Varietas, 10: EstimasiPanen, 11: EstimasiHasilTon, 12: StatusVerifikasi, 13: CatatanAI
          if (col === 3 && value) farmer.nama = String(value);
          else if (col === 4 && value) farmer.noHp = String(value);
          else if (col === 5 && value) farmer.alamat = String(value);
          else if (col === 6 && value) farmer.kabupaten = String(value);
          else if (col === 7 && value) {
            const num = parseFloat(value) || farmer.luasLahan;
            farmer.luasLahan = num;
            farmer.luasLahanFormatted = `${num} Ha`;
          } else if (col === 8 && value) farmer.komoditas = String(value);
          else if (col === 9 && value) farmer.varietas = String(value);
          else if (col === 10 && value) farmer.estimasiPanen = String(value);
          else if (col === 11 && value) farmer.estimasiHasilTon = parseFloat(value) || farmer.estimasiHasilTon;
          else if (col === 12 && value) {
            const str = String(value).trim().toLowerCase();
            if (str.includes("terverifikasi")) farmer.statusVerifikasi = "Terverifikasi";
            else if (str.includes("klarifikasi")) farmer.statusVerifikasi = "Perlu Klarifikasi";
            else farmer.statusVerifikasi = "Menunggu Verifikasi";
          }
          else if (col === 13 && value) farmer.catatanAI = String(value);

          saveFarmersToDisk();
          detail += ` → Data petani ${farmer.nama} (${farmer.id}) berhasil diperbarui & disimpan ke disk`;
        }

        // Lembar 3 (kas tani). Kolom (1-based, selaras ekspor CSV):
        // 3: Tanggal, 4: Jenis, 5: Kategori, 6: Jumlah (Rp), 7: Komoditas, 8: Musim Tanam, 9: Catatan
        if (isCashSheet && row >= 2 && row - 2 < cashDb.length) {
          const rec = cashDb[row - 2];
          const v = value === undefined || value === null ? "" : String(value);
          if (col === 3 && v && isValidIsoDate(v)) rec.tanggal = v;
          else if (col === 4 && (v.toUpperCase() === "MASUK" || v.toUpperCase() === "KELUAR")) {
            rec.jenis = v.toUpperCase() as CashTransaction["jenis"];
          } else if (col === 5 && v) {
            const allowed = rec.jenis === "MASUK" ? CASH_KATEGORI_MASUK : CASH_KATEGORI_KELUAR;
            if (allowed.includes(v)) rec.kategori = v;
          } else if (col === 6 && v) {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) rec.jumlahRp = n;
          } else if (col === 7) rec.komoditas = v ? sanitizeText(v, 60) : undefined;
          else if (col === 8 && (v === "" || isValidMusim(v))) rec.musimTanam = v || undefined;
          else if (col === 9) rec.catatan = v ? sanitizeText(v, 500) : undefined;
          saveCashToDisk();
          bumpDataVersion();
          detail += ` → Kas ${rec.id} (${rec.jenis} ${rec.jumlahRp}) diperbarui & disimpan ke disk`;
        }

        // Lembar 4 (stok kios). Kolom (1-based, selaras ekspor CSV):
        // 3: Produk, 4: Satuan, 5: Arah, 6: Qty, 7: Harga Satuan (Rp), 8: Tanggal, 9: Keterangan
        if (isStockSheet && row >= 2 && row - 2 < stockDb.length) {
          const rec = stockDb[row - 2];
          const v = value === undefined || value === null ? "" : String(value);
          if (col === 3 && v) rec.produk = sanitizeText(v, 80);
          else if (col === 4 && v && STOCK_SATUAN.includes(v)) rec.satuan = v;
          else if (col === 5 && ["MASUK", "KELUAR", "PENYESUAIAN"].includes(v.toUpperCase())) {
            rec.arah = v.toUpperCase() as StockMutation["arah"];
          } else if (col === 6 && v) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) rec.qty = n;
          } else if (col === 7 && v !== "") {
            const n = Math.floor(Number(v) || 0);
            if (n >= 0) rec.hargaSatuanRp = n;
          } else if (col === 8 && v && isValidIsoDate(v)) rec.tanggal = v;
          else if (col === 9) rec.keterangan = v ? sanitizeText(v, 300) : undefined;
          saveStockToDisk();
          bumpDataVersion();
          detail += ` → Stok ${rec.id} (${rec.produk} ${rec.qty}${rec.satuan}) diperbarui & disimpan ke disk`;
        }

        const logItem = {
          id: `wh-${Date.now()}`,
          timestamp,
          event: "sheet_edit",
          detail,
          status: "SUCCESS",
        };
        webhookLogs.unshift(logItem);
        if (webhookLogs.length > 50) webhookLogs.pop();

        return res.json({
          success: true,
          message: "Sinkronisasi perubahan Google Sheets berhasil dicatat.",
          log: logItem,
        });
      }

      // 2. Generic or Manual Webhook Payload
      const logItem = {
        id: `wh-${Date.now()}`,
        timestamp,
        event: payload.event || "generic_payload",
        detail: typeof payload === "string" ? payload.substring(0, 120) : JSON.stringify(payload).substring(0, 120),
        status: "RECEIVED",
      };
      webhookLogs.unshift(logItem);
      if (webhookLogs.length > 50) webhookLogs.pop();

      res.json({ success: true, message: "Webhook payload diterima", log: logItem });
    } catch (err: any) {
      console.error("[Webhook Error]", err);
      res.status(500).json({ error: "Gagal memproses webhook: " + err.message });
    }
  });

  // Test Ping Endpoint for Webhook Verification UI
  app.post("/api/webhook/test-ping", requireSession(), (_req, res) => {
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    const logItem = {
      id: `wh-ping-${Date.now()}`,
      timestamp,
      event: "test_ping",
      detail: "Uji koneksi ping dari antarmuka Webhook Google Apps Script",
      status: "ACTIVE",
    };
    webhookLogs.unshift(logItem);
    if (webhookLogs.length > 50) webhookLogs.pop();

    res.json({
      ok: true,
      timestamp,
      message: "Endpoint Webhook TaniAI aktif dan siap menerima panggilan dari Google Apps Script onEdit",
      farmersCount: farmersDb.length,
    });
  });

  // GET Webhook Logs
  app.get("/api/webhook/logs", requireSession(), (_req, res) => {
    res.json(webhookLogs);
  });

  // Halaman ketertelusuran publik per petani (seed-to-table ringkas).
  // Tanpa auth (untuk QR/pembeli): no WA disamarkan, tanpa rincian kas per baris.
  app.get("/api/trace/:id", (req, res) => {
    const f = farmersDb.find((x) => x.id === String(req.params.id || "").toUpperCase());
    if (!f) return res.status(404).send("ID tidak ditemukan di database TaniAI.");
    const cashRows = cashDb.filter((c) => c.farmerId === f.id);
    const biaya = cashRows.filter((c) => c.jenis === "KELUAR").reduce((s, c) => s + c.jumlahRp, 0);
    const hppn = hppDb.filter((h) => h.farmerId === f.id);
    const masked = maskPhone(f.noHp);
    const fmtRp = (n: number) => "Rp" + Number(n || 0).toLocaleString("id-ID");
    const steps = [
      { t: "Didata", d: `${f.timestamp} — via ${f.googleSheetRow ? "Sheets baris #" + f.googleSheetRow : "aplikasi"}` },
      { t: "Verifikasi", d: f.statusVerifikasi },
      ...(hppn.length
        ? [{ t: "HPP", d: `${fmtRp(hppn[0].hppPerKg)}/kg dari ${fmtRp(hppn[0].totalBiayaRp)} (${hppn[0].musimTanam || "tanpa musim"})` }]
        : []),
      { t: "Transaksi kas", d: `${cashRows.length} tercatat, total biaya ${fmtRp(biaya)}` },
    ];
    res.send(`<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jejak ${escHtml(f.id)} — TaniAI</title></head><body style="font-family:system-ui;max-width:640px;margin:24px auto;padding:0 16px;color:#1e293b"><h2>🌾 Jejak Panen ${escHtml(f.id)}</h2><p><b>${escHtml(f.nama)}</b> — ${escHtml(f.komoditas)}${f.varietas ? " (" + escHtml(f.varietas) + ")" : ""}<br>${escHtml(f.alamat)}${f.kabupaten ? ", " + escHtml(f.kabupaten) : ""}<br>Lahan ${escHtml(f.luasLahan)} Ha • Estimasi ${escHtml(f.estimasiHasilTon)} ton • WA ${escHtml(masked)}</p><ol>${steps.map((s) => `<li><b>${escHtml(s.t)}</b>: ${escHtml(s.d)}</li>`).join("")}</ol><p style="color:#64748b;font-size:12px">Terverifikasi oleh TaniAI — pindai QR pada kemasan untuk membuka halaman ini.</p></body></html>`);
  });

  // Webhook WhatsApp Verification (Meta Cloud API Standard)
  app.get("/api/webhook/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "tani_ai_webhook_verify_token";

    if (mode === "subscribe" && token === verifyToken) {
      console.log("WhatsApp Webhook verified successfully.");
      return res.status(200).type("text/plain").send(String(challenge ?? ""));
    }
    return res.status(403).send("Verification token mismatch");
  });

  // Webhook WhatsApp Message Receiver (Meta Cloud API)
  // Jika FORWARD_SECRET di-set, hanya forwarder resmi (header x-tani-forward-secret)
  // yang boleh POST — menutup injeksi petani palsu dari internet.
  app.post("/api/webhook/whatsapp", async (req, res) => {
    try {
      const forwardSecret = (process.env.FORWARD_SECRET || "").trim();
      if (forwardSecret) {
        const got = String(req.headers["x-tani-forward-secret"] || "");
        if (got !== forwardSecret) {
          return res.status(403).json({ error: "Webhook hanya menerima penerusan resmi." });
        }
      }
      const appSecret = (process.env.WHATSAPP_APP_SECRET || "").trim();
      const sig = String(req.headers["x-hub-signature-256"] || "");
      const remoteOk = !!forwardSecret && String(req.headers["x-tani-forward-secret"] || "") === forwardSecret;
      if (appSecret && !remoteOk) {
        try {
          const raw: Buffer | undefined = (req as any).rawBody;
          if (!raw || !raw.length) {
            return res.status(403).json({ error: "Verifikasi webhook gagal." });
          }
          const m = /^sha256=([a-f0-9]{64})$/i.exec(sig);
          if (!m) {
            return res.status(403).json({ error: "Tanda tangan webhook tidak valid." });
          }
          const expectedHex = crypto.createHmac("sha256", appSecret).update(raw).digest("hex");
          const a = Buffer.from(m[1].toLowerCase(), "hex");
          const b = Buffer.from(expectedHex, "hex");
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(403).json({ error: "Tanda tangan webhook tidak valid." });
          }
        } catch {
          return res.status(403).json({ error: "Verifikasi webhook gagal." });
        }
      } else if (!forwardSecret && !appSecret) {
        console.warn("[WA] webhook tanpa signature/secret — mode kompatibilitas prod (set FORWARD_SECRET/WHATSAPP_APP_SECRET untuk menutup).");
      }
      const body = req.body || {};
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      const text = msg?.text?.body || msg?.button?.text || "";
      const from = msg?.from || "";
      // Router multi-nomor: ingat nomor WA mana yang menerima chat ini (sticky per user).
      try {
        const recvId: string = String(entry?.metadata?.phone_number_id || "");
        if (from && recvId) waNoteInbound(String(from), recvId);
      } catch { /* sticky best-effort */ }
      // ShareLoc Meta: msg.type === "location" -> msg.location.{latitude,longitude,name,address}.
      const waLoc = msg?.type === "location" && msg?.location ? msg.location : null;
      const waLocValid = !!(waLoc && isValidWaCoords(waLoc.latitude, waLoc.longitude));
      if (msg && waLocValid) {
        const locDetail = `${Number(waLoc.latitude).toFixed(6)},${Number(waLoc.longitude).toFixed(6)}`
          + [waLoc.name, waLoc.address].filter((s: any) => String(s || "").trim()).map((s: any) => ` — ${String(s).slice(0, 100)}`).join("");
        webhookLogs.unshift({
          id: `wa-loc-${msg.id || Date.now()}`,
          timestamp: new Date(Number(msg.timestamp || Date.now() / 1) * (msg.timestamp ? 1000 : 1)).toISOString(),
          event: `WA lokasi dari ${from}`,
          detail: locDetail.slice(0, 300),
          status: "RECEIVED",
        });
        if (webhookLogs.length > 50) webhookLogs.pop();
      }
      // Pesan masuk juga dicatat agar terlihat di GET /api/webhook/logs.
      if (msg && (text || from)) {
        webhookLogs.unshift({
          id: `wa-in-${msg.id || Date.now()}`,
          timestamp: new Date(Number(msg.timestamp || Date.now() / 1) * (msg.timestamp ? 1000 : 1)).toISOString(),
          event: `WA masuk dari ${from}`,
          detail: (text || "(tanpa teks)").slice(0, 300),
          status: "RECEIVED",
        });
        if (webhookLogs.length > 50) webhookLogs.pop();
      }
      // Tanda terima Meta (sent/delivered/read/failed) — satu-satunya bukti
      // status kirim; bisa dibaca via GET /api/webhook/logs.
      const statuses = entry?.statuses || [];
      for (const st of statuses) {
        webhookLogs.unshift({
          id: `wa-status-${st.id || Date.now()}`,
          timestamp: new Date(Number(st.timestamp || Date.now() / 1) * (st.timestamp ? 1000 : 1)).toISOString(),
          event: `WA ${st.status || "?"} -> ${st.recipient_id || "?"}`,
          detail: JSON.stringify(st).slice(0, 800),
          status: String(st.status || "unknown").toUpperCase(),
        });
        if (webhookLogs.length > 50) webhookLogs.pop();
        console.log(`[WA status] ${st.status} id=${st.id} to=${st.recipient_id} ${st.errors ? JSON.stringify(st.errors) : ""}`);
      }
      if (waLocValid) {
        // Idempoten dengan /api/wa-location (forwarder): tulis koordinat yang sama.
        const r = applyWaLocationToFarmer(from, {
          latitude: Number(waLoc.latitude),
          longitude: Number(waLoc.longitude),
          name: sanitizeText(waLoc.name, 200),
          address: sanitizeText(waLoc.address, 500),
        }, "wa-webhook");
        console.log(`[WA] lokasi tersimpan dari ${from} -> ${r.mapsUrl}${r.farmerId ? ` (${r.farmerId})` : " (draf)"}`);
      }
      if (text) {
        const clean = sanitizeText(text, 2000);
        const { extracted } = extractFarmerFromText(clean, {});
        const check = checkFarmerCompleteness({ ...extracted, noHp: from || extracted.noHp });
        if (check.isComplete) {
          const saved = saveFarmerRecord({ ...extracted, noHp: from || extracted.noHp }, undefined, from, "wa-webhook");
          console.log(`[WA] petani tersimpan ${saved.id} dari ${from}`);
        } else {
          console.log(`[WA] draf masuk dari ${from}: ${check.missingFields.join(", ")}`);
        }
      } else if (!waLocValid) {
        console.log("Incoming WhatsApp Webhook event:", JSON.stringify(body).slice(0, 500));
      }
      res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("Webhook processing error:", err);
      res.status(500).send("INTERNAL_ERROR");
    }
  });

  // Korelasi Pearson luas vs ton (stdlib, tanpa dep).
  app.get("/api/analytics/correlation", requireSession(), (_req, res) => {
    const xs = farmersDb.map((f) => Number(f.luasLahan) || 0);
    const ys = farmersDb.map((f) => Number(f.estimasiHasilTon) || 0);
    const n = xs.length;
    if (n < 2) return res.json({ n, r: 0 });
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    const r = dx && dy ? Number((num / Math.sqrt(dx * dy)).toFixed(3)) : 0;
    res.json({ n, r });
  });

  // Simulasi intervensi Dinas (resapan gudang, CAS 30-45 hari, subsidi ongkir, OP murah).
  app.post("/api/interventions/simulate", requireSession(), (req, res) => {
    const b = req.body || {};
    const ton = Number(b.estimasiTon || farmersDb.reduce((a, f) => a + (f.estimasiHasilTon || 0), 0));
    const harga = Number(b.hargaKg || 12000);
    const resapan = Math.min(1, Math.max(0, Number(b.resapanPersen ?? 20) / 100));
    const casHari = Math.min(45, Math.max(0, Number(b.casHari ?? 30)));
    const subsidiKg = Math.max(0, Number(b.subsidiOngkirKg ?? 0));
    const opKg = Math.max(0, Number(b.operasiPasarKg ?? 0));
    const nilaiTerserap = Math.round(ton * 1000 * resapan * harga);
    const nilaiCas = Math.round(ton * 1000 * (1 - resapan) * harga * (casHari / 45) * 0.05);
    const biayaSubsidi = Math.round(ton * 1000 * subsidiKg);
    const nilaiOp = Math.round(opKg * harga);
    res.json({ ton, harga, resapan: resapan * 100, casHari, nilaiTerserap, nilaiCas, biayaSubsidi, nilaiOp });
  });

  // Broadcast hama khusus (template + endpoint sendiri).
  app.post("/api/notifications/pest-broadcast", requireSession(), async (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    const komoditas = sanitizeText(req.body?.komoditas || "Padi", 80) || "Padi";
    const hama = sanitizeText(req.body?.hama || "wereng", 80) || "wereng";
    const anjuran = sanitizeText(req.body?.anjuran || "Lapor PPL, pasang perangkap kuning, semprot neem 2ml/L pagi hari.", 500);
    const target = farmersDb.filter((f) => (f.komoditas || "").toLowerCase().includes(komoditas.toLowerCase().split(" ")[0]));
    const pesan = `🐛 *[TaniAI SIAGA HAMA]*\nYth. Petani ${komoditas},\nWaspada serangan ${hama}.\n💡 ${anjuran}\n_Lapor PPL bila >10% rumpun terdampak._`;
    const notif: AnomalyNotification = {
      id: `pest-${Date.now()}`,
      komoditas,
      tipeAnomali: "PERINGATAN_PASAR",
      pesanPeringatan: pesan,
      waktuKirim: new Date().toLocaleString("id-ID") + " WIB",
      jumlahPetaniTerdampak: Math.max(target.length, 1),
      status: "Terkirim",
      targetPetaniNames: target.length ? target.map((f) => f.nama) : ["Seluruh Petani Terdaftar"],
    };
    notificationsDb.unshift(notif);
    let wa: { attempted: number; sent: number; failed: { nama: string; to: string; errorCode?: number; error?: string }[] } | { attempted: 0; reason: string } = { attempted: 0, reason: "viaWa tidak diminta" };
    if (req.body?.viaWa === true) {
      if (target.length > 0) {
        wa = await broadcastWaText(target.map((f) => ({ nama: f.nama, noHp: f.noHp })), pesan);
      } else {
        wa = { attempted: 0, reason: "tanpa petani target bernomor" };
      }
    } else if (req.body?.viaWa === "template") {
      if (target.length > 0) {
        wa = await broadcastWaTemplate(target.map((f) => ({ nama: f.nama, noHp: f.noHp })), WA_OPENER_TEMPLATE, "id", []);
      } else {
        wa = { attempted: 0, reason: "tanpa petani target bernomor" };
      }
    }
    res.json({ success: true, notification: notif, wa });
  });

  // HALAMAN PUBLIK (tanpa sesi): ringkasan statistik + titik peta teranonimasi.
  // Tanpa noHp/kontak/alamat detail. Nama + komoditas + kabupaten tampil sesuai
  // prinsip Sheets transparan (petani mendaftar untuk terdata di peta).
  app.get("/api/publik/ringkas", (_req, res) => {
    try {
      const farmers = farmersDb
        .filter((f) => typeof f.latitude === "number" && typeof f.longitude === "number")
        .map((f) => ({
          id: f.id, nama: f.nama, komoditas: f.komoditas, kabupaten: f.kabupaten || "",
          latitude: f.latitude, longitude: f.longitude, statusVerifikasi: f.statusVerifikasi,
        }));
      const suppliers = suppliersDb
        .filter((s) => typeof s.latitude === "number" && typeof s.longitude === "number")
        .map((s) => ({
          id: s.id, nama: s.nama, kategori: s.kategori, kabupaten: s.kabupaten || "",
          latitude: s.latitude, longitude: s.longitude, statusKemitraan: s.statusKemitraan,
          produkUnggulan: s.produkUnggulan || [], stokTersedia: s.stokTersedia || "",
          jamBuka: s.jamBuka || "",
        }));
      const anomaliAktif = commoditiesDb.filter(
        (c) => c.statusAnomali === "LONJAKAN_EKSTREM" || c.statusAnomali === "PENURUNAN_DRASTIS"
      ).length;
      const dealTercatat = offersDb.filter((o) => o.status === "DEAL").length;
      const totalLuasHa = Math.round(farmersDb.reduce((n, f) => n + (Number(f.luasLahan) || 0), 0) * 10) / 10;
      res.json({
        stats: {
          petani: farmersDb.length, pemasok: suppliersDb.length, totalLuasHa,
          komoditas: commoditiesDb.length, anomaliAktif, deal: dealTercatat,
        },
        peta: { farmers, suppliers },
        updatedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: "Gagal memuat ringkasan publik" });
    }
  });

  // FR-04: Kartu Tanda Registrasi PDF + QR. PUBLIK (tanpa sesi) agar bisa dibuka
  // petani dari tautan WA; no HP tampil termasking. Field kartu non-rahasia
  // (sejalan prinsip Sheets transparan).
  app.get("/api/kartu/:id", async (req, res) => {
    try {
      const id = String(req.params.id || "").toUpperCase();
      const f = farmersDb.find((x) => x.id.toUpperCase() === id);
      if (!f) { res.status(404).json({ error: "Petani tidak ditemukan" }); return; }
      const pdf = await buildKartuPdf(f);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="kartu-${f.id}.pdf"`);
      res.send(Buffer.from(pdf));
    } catch (e: any) {
      res.status(500).json({ error: "Gagal membuat kartu", detail: String(e?.message || e) });
    }
  });

  // CSV Export for Google Sheets
  app.get("/api/sheets/export.csv", requireSession(), (_req, res) => {
    const headers = [
      "ID",
      "Waktu Pencatatan",
      "Nama Petani",
      "Nomor WhatsApp",
      "Alamat / Desa",
      "Kabupaten / Provinsi",
      "Luas Lahan (Ha)",
      "Komoditas",
      "Varietas",
      "Estimasi Panen",
      "Estimasi Hasil (Ton)",
      "Status Verifikasi",
      "Catatan Rekomendasi AI",
    ];

    const sanitizeCsv = (val: any) => {
      if (val === null || val === undefined) return '""';
      let str = String(val).replace(/"/g, '""');
      if (/^[=+\-@]/.test(str)) {
        str = "'" + str;
      }
      return `"${str}"`;
    };

    const rows = farmersDb.map((f) => [
      sanitizeCsv(f.id),
      sanitizeCsv(f.timestamp),
      sanitizeCsv(f.nama),
      sanitizeCsv(f.noHp),
      sanitizeCsv(f.alamat),
      sanitizeCsv(f.kabupaten || ""),
      f.luasLahan,
      sanitizeCsv(f.komoditas),
      sanitizeCsv(f.varietas || ""),
      sanitizeCsv(f.estimasiPanen),
      f.estimasiHasilTon,
      sanitizeCsv(f.statusVerifikasi),
      sanitizeCsv(f.catatanAI || ""),
    ]);

    const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="TaniAI_Database_Petani_GoogleSheets.csv"');
    res.send(csvContent);
  });

  // Status cermin Sheets write-behind (terbuka; tanpa rahasia di output).
  app.get("/api/sheets/status", async (_req, res) => {
    res.json({ ...getSheetsStatus(), remote: await getSheetsRemote() });
  });

  // Paksa kirim antrean sekarang (Admin Utama bersesi).
  app.post("/api/sheets/sync-now", requireSession(), async (req, res) => {
    const gate = requireRequesterAdmin(req.body, (req as any).sessionAdmin);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.error });
    }
    try {
      const r = await drainSheetsQueue("manual");
      res.json(r);
    } catch (e: any) {
      res.status(502).json({ error: "Gagal sinkronisasi", detail: String(e?.message || e) });
    }
  });

  // Standalone Google Sheets Live View Web Page with authentic spreadsheet UI & interaction
  app.get("/api/sheets/live-view", requireSession(), (req, res) => {
    const totalLuas = farmersDb.reduce((acc, f) => acc + (f.luasLahan || 0), 0).toFixed(1);
    const totalTon = farmersDb.reduce((acc, f) => acc + (f.estimasiHasilTon || 0), 0).toFixed(1);
    const protoRaw = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
    const protocol = protoRaw === "http" ? "http" : "https";
    const host = cleanHost(req.get("host"));
    const fullCsvUrl = `${protocol}://${host}/api/sheets/export.csv`;

    const rowsHtml = farmersDb
      .map(
        (f, idx) => `
      <tr class="farmer-row hover:bg-emerald-50/50 transition-colors" data-nama="${escAttr((f.nama || "").toLowerCase())}" data-komoditas="${escAttr((f.komoditas || "").toLowerCase())}" data-alamat="${escAttr((f.alamat || "").toLowerCase())}">
        <td class="row-num select-none">${idx + 2}</td>
        <td class="cell font-mono font-semibold text-emerald-800" data-col="A" data-row="${idx + 2}">${escHtml(f.id)}</td>
        <td class="cell text-slate-500 font-mono text-xs" data-col="B" data-row="${idx + 2}">${escHtml(f.timestamp)}</td>
        <td class="cell font-semibold text-slate-900" data-col="C" data-row="${idx + 2}">${escHtml(f.nama)}</td>
        <td class="cell font-mono text-slate-700" data-col="D" data-row="${idx + 2}">${escHtml(f.noHp)}</td>
        <td class="cell text-slate-700" data-col="E" data-row="${idx + 2}">${escHtml(f.alamat)}</td>
        <td class="cell text-slate-700" data-col="F" data-row="${idx + 2}">${escHtml(f.kabupaten || "—")}</td>
        <td class="cell text-right font-mono font-bold text-emerald-900 bg-emerald-50/40" data-col="G" data-row="${idx + 2}">${Number(f.luasLahan || 0).toFixed(1)}</td>
        <td class="cell font-medium text-slate-800" data-col="H" data-row="${idx + 2}">${escHtml(f.komoditas)}</td>
        <td class="cell text-slate-600" data-col="I" data-row="${idx + 2}">${escHtml(f.varietas || "—")}</td>
        <td class="cell text-slate-700" data-col="J" data-row="${idx + 2}">${escHtml(f.estimasiPanen)}</td>
        <td class="cell text-right font-mono font-bold text-amber-900 bg-amber-50/40" data-col="K" data-row="${idx + 2}">${Number(f.estimasiHasilTon || 0).toFixed(1)}</td>
        <td class="cell text-center" data-col="L" data-row="${idx + 2}"><span class="badge">${escHtml(f.statusVerifikasi)}</span></td>
        <td class="cell text-slate-600 max-w-sm truncate" data-col="M" data-row="${idx + 2}" title="${escAttr(f.catatanAI || "")}">${escHtml(f.catatanAI || "—")}</td>
      </tr>`
      )
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Petani_TaniAI_2026_Database_Master - Google Sheets</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="icon" href="https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 10px; white-space: nowrap; }
    th { background: #f8fafc; color: #475569; position: sticky; top: 0; z-index: 10; font-weight: 600; text-align: left; }
    .col-header { text-align: center; color: #64748b; font-size: 11px; font-weight: 600; background: #f1f5f9; }
    .row-num { background: #f1f5f9; text-align: center; color: #64748b; font-family: monospace; width: 42px; font-size: 11px; }
    .badge { background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; border: 1px solid #bbf7d0; display: inline-block; }
    .cell-selected { outline: 2px solid #059669 !important; background-color: #ecfdf5 !important; position: relative; z-index: 2; }
    .scrollbar-thin::-webkit-scrollbar { height: 7px; width: 7px; }
    .scrollbar-thin::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
  </style>
</head>
<body class="bg-slate-100 flex flex-col h-screen overflow-hidden">
  <!-- Google Sheets Top Bar -->
  <header class="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between shrink-0 shadow-2xs">
    <div class="flex items-center space-x-3">
      <!-- Sheets Green Logo -->
      <div class="w-9 h-9 rounded-lg bg-emerald-600 text-white flex items-center justify-center shadow-xs">
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14H6v-2h6v2zm0-4H6v-2h6v2zm0-4H6V7h6v2zm6 8h-4v-2h4v2zm0-4h-4v-2h4v2zm0-4h-4V7h4v2z"/>
        </svg>
      </div>
      <div>
        <div class="flex items-center space-x-2">
          <span class="font-bold text-slate-900 text-base">Petani_TaniAI_2026_Database_Master</span>
          <span class="bg-emerald-100 text-emerald-800 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-emerald-300">
            Live Web Spreadsheet
          </span>
          <span class="text-xs text-slate-400 hidden sm:inline">&bull; Tersimpan otomatis</span>
        </div>
        <!-- Menus -->
        <div class="flex items-center space-x-3 text-xs text-slate-600 mt-0.5">
          <span class="hover:text-emerald-700 cursor-pointer font-medium">File</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Edit</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Tampilan</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Sisipkan</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Format</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Data</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Alat</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Ekstensi</span>
          <span class="hover:text-emerald-700 cursor-pointer font-medium">Bantuan</span>
        </div>
      </div>
    </div>

    <!-- Quick Action Buttons -->
    <div class="flex items-center space-x-2">
      <button onclick="copyAllTSV()" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition cursor-pointer" title="Salin semua data tabel untuk di-paste (Ctrl+V) langsung ke Google Sheets">
        <span>📋 Salin Data (TSV)</span>
      </button>

      <button onclick="copyImportFormula()" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition cursor-pointer" title="Salin rumus =IMPORTDATA untuk live sync">
        <span>🔗 Salin Rumus Live</span>
      </button>

      <a href="/api/sheets/export.csv" download class="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm transition cursor-pointer">
        <span>📥 Unduh .CSV</span>
      </a>

      <button onclick="openDocsGoogle()" class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm transition cursor-pointer" title="Buka docs.google.com dengan panduan paste instan">
        <span>🌐 Buka di docs.google.com</span>
      </button>
    </div>
  </header>

  <!-- Formula Bar & Filter Toolbar -->
  <div class="bg-slate-50 border-b border-slate-200 px-4 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
    <div class="flex items-center space-x-2 w-full sm:w-auto">
      <div id="cellCoord" class="bg-white border border-slate-300 rounded px-2.5 py-1 font-mono text-slate-800 font-bold text-xs min-w-[50px] text-center shadow-2xs">
        C2
      </div>
      <div class="text-slate-400 font-serif italic text-sm select-none px-1">
        fx
      </div>
      <input id="formulaInput" type="text" readonly value="${farmersDb[0]?.nama || ""}" class="bg-white border border-slate-300 rounded px-3 py-1 text-slate-800 text-xs flex-1 sm:w-96 font-mono shadow-2xs focus:outline-none" />
    </div>

    <!-- Search / Filter Box -->
    <div class="flex items-center space-x-2">
      <div class="relative">
        <input id="searchInput" type="text" onkeyup="filterTable()" placeholder="Cari nama, komoditas, desa..." class="pl-3 pr-3 py-1 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500 w-52 sm:w-64" />
      </div>
      <button onclick="window.location.reload()" class="px-2.5 py-1 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 transition cursor-pointer font-medium" title="Perbarui data terbaru">
        🔄 Refresh
      </button>
    </div>
  </div>

  <!-- Notification Banner -->
  <div id="toastBanner" class="hidden bg-emerald-700 text-white text-xs px-4 py-1.5 flex items-center justify-between transition-all">
    <span id="toastText">Data berhasil disalin!</span>
    <button onclick="document.getElementById('toastBanner').classList.add('hidden')" class="text-white/80 hover:text-white font-bold ml-4">✕</button>
  </div>

  <!-- Spreadsheet Data Table Container -->
  <div class="flex-1 overflow-auto bg-white scrollbar-thin">
    <table id="farmerTable" class="w-full">
      <thead>
        <tr>
          <th class="row-num select-none">#</th>
          <th class="col-header min-w-[90px]"><span class="block text-[10px] text-slate-400">A</span>ID Petani</th>
          <th class="col-header min-w-[130px]"><span class="block text-[10px] text-slate-400">B</span>Waktu Registrasi</th>
          <th class="col-header min-w-[160px]"><span class="block text-[10px] text-slate-400">C</span>Nama Petani</th>
          <th class="col-header min-w-[130px]"><span class="block text-[10px] text-slate-400">D</span>Nomor WhatsApp</th>
          <th class="col-header min-w-[180px]"><span class="block text-[10px] text-slate-400">E</span>Alamat / Desa</th>
          <th class="col-header min-w-[120px]"><span class="block text-[10px] text-slate-400">F</span>Kabupaten</th>
          <th class="col-header min-w-[110px] text-right bg-emerald-50/50"><span class="block text-[10px] text-slate-400">G</span>Luas Lahan (Ha)</th>
          <th class="col-header min-w-[130px]"><span class="block text-[10px] text-slate-400">H</span>Komoditas</th>
          <th class="col-header min-w-[120px]"><span class="block text-[10px] text-slate-400">I</span>Varietas</th>
          <th class="col-header min-w-[120px]"><span class="block text-[10px] text-slate-400">J</span>Estimasi Panen</th>
          <th class="col-header min-w-[110px] text-right bg-amber-50/50"><span class="block text-[10px] text-slate-400">K</span>Hasil (Ton)</th>
          <th class="col-header min-w-[120px] text-center"><span class="block text-[10px] text-slate-400">L</span>Status Verifikasi</th>
          <th class="col-header min-w-[260px]"><span class="block text-[10px] text-slate-400">M</span>Catatan AI Rekomendasi</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        <!-- Total Formula Row -->
        <tr class="bg-slate-100 font-bold border-t-2 border-slate-300 text-slate-900">
          <td class="row-num select-none">${farmersDb.length + 2}</td>
          <td colspan="6" class="p-2 font-mono text-emerald-900">∑ TOTAL REKAPITULASI ( =SUM )</td>
          <td class="cell text-right font-mono text-emerald-900 bg-emerald-100 font-bold" data-col="G" data-row="${farmersDb.length + 2}">
            ${totalLuas} Ha
          </td>
          <td colspan="3" class="p-2 text-slate-600">
            Rata-rata: ${(Number(totalLuas) / (farmersDb.length || 1)).toFixed(2)} Ha/Petani
          </td>
          <td class="cell text-right font-mono text-amber-900 bg-amber-100 font-bold" data-col="K" data-row="${farmersDb.length + 2}">
            ${totalTon} Ton
          </td>
          <td colspan="2" class="p-2 text-center text-slate-500 font-normal">
            Database Siap Data Science
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Bottom Sheet Tabs Bar -->
  <footer class="bg-slate-100 border-t border-slate-300 px-4 py-1.5 flex items-center justify-between text-xs shrink-0">
    <div class="flex items-center space-x-1">
      <div class="bg-white border-t-2 border-emerald-600 px-3 py-1 text-xs font-bold text-slate-800 rounded-t shadow-2xs flex items-center space-x-1.5">
        <span class="text-emerald-700">📄</span>
        <span>Lahan_Petani_Master</span>
      </div>
      <div class="px-3 py-1 text-xs text-slate-500 hover:bg-slate-200 rounded cursor-pointer hidden sm:block">
        📊 Rekap_Komoditas
      </div>
      <div class="px-3 py-1 text-xs text-slate-500 hover:bg-slate-200 rounded cursor-pointer hidden sm:block">
        📈 Analisis_Harga_Pasar
      </div>
    </div>
    <div class="text-slate-500 text-[11px] flex items-center space-x-3">
      <span>Total Baris: <strong>${farmersDb.length} Petani Terdata</strong></span>
      <span>• Total Lahan: <strong>${totalLuas} Ha</strong></span>
      <span>• Proyeksi Panen: <strong>${totalTon} Ton</strong></span>
    </div>
  </footer>

  <script>
    const fullCsvUrl = "${fullCsvUrl}";
    const importFormula = '=IMPORTDATA("' + fullCsvUrl + '")';

    // Interactive Cell Selection
    let activeCell = null;
    document.querySelectorAll('.cell').forEach(td => {
      td.addEventListener('click', () => {
        if (activeCell) activeCell.classList.remove('cell-selected');
        td.classList.add('cell-selected');
        activeCell = td;
        const col = td.getAttribute('data-col') || 'A';
        const row = td.getAttribute('data-row') || '2';
        document.getElementById('cellCoord').innerText = col + row;
        document.getElementById('formulaInput').value = td.innerText.trim();
      });
    });

    function showToast(msg) {
      const banner = document.getElementById('toastBanner');
      const text = document.getElementById('toastText');
      text.textContent = String(msg || "").replace(/<[^>]*>/g, "");
      banner.classList.remove('hidden');
      setTimeout(() => banner.classList.add('hidden'), 5000);
    }

    function copyAllTSV() {
      const table = document.getElementById('farmerTable');
      let tsv = '';
      for (const row of table.rows) {
        const cells = Array.from(row.cells).map(c => c.innerText.replace(/\\t|\\n/g, ' ').trim());
        tsv += cells.join('\\t') + '\\n';
      }
      navigator.clipboard.writeText(tsv);
      showToast('✅ Seluruh tabel data petani berhasil disalin ke clipboard! Buka Google Sheets lalu tekan <strong>Ctrl+V</strong>.');
    }

    function copyImportFormula() {
      navigator.clipboard.writeText(importFormula);
      showToast('✅ Rumus Live Sync disalin: <code>' + importFormula + '</code>. Tempelkan di sel A1 Google Sheets Anda.');
    }

    function openDocsGoogle() {
      copyAllTSV();
      showToast('🌐 Membuka Google Sheets... Data telah disalin! Tekan <strong>Ctrl+V</strong> di sel A1 pada lembar kerja baru.');
      setTimeout(() => {
        window.open('https://docs.google.com/spreadsheets/create', '_blank');
      }, 500);
    }

    function filterTable() {
      const query = document.getElementById('searchInput').value.toLowerCase();
      const rows = document.querySelectorAll('.farmer-row');
      rows.forEach(r => {
        const nama = r.getAttribute('data-nama') || '';
        const komoditas = r.getAttribute('data-komoditas') || '';
        const alamat = r.getAttribute('data-alamat') || '';
        if (nama.includes(query) || komoditas.includes(query) || alamat.includes(query)) {
          r.style.display = '';
        } else {
          r.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  // AI Cost Optimization & Metrics endpoint
  app.get("/api/ai/metrics", requireSession(), (_req, res) => {
    res.json({
      totalCacheHits,
      totalTokensSavedEstimate,
      cachedItemsCount: aiResponseCache.size,
      dataVersion: currentDataVersion,
      maxOutputTokensLimit: 550,
      activeProvider: getMetaModelConfig().isConfigured ? "meta" : (getNineRouterConfig().isConfigured ? "9router" : getGemini() ? "gemini" : "offline_fallback"),
    });
  });

  // Explicit cancellation endpoint
  app.post("/api/chat/cancel", requireSession(), (_req, res) => {
    console.log("[AI Cost Optimizer] Client requested explicit cancellation.");
    res.json({ ok: true, message: "Proses AI dibatalkan untuk menghemat token." });
  });

  return app;
}

async function startServer() {
  loadEventsDb();
  const app = createServerApp();
  const PORT = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : 3000;

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌾 TaniAI Server running on port ${PORT}`);
    initLayaDaemon();
    initSheetsSync({
      dataDir: DATA_DIR,
      farmers: () => farmersDb,
      suppliers: () => suppliersDb,
      cash: () => cashDb,
      stock: () => stockDb,
      commodities: () => komoditasDb,
      feedback: () => feedbackDb,
      saveFarmers: () => saveFarmersToDisk(),
      saveSuppliers: () => saveSuppliersToDisk(),
      saveCash: () => saveCashToDisk(),
      saveStock: () => saveStockToDisk(),
      saveCommodities: () => saveKomoditasToDisk(),
      saveFeedback: () => saveFeedbackToDisk(),
    });
  });
}

startServer();
