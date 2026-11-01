# Hai Tani Carbon Roadmap: From Farm Data to Carbon Credits

> Intent: Hai Tani's farmer and plantation activity logs are the foundation for entering the carbon market. Data is the commodity — it feeds MRV (Measurement, Reporting, Verification).

## Why This Is Real (verified)

- IDXCarbon (launched Sept 2023): ~1.98M tCO2e traded worth Rp93.81B through June 2026 — http://berkas.dpr.go.id/pusaka/files/info_singkat/Info%20Singkat-XVIII-19-I-P3DI-Oktober-2026-206-EN.pdf ; average Rp66,352/tCO2e (Sept 2026) — https://karbonlens.com/
- Carbon credits are securities (POJK 14/2023), international trading since Jan 2025.
- SRN PPI (KLHK national registry, https://srn.menlhk.go.id) registration is mandatory before trading; Verra MRA allows dual VCS + SRN registration — https://investinasia.id/blog/indonesia-carbon-market-investment-opportunities/
- Minister of Agriculture Regulation No. 18 of 2026 opens carbon trading to rice, livestock, and plantations AND mandates developers partner with at least 3 local farmer groups with farmer benefit-sharing — https://biochartoday.com/news/indonesia-establishes-new-regulatory-framework-for-agricultural-carbon-credits-and-mandatory-farmer-benefit-sharing/
- Aggregators exist: Fairatmos ($4.5M seed, 40+ developers, remote-sensing/ML) — https://techfundingnews.com/indonesian-tech-fairatmos-picks-4-5m-to-democratise-access-to-carbon-markets%EF%BF%BC/ ; Jejak.in (monitoring + offset marketplace, ministry collaborations).
- Scale matters: a lone 10 ha cannot enter the exchange (credits too small vs cost) — aggregation is required (Nol Karbon CEO via Heaptalk).

## Architecture: Hai Tani as MRV Pipeline

Hai Tani acts as the farm ERP (Reporting layer), not a lone carbon registrant:

```
Farmer WA activity logs → Hai Tani aggregation + data hygiene
  → Carbon Project Developer (e.g. Fairatmos) : science + VVB audit
    → Standard (Verra VCS / Gold Standard / Plan Vivo for smallholders)
      → SRN PPI registry + IDXCarbon (profit-sharing on sale)
```

Business model: B2B data + MRV pipeline with profit-sharing when credits clear. Never sell raw farmer data to end buyers directly.

## Data Gap: Have vs Need

| Required by aggregators | Hai Tani today | Gap to close |
|---|---|---|
| Geolocation per plot | GPS point (lat/lng) + area (Ha) + commodity | Need polygon mapping per garden, not just points |
| Regenerative practice logs | WA event log (planting, harvest, fertilizer doses) | Need explicit practice tags: no-burn residue, rotation, reduced synthetic fertilizer, agroforestry |
| Historical baseline | Registration timestamps, partial history | Need baseline survey per plot before green practices |
| Farmer group structure | Farmer directory + verification status | Need formal farmer-group (poktan) entities for the 3-group rule |
| Identities for benefit-sharing | QR registration cards | Ready to extend as beneficiary IDs |

## Call to Action (ajakan)

Farmers: every unburned harvest residue, every kilogram of chemical fertilizer replaced, every shade tree planted is measurable climate action — and future income. Log it in Hai Tani; we turn honest records into carbon value shared with farmers.

> Dari Petani, untuk Kesejahteraan Petani — including the air.

## Status

Research + intent (this doc). Code integration starts when a partner API contract exists (no speculative endpoints). Next code steps when contracted: polygon capture, practice tagging on activity logs, poktan entities, MRV export endpoint.
