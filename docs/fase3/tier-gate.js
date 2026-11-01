// Gate tier langganan Hai Tani: perintah "langganan" + kartu QR khusus Tumbuh+.
// Pakai: node docs/fase3/tier-gate.js [baseUrl]
// Tanpa dependensi. FORWARD_SECRET dibaca dari .env (tidak di-commit).
// Identitas uji: TANI-017/016 (consented, FREE) + TANI-013 (TOS_SENT) + nomor segar.
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

const FARMER_FREE_1 = '6287864771451'; // TANI-017 consented FREE
const FARMER_FREE_2 = '62859106513135'; // TANI-016 consented FREE
const FARMER_TOS = '6285954250334'; // TANI-013 TOS_SENT
const FRESH = '6270999999013'; // nomor segar -> gate TOS

let r = await chat(FARMER_FREE_1, 'langganan');
check('langganan-info', /Langganan Hai Tani/.test(r.json.reply || '') && /rekening Hai Tani/.test(r.json.reply || '') && /\*FREE\*/.test(r.json.reply || ''), r.json.reply);
await sleep(2000);

r = await chat(FARMER_FREE_2, 'kartu saya');
check('kartu-upsell-free', /Tumbuh/.test(r.json.reply || '') && /langganan/.test(r.json.reply || '') && !/Unduh PDF/.test(r.json.reply || ''), r.json.reply);
await sleep(2000);

r = await chat(FARMER_TOS, 'info langganan');
check('langganan-pre-consent', /Langganan Hai Tani/.test(r.json.reply || ''), r.json.reply);
await sleep(2000);

r = await chat(FRESH, 'kartu saya');
check('kartu-tos-gate', /SETUJU/.test(r.json.reply || ''), r.json.reply);

console.log(`\nringkas: ${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
