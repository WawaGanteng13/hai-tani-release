// Cermin Google Sheets satu arah (bot -> Sheets), write-behind async.
//
// Kontrak kecepatan: jalur chat TIDAK PERNAH menunggu Sheets. Mutasi hanya
// enqueue (<1ms, memori + antrean disk); worker background mengirim berkelompok.
// Sheets adalah cermin/backup transparan — satu-satunya penulis adalah bot ini
// (single-writer; jangan edit sel data manual di Sheets).
// HPP belum dicerminkan (menyusul; tak ada format CSV kanonis).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FarmerRecord, SupplierRecord, CashTransaction, StockMutation, FarmerCommodity, FeedbackRecord } from "../src/types";

export type SheetKind = "farmer" | "supplier" | "cash" | "stock" | "commodity" | "feedback";

interface SheetOp {
  kind: SheetKind;
  id: string;
  enqueuedAt: number;
  attempts: number;
  nextRetry: number;
}

export interface SheetsDeps {
  dataDir: string;
  farmers: () => FarmerRecord[];
  suppliers: () => SupplierRecord[];
  cash: () => CashTransaction[];
  stock: () => StockMutation[];
  commodities: () => FarmerCommodity[];
  feedback: () => FeedbackRecord[];
  saveFarmers: () => void;
  saveSuppliers: () => void;
  saveCash: () => void;
  saveStock: () => void;
  saveCommodities: () => void;
  saveFeedback: () => void;
}

interface TabSpec {
  tab: string;
  headers: string[];
}

// Urutan kolom = persis ekspor CSV kanonis (/api/sheets/*.csv).
const TABS: Record<SheetKind, TabSpec> = {
  farmer: {
    tab: "Petani",
    headers: ["ID", "Waktu Pencatatan", "Nama Petani", "Nomor WhatsApp", "Alamat / Desa",
      "Kabupaten / Provinsi", "Luas Lahan (Ha)", "Komoditas", "Varietas", "Estimasi Panen",
      "Estimasi Hasil (Ton)", "Status Verifikasi", "Catatan Rekomendasi AI"],
  },
  supplier: {
    tab: "Supplier",
    headers: ["ID Supplier", "Waktu Terdaftar", "Nama Supplier / Kios", "Kategori Usaha",
      "Kontak WhatsApp", "Alamat", "Kabupaten", "Status Kemitraan", "Produk Unggulan",
      "Stok Tersedia", "Radius Layanan (Km)", "Jam Buka", "Petani Binaan Terhubung",
      "Latitude", "Longitude", "Catatan"],
  },
  cash: {
    tab: "Kas",
    headers: ["ID", "Farmer ID", "Tanggal", "Jenis", "Kategori", "Jumlah (Rp)",
      "Komoditas", "Musim Tanam", "Catatan", "Dicatat Oleh", "Waktu Catat"],
  },
  stock: {
    tab: "Stok",
    headers: ["ID", "Supplier ID", "Produk", "Satuan", "Arah", "Qty", "Harga Satuan (Rp)",
      "Tanggal", "Keterangan", "Dicatat Oleh", "Waktu Catat"],
  },
  commodity: {
    tab: "Komoditas",
    headers: ["ID", "Farmer ID", "Komoditas", "Varietas", "Luas (Ha)",
      "Estimasi Panen", "Estimasi Hasil (Ton)", "Musim Tanam", "Status",
      "Dibuat", "Diubah"],
  },
  feedback: {
    tab: "Saran & Masukan",
    headers: ["ID", "Tanggal", "Nama", "Nomor WhatsApp", "Kategori",
      "Pesan", "Konteks", "Status", "Waktu Catat"],
  },
};

const QUEUE_CAP = 5000;
const DRAIN_EVERY_MS = 15000;
const KICK_DEBOUNCE_MS = 5000;
const BOOT_RECONCILE_DELAY_MS = 10000;
const REWRITE_ROW_GUARD = 2000;

let deps: SheetsDeps | null = null;
let queue = new Map<string, SheetOp>();
let workerOn = false;
let draining = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let queuedTotal = 0;
let syncedTotal = 0;
let lastOkAt = "";
let lastError = "";
let lastDrainAt = "";
let tokenCache: { token: string; exp: number } | null = null;

const opKey = (kind: SheetKind, id: string) => `${kind}:${id}`;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const colName = (n: number): string => String.fromCharCode(64 + n); // n<=26

function queueFile(): string {
  return path.join(deps?.dataDir || process.cwd(), "sheets_queue.json");
}

function persistQueueSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const f = queueFile();
      const tmp = `${f}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify([...queue.values()]), "utf8");
      fs.renameSync(tmp, f);
    } catch (err) {
      console.error("[SheetsSync] gagal menyimpan antrean:", (err as Error)?.message || err);
    }
  }, 1000);
}

function loadQueue(): void {
  try {
    const f = queueFile();
    if (!fs.existsSync(f)) return;
    const arr = JSON.parse(fs.readFileSync(f, "utf8")) as SheetOp[];
    if (!Array.isArray(arr)) return;
    for (const o of arr.slice(-QUEUE_CAP)) {
      if (o && o.kind && o.id && TABS[o.kind as SheetKind]) {
        queue.set(opKey(o.kind, o.id), { ...o, nextRetry: 0 });
      }
    }
    if (queue.size > 0) console.log(`[SheetsSync] antrean tertunda dimuat: ${queue.size} op`);
  } catch (err) {
    console.error("[SheetsSync] gagal memuat antrean:", (err as Error)?.message || err);
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function loadServiceAccount(): ServiceAccount | null {
  try {
    const inline = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
    if (inline) {
      const j = JSON.parse(inline) as ServiceAccount;
      if (j.client_email && j.private_key) return j;
    }
    const fp = (process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "").trim()
      || path.join(deps?.dataDir || process.cwd(), "gcp-service-account.json");
    if (fp && fs.existsSync(fp)) {
      const j = JSON.parse(fs.readFileSync(fp, "utf8")) as ServiceAccount;
      if (j.client_email && j.private_key) return j;
    }
  } catch (err) {
    console.error("[SheetsSync] kredensial service account tidak valid:", (err as Error)?.message || err);
  }
  return null;
}

function sheetId(): string {
  return (process.env.GOOGLE_SHEETS_ID || "").trim();
}

export function isSheetsConfigured(): boolean {
  return !!sheetId() && !!loadServiceAccount();
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${head}.${claim}`);
  signer.end();
  const sig = signer.sign(sa.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(`${head}.${claim}.${sig}`)}`,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("token kosong");
  tokenCache = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  return tokenCache.token;
}

async function sheetsFetch(sa: ServiceAccount, id: string, p: string, init?: RequestInit): Promise<any> {
  const token = await getAccessToken(sa);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${p}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const msg = String(body?.error?.message || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return body;
}

const isTabMissing = (err: unknown): boolean =>
  /Unable to parse range|not found|exceeds grid limits/i.test(String((err as Error)?.message || err));

async function ensureTab(sa: ServiceAccount, id: string, kind: SheetKind): Promise<void> {
  const spec = TABS[kind];
  try {
    await sheetsFetch(sa, id, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: spec.tab } } }] }),
    });
  } catch (err) {
    if (!/already exists/i.test(String((err as Error)?.message || err))) throw err;
  }
  await sheetsFetch(sa, id, `/values/${encodeURIComponent(spec.tab)}!A1:append?valueInputOption=RAW`, {
    method: "POST",
    body: JSON.stringify({ values: [spec.headers] }),
  });
}

function serialize(kind: SheetKind, r: any): Array<string | number> {
  if (kind === "farmer") {
    return [s(r.id), s(r.timestamp), s(r.nama), s(r.noHp), s(r.alamat), s(r.kabupaten),
      Number(r.luasLahan) || 0, s(r.komoditas), s(r.varietas), s(r.estimasiPanen),
      Number(r.estimasiHasilTon) || 0, s(r.statusVerifikasi), s(r.catatanAI)];
  }
  if (kind === "supplier") {
    return [s(r.id), s(r.timestamp), s(r.nama), s(r.kategori), s(r.kontak), s(r.alamat),
      s(r.kabupaten), s(r.statusKemitraan), (r.produkUnggulan || []).join("; "), s(r.stokTersedia),
      Number(r.radiusLayananKm) || 0, s(r.jamBuka), Number(r.petaniBinaanCount) || 0,
      Number(r.latitude) || 0, Number(r.longitude) || 0, s(r.catatan)];
  }
  if (kind === "cash") {
    return [s(r.id), s(r.farmerId), s(r.tanggal), s(r.jenis), s(r.kategori),
      Number(r.jumlahRp) || 0, s(r.komoditas), s(r.musimTanam), s(r.catatan),
      s(r.dicatatOleh), s(r.waktuCatat)];
  }
  if (kind === "commodity") {
    return [s(r.id), s(r.farmerId), s(r.komoditas), s(r.varietas),
      Number(r.luasHa) || 0, s(r.estimasiPanen), Number(r.estimasiHasilTon) || 0,
      s(r.musimTanam), s(r.status), s(r.createdAt), s(r.updatedAt)];
  }
  if (kind === "feedback") {
    return [s(r.id), s(r.tanggal), s(r.nama), s(r.phone), s(r.kategori),
      s(r.pesan), s(r.konteks), s(r.status), s(r.waktuCatat)];
  }
  return [s(r.id), s(r.supplierId), s(r.produk), s(r.satuan), s(r.arah),
    Number(r.qty) || 0, r.hargaSatuanRp === undefined || r.hargaSatuanRp === null ? "" : Number(r.hargaSatuanRp),
    s(r.tanggal), s(r.keterangan), s(r.dicatatOleh), s(r.waktuCatat)];
}

function allOf(kind: SheetKind): any[] {
  if (!deps) return [];
  if (kind === "farmer") return deps.farmers();
  if (kind === "supplier") return deps.suppliers();
  if (kind === "cash") return deps.cash();
  if (kind === "commodity") return deps.commodities();
  if (kind === "feedback") return deps.feedback();
  return deps.stock();
}

function findRec(kind: SheetKind, id: string): any | undefined {
  return allOf(kind).find((r) => r && r.id === id);
}

function saveKind(kind: SheetKind): void {
  if (!deps) return;
  if (kind === "farmer") deps.saveFarmers();
  else if (kind === "supplier") deps.saveSuppliers();
  else if (kind === "cash") deps.saveCash();
  else if (kind === "commodity") deps.saveCommodities();
  else if (kind === "feedback") deps.saveFeedback();
  else deps.saveStock();
}

function kickWorkerSoon(): void {
  if (kickTimer || !workerOn) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    drainSheetsQueue("kick").catch((err) => {
      console.error("[SheetsSync] drain gagal:", (err as Error)?.message || err);
    });
  }, KICK_DEBOUNCE_MS);
}

// Dipanggil dari jalur mutasi (wajib <1ms, tak boleh throw).
export function enqueueSheetSync(kind: SheetKind, id: string): void {
  try {
    if (!kind || !id || !TABS[kind]) return;
    const k = opKey(kind, id);
    const prev = queue.get(k);
    queue.set(k, { kind, id, enqueuedAt: Date.now(), attempts: prev?.attempts || 0, nextRetry: 0 });
    if (queue.size > QUEUE_CAP) {
      const first = queue.keys().next().value as string;
      queue.delete(first);
    }
    queuedTotal++;
    persistQueueSoon();
    kickWorkerSoon();
  } catch (err) {
    console.error("[SheetsSync] enqueue gagal:", (err as Error)?.message || err);
  }
}

export interface DrainResult {
  ok: boolean;
  synced: number;
  appended: number;
  failed: number;
  pending: number;
  busy?: boolean;
  error?: string;
}

export async function drainSheetsQueue(reason: string): Promise<DrainResult> {
  const id = sheetId();
  const sa = loadServiceAccount();
  if (!id || !sa) return { ok: false, synced: 0, appended: 0, failed: 0, pending: queue.size, error: "not configured" };
  if (draining) return { ok: true, synced: 0, appended: 0, failed: 0, pending: queue.size, busy: true };
  const now = Date.now();
  const due = [...queue.values()].filter((o) => o.nextRetry <= now).slice(0, 100);
  if (due.length === 0) return { ok: true, synced: 0, appended: 0, failed: 0, pending: queue.size };
  draining = true;
  lastDrainAt = new Date().toISOString();
  const result: DrainResult = { ok: true, synced: 0, appended: 0, failed: 0, pending: 0 };
  try {
    const updates: Array<{ range: string; values: Array<Array<string | number>> }> = [];
    const appends: SheetOp[] = [];
    for (const o of due) {
      const rec = findRec(o.kind, o.id);
      if (!rec) {
        queue.delete(opKey(o.kind, o.id));
        continue;
      }
      const row = Number(rec.googleSheetRow);
      const spec = TABS[o.kind];
      if (Number.isFinite(row) && row >= 2) {
        updates.push({ range: `${spec.tab}!A${row}:${colName(spec.headers.length)}${row}`, values: [serialize(o.kind, rec)] });
      } else {
        appends.push(o);
      }
    }
    const sendBatch = () =>
      sheetsFetch(sa, id, "/values:batchUpdate", {
        method: "POST",
        body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
      });
    if (updates.length > 0) {
      try {
        await sendBatch();
      } catch (err) {
        if (!isTabMissing(err)) throw err;
        const kinds = [...new Set(due.map((o) => o.kind))];
        for (const k of kinds) await ensureTab(sa, id, k);
        await sendBatch();
      }
      for (const o of due) {
        const rec = findRec(o.kind, o.id);
        if (rec && Number(rec.googleSheetRow) >= 2) {
          queue.delete(opKey(o.kind, o.id));
          result.synced++;
        }
      }
    }
    for (const o of appends) {
      try {
        const rec = findRec(o.kind, o.id);
        if (!rec) {
          queue.delete(opKey(o.kind, o.id));
          continue;
        }
        const spec = TABS[o.kind];
        let out: any;
        try {
          out = await sheetsFetch(sa, id, `/values/${encodeURIComponent(spec.tab)}!A1:append?valueInputOption=RAW`, {
            method: "POST",
            body: JSON.stringify({ values: [serialize(o.kind, rec)] }),
          });
        } catch (err) {
          if (!isTabMissing(err)) throw err;
          await ensureTab(sa, id, o.kind);
          out = await sheetsFetch(sa, id, `/values/${encodeURIComponent(spec.tab)}!A1:append?valueInputOption=RAW`, {
            method: "POST",
            body: JSON.stringify({ values: [serialize(o.kind, rec)] }),
          });
        }
        const m = String(out?.updates?.updatedRange || "").match(/!A(\d+)/);
        if (m) {
          rec.googleSheetRow = Number(m[1]);
          saveKind(o.kind);
        }
        queue.delete(opKey(o.kind, o.id));
        result.appended++;
      } catch (err) {
        failOp(o, err, result);
      }
    }
    lastOkAt = new Date().toISOString();
    lastError = "";
    syncedTotal += result.synced + result.appended;
    console.log(`[SheetsSync] drain(${reason}): +${result.synced} upd +${result.appended} app, sisa ${queue.size}`);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    lastError = msg.slice(0, 300);
    result.ok = false;
    result.error = lastError;
    for (const o of due) {
      if (queue.has(opKey(o.kind, o.id))) failOp(o, err, result);
    }
    console.error(`[SheetsSync] drain(${reason}) gagal:`, msg);
  } finally {
    draining = false;
    result.pending = queue.size;
    persistQueueSoon();
  }
  return result;
}

function failOp(o: SheetOp, err: unknown, result: DrainResult): void {
  const cur = queue.get(opKey(o.kind, o.id));
  if (!cur) return;
  cur.attempts++;
  cur.nextRetry = Date.now() + Math.min(5 * 60 * 1000, 10000 * Math.pow(2, Math.min(cur.attempts, 5)));
  queue.set(opKey(o.kind, o.id), cur);
  result.failed++;
  lastError = String((err as Error)?.message || err).slice(0, 300);
}

// Rekonsiliasi boot: tulis-ulang penuh tiap tab (skala kecil, 4 panggilan).
// Menjamin header + baris + googleSheetRow selalu benar setelah restart.
async function reconcileAll(): Promise<void> {
  const id = sheetId();
  const sa = loadServiceAccount();
  if (!id || !sa) return;
  const kinds: SheetKind[] = ["farmer", "supplier", "cash", "stock", "commodity", "feedback"];
  for (const kind of kinds) {
    const recs = allOf(kind);
    if (recs.length > REWRITE_ROW_GUARD) {
      console.log(`[SheetsSync] tab ${TABS[kind].tab} >${REWRITE_ROW_GUARD} baris, tulis-ulang boot dilewati (andalkan antrean)`);
      continue;
    }
    const spec = TABS[kind];
    const values = [spec.headers, ...recs.map((r) => serialize(kind, r))];
    const send = () =>
      sheetsFetch(sa, id, `/values/${encodeURIComponent(spec.tab)}!A1?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ values }),
      });
    try {
      await send();
    } catch (err) {
      if (!isTabMissing(err)) throw err;
      await ensureTab(sa, id, kind);
      await send();
    }
    recs.forEach((r, i) => {
      r.googleSheetRow = i + 2;
    });
    saveKind(kind);
  }
  queue.clear();
  persistQueueSoon();
  lastOkAt = new Date().toISOString();
  syncedTotal += 1;
  console.log("[SheetsSync] rekonsiliasi boot selesai");
}

export function getSheetsStatus(): Record<string, unknown> {
  const id = sheetId();
  return {
    configured: isSheetsConfigured(),
    sheetIdTail: id ? `…${id.slice(-4)}` : "",
    workerOn,
    queueDepth: queue.size,
    queuedTotal,
    syncedTotal,
    lastOkAt,
    lastError,
    lastDrainAt,
  };
}

// Info baca-saja via API key (tanpa service account): membuktikan ID+key benar
// dan dipakai sebagai oracle independen verifikasi tulis. Tak pernah throw.
let remoteCache: { at: number; data: Record<string, unknown> | null } = { at: 0, data: null };
export async function getSheetsRemote(): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  if (now - remoteCache.at < 5 * 60 * 1000) return remoteCache.data;
  const id = sheetId();
  const key = (process.env.GOOGLE_DRIVE_SHEETS_API_KEY || "").trim();
  if (!id || !key) {
    remoteCache = { at: now, data: null };
    return null;
  }
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties.title&key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as any;
    remoteCache = {
      at: now,
      data: {
        title: String(j?.properties?.title || ""),
        tabs: ((j?.sheets || []) as any[]).map((t) => String(t?.properties?.title || "")).filter(Boolean),
      },
    };
  } catch (err) {
    remoteCache = { at: now, data: { error: String((err as Error)?.message || err).slice(0, 120) } };
  }
  return remoteCache.data;
}

export function initSheetsSync(d: SheetsDeps): void {
  deps = d;
  loadQueue();
  if (workerOn) return;
  workerOn = true;
  const timer = setInterval(() => {
    drainSheetsQueue("timer").catch((err) => {
      console.error("[SheetsSync] drain timer gagal:", (err as Error)?.message || err);
    });
  }, DRAIN_EVERY_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  setTimeout(() => {
    if (!isSheetsConfigured()) {
      console.log("[SheetsSync] nonaktif (isi GOOGLE_SHEETS_ID + kredensial service account untuk mengaktifkan)");
      return;
    }
    reconcileAll().catch((err) => {
      lastError = String((err as Error)?.message || err).slice(0, 300);
      console.error("[SheetsSync] rekonsiliasi boot gagal:", lastError);
    });
  }, BOOT_RECONCILE_DELAY_MS);
}
