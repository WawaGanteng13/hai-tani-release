// Gate notifikasi order ke petani (OFR-047: order tanpa kabar).
// - OFR baru memicu notify 1x per (offer, farmer): teks bila inbound <24 jam,
//   template opener bila basi (mode dry: tanpa HTTP, cabang tercatat di event).
// - Dedupe: demand ulang komoditas sama tidak mengirim ulang.
// - Digest nudge: petani yang chat melihat pesanan menunggu harga.
// - lastInboundAt dicap tiap chat masuk.
// Pakai: node docs/fase3/order-notify-gate.js [baseUrl]
// Butuh: seed-ci-users.js + DISABLE_WA_OUTBOUND=true di server.
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
  try { const v = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${String(detail || '').slice(0, 250)}`); }
}

const B_NTF = '6270999999011';
const F_NTF = '6270999999012'; // inbound baru -> teks
const F_OLD = '6270999999014'; // inbound basi -> template

// 1. Order baru -> kedua petani ditandai + event cabang benar.
let r = await chat(B_NTF, 'butuh bawang 2 ton');
const mid = String(r.json.reply || '').match(/\b(OFR-\d+)\b/);
const oid = mid ? mid[1] : '';
{
  const offers = readDb('offers_db.json');
  const o = offers.find((x) => x.id === oid);
  const flags = o?.notifiedFarmerIds || [];
  const evs = readDb('events_db.json').filter((e) => e.entityId === oid && e.action === 'notify');
  const ch = Object.fromEntries(evs.map((e) => [e.payload?.farmerId, e.payload?.channel]));
  check('notify-cabang-teks-template', !!oid && flags.includes('TANI-031') && flags.includes('TANI-032') && ch['TANI-031'] === 'text' && ch['TANI-032'] === 'template', `${oid} flags=${JSON.stringify(flags)} ch=${JSON.stringify(ch)}`);
}
await sleep(1500);

// 2. Demand ulang -> tidak kirim ulang.
r = await chat(B_NTF, 'butuh bawang 2 ton');
{
  const offers = readDb('offers_db.json');
  const o = offers.find((x) => x.id === oid);
  const evs = readDb('events_db.json').filter((e) => e.entityId === oid && e.action === 'notify');
  check('notify-dedupe', (o?.notifiedFarmerIds || []).length === 2 && evs.length === 2, `flags=${JSON.stringify(o?.notifiedFarmerIds)} evs=${evs.length}`);
}
await sleep(1500);

// 3. Digest nudge: petani chat -> lihat pesanan menunggu harga.
r = await chat(F_NTF, 'halo');
check('nudge-digest-order', r.json.reply?.includes(oid) && /menunggu harga/.test(r.json.reply || ''), r.json.reply);
await sleep(1500);

// 4. lastInboundAt dicap pada chat masuk.
{
  const users = readDb('users_db.json');
  const ub = users.find((x) => x.phone === B_NTF);
  const uf = users.find((x) => x.phone === F_NTF);
  const fresh = (v) => v && Date.now() - Date.parse(v) < 10 * 60e3;
  check('lastinbound-dicap', fresh(ub?.lastInboundAt) && fresh(uf?.lastInboundAt), `buyer=${ub?.lastInboundAt} farmer=${uf?.lastInboundAt}`);
}

console.log(`\nringkas: ${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
