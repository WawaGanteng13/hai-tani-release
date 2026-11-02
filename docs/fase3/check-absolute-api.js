// Regression gate: no relative backend URLs in the web client.
// On Vercel the frontend origin only serves the WA webhook forwarder;
// every other /api/* path must go through the api()/apiUrl() helper
// (VITE_BACKEND_URL) or it 404s. Pakai: node docs/fase3/check-absolute-api.js
// Note: exemption is lexical (helper identifier on the same line as the
// literal), not dataflow — a tripwire against regressions, not a prover.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(DIR, '..', '..', 'src');
const LITERAL = /['"`}]\/api\//; // a quoted/embedded backend-path literal
const EXEMPT = [
  /API_BASE/, // same-line base prefix
  /\bapiUrl\s*\(/, // apiUrl(...) — helper adds the base
  /\bapi\s*\(/, // api(...) — helper adds the base
  /token\s*===/, // string comparison, not a request sink
  /\.startsWith\(\s*['"`]\/api/, // main.tsx fetch patch matcher
  /SAME-ORIGIN-OK/, // explicit opt-out: genuinely same-origin (Vercel forwarder URL)
];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(e.name) && !p.endsWith(`${path.sep}api.ts`)) yield p;
  }
}

let failures = 0;
for (const file of walk(SRC)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (LITERAL.test(line) && !EXEMPT.some((re) => re.test(line))) {
      failures++;
      console.log(`FAIL ${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    }
  });
}
if (failures === 0) console.log('PASS check-absolute-api: no relative /api sinks');
else console.log(`\nringkas: ${failures} relatif /api ditemukan`);
process.exit(failures === 0 ? 0 : 1);
