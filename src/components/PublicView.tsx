import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Sprout,
  Users,
  Store,
  Ruler,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  Lock,
} from 'lucide-react';
import { MarketPriceTable } from './MarketPriceTable';
import { FarmerSupplierMapView } from './FarmerSupplierMapView';
import { FarmerRecord, SupplierRecord } from '../types';

interface PubFarmer {
  id: string;
  nama: string;
  komoditas: string;
  kabupaten: string;
  latitude: number;
  longitude: number;
  statusVerifikasi: FarmerRecord['statusVerifikasi'];
}

interface PubSupplier {
  id: string;
  nama: string;
  kategori: SupplierRecord['kategori'];
  kabupaten: string;
  latitude: number;
  longitude: number;
  statusKemitraan: SupplierRecord['statusKemitraan'];
  produkUnggulan: string[];
  stokTersedia: string;
  jamBuka: string;
}

interface PublikRingkas {
  stats: {
    petani: number;
    pemasok: number;
    totalLuasHa: number;
    komoditas: number;
    anomaliAktif: number;
  };
  peta: { farmers: PubFarmer[]; suppliers: PubSupplier[] };
  updatedAt: string;
}

// Adaptor: payload publik (tanpa kontak) ke bentuk penuh agar panel peta tidak
// menampilkan undefined. Kontak disembunyikan via hidePrivate di peta.
const toFarmer = (p: PubFarmer): FarmerRecord => ({
  id: p.id,
  timestamp: '',
  nama: p.nama,
  noHp: '',
  alamat: p.kabupaten,
  kabupaten: p.kabupaten,
  luasLahan: 0,
  luasLahanFormatted: '-',
  komoditas: p.komoditas,
  estimasiPanen: '-',
  estimasiHasilTon: 0,
  statusVerifikasi: p.statusVerifikasi,
  syncStatus: 'synced',
  latitude: p.latitude,
  longitude: p.longitude,
});

const toSupplier = (p: PubSupplier): SupplierRecord => ({
  id: p.id,
  nama: p.nama,
  kategori: p.kategori,
  kontak: '',
  alamat: p.kabupaten,
  kabupaten: p.kabupaten,
  latitude: p.latitude,
  longitude: p.longitude,
  statusKemitraan: p.statusKemitraan,
  produkUnggulan: p.produkUnggulan,
  stokTersedia: p.stokTersedia,
  jamBuka: p.jamBuka,
});

const Stat: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | undefined;
  suffix?: string;
  alert?: boolean;
  loading: boolean;
}> = ({ icon: Icon, label, value, suffix, alert, loading }) => (
  <div className="px-4 py-4">
    <div className="flex items-center gap-1.5 text-xs text-slate-500">
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </div>
    {loading ? (
      <div className="mt-1.5 h-7 w-20 rounded bg-slate-200 animate-pulse" />
    ) : (
      <p className={`mt-1 text-2xl font-bold tabular-nums ${alert && (value ?? 0) > 0 ? 'text-rose-600' : 'text-slate-900'}`}>
        {(value ?? 0).toLocaleString('id-ID')}
        {suffix && <span className="ml-1 text-sm font-medium text-slate-500">{suffix}</span>}
      </p>
    )}
  </div>
);

export const PublicView: React.FC = () => {
  const [data, setData] = useState<PublikRingkas | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/publik/ringkas');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koneksi gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const s = data?.stats;
  const farmers = (data?.peta.farmers ?? []).map(toFarmer);
  const suppliers = (data?.peta.suppliers ?? []).map(toSupplier);
  const updated = data
    ? new Date(data.updatedAt).toLocaleString('id-ID', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <div className="min-h-screen bg-white font-sans text-slate-800 antialiased">
      <header className="border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-emerald-700 flex items-center justify-center">
              <Sprout className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-bold text-slate-900 leading-tight">Hai Tani</p>
              <p className="text-xs text-slate-500 leading-tight">Transparansi pertanian</p>
            </div>
          </div>
          <Link
            to="/admin"
            className="flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 border border-slate-300 hover:border-slate-400 rounded-lg px-3 py-1.5 transition"
          >
            <Lock className="w-3.5 h-3.5" />
            Masuk Admin
          </Link>
        </div>
      </header>

      <div className="border-b border-slate-200 bg-slate-50">
        <div className="max-w-7xl mx-auto px-2 sm:px-4 grid grid-cols-2 sm:grid-cols-5 sm:divide-x divide-slate-200">
          <Stat icon={Users} label="Petani terdata" value={s?.petani} loading={loading} />
          <Stat icon={Store} label="Kios mitra" value={s?.pemasok} loading={loading} />
          <Stat icon={Ruler} label="Total lahan" value={s?.totalLuasHa} suffix="Ha" loading={loading} />
          <Stat icon={TrendingUp} label="Komoditas pantau" value={s?.komoditas} loading={loading} />
          <Stat icon={AlertTriangle} label="Anomali aktif" value={s?.anomaliAktif} alert loading={loading} />
        </div>
      </div>

      {error && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 mt-6">
          <div className="flex items-center justify-between gap-3 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
            <p className="text-sm text-rose-700">Gagal memuat data publik ({error}). Periksa koneksi ke server.</p>
            <button
              onClick={load}
              className="flex items-center gap-1.5 text-sm font-medium text-rose-700 hover:text-rose-900 shrink-0"
            >
              <RefreshCw className="w-4 h-4" />
              Coba lagi
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-xl font-bold text-slate-900">Harga pasar hari ini</h1>
        <p className="text-sm text-slate-500 mt-1 mb-4">Cari komoditas untuk melihat harga acuan per pasar.</p>
        <MarketPriceTable />
      </main>

      <section className="border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-4">
          <h2 className="text-xl font-bold text-slate-900">Peta sebaran</h2>
          <p className="text-sm text-slate-500 mt-1">
            Titik hijau petani, biru kios mitra. Nomor kontak tidak ditampilkan di halaman publik.
          </p>
        </div>
        <FarmerSupplierMapView farmers={farmers} suppliers={suppliers} hidePrivate />
      </section>

      <footer className="border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>Hai Tani, data per {updated || '-'}</span>
          <Link to="/admin" className="hover:text-slate-800">
            Kelola data sebagai admin
          </Link>
        </div>
      </footer>
    </div>
  );
};
