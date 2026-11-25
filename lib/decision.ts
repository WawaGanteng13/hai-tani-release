// Klasifikasi intent chat: daftar intent + prompt + parser respons Gemini.
// Dipakai server.ts (getGeminiIntent). Kriteria di-port dari QUESTIONS
// laya_sidecar.py agar 8 intent identik di kedua engine.
// Uji mandiri (pola lib/sheet-row.ts): npx tsx lib/decision.ts
import assert from "node:assert/strict";

export const DECISION_INTENTS = [
  "daftar_lahan",
  "cek_harga",
  "hama_pupuk",
  "supplier",
  "catat_kas",
  "catat_stok",
  "hitung_hpp",
  "lain",
] as const;
export type DecisionIntent = (typeof DECISION_INTENTS)[number];

export const DECISION_CRITERIA: Record<DecisionIntent, string> = {
  daftar_lahan: "register farmer/land: name, land area (hectare/m2/are), village, commodity, harvest estimate",
  cek_harga: "market price info, price up/down, price anomaly, cheap-market operation, buy cost",
  hama_pupuk: "pest, plant disease, fertilizer/pesticide dosage, leaf symptoms, consultation",
  supplier: "farm shop/kiosk, distributor, agent, cooperative, offtaker, saprodi seller",
  catat_kas: "record farm money: expense, income, harvest sale, cost, rupiah, cash ledger",
  catat_stok: "kiosk stock in/out, inventory balance, remaining goods, stock opname",
  hitung_hpp: "production cost per kilo (HPP), margin, break-even, profit per kilo",
  lain: "greeting, thanks, smalltalk, anything else",
};

const PROMPT_TEXT_MAX = 1000;

export function buildDecisionPrompt(text: string): string {
  const clean = String(text || "").replace(/"""/g, "''").slice(0, PROMPT_TEXT_MAX);
  const lines = DECISION_INTENTS.map((id) => `- ${id}: ${DECISION_CRITERIA[id]}`).join("\n");
  return (
    `Klasifikasikan maksud petani dalam TEKS ke tepat satu INTENT berikut.\n${lines}\n` +
    `Jawab HANYA dengan JSON valid tanpa teks lain: {"intent":"<salah satu di atas>","confidence":<0.0-1.0>}\n` +
    `TEKS:\n"""${clean}"""`
  );
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "string" ? Number(v.trim()) : (v as number);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function parseDecisionResponse(raw: string): { intent: DecisionIntent; confidence: number } | null {
  const t = String(raw || "")
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/```\s*$/, "")
    .trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: any = null;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const intent = String(o.intent ?? "").trim().toLowerCase();
  if (!(DECISION_INTENTS as readonly string[]).includes(intent)) return null;
  return { intent: intent as DecisionIntent, confidence: clampConfidence(o.confidence) };
}

if (typeof process !== "undefined" && process.argv?.[1]?.includes("decision")) {
  assert.deepEqual(parseDecisionResponse('{"intent":"cek_harga","confidence":0.82}'), {
    intent: "cek_harga",
    confidence: 0.82,
  });
  assert.deepEqual(parseDecisionResponse('```json\n{"intent":"supplier","confidence":0.6}\n```'), {
    intent: "supplier",
    confidence: 0.6,
  });
  assert.deepEqual(parseDecisionResponse('Hasilnya {"intent":"hama_pupuk","confidence":0.9} ya.'), {
    intent: "hama_pupuk",
    confidence: 0.9,
  });
  assert.equal(parseDecisionResponse('{"intent":"tidak_ada","confidence":0.9}'), null);
  assert.equal(parseDecisionResponse('{"confidence":0.9}'), null);
  assert.equal(parseDecisionResponse("halo, bukan json"), null);
  assert.equal(parseDecisionResponse('[1,2]'), null);
  assert.deepEqual(parseDecisionResponse('{"intent":"catat_kas","confidence":1.5}'), {
    intent: "catat_kas",
    confidence: 1,
  });
  assert.deepEqual(parseDecisionResponse('{"intent":"catat_stok","confidence":-0.3}'), {
    intent: "catat_stok",
    confidence: 0,
  });
  assert.deepEqual(parseDecisionResponse('{"intent":"hitung_hpp","confidence":"0.75"}'), {
    intent: "hitung_hpp",
    confidence: 0.75,
  });
  assert.deepEqual(parseDecisionResponse('{"intent":"daftar_lahan"}'), {
    intent: "daftar_lahan",
    confidence: 0,
  });
  assert.deepEqual(parseDecisionResponse('{"intent":"CEK_HARGA","confidence":0.5}'), {
    intent: "cek_harga",
    confidence: 0.5,
  });
  const p = buildDecisionPrompt("berapa harga cabai hari ini?");
  for (const id of DECISION_INTENTS) assert.ok(p.includes(id), `prompt memuat ${id}`);
  const long = buildDecisionPrompt("x".repeat(5000));
  assert.ok(long.includes("x".repeat(1000)), "teks dipotong 1000 char");
  assert.ok(!long.includes("x".repeat(1001)), "tidak lebih dari 1000 char");
  console.log("decision ok");
}
