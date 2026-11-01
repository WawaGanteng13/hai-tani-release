# Hai Tani Cost Structure: Burn vs Revenue

All figures in Rupiah; M = miliar, jt = juta. Assumptions explicit; verify before budgeting.

## Unit prices (researched)

- WhatsApp Cloud API (per-message since July 2025): Indonesia utility/auth ~Rp357/message, marketing ~Rp586; service messages Rp356.65 with first 1,000/month free per number. Sources: Meta IDR rate card July 2025 (via Gupshup PDF), bitbybit calculator (April 2026 card). Caution: Meta's card layout is ambiguous across mirrors - re-check the official rate card at billing time. Model uses Rp357/bot-message beyond the free 1,000.
- LLM (Gemini Flash-class): ~$0.15 in / $0.60 out per M tokens (1.5 Flash, Oct 2026) or $0.75/$3.75 promo (3.8 Flash, doubles Jan 2027). Per chat message (~500 tokens blended) ~Rp2-5. Negligible vs WA messages.
- VPS Indonesia: DomaiNesia 1GB Rp48rb/mo; 4GB class ~Rp350rb/mo; Hostinger 8GB Rp645rb/mo (whtop 2026). Domain ~Rp150rb/year.
- Maps/Sheets: Google Maps $200/mo free credit (likely $0 at MVP scale); Sheets API free.
- Payments (rough, verify): VA ~Rp4-5rb flat/transaction; cards ~2.9%. Escrow/partner fees per deal terms.
- NIM key: founder-provided; plan cost TBD.

## Monthly burn by scale

Assumptions: active farmer = 30 bot-messages/month; infra steps with load; staff 1 ops @Rp5jt (MVP, founder-led) to 2 ops @Rp10jt.

| Scale | WA messages | WA cost | Infra+domain+LLM | Staff | Total burn/mo |
|---|---|---|---|---|---|
| MVP 100 farmers | 3.000 (2.000 paid) | Rp714rb | Rp370rb | Rp0-5jt | ~Rp1,1-6jt |
| 1k farmers | 30.000 | Rp10,4jt | Rp730rb | Rp10jt | ~Rp21jt |
| 10k farmers | 300.000 | Rp107jt | Rp2,7jt | Rp15jt | ~Rp125jt |

10k WA math: 299.000 x Rp357 = Rp106,7jt.

## Burn vs revenue (from revenue-streams.md)

| Scale | Revenue/mo | Burn/mo | Margin |
|---|---|---|---|
| 100 farmers | ~Rp6,2jt | ~Rp1,1-6jt | thin to break-even |
| 1k farmers | ~Rp62jt | ~Rp21jt | ~66% |
| 10k farmers | ~Rp622jt | ~Rp125jt | ~80% |

## Verification notes

- WA messages dominate cost (95%+); LLM is noise. Cost control = message discipline (concise replies, template only when needed), not model choice.
- Biggest uncertainty: messages/farmer/month (30 assumed) and off-platform leakage (see revenue doc haircut).
- Break-even sits below 1k active farmers even with staff - provided commission collection works (escrow).
- Re-check Meta's rate card quarterly; utility-in-service-window rules changed Oct 2026 already.

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
