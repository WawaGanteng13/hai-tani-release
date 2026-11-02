// Gate peran-kontekstual: petani yang chat mencari barang diproses sebagai buyer.
// - Demand panen tak memasukkan stok sendiri sebagai kandidat.
// - Demand saprodi tercatat sebagai kebutuhan (NDB-xxx), bukan OFR.
// Pakai: node docs/fase3/role-context-gate.js [baseUrl]
// Butuh seed: node docs/fase3/seed-ci-users.js (TANI-FFF + stok kentang).
// FORWARD_SECRET: env dulu, lalu .env (tidak di-commit).
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${String(detail || '').slice(0, 200)}`); }
}

const FARMER = '6281110001001'; // TANI-FFF: petani kentang + stok 1 ton (seed)

let r = await chat(FARMER, 'butuh kentang 2 ton');
check('demand-tanpa-stok-sendiri', /OFR-\d+/.test(r.json.reply || '') && /Belum ada petani yang lapor stok/.test(r.json.reply || '') && !/CI Kentang Tani/.test(r.json.reply || ''), r.json.reply);
await sleep(2000);

r = await chat(FARMER, 'butuh pupuk urea 2 sak');
check('saprodi-jadi-kebutuhan', /NDB-\d+/.test(r.json.reply || '') && /pupuk urea/.test(r.json.reply || '') && /PUPUK/.test(r.json.reply || ''), r.json.reply);
await sleep(2000);

r = await chat(FARMER, 'kebutuhan saya');
check('status-kebutuhan', /pupuk urea/.test(r.json.reply || '') && /NDB-/.test(r.json.reply || ''), r.json.reply);

console.log(`\nringkas: ${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
