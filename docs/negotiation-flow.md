# Buyer-Farmer Negotiation Flow via WhatsApp

Hai Tani's flagship: a stateful bot matches buyers looking for harvest with ready-to-harvest farmers, then drives the deal to completion — no app install, just chat.

```mermaid
sequenceDiagram
    participant B as Buyer
    participant Bot as Hai Tani Bot
    participant F as Farmer(s)
    B->>Bot: "butuh bawang 500 kg" + budget
    Bot->>Bot: Offer OPEN (OFR-xxx)
    Bot->>F: Auto-notify new order (text/template)
    F->>Bot: "jual bawang 7rb" (quote)
    Bot->>Bot: Evaluate: quote ≤ budget?
    Bot->>B: COCOK notification
    B->>Bot: "spek: ukuran besar" (optional)
    Bot->>F: Verify spec: sanggup?
    F->>Bot: sanggup / tidak
    B->>Bot: "deal oke"
    Bot->>Bot: Re-validate live stock → DEAL locked
    Bot->>B: Deal receipt + ask address
    Bot->>F: Deal receipt + ask photo
```

States: `OPEN → SEBAGIAN → COCOK → DEAL (terminal)`. Cheapest-first allocation can never oversell; the negotiated spread above the tier cap (5/2/0%) returns to the farmer via price top-up, the rest to kas.

## Post-Deal Fulfilment (automatic)

```mermaid
flowchart TD
    DEAL([DEAL locked]) --> ADDR[Ask buyer: address? text/ShareLoc]
    ADDR --> PHOTO[Ask seller: photo + ship time?]
    PHOTO --> JUDGE{Vision judge: match?}
    JUDGE -->|Tidak| RETAKE[Retake request]
    RETAKE --> PHOTO
    JUDGE -->|Cocok| FWD[Forward to buyer]
    FWD --> VERDICT{Buyer: foto oke?}
    VERDICT -->|Tolak| RETAKE
    VERDICT -->|Oke| SCHED[Seller: ship schedule]
    SCHED --> PAID[Buyer: sudah bayar]
    PAID --> RCVD[Seller: uang masuk]
    RCVD --> DONE([SELESAI ✅])
    PAID -->|belum terima| FRZ([SENGKETA: frozen + admin])
```

Commands: `minta foto [OFR-x]`, `teruskan/kirim/forward lokasi OFR-x`. Chat-cancel of a DEAL is refused — contact admin.
