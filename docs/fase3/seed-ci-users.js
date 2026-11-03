// CI fixture: tier-gate + role-context-gate identities.
// Fresh clones have empty gitignored data/*.json, so without this the live
// assertions fail. WARNING: overwrites data/users_db.json,
// data/farmers_db.json and data/komoditas_db.json — CI-only, never run
// against production data.
// Pakai: node docs/fase3/seed-ci-users.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(DIR, '..', '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const now = new Date().toISOString();

const users = [
  { phone: '6287864771451', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now },
  { phone: '62859106513135', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now },
  { phone: '6285954250334', onboardingState: 'TOS_SENT', onboardingTries: 0, tier: 'FREE', status: 'ACTIVE', createdAt: now, updatedAt: now },
  { phone: '6281110001001', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, lastInboundAt: now, lastWaInboundAt: now },
  // Router-shadow fixtures (OFR-900x): buyer pendingAsk + LOC_ASK + SPEK_OK farmer.
  { phone: '6270999999001', role: 'BUYER', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, pendingAsk: { kind: 'BUDGET', offerId: 'OFR-9002', ts: now } },
  { phone: '6270999999002', role: 'BUYER', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, pendingAsk: { kind: 'BUDGET', offerId: 'OFR-9003', ts: now } },
  { phone: '6270999999003', role: 'BUYER', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, pendingAsk: { kind: 'KONFIRM_DEAL', offerId: 'OFR-9004', ts: now } },
  { phone: '6270999999004', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, pendingAsk: { kind: 'SPEK_OK', offerId: 'OFR-9005', ts: now } },
  { phone: '6270999999005', onboardingState: 'LOC_ASK', onboardingTries: 0, tier: 'FREE', status: 'ACTIVE', createdAt: now, updatedAt: now },
  // Order-notify fixtures (Bawang): buyer + 2 petani (1 dalam jendela 24 jam, 1 basi).
  { phone: '6270999999011', role: 'BUYER', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, lastInboundAt: now, lastWaInboundAt: now },
  { phone: '6270999999012', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, lastInboundAt: now, lastWaInboundAt: now },
  { phone: '6270999999014', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, lastInboundAt: now, lastWaInboundAt: new Date(Date.now() - 3 * 864e5).toISOString() },
  // Deal-fulfil fixtures (Tomat): buyer + petani terisolasi dari gate lain.
  { phone: '6270999999021', role: 'BUYER', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, lastInboundAt: now, lastWaInboundAt: now },
  { phone: '6270999999022', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now, lastInboundAt: now, lastWaInboundAt: now },
];
const farmers = [
  { id: 'TANI-016', timestamp: now.slice(0, 10), nama: 'CI Fixture Tani', noHp: '62859106513135', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Padi', estimasiPanen: 'Des 2026', estimasiHasilTon: 5, statusVerifikasi: 'Menunggu Verifikasi', syncStatus: 'pending' },
  { id: 'TANI-FFF', timestamp: now.slice(0, 10), nama: 'CI Kentang Tani', noHp: '6281110001001', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Kentang', estimasiPanen: 'Des 2026', estimasiHasilTon: 8, statusVerifikasi: 'Terverifikasi', syncStatus: 'pending' },
  { id: 'TANI-025', timestamp: now.slice(0, 10), nama: 'CI Spek Tani', noHp: '6270999999004', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Padi', estimasiPanen: 'Des 2026', estimasiHasilTon: 5, statusVerifikasi: 'Terverifikasi', syncStatus: 'pending' },
  { id: 'TANI-031', timestamp: now.slice(0, 10), nama: 'CI Bawang Baru', noHp: '6270999999012', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Bawang', estimasiPanen: 'Des 2026', estimasiHasilTon: 4, statusVerifikasi: 'Terverifikasi', syncStatus: 'pending' },
  { id: 'TANI-032', timestamp: now.slice(0, 10), nama: 'CI Bawang Lama', noHp: '6270999999014', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Bawang', estimasiPanen: 'Des 2026', estimasiHasilTon: 3, statusVerifikasi: 'Terverifikasi', syncStatus: 'pending' },
  { id: 'TANI-041', timestamp: now.slice(0, 10), nama: 'CI Tomat Tani', noHp: '6270999999022', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Tomat', estimasiPanen: 'Des 2026', estimasiHasilTon: 2, statusVerifikasi: 'Terverifikasi', syncStatus: 'pending' },
];
const komoditas = [
  { id: 'KMD-CI1', farmerId: 'TANI-FFF', komoditas: 'Kentang', luasHa: 1, estimasiPanen: 'Des 2026', estimasiHasilTon: 8, status: 'PANEN', createdAt: now, updatedAt: now, stokSiapJualTon: 1, stokUpdatedAt: now },
  { id: 'KMD-CI2', farmerId: 'TANI-016', komoditas: 'Padi', luasHa: 1, estimasiPanen: 'Des 2026', estimasiHasilTon: 5, status: 'PANEN', createdAt: now, updatedAt: now },
  { id: 'KMD-CI3', farmerId: 'TANI-016', komoditas: 'Beras', luasHa: 1, estimasiPanen: 'Des 2026', estimasiHasilTon: 3, status: 'PANEN', createdAt: now, updatedAt: now },
  { id: 'KMD-CI4', farmerId: 'TANI-031', komoditas: 'Bawang', luasHa: 1, estimasiPanen: 'Des 2026', estimasiHasilTon: 4, status: 'PANEN', createdAt: now, updatedAt: now, stokSiapJualTon: 0.5, stokUpdatedAt: now },
  { id: 'KMD-CI5', farmerId: 'TANI-032', komoditas: 'Bawang', luasHa: 1, estimasiPanen: 'Des 2026', estimasiHasilTon: 3, status: 'PANEN', createdAt: now, updatedAt: now, stokSiapJualTon: 0.3, stokUpdatedAt: now },
  { id: 'KMD-CI6', farmerId: 'TANI-041', komoditas: 'Tomat', luasHa: 1, estimasiPanen: 'Des 2026', estimasiHasilTon: 2, status: 'PANEN', createdAt: now, updatedAt: now, stokSiapJualTon: 1, stokUpdatedAt: now },
];
const offers = [
  { id: 'OFR-9002', buyerPhone: '6270999999001', komoditas: 'Kentang', qtyKg: 1000, status: 'OPEN', lines: [], createdAt: now, updatedAt: now },
  { id: 'OFR-9003', buyerPhone: '6270999999002', komoditas: 'Cabai', qtyKg: 500, status: 'OPEN', lines: [], createdAt: now, updatedAt: now },
  { id: 'OFR-9004', buyerPhone: '6270999999003', komoditas: 'Bawang', qtyKg: 200, status: 'OPEN', lines: [], createdAt: now, updatedAt: now },
  { id: 'OFR-9005', buyerPhone: '6270999999006', komoditas: 'Padi', qtyKg: 1000, status: 'OPEN', spesifikasi: 'ukuran besar', lines: [{ farmerId: 'TANI-025', stokKg: 500 }, { farmerId: 'TANI-016', stokKg: 0 }], createdAt: now, updatedAt: now },
];
fs.writeFileSync(path.join(DATA, 'users_db.json'), JSON.stringify(users, null, 1));
fs.writeFileSync(path.join(DATA, 'farmers_db.json'), JSON.stringify(farmers, null, 1));
fs.writeFileSync(path.join(DATA, 'komoditas_db.json'), JSON.stringify(komoditas, null, 1));
fs.writeFileSync(path.join(DATA, 'offers_db.json'), JSON.stringify(offers, null, 1));
console.log(`seeded CI fixture: ${users.length} users + ${farmers.length} farmers + ${komoditas.length} commodities + ${offers.length} offers ->`, DATA);
