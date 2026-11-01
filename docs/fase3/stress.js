// Uji stres Hai Tani: 100 req/detik endpoint baca + probe chat ringan.
// Pakai: node docs/fase3/stress.js [baseUrl]
// Tanpa dependensi. Metedologi bukti Fase 3 (2/3).
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const DIR = path.dirname(fileURLToPath(import.meta.url));

function req(path, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const u = new URL(path, BASE);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = opts.body ? Buffer.from(opts.body) : null;
    const headers = { ...(opts.headers || {}) };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = lib.request(
      u,
      { method: opts.method || 'GET', timeout: 15000, headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, ms: Date.now() - t0, code: res.statusCode }));
      }
    );
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, ms: Date.now() - t0, code: 'timeout' }); });
    r.on('error', () => resolve({ ok: false, ms: Date.now() - t0, code: 'error' }));
    if (payload) r.write(payload);
    r.end();
  });
}

function ringkas(lat) {
  const s = [...lat].sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.length ? s[s.length - 1] : 0 };
}

async function faseBaca(rps, detik) {
  const paths = ['/api/health', '/api/publik/ringkas', '/api/harga-pasar', '/api/harga-pasar?sumber=buah'];
  const lat = [];
  let ok = 0, gagal = 0, i = 0;
  const t0 = Date.now();
  const tiap = 1000 / rps;
  while (Date.now() - t0 < detik * 1000) {
    const target = t0 + i * tiap;
    const tunggu = target - Date.now();
    if (tunggu > 0) await new Promise((r) => setTimeout(r, tunggu));
    i++;
    req(paths[i % paths.length]).then((h) => {
      lat.push(h.ms);
      if (h.ok) ok++; else gagal++;
    });
  }
  await new Promise((r) => setTimeout(r, 3000));
  const aktual = (lat.length / ((Date.now() - t0) / 1000)).toFixed(1);
  return { rpsTarget: rps, rpsAktual: Number(aktual), ok, gagal, ...ringkas(lat) };
}

function forwardSecret() {
  try {
    const env = fs.readFileSync(path.join(DIR, '..', '..', '.env'), 'utf8');
    const m = env.match(/^FORWARD_SECRET=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

async function faseChat(n) {
  // 'menu' = balasan statis tanpa LLM; nomor pengirim diputar agar anti-spam tidak aktif.
  const lat = [];
  let ok = 0, gagal = 0;
  const fwd = forwardSecret();
  for (let i = 0; i < n; i++) {
    const no = `628990000${String(1000 + i)}`;
    const h = await req('/api/chat', {
      method: 'POST',
      headers: { 'x-tani-forward-secret': fwd },
      body: JSON.stringify({ message: 'menu', senderPhone: no }),
    });
    lat.push(h.ms);
    if (h.ok && h.code === 200) ok++; else gagal++;
  }
  return { n, ok, gagal, ...ringkas(lat) };
}

(async () => {
  console.log(JSON.stringify({ base: BASE, mulai: new Date().toISOString() }));
  const rps = Number(process.argv[3]) || 100;
  const detik = Number(process.argv[4]) || 30;
  const baca = await faseBaca(rps, detik);
  console.log('BACA_100RPS_30D ' + JSON.stringify(baca));
  const chat = await faseChat(20);
  console.log('CHAT_MENU_20 ' + JSON.stringify(chat));
})();
