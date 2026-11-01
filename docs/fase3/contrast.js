// Hitung rasio kontras WCAG untuk pasangan warna Hai Tani.
// Pakai: node docs/fase3/contrast.js. Metodologi bukti Fase 3 (3/3).
const P = [
  ['emerald-700 teks di putih', '#047857', '#ffffff'],
  ['slate-900 teks di putih', '#0f172a', '#ffffff'],
  ['slate-600 teks di putih', '#475569', '#ffffff'],
  ['slate-500 teks di putih', '#64748b', '#ffffff'],
  ['slate-400 teks di putih', '#94a3b8', '#ffffff'],
  ['rose-700 teks di rose-50', '#be123c', '#fff1f2'],
  ['putih di emerald-700 (tombol)', '#ffffff', '#047857'],
  ['emerald-200 di emerald-950', '#a7f3d0', '#022c22'],
  ['putih di emerald-950', '#ffffff', '#022c22'],
  ['slate-300 di slate-900', '#cbd5e1', '#0f172a'],
  ['emerald-400 di slate-900', '#34d399', '#0f172a'],
];
function lum(hex) {
  const c = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
for (const [nama, fg, bg] of P) {
  const l1 = lum(fg), l2 = lum(bg);
  const r = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  console.log(`${r.toFixed(2)} ${r >= 7 ? 'AAA' : r >= 4.5 ? 'AA ' : r >= 3 ? 'AA-BESAR' : 'GAGAL'} ${nama}`);
}
