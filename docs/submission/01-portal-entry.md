# Hai Tani — Hackathon Portal Entry (draft, English)

## Title
Hai Tani — WhatsApp Negotiation Agent Connecting Farmers Directly to Buyers

## Tagline
Dari Petani, untuk Kesejahteraan Petani — an agentic AI that cuts out the middleman, not the farmer.

## Short description (for listing)
Hai Tani (TaniAI) is a WhatsApp-first agentic marketplace for Indonesian smallholders: a stateful negotiation bot matches buyers looking for harvest with ready-to-harvest farmers, verifies buyer specs with each farmer, records the deal, and tracks it on a monitoring dashboard. Built on the WhatsApp Cloud API (Meta for Developers) + Meta Model API with a multi-provider AI dispatcher, live market prices, anomaly alerts, and spreadsheet sync.

## Problem
68% of Indonesian farmers sell through the same middlemen, harvests bought cheap at the farm gate while traders control market selling. Farmers keep razor-thin margins and have no direct buyer access.

## Solution (agentic, not a chatbot)
- Stateful buyer↔farmer negotiation over WhatsApp: demands, budgets, farmer quotes, spec verification (`sanggup`/`tidak`), allocation, deal, tiered commission (5/2/0%).
- Verified farmer directory + spatial map, live SISKAPERBAPO/Mantung/InfoPangan prices, auto anomaly detection with admin broadcast.
- Supporting agent tools (not the headline): photo diagnosis loop (vision → verified-reference match → clarifying question → saved case), grounded agronomy Q&A with [REF-xxx] citations + PPL escalation, ERP logging, QR registration cards, Sheets two-way sync.

## Meta tools used
- WhatsApp Cloud API via Meta for Developers: webhook verification + HMAC-signed POST handling, outbound messaging incl. templates, multi-number free-quota router.
- Meta Model API in the multi-provider dispatcher (Meta → NIM → 9Router → Gemini + rule fallback).
- Built with Muse Code (Meta).

## Links
- Repo: https://github.com/WawaGanteng13/hai-tani-release (public, full history inside the event window — see 03-contribution.md)
- Demo video: [TO RECORD — script in 02-demo-script.md]
- Test evidence: docs/fase3/ (functional 100/100, stress 104 rps, WCAG pre-audit)

## Founder note
Hello Farmers — Mochammad Setiawan Putra, ornamental-plant farmer (6 years, SnS Nursery, Batu). Built from direct experience: the #1 farmer complaint is buyer access, not information.
