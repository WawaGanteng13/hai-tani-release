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
const DATA = path.join(DIR, '..', '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const now = new Date().toISOString();

const users = [
  { phone: '6287864771451', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now },
  { phone: '62859106513135', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now },
  { phone: '6285954250334', onboardingState: 'TOS_SENT', onboardingTries: 0, tier: 'FREE', status: 'ACTIVE', createdAt: now, updatedAt: now },
  { phone: '6281110001001', role: 'PETANI', onboardingState: 'DONE_WEAK', tier: 'FREE', status: 'ACTIVE', tosVersion: '2026-10-31a', tosAt: now, createdAt: now, updatedAt: now },
];
const farmers = [
  { id: 'TANI-016', timestamp: now.slice(0, 10), nama: 'CI Fixture Tani', noHp: '62859106513135', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Padi', estimasiPanen: 'Des 2026', estimasiHasilTon: 5, statusVerifikasi: 'Menunggu Verifikasi', syncStatus: 'pending' },
  { id: 'TANI-FFF', timestamp: now.slice(0, 10), nama: 'CI Kentang Tani', noHp: '6281110001001', alamat: 'CI', kabupaten: 'CI-Kab', luasLahan: 1, luasLahanFormatted: '1 Ha (10.000 m2)', komoditas: 'Kentang', estimasiPanen: 'Des 2026', estimasiHasilTon: 8, statusVerifikasi: 'Terverifikasi', syncStatus: 'pending' },
];
const komoditas = [
  { id: 'KMD-CI1', farmerId: 'TANI-FFF', komoditas: 'Kentang', luasHa: 1, estimasiPanen: 'Des 2026', estimasiHasilTon: 8, status: 'PANEN', createdAt: now, updatedAt: now, stokSiapJualTon: 1, stokUpdatedAt: now },
];
fs.writeFileSync(path.join(DATA, 'users_db.json'), JSON.stringify(users, null, 1));
fs.writeFileSync(path.join(DATA, 'farmers_db.json'), JSON.stringify(farmers, null, 1));
fs.writeFileSync(path.join(DATA, 'komoditas_db.json'), JSON.stringify(komoditas, null, 1));
console.log('seeded CI fixture: 4 users + 2 farmers + 1 commodity ->', DATA);
