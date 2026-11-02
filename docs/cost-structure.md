# Hai Tani Cost Structure: Burn vs Revenue

All figures in Rupiah; M = miliar, jt = juta. Assumed rate Rp15,800/USD. Assumptions explicit; verify before budgeting.

## Direction: 100% Muse (Meta)

Hai Tani's production LLM stack is all-Muse via the Meta Model API — one vendor for chat, negotiation reasoning, and photo triage. No per-provider juggling in the cost model below.

Why Muse covers everything Hai Tani needs:

- Indonesian is officially supported and the training corpus spans 200 languages; negotiation, chat, and agronomy Q&A run in Indonesian — https://docs.litellm.ai/docs/providers/meta , https://howaiworks.ai/models/llama/
- Native multimodal input (text + image, early fusion of text and vision tokens; 1M context) — photo-based crop triage runs on the same model, no separate vision vendor — https://docs.litellm.ai/docs/providers/meta
- Reasoning-first design for agentic, multi-step tasks (negotiation state machine, spec verification) — https://www.marktechpost.com/2026/07/09/meta-superintelligence-labs-releases-muse-spark-1-1/

Flag (honest): Javanese/Sundanese and other regional languages are NOT on Meta's published supported-language list — verify on pilot with real farmer voice notes before promising dialect support.

## Unit prices (researched)

- WhatsApp Cloud API (per-message since July 2025): Indonesia utility/auth ~Rp357/message, marketing ~Rp586; service messages Rp356.65 with first 1,000/month free per number. Sources: Meta IDR rate card July 2025 (via Gupshup PDF), bitbybit calculator (April 2026 card). Caution: Meta's card layout is ambiguous across mirrors - re-check the official rate card at billing time. Model uses Rp357/bot-message beyond the free 1,000.
- Muse Spark Standard (the Hai Tani pick, code default `muse-spark-1.3`): $1.25 in / $4.25 out per M tokens, $0.15/M cached input, 1M context, no long-context premium. Sources: Meta developer docs via pricing mirrors, Oct 2026 — https://www.toolcolumn.com/pricing/meta-muse-pricing , https://www.marktechpost.com/2026/07/09/meta-superintelligence-labs-releases-muse-spark-1-1/ . New accounts report $20 free credits — verify the current promo at signup.
- Rejected: Muse Wonder ($4/$20 per M — 3-5x the LLM line, unjustified for chat/triage — https://www.deeplearning.ai/the-batch/meta-releases-wonder-opens-spark); Contributor tier ($0.10/$0.20 per M — ~95% cheaper but grants training rights on content; rejected for farmer PII and deal data — Standard only).
- Per-message math (Spark Standard, 500-token blended message ≈ 350 in + 150 out): input 350 × $1.25/M ≈ Rp7; output 150 × $4.25/M ≈ Rp10 → ~Rp17/message; prompt caching on the system prompt pushes this toward ~Rp10. At 30 msgs/farmer/month ≈ Rp300-600/farmer/month.
- Photo triage: occasional, same model, image-token pricing TBD — verify against the Meta rate card; bounded by triage-only design (one pass + reference match, not open chat).
- VPS Indonesia: DomaiNesia 1GB Rp48rb/mo; 4GB class ~Rp350rb/mo; Hostinger 8GB Rp645rb/mo (whtop 2026). Domain ~Rp150rb/year.
- Maps/Sheets: map SDK ~$200/mo free credit (likely $0 at MVP scale); spreadsheet API free.
- Payments (rough, verify): VA ~Rp4-5rb flat/transaction; cards ~2.9%. Escrow/partner fees per deal terms.

## Monthly burn by scale

Assumptions: active farmer = 30 bot-messages/month; LLM ≈ Rp17/message (uncached worst case); infra steps with load; staff 1 ops @Rp5jt (MVP, founder-led) to 2 ops @Rp10jt.

| Scale | WA messages | WA cost | Infra+domain+LLM | Staff | Total burn/mo |
|---|---|---|---|---|---|
| MVP 100 farmers | 3.000 (2.000 paid) | Rp714rb | Rp420rb | Rp0-5jt | ~Rp1,1-6jt |
| 1k farmers | 30.000 | Rp10,4jt | Rp1,2jt | Rp10jt | ~Rp22jt |
| 10k farmers | 300.000 | Rp107jt | Rp7,8jt | Rp15jt | ~Rp130jt |

LLM math: 3.000 × Rp17 ≈ Rp51rb; 30.000 × Rp17 ≈ Rp510rb; 300.000 × Rp17 ≈ Rp5,1jt.
10k WA math: 299.000 x Rp357 = Rp106,7jt.

## Burn vs revenue (from revenue-streams.md)

| Scale | Revenue/mo | Burn/mo | Margin |
|---|---|---|---|
| 100 farmers | ~Rp6,2jt | ~Rp1,1-6jt | thin to break-even |
| 1k farmers | ~Rp62jt | ~Rp22jt | ~65% |
| 10k farmers | ~Rp622jt | ~Rp130jt | ~79% |

## Verification notes

- WA messages still dominate (~90-95%); Muse Spark moves LLM from noise to ~4-5% of burn — visible, not decisive. Cost control = message discipline + prompt caching, not model-hopping.
- Biggest uncertainty: messages/farmer/month (30 assumed) and off-platform leakage (see revenue doc haircut).
- Break-even sits below 1k active farmers even with staff - provided commission collection works (escrow).
- Re-check Meta's WA rate card quarterly; utility-in-service-window rules changed Oct 2026 already. Re-check Muse pricing at billing time (preview pricing moves).

## Implementation status (honest)

- `server.ts` dispatcher is already Meta-first: Meta Model API (default `muse-spark-1.3`) is tried before any legacy fallback.
- Remaining code step (not done): the media/vision path still uses a legacy vision vendor — migrating photo triage to Muse multimodal is required before the 100%-Muse claim is fully true in code.
- Legacy third-party chat fallbacks are still wired in code; retiring them is a founder decision after a Muse-only soak period. Local rule fallback stays permanently for total-outage resilience.

## Multi-number free-quota router (implemented 1 Nov 2026)

Each WA business number gets 1,000 free service messages/month. `server.ts` now
pools numbers: new chats route to the number with remaining quota, while each
user sticks to the number they first contacted (context preserved in
`usersDb`/`offersDb`, keyed by user phone - never by number).

- Config: `WA_NUMBERS_JSON='[{"id":"<phone_number_id>","label":"CS-1"},...]'`
  (all numbers under one WABA share one `WHATSAPP_ACCESS_TOKEN`). Unset = legacy
  single-number behavior via `PHONE_NUMBER_ID`.
- State: `data/waquota_db.json` (`usage` per number per month, `sticky`
  user->number map; last 3 months retained).
- Monitor: `GET /api/wa/quota` (admin session) shows sent/remaining per number.
- Each extra number adds ~1,000 free messages/month (~Rp357rb value at utility
  rates); 3 numbers cover ~100 farmers at 30 msgs/month entirely free.
