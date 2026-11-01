# Alur Negosiasi Buyer-Petani via WhatsApp

Fitur unggulan Hai Tani: mempertemukan buyer yang cari barang dengan petani siap panen (atau akan panen) lewat negosiasi chat yang terdokumentasi.

```mermaid
flowchart TD
    A[Buyer chat WA] --> B[Bot sambut]
    B --> C[Cari panen siap]
    C --> D[Kirim daftar petani]
    D --> E[Buyer pilih dan tawar]
    E --> F[Bot teruskan ke petani]
    F --> G{Petani setuju?}
    G -->|Ya| H[Deal tercatat]
    G -->|Tidak| I[Tawar ulang]
    I --> E
    H --> J[Kas tercatat]
```

Penjelasan tiap langkah:

1. Buyer membuka chat WhatsApp Kang Tani dan menyampaikan kebutuhan (komoditas, volume).
2. Bot menyambut dan mencocokkan dengan data petani siap panen / akan panen.
3. Bot mengirim daftar petani (komoditas, estimasi tonase, lokasi).
4. Buyer memilih petani dan mengajukan penawaran harga.
5. Bot meneruskan penawaran ke petani.
6. Petani setuju (deal tercatat + kas tercatat) atau menolak (tawar ulang).
