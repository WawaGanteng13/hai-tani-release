# Onboarding Hai Tani ke Google Cloud (Cloud Run)

Target: backend Hai Tani jalan 24/7 di Cloud Run region Jakarta, data JSON tetap
persisten di bucket GCS. Kredit trial $300/90 hari menutup masa ukur.

```
Meta WA ---> forwarder Vercel ---> Cloud Run (haitani-backend, :8080) <-- dashboard Vercel
                                      |  DATA_DIR=/mnt/data (GCS Fuse)
                                      v
                               bucket GCS (farmers/admins/kas/stok/latihan/media)
```

## Keputusan kunci

- Storage v1 = bucket GCS via volume Cloud Run (tanpa ubah kode baca/tulis).
  Migrasi Firestore ditunda (opsi, bukan syarat).
- Region `asia-southeast2` (Jakarta): dekat pengguna WA.
- `min-instances=1` selama kredit (webhook selalu hangat); tuas hemat =
  turunkan ke 0 bila tagihan idle berlebih (kode tahan cold-start via ack).
- LLM tetap kunci AI Studio (bukan Vertex) = nol biaya GCP untuk AI.
- Prod lokal (PC, task HaiTaniBackend) JANGAN dimatikan sebelum cloud stabil H+3.

## 0. Prasyarat

- Project GCP + billing aktif (trial). Ganti `<PROJECT>` dan `<BUCKET>`
  (nama bucket unik global, mis. `haitani-prod-data`).
- Enable API (sekali, via Console atau CLI):

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com storage.googleapis.com \
  --project=<PROJECT>
```

## 1. Bucket data + seed awal

```bash
# Bucket regional Jakarta + versioning (pengaman tulis rusak)
gcloud storage buckets create gs://<BUCKET> --location=asia-southeast2 \
  --uniform-bucket-level-access --project=<PROJECT>
gcloud storage buckets update gs://<BUCKET> --versioning

# Seed dari prod lokal (PC): semua JSON KECUALI .session-key (sesi baru saja)
gcloud storage cp D:\PindahanDariC\Users\USER\Downloads\remix-taniai-extracted\data\*.json gs://<BUCKET>/ --project=<PROJECT>
```

Catatan: `admins_db.json` ikut tersalin agar password dashboard tetap sama.

## 2. Service account + IAM

Pakai service account khusus (bukan default) agar izin sempit:

```bash
gcloud iam service-accounts create haitani-run --display-name="Hai Tani Cloud Run" --project=<PROJECT>
SA=haitani-run@<PROJECT>.iam.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding gs://<BUCKET> \
  --member=serviceAccount:$SA --role=roles/storage.objectAdmin
```

(Akses secret diberikan per-secret di langkah 3.)

## 3. Secret (Secret Manager)

Minimal 4 (nilai = isi .env prod; JANGAN commit):

```bash
for s in haitani-gemini-key haitani-wa-token haitani-wa-appsecret haitani-forward-secret; do
  gcloud secrets create $s --replication-policy=automatic --project=<PROJECT>
done
# Isi tiap secret (tempel nilai saat diminta, tanpa newline):
#   GEMINI_API_KEY         -> haitani-gemini-key
#   WHATSAPP_ACCESS_TOKEN  -> haitani-wa-token
#   WHATSAPP_APP_SECRET    -> haitani-wa-appsecret
#   FORWARD_SECRET         -> haitani-forward-secret
printf '%s' '<NILAI>' | gcloud secrets versions add haitani-gemini-key --data-file=- --project=<PROJECT>
# ... ulangi untuk 3 lainnya, lalu beri akses baca ke SA:
for s in haitani-gemini-key haitani-wa-token haitani-wa-appsecret haitani-forward-secret; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA \
    --role=roles/secretmanager.secretAccessor --project=<PROJECT>
done
```

Opsional (bila dipakai prod): `NINEROUTER_KEY`, `META_MODEL_KEY`,
`NVIDIA_NIM_KEY`, `APPS_SCRIPT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON` —
tambah secret + entri `--update-secrets` di `cloudbuild.yaml`.

## 4. Deploy

Jalur A — Console (tanpa install apa pun):

1. Cloud Run > Create Service > **Continuously deploy from a repository** >
   hubungkan repo GitHub `hai-tani-release` > Dockerfile (file `Dockerfile`).
2. Region `asia-southeast2`, CPU 1, memori 1Gi, min 1 / maks 3 instance.
3. Variables: `NODE_ENV=production`, `DATA_DIR=/mnt/data`,
   `INTENT_ENGINE=gemini`. Secrets: 4 secret langkah 3 (mount sbg env).
4. Volume: tambah GCS `gs://<BUCKET>` di `/mnt/data`, service account
   `haitani-run`. Allow unauthenticated. Create.

Jalur B — CLI (butuh [gcloud](https://cloud.google.com/sdk/docs/install)):

```bash
# Tambahkan SA ke cloudbuild.yaml (flag --service-account) atau set manual:
gcloud builds submit --config cloudbuild.yaml \
  --substitutions _REGION=asia-southeast2,_DATA_BUCKET=<BUCKET>,_MIN_INSTANCES=1 \
  --project=<PROJECT>
```

## 5. Set URL eksak (deploy #1 selesai)

Deploy pertama belum tahu URL publiknya; fallback host-request menutupinya.
Setelah URL `https://haitani-backend-xxx-uc.a.run.app` terbit:

```bash
# ^;^ = pemisah custom (WAJIB bila ada nilai mengandung koma, mis. CORS_ORIGINS).
gcloud run services update haitani-backend --region=asia-southeast2 \
  --update-env-vars='^;^APP_URL=<RUN-URL>;KARTU_PUBLIC_BASE=<RUN-URL>;CORS_ORIGINS=https://haitani.my.id,https://www.haitani.my.id' \
  --project=<PROJECT>
```

## 6. Wiring Vercel + Meta

- Vercel forwarder: env `BACKEND_URL=<RUN-URL>` > **Redeploy** (env baru
  butuh deploy ulang agar termuat).
- Dashboard Vercel: env `VITE_BACKEND_URL=<RUN-URL>` > **Redeploy**.
- Meta webhook: TETAP ke URL Vercel (tak berubah).
- Uji kirim pesan WA "halo" ke nomor bot.

## 7. Verifikasi

- [ ] `GET <RUN-URL>/api/health` → ok, farmers=15, admins=7.
- [ ] Login dashboard + `POST /api/laya/decide` → `source: gemini_decision`.
- [ ] Pesan WA 1-on-1 dibalas < 8 dtk (2 kali: hangat + dingin).
- [ ] Spreadsheet write-behind terisi (bila GOOGLE_* dikonfigurasi).
- [ ] Billing: budget alert 50/90/100% aktif.

## Biaya & guard

- Selalu-pantau: Billing > Budgets & alerts (satu budget project, alert
  50/90/100%). Label project `haitani` + `landscapein` terpisah agar
  pemakaian per project terbaca.
- Tuas bila idle mahal: `--min-instances=0` (gratis saat sepi; cold-start
  pertama ±detik, ditutup pola ack + jawaban susulan).
- Egress gratis cuma 1 GB/bln per billing account (dipakai bersama
  LandscapeIN bila kelak pindah Vertex).

## Rollback

- Revisi gagal: Cloud Run > Revisions > alihkan traffic ke revisi lama.
- Darurat: prod lokal masih utuh — arahkan `BACKEND_URL`/`VITE_BACKEND_URL`
  kembali ke tunnel lokal + redeploy Vercel.

## Troubleshooting

- `403` di URL publik padahal deploy sukses: binding `allUsers` hilang —
  pulihkan: `gcloud run services add-iam-policy-binding haitani-backend
  --region=asia-southeast2 --member=allUsers --role=roles/run.invoker`.
- `403` tulis data: SA kurang `storage.objectAdmin` di bucket (langkah 2).
- Secret kosong: nama secret salah / versi belum `latest` / SA tanpa accessor.
- Boot lambat pertama: initPersistence + preload wajar ±30-60 dtk; health
  check Cloud Run beri timeout 300 dtk.
- 503 dingin acak: naikkan min-instances sementara ke 1 saat ukur.

