// Vercel Serverless: penerima webhook WhatsApp Meta (stateless, tanpa dep baru).
// GET: verifikasi hub.challenge. POST: verifikasi X-Hub-Signature-256 (bila
// WHATSAPP_APP_SECRET di-set), lalu teruskan body mentah ke backend persisten
// (BACKEND_URL + header x-tani-forward-secret). Backend tetap satu-satunya
// sumber kebenaran (DB JSON lokal); fungsi ini tidak menyimpan apa pun.

export const config = { api: { bodyParser: false } };

import crypto from "crypto";

function readRaw(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(raw: Buffer, sig: string, secret: string): boolean {
  const m = /^sha256=([a-f0-9]{64})$/i.exec(sig || "");
  if (!m) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(m[1].toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req: any, res: any) {
  if (req.method === "GET") {
    const q = req.query || {};
    const token = process.env.WHATSAPP_VERIFY_TOKEN || "";
    if (q["hub.mode"] === "subscribe" && token && q["hub.verify_token"] === token) {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(String(q["hub.challenge"] || ""));
    }
    return res.status(403).send("Verification token mismatch");
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }
  let raw: Buffer;
  try {
    raw = await readRaw(req);
  } catch {
    return res.status(400).json({ error: "cannot read body" });
  }
  const appSecret = (process.env.WHATSAPP_APP_SECRET || "").trim();
  if (appSecret) {
    const sig = String(req.headers["x-hub-signature-256"] || "");
    if (!verifySignature(raw, sig, appSecret)) {
      return res.status(403).json({ error: "bad signature" });
    }
  }
  const backend = (process.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
  const fwd = (process.env.FORWARD_SECRET || "").trim();
  if (!backend || !fwd) {
    console.error("[wa-fwd] BACKEND_URL/FORWARD_SECRET belum di-set");
    return res.status(500).json({ error: "forwarder belum dikonfigurasi" });
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const up = await fetch(backend + "/api/webhook/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tani-forward-secret": fwd },
      body: raw as any,
      signal: ctl.signal,
    });
    const text = await up.text();
    return res.status(up.status).send(text);
  } catch (err: any) {
    console.error("[wa-fwd] backend unreachable:", err && err.message);
    return res.status(500).json({ error: "backend unreachable, Meta will retry" });
  } finally {
    clearTimeout(t);
  }
}
