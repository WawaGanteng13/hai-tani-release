// Gate fulfil pasca-DEAL: ALAMAT -> FOTO -> KIRIM -> BAYAR -> SELESAI.
// - deal oke -> fulfil ALAMAT + buyer ditanya alamat.
// - Alamat teks / ShareLoc -> FOTO + seller diminta foto.
// - Foto seller -> juri (stub CI) -> cocok diteruskan + buyer FOTO_OK.
// - foto oke -> KIRIM; jadwal seller -> BAYAR; sudah bayar -> TERIMA_UANG;
//   uang masuk -> SELESAI. Minta foto + teruskan lokasi tercakup.
// Pakai: node docs/fase3/deal-fulfil-gate.js [baseUrl]
// Butuh: seed-ci-users.js + DISABLE_WA_OUTBOUND=true + DISABLE_VISION_JUDGE=true.
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

function post(pathname, body) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
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
const chat = (senderPhone, message, extra) => post('/api/chat', { senderPhone, message, ...(extra || {}) });

function readDb(name) {
  try { const v = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
const offer = (id) => readDb('offers_db.json').find((x) => x.id === id);
const user = (phone) => readDb('users_db.json').find((x) => x.phone === phone);
const evs = (id, phase) => readDb('events_db.json').filter((e) => e.entityId === id && e.action === 'notify' && (!phase || e.payload?.phase === phase));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${String(detail || '').slice(0, 300)}`); }
}

const B_FF = '6270999999021'; // buyer fulfil (tomat)
const S_FF = '6270999999022'; // TANI-041 (Tomat, terisolasi)

// 0. Rakit order -> DEAL (tomat 200 kg).
let r = await chat(B_FF, 'butuh tomat 200 kg');
const mid = String(r.json.reply || '').match(/\b(OFR-\d+)\b/);
const oid = mid ? mid[1] : '';
await sleep(1200);
r = await chat(B_FF, 'budget 6000');
await sleep(1200);
r = await chat(S_FF, 'jual tomat 5rb'); // NB: angka telanjang ditolak parser
await sleep(2500);
r = await chat(B_FF, 'deal oke');
await sleep(1200);

// 1. Kickoff: DEAL -> fulfil ALAMAT + buyer ditanya alamat.
{
  const o = offer(oid);
  const ub = user(B_FF);
  check('fulfil-kickoff-alamat', !!oid && o?.status === 'DEAL' && o?.fulfil === 'ALAMAT'
    && ub?.pendingAsk?.kind === 'ALAMAT' && ub?.pendingAsk?.offerId === oid
    && /Alamat kirim ke mana/.test(String(r.json.reply || '')), `${oid} fulfil=${o?.fulfil} ask=${JSON.stringify(ub?.pendingAsk)}`);
}
await sleep(1200);

// 2. Alamat teks -> FOTO + seller diminta foto.
r = await chat(B_FF, 'Jl. Raya Tani No. 12, Desa Ciherang, Bogor');
await sleep(1200);
{
  const o = offer(oid);
  check('fulfil-alamat-ke-foto', o?.fulfil === 'FOTO' && String(o?.alamatKirim || '').includes('Ciherang')
    && evs(oid, 'foto-request').length >= 1 && /Alamat tercatat/.test(String(r.json.reply || '')), `fulfil=${o?.fulfil} alamat=${o?.alamatKirim}`);
}
await sleep(1200);

// 3-4. Foto seller -> LOLOS (stub) + buyer FOTO_OK; caption jadwal tercatat.
const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
r = await post('/api/wa-media', { kind: 'image', base64: px, mimeType: 'image/png', senderPhone: S_FF, waId: 'wamid.test1', caption: 'kirim besok jam 9', filename: '' });
await sleep(800);
{
  const o = offer(oid);
  const ub = user(B_FF);
  check('fulfil-foto-lolos', /LOLOS penilaian/.test(String(r.json.reply || '')) && !!o?.fotoMediaPath
    && ub?.pendingAsk?.kind === 'FOTO_OK' && evs(oid, 'foto-cocok').length === 1, `${r.json.reply} || media=${o?.fotoMediaPath}`);
  check('fulfil-foto-caption-jadwal', String(o?.jadwalKirim || '').includes('besok'), `jadwal=${o?.jadwalKirim}`);
}
await sleep(1200);

// 5. Minta foto (dry) -> catatan uji.
r = await chat(B_FF, 'minta foto');
check('fulfil-minta-foto', /mode uji/.test(String(r.json.reply || '')) && String(r.json.reply || '').includes(oid), r.json.reply);
await sleep(1200);

// 6. Foto oke -> KIRIM + seller diminta jadwal.
r = await chat(B_FF, 'foto oke');
await sleep(1200);
{
  const o = offer(oid);
  const us = user(S_FF);
  check('fulfil-foto-oke-ke-kirim', o?.fulfil === 'KIRIM' && us?.pendingAsk?.kind === 'JADWAL_KIRIM'
    && /Foto disetujui/.test(String(r.json.reply || '')), `fulfil=${o?.fulfil} ask=${JSON.stringify(us?.pendingAsk)}`);
}
await sleep(1200);

// 7. Jadwal seller -> BAYAR + buyer diminta bayar.
r = await chat(S_FF, 'kirim besok jam 9 pagi');
await sleep(1200);
{
  const o = offer(oid);
  const ub = user(B_FF);
  check('fulfil-jadwal-ke-bayar', o?.fulfil === 'BAYAR' && String(o?.jadwalKirim || '').includes('jam 9')
    && ub?.pendingAsk?.kind === 'BAYAR' && /Jadwal tercatat/.test(String(r.json.reply || '')), `fulfil=${o?.fulfil} jadwal=${o?.jadwalKirim}`);
}
await sleep(1200);

// 8. Sudah bayar -> seller diminta konfirmasi terima.
r = await chat(B_FF, 'sudah bayar');
await sleep(1200);
{
  const us = user(S_FF);
  check('fulfil-bayar-ke-terima', us?.pendingAsk?.kind === 'TERIMA_UANG' && /konfirmasi/.test(String(r.json.reply || '')), `${r.json.reply} || ask=${JSON.stringify(us?.pendingAsk)}`);
}
await sleep(1200);

// 9. Uang masuk -> SELESAI.
r = await chat(S_FF, 'uang masuk');
await sleep(800);
{
  const o = offer(oid);
  check('fulfil-terima-ke-selesai', o?.fulfil === 'SELESAI' && !!o?.selesaiAt && /SELESAI/.test(String(r.json.reply || '')), `fulfil=${o?.fulfil}`);
}
await sleep(1200);

// 10. Status menampilkan progres selesai.
r = await chat(B_FF, 'cek penawaran');
check('fulfil-status-selesai', String(r.json.reply || '').includes(oid) && /selesai/i.test(String(r.json.reply || '')), r.json.reply);
await sleep(1200);

// 11-12. Order kedua: ShareLoc buyer mengisi alamat -> FOTO.
r = await chat(B_FF, 'butuh tomat 50 kg');
const mid2 = String(r.json.reply || '').match(/\b(OFR-\d+)\b/);
const oid2 = mid2 ? mid2[1] : '';
await sleep(1200);
r = await chat(B_FF, 'budget 6000');
await sleep(1500);
if (offer(oid2)?.status !== 'COCOK') { r = await chat(S_FF, 'jual tomat 5rb'); await sleep(2500); }
r = await chat(B_FF, 'deal oke');
await sleep(1200);
r = await post('/api/wa-location', { latitude: -6.6, longitude: 106.8, name: 'Rumah Buyer', address: 'Bogor', senderPhone: B_FF, waId: 'wamid.testloc1' });
await sleep(800);
{
  const o = offer(oid2);
  check('fulfil-shareloc-alamat', !!oid2 && o?.fulfil === 'FOTO' && /tercatat/.test(String(r.json.reply || '')), `${oid2} fulfil=${o?.fulfil} reply=${r.json.reply}`);
  check('fulfil-shareloc-maps', String(o?.alamatKirim || '').includes('maps.google'), `alamat=${o?.alamatKirim}`);
}
await sleep(1200);

// 13. Teruskan lokasi (buyer -> seller) tercatat.
r = await chat(B_FF, `teruskan lokasi ${oid2}`);
await sleep(500);
check('fulfil-teruskan-lokasi', /diteruskan/.test(String(r.json.reply || '')) && evs(oid2, 'lokasi-forward-cmd').length === 1, `${r.json.reply}`);
await sleep(1200);

// 14. ShareLoc seller diteruskan ke buyer.
r = await post('/api/wa-location', { latitude: -6.61, longitude: 106.81, name: 'Kebun', address: '', senderPhone: S_FF, waId: 'wamid.testloc2' });
await sleep(500);
check('fulfil-seller-shareloc', String(r.json.reply || '').includes(oid2) && evs(oid2, 'lokasi-forward').length === 1, `${r.json.reply}`);

console.log(`\nringkas: ${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
