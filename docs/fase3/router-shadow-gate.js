// Router-shadow gate: regresi anti-salah-cabang hasil audit WA router Nov-2026.
// - P0: pupuk-vs-harga, daftar-harga, pesan/bantuan, stok-rumah-tangga,
//   harga-saat-pending, catat-supplier-vs-kas.
// - P1: oke/siap-saat-pending, kios-vs-stok, spek-saat-pending, sak,
//   komoditas-semu, LOC_ASK-demand, toko-vs-harga, batal-sopan.
// Pakai: node docs/fase3/router-shadow-gate.js [baseUrl]
// Butuh seed: node docs/fase3/seed-ci-users.js (OFR-900x + KMD-CI2/CI3).
// Citizens: reply asserts + DB asserts (DATA_DIR-aware).
// FORWARD_SECRET: env dulu, lalu .env (tidak di-commit).
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');

function forwardSecret() {
  try {
    const fromEnv = (process.env.FORWARD_SECRET || '').trim();
    if (fromEnv) return fromEnv;
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^FORWARD_SECRET=(.+)$/m);
    return (m ? m[1] : '').trim();
  } catch { return ''; }
}
const FS = forwardSecret();

function chat(senderPhone, message) {
  return new Promise((resolve) => {
    const u = new URL('/api/chat', BASE);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify({ senderPhone, message }));
    const r = lib.request(u, {
      method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'x-tani-forward-secret': FS },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, json: {} }); } });
    });
    r.on('timeout', () => { r.destroy(); resolve({ code: 'timeout', json: {} }); });
    r.on('error', () => resolve({ code: 'error', json: {} }));
    r.write(payload);
    r.end();
  });
}

function readDb(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${String(detail || '').slice(0, 250)}`); }
}

const B_BATAL = '6270999999001'; // BUDGET OFR-9002
const B_SPK = '6270999999002'; // BUDGET OFR-9003
const B_DEAL = '6270999999003'; // KONFIRM_DEAL OFR-9004
const P25 = '6270999999004'; // SPEK_OK OFR-9005 (TANI-025)
const LOC = '6270999999005'; // LOC_ASK
const F16 = '62859106513135'; // TANI-016: KMD Padi + Beras
const FFF = '6281110001001'; // TANI-FFF (residu BUDGET role-context tidak masalah)
const ADMIN = '081234567890';

// P1-18: komoditas semu bukan order (pending BUDGET B_SPK tetap bertahan).
let r = await chat(B_SPK, 'perlu info harga 5 kg beras');
check('p1-18-komoditas-semu', /harga/i.test(r.json.reply || '') && !/OFR-\d+/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P1-17: "spesifikasi: ..." lolos BUDGET pending ke mSpek.
r = await chat(B_SPK, 'spesifikasi: ukuran besar');
{
  const offers = readDb('offers_db.json') || [];
  const o = offers.find((x) => x.id === 'OFR-9003');
  check('p1-17-spek-lolos-pending', /spek|spesifikasi/i.test(r.json.reply || '') && !/Balas angka budget/.test(r.json.reply || '') && /ukuran besar/i.test(String(o?.spesifikasi || '')), `${r.json.reply} || spek=${o?.spesifikasi}`);
}
await sleep(1500);

// P1-13: "tolong batal OFR-9002" saat BUDGET pending.
r = await chat(B_BATAL, 'tolong batal OFR-9002');
{
  const offers = readDb('offers_db.json') || [];
  const o = offers.find((x) => x.id === 'OFR-9002');
  check('p1-13-batal-sopan', /dibatalkan/i.test(r.json.reply || '') && !/Balas angka/.test(r.json.reply || '') && o?.status === 'BATAL', `${r.json.reply} || status=${o?.status}`);
}
await sleep(1500);

// P1-1: "oke" saat KONFIRM_DEAL pending (tanpa draf) -> pending, bukan smalltalk.
r = await chat(B_DEAL, 'oke');
check('p1-1-oke-milik-pending', /belum COCOK/.test(r.json.reply || '') && !/Sama-sama/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P1-25: "siap" jawaban SPEK_OK (tanpa draf) -> spekOk=true, bukan smalltalk.
r = await chat(P25, 'siap');
{
  const offers = readDb('offers_db.json') || [];
  const o = offers.find((x) => x.id === 'OFR-9005');
  const ln = (o?.lines || []).find((l) => l.farmerId === 'TANI-025');
  check('p1-25-siap-milik-pending', /sanggup|Siap/.test(r.json.reply || '') && !/Sama-sama/.test(r.json.reply || '') && ln?.spekOk === true, `${r.json.reply} || spekOk=${ln?.spekOk}`);
}
await sleep(1500);

// P0-4: stok rumah tangga bukan lapor stok jual (DB tidak berubah).
r = await chat(F16, 'ada beras 5 kg di rumah untuk makan');
{
  const kmd = readDb('komoditas_db.json') || [];
  const row = kmd.find((x) => x.id === 'KMD-CI3');
  check('p0-4-stok-rumah-tangga', !/tercatat: siap|Stok \*beras\* tercatat/.test(r.json.reply || '') && row?.stokSiapJualTon === undefined, `${r.json.reply} || stok=${row?.stokSiapJualTon}`);
}
await sleep(1500);

// P1-14: "stok padi 50 sak" tercatat (1 sak = 50 kg) + picu HARGA_JUAL pending.
r = await chat(F16, 'stok padi 50 sak');
{
  const kmd = readDb('komoditas_db.json') || [];
  const row = kmd.find((x) => x.id === 'KMD-CI2');
  check('p1-14-sak-dicatat', /tercatat: siap/.test(r.json.reply || '') && /asumsi 1 sak = 50 kg/.test(r.json.reply || '') && Number(row?.stokSiapJualTon) === 2.5, `${r.json.reply} || stok=${row?.stokSiapJualTon}`);
}
await sleep(1500);

// P0-5: "cek harga cabai" lolos HARGA_JUAL pending (retensi dibuktikan cek berikut).
r = await chat(F16, 'cek harga cabai');
check('p0-5-harga-lolos-pending', /harga|Rp/.test(r.json.reply || '') && !/Balas angka harga saja/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P0-5 lanjutan: pending bertahan — "8000" mengisi harga (bukan re-prompt basi).
r = await chat(F16, '8000');
{
  const offers = readDb('offers_db.json') || [];
  const o = offers.find((x) => x.id === 'OFR-9005');
  const ln = (o?.lines || []).find((l) => l.farmerId === 'TANI-016');
  check('p0-5-pending-retained', /8000|8\.000|tercatat/i.test(r.json.reply || '') && Number(ln?.hargaPetaniPerKg) === 8000, `${r.json.reply} || harga=${ln?.hargaPetaniPerKg}`);
}
await sleep(1500);

// P1-2: gerakan kios bukan lapor stok jual.
r = await chat(F16, 'stok padi keluar 50 kg kios tani makmur');
check('p1-2-kios-bukan-stok-jual', !/tercatat: siap/.test(r.json.reply || '') && /kios|stok/i.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P0-2: "minta daftar harga gabah" milik cabang harga.
r = await chat(F16, 'minta daftar harga gabah');
check('p0-2-daftar-harga', /harga|Rp/.test(r.json.reply || '') && !/belum lengkap|Draf Data/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P0-1: "cek harga pupuk urea" milik cabang harga, bukan dosis.
r = await chat(FFF, 'cek harga pupuk urea');
check('p0-1-harga-bukan-dosis', /harga/i.test(r.json.reply || '') && !/dosis|takaran|pemupukan|rekomendasi/i.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P1-5: harga di toko bukan pendaftaran supplier.
r = await chat(FFF, 'berapa harga pupuk di toko tani makmur?');
check('p1-5-harga-di-toko', /harga|Rp/.test(r.json.reply || '') && !/Draf Data Supplier/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P0-3: kata benda bukan niat beli (F16 kini bersih dari pending).
r = await chat(F16, 'pesan saya belum dibaca');
check('p0-3a-pesan-bukan-beli', !/Mau beli/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

r = await chat(F16, 'perlu bantuan admin');
check('p0-3b-bantuan-bukan-beli', !/Mau beli/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P1-19: obat manusia bukan kebutuhan saprodi (respons 200 = tidak hang).
r = await chat(F16, 'butuh obat cacing 2 botol untuk anak');
check('p1-19-obat-manusia', r.code === 200 && (r.json.reply || '').length > 0 && !/NDB-|Kebutuhan dicatat|Mau beli/.test(r.json.reply || ''), `${r.code} ${r.json.reply}`);
await sleep(1500);

// P0-6: bersihkan dulu OFR residu ADMIN (role-context), lalu catat supplier.
{
  const st = await chat(ADMIN, 'cek penawaran');
  await sleep(1500);
  const mid = String(st.json.reply || '').match(/\b(OFR-\d+)\b/);
  if (mid) { await chat(ADMIN, `batal ${mid[1]}`); await sleep(1500); }
}
r = await chat(ADMIN, 'catat supplier baru Kios Tani Makmur 081234567891');
check('p0-6-supplier-bukan-kas', /supplier/i.test(r.json.reply || '') && !/Kas tercatat|Draf Data Petani/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// P1-24: demand saat LOC_ASK diproses (bukan ditelan jadi label lokasi).
r = await chat(LOC, 'butuh kentang 2 ton');
{
  const users = readDb('users_db.json') || [];
  const u = users.find((x) => x.phone === '6270999999005');
  check('p1-24-demand-lolos-locask', /OFR-\d+|berapa banyak/.test(r.json.reply || '') && u?.onboardingState !== 'LOC_ASK' && !/butuh/i.test(String(u?.locLabel || u?.alamat || '')), `${r.json.reply} || state=${u?.onboardingState}`);
}

console.log(`\nringkas: ${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
