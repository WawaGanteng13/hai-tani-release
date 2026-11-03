# Hai Tani — Hackathon Contribution Statement (English)

Event window: 26 Oct – 4 Nov 2026. Rule: demo only what was built during the event.

## Evidence
- Repository: https://github.com/WawaGanteng13/hai-tani-release (public).
- First commit: `150cd69` (29 Oct 2026) — "Hai Tani release: WA bot + ERP Fase 5 + traceability + hardening".
- Commits before 26 Oct 2026: **0**. Commits in window: **74** (29 Oct – 3 Nov).
- Verify: `git log --since="2026-10-26" --until="2026-11-05" --oneline` (entire history).

## What was built in the window (grouped)
- WA core (29 Oct): outbound Graph v24, reply loop via /api/chat, HMAC webhook verify, session login + RBAC, intent router + Laya, fast-path smalltalk, price table live SISKAPERBAPO.
- Marketplace agent (30 Oct – 1 Nov): ERP F0–F8, buyer negotiator with budget/quote/deal, buyer-spec capture + farmer `sanggup`/`tidak` verification, tiered commission 5/2/0%, allocation engine, multi-number WA quota router, partnership (Kemitraan) tab.
- Grounding & integrity (1 Nov): verified-reference corpus (24 REF entries) + citations + PPL escalation, photo diagnosis loop (vision → reference match → clarifying question → saved case), terminal-deal lock, stock-aware allocation, session-bound authz.
- Product surface (1 Nov): public company-profile landing, public/admin dashboard split, QR registration cards, fruit prices, admin field-ops view.
- Docs & proof (1 Nov): README (problem/pivot/flow/TOM-SAM-SOM/founder), revenue + cost + business-flow + carbon docs, Phase-3 evidence (functional 100/100, stress 104 rps, WCAG pre-audit), SLSA workflow.
- Deploy & data fix (2 Nov): Vercel public-data fix (API_BASE helper, vercel.app CORS allowlist, cross-site session cookie), VITE_BACKEND_URL production deploy, browser-verified /#/publik.
- Cost direction (2 Nov): 100%-Muse stack doc (Spark Standard pricing, WA-vs-LLM burn, rejections with reasons, honest migration status).
- Deploy & data fix II (2 Nov): harga-pasar 404 fix (apiUrl helper for href/window.open/formula, 16 relative sinks, check-absolute-api regression gate).
- User memory (2 Nov): UserMemory auto-capture/recall, recognition greeting for registered numbers (TOS gate kept), fertilizer memory defaults — live-verified, tier-gate 4/4.
- SLSA release (2 Nov): v0.1.0-mvp with Level 3 provenance (digests fix, generator v2.1.0).
- CI pipeline (2 Nov): ci.yml (static + live-gates on ubuntu), CI seed fixture, gate env-fallback, greeting info-passthrough — designed by 5-agent fan-out, live-verified locally.
- Contextual roles (2 Nov): farmer-as-buyer demand (own-stock exclusion), chat saprodi needs (NDB) + status, qty-less demand clarification, admin buying — role-context-gate 5/5 in CI.
- Demand misroute fix (2 Nov): buyer demand no longer hijacked into supplier draft (Laya supplier verdict skipped for demand-shaped messages) — reported from live admin chat.
- Router-shadow audit (2 Nov): full anti-misroute audit (6 P0 + 29 P1) with fixes + router-shadow-gate 18/18 BLOCKING in CI — reported from live beta chat (`saya mau beli agave` misrouted to supplier draft).
- Order notify (2 Nov): farmers auto-notified on every new order (24h-window text/template branch, per-farmer dedupe, digest nudge), buyer notified on COCOK, both parties on DEAL — order-notify-gate 10/10 BLOCKING in CI, live-verified OFR-047.
- Deal fulfil (3 Nov): post-DEAL chain ALAMAT→FOTO→KIRIM→BAYAR→SELESAI fully automatic over WA (address/ShareLoc capture, seller photo with vision judge + buyer verdict, ship schedule, 2-party payment confirm, `minta foto` / `teruskan lokasi` commands, viaWa stamp race fix) — deal-fulfil-gate 14/14 BLOCKING in CI (51 live checks total).

## Pre-existing (outside the submission claim)
- Founder domain knowledge, nursery business, farmer interviews (problem discovery).
- No code, data, or models are claimed from outside the window; mock/seed data used in-repo is labeled as such (see README Data & Status).
