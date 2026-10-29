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
// ---- Reply loop v2: panggil /api/chat lalu kirim via Meta Graph API ----
// Best-effort: kegagalan reply TIDAK menggagalkan respons webhook ke Meta.
function pickIncoming(value: any): { from: string; text: string } | null {
  try {
    const msg = value?.messages?.[0];
    if (!msg) return null; // statuses/delivery receipt → bukan pesan pengguna
    const text = msg?.text?.body || msg?.button?.text || msg?.interactive?.button_reply?.title || msg?.interactive?.list_reply?.title || "";
    if (!String(text || "").trim()) return null;
    const from = String(msg.from || "");
    const businessNumber = String(value?.metadata?.display_phone_number || "");
    if (!from || (businessNumber && from === businessNumber)) return null; // anti-loop
    return { from, text: String(text).slice(0, 1000) };
  } catch {
    return null;
  }
}
async function sendWaReply(to: string, body: string): Promise<boolean> {
  const token = (process.env.WHATSAPP_TOKEN || "").trim();
  const phoneId = (process.env.PHONE_NUMBER_ID || "").trim();
  if (!token || !phoneId || !to || !body) {
    console.error("[wa-reply] WHATSAPP_TOKEN/PHONE_NUMBER_ID belum di-set — balasan dilewati");
    return false;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`https://graph.facebook.com/v24.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 4000), preview_url: false } }),
      signal: ctl.signal,
    });
    if (!r.ok) console.error("[wa-reply] meta menolak:", r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (err: any) {
    console.error("[wa-reply] kirim gagal:", (err && err.message) || err);
    return false;
  } finally {
    clearTimeout(t);
  }
}
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
  const T0 = Date.now();
  const GLOBAL_BUDGET_MS = 9500; // Hobby: respons ke Meta harus < 10 dtk
  const remaining = () => Math.max(0, GLOBAL_BUDGET_MS - (Date.now() - T0));
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
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
  // Pipe + chat diminta paralel sejak awal: total ≈ max(pipe, chat), bukan jumlah.
  let inc: { from: string; text: string } | null = null;
  try {
    const payload = JSON.parse(raw.toString("utf-8"));
    inc = pickIncoming(payload?.entry?.[0]?.changes?.[0]?.value);
    const eid = String(payload?.entry?.[0]?.id || "");
    if (eid) console.log(`[wa-fwd] waba=${eid} from=${inc?.from || "-"} msglen=${(inc?.text || "").length}`);
  } catch {
    inc = null;
  }
  const pipeP = fetch(backend + "/api/webhook/whatsapp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tani-forward-secret": fwd },
    body: raw as any,
    signal: ctl.signal,
  });
  const chatP: Promise<any> = inc
    ? (async () => {
        const chatCtl = new AbortController();
        const chatBudget = Math.max(1500, Math.min(8000, remaining() - 1500));
        const chatT = setTimeout(() => chatCtl.abort(), chatBudget);
        try {
          const chatRes = await fetch(backend + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-tani-forward-secret": fwd },
            body: JSON.stringify({ message: (inc as any).text, senderPhone: (inc as any).from }),
            signal: chatCtl.signal,
          });
          if (!chatRes.ok) return null;
          return await chatRes.json().catch(() => null);
        } catch {
          return null;
        } finally {
          clearTimeout(chatT);
        }
      })()
    : Promise.resolve(null);
  let up: any;
  try {
    up = await pipeP;
  } catch (err: any) {
    console.error("[wa-fwd] backend unreachable:", err && err.message);
    return res.status(500).json({ error: "backend unreachable, Meta will retry" });
  } finally {
    clearTimeout(t);
  }
  const text = await Promise.race([
    up.text(),
    new Promise<string>((_, rej) => setTimeout(() => rej(new Error("body-timeout")), remaining())),
  ]).catch(() => "");
  if (up.ok && inc && remaining() > 500) {
    try {
      const chatJson = await Promise.race([
        chatP.catch(() => null),
        new Promise((res) => setTimeout(() => res(null), Math.max(0, remaining() - 500))),
      ]);
      if (!chatJson) console.error("[wa-reply] chat kosong/timeout, balasan tidak dikirim");
      const reply = String((chatJson && chatJson.reply) || "").trim();
      // Jangan teruskan pesan error gerbang sebagai balasan WA.
      if (reply && !/sesi dashboard berakhir/i.test(reply) && remaining() > 1500) {
        await Promise.race([
          sendWaReply(inc.from, reply),
          new Promise((res) => setTimeout(() => res(false), Math.max(0, remaining() - 500))),
        ]);
      }
    } catch {
      /* best-effort */
    }
  }
  return res.status(up.status).send(text);
  } catch (err: any) {
    console.error("[wa-fwd] backend unreachable:", err && err.message);
    return res.status(500).json({ error: "backend unreachable, Meta will retry" });
  } finally {
    clearTimeout(t);
  }
}
