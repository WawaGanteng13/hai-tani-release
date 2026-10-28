// Pekerja XLSX terisolasi: parse di worker thread agar berkas crafted
// (proto-pollution / ReDoS SheetJS) tidak menyentuh proses utama.
// Polusi prototipe (bila ada) mati bersama worker sekali pakai ini.
const { parentPort, workerData } = require("worker_threads");

try {
  const XLSX = require("xlsx");
  const buf = Buffer.from(workerData.b64, "base64");
  const wb = XLSX.read(buf, { type: "buffer", sheetStubs: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("lembar kerja kosong");
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const rows = aoa.map((r) => (r || []).map((c) => String(c ?? "").trim()));
  parentPort.postMessage({ ok: true, rows });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
