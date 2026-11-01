# Hai Tani Revenue Streams: Freemium + Commission

Model: core features free; paid tiers cut commission and unlock deeper records and advice. All figures in Rupiah; M = miliar (billion), jt = juta (million).

## Tiers (proposal)

| | Tunas (Free) | Tumbuh Rp25rb/bln (Rp250rb/thn) | Panen Rp75rb/bln (Rp750rb/thn) |
|---|---|---|---|
| Chat + market prices | Yes | Yes | Yes |
| Plots recorded | 1 | Unlimited | Unlimited + poktan multi-user (5) |
| Buyer matchmaking | Yes, 5% commission | Yes, 2% commission | Yes, 0% commission |
| Records | Basic | Full + export | Full + analytics + forecast |
| Crop clinic + fertilizer dosing | No | Yes | Yes, priority |
| QR card | No | Yes | Yes |
| Carbon-record ready | No | No | Yes |

Buyer seat "Mitra" Rp150rb/bln (sourcing analytics, verified directory) - optional 4th tier, excluded from math below.

## Basis numbers (explicit assumptions)

- Average deal: 500 kg x Rp15.000 = Rp7.5jt. Assumption, conservative for vegetables.
- Farmer net: Rp1.8jt/ha/season (prior research) ~ Rp300rb/mo/ha over 6 months.
- Paid conversion: 5% of farmers (4:1 Plus:Pro). Industry freemium rule of thumb 2-5%; treated as assumption, sensitivity below.
- Deals per farmer per year: 2. Assumption.

## Revenue engine: agentic 2-way negotiation (live in code)

Commission here is not a passive fee — it is the spread the negotiation agent creates. The bot collects the buyer budget on one side and each farmer ask on the other (`evalOffer`: spread = alokasiKg x (budget - farmerPrice)); at deal time Hai Tani takes at most the tier cap and returns the remainder to the farmer via price top-up (`finalizeOfferDeal`: take = min(spread, tier% x dealValue), server.ts). Better bargaining = bigger spread = more revenue, while the farmer always keeps budget-minus-capped-commission. The better the agent negotiates for BOTH sides, the more it earns.

## Calculation A: commission per deal

- Free: 5% x Rp7.5jt = Rp375rb. Plus: 2% = Rp150rb. Pro: Rp0.
- Simplification note: the math below assumes negotiated spread covers the tier cap. When spread is thinner, Hai Tani takes only the spread (code: min(spread, tier%)) — the agent must bargain well to earn well.
- Plus saves Rp225rb/deal vs Free - monthly fee Rp25rb pays back in 0.11 deals; annual Rp250rb in 1.1 deals/year.
- Pro annual Rp750rb breaks even vs Free at 2 deals/year.

## Calculation B: affordability check

- Rp25rb/mo vs ~Rp300rb/mo/ha net = 8.3% of monthly net per hectare. Honest flag: meaningful for 1-ha farmers, which is why one deal covers 9 months of subscription. Pricing must stay here, not higher.

## Calculation C: scale scenarios (10k farmers)

- GMV = 10.000 x 2 x Rp7.5jt = Rp150B.
- Blended commission = 0.95x5 + 0.04x2 + 0.01x0 = 4.83% -> Rp7.25B/year.
- Subscriptions = 400 x Rp300rb + 100 x Rp900rb = Rp210jt/year.
- Total ~ Rp7.46B/year. Commission dominates 35:1 - subscriptions are loyalty, commission is the engine.
- Leakage haircut (cash deals off-platform, mitigated by escrow): -30% commission -> total ~Rp5.29B.
- Linear scale: 1k farmers ~Rp746jt; 100k ~Rp74.6B (diseconomies ignored).
- Half conversion (2.5%): subs Rp105jt, commission Rp7.31B - total barely moves.

### Downside: adverse selection (illustrative assumptions)

- Assumption: the most active 10% of farmers, holding an assumed 50% of GMV, upgrade to Panen (0% commission), leaving the commission base to smaller, less active deals.
- Commission falls to ~Rp3.6B while subscriptions rise to ~Rp900jt (1k Panen seats x Rp900rb/year); total ~Rp4.5B vs the ~Rp7.46B basis above (-40%).
- Every figure in this subsection is an assumption for sensitivity analysis, not a measurement; mitigations under study: Mitra buyer seats, escrow stickiness, and Panen pricing above the avoided commission.

## Verification

| Claim | Check | Status |
|---|---|---|
| 5%/2%/0% fair | Shopee 1-6%, Tokopedia 2-6.5% basic-seller range (COSTING journal 2026; id-marketplace-tools); Shopee Mall to 6%; campaign all-in to 30% | PASS - inside market norms |
| Subscription affordable | 8.3% of monthly net/ha; 1 deal covers 9 months | PASS with flag |
| Conversion realistic | 2-5% rule of thumb; model works at half | PASS - insensitive |
| Consistent with SOM doc | SOM subs-only Rp21-189M at 210k+ farmers; this model adds commission engine explicitly excluded there | PASS - reconciled |
| Tax cost | PMK 37/2025: marketplaces withhold PPh 22 0.5% of turnover | NOTED as cost |
| No lending risk | No P2P (TaniFund lesson, see business-flow.md) | PASS by design |

## Live today vs roadmap

- Live: negotiation spread to kas (variable), affiliate 3% (AFFILIATE_PCT in code).
- Roadmap: tier enforcement (F9), subscription billing, escrow-via-bank (see business-flow.md), Mitra buyer seats.
