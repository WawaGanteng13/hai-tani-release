import React, { useState, useEffect, useCallback } from 'react';
import {
  TrendingUp,
  Search,
  RefreshCw,
  AlertTriangle,
  SearchX,
  Database,
} from 'lucide-react';

interface HargaPasarItem {
  nama: string;
  satuan: string;
  harga: number;
}

interface HargaPasarResponse {
  sumber: string;
  tanggal: string;
  live: boolean;
  count: number;
  daftar: HargaPasarItem[];
}

const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

export const MarketPriceTable: React.FC = () => {
  const [data, setData] = useState<HargaPasarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string>('');

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch('/api/harga-pasar');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: HargaPasarResponse = await res.json();
      setData(json);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      if (!isRefresh || !data) {
        setError(e instanceof Error ? e.message : 'Koneksi gagal');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const q = query.trim().toLowerCase();
  const rows = (data?.daftar || []).filter(
    (it) => !q || it.nama.toLowerCase().includes(q)
  );

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
      {/* Header */}
      <div className="p-5 pb-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center space-x-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 flex-wrap">
              <span>Harga Pasar Jatim Terkini</span>
              <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-0.5 rounded-full font-medium border border-emerald-200">
                SISKAPERBAPO
              </span>
            </h2>
            <p className="text-xs text-slate-500">
              {data ? (
                <>
                  {data.count} komoditas - Tanggal data {data.tanggal}
                  {updatedAt ? ` - Diperbarui ${updatedAt}` : ''}
                  {refreshing ? ' - memperbarui...' : ''}
                </>
              ) : (
                'Rata-rata harga konsumen provinsi Jawa Timur'
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <div className="relative flex-1 sm:w-56">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari komoditas..."
              aria-label="Cari komoditas"
              className="w-full text-sm border border-slate-200 rounded-xl pl-8 pr-3 py-2 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing || loading}
            aria-label="Muat ulang harga pasar"
            className="w-9 h-9 rounded-xl border border-slate-200 flex items-center justify-center text-slate-600 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 pb-5">
        {loading ? (
          <div className="space-y-2" aria-label="Memuat harga pasar">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex gap-3 items-center animate-pulse">
                <div className="w-8 h-5 rounded bg-slate-100" />
                <div className="flex-1 h-5 rounded bg-slate-100" />
                <div className="w-16 h-5 rounded bg-slate-100" />
                <div className="w-24 h-5 rounded bg-slate-100" />
              </div>
            ))}
          </div>
        ) : error && !data ? (
          <div className="border border-rose-200 bg-rose-50 rounded-xl p-5 text-center">
            <AlertTriangle className="w-6 h-6 text-rose-600 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-900">Gagal memuat harga pasar</p>
            <p className="text-xs text-slate-500 mt-1">
              Sumber SISKAPERBAPO tidak menjawab ({error}). Periksa koneksi lalu coba lagi.
            </p>
            <button
              type="button"
              onClick={() => load(false)}
              className="mt-3 text-sm font-medium px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
            >
              Coba lagi
            </button>
          </div>
        ) : data && data.daftar.length === 0 ? (
          <div className="border border-slate-200 rounded-xl p-5 text-center">
            <Database className="w-6 h-6 text-slate-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-900">Belum ada data harga</p>
            <p className="text-xs text-slate-500 mt-1">
              Tabel SISKAPERBAPO kosong untuk tanggal {data.tanggal}. Coba muat ulang.
            </p>
            <button
              type="button"
              onClick={() => load(true)}
              className="mt-3 text-sm font-medium px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
            >
              Muat ulang
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-slate-200 rounded-xl p-5 text-center">
            <SearchX className="w-6 h-6 text-slate-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-900">Tidak ada hasil untuk &quot;{query.trim()}&quot;</p>
            <p className="text-xs text-slate-500 mt-1">Coba kata kunci lain atau hapus pencarian.</p>
            <button
              type="button"
              onClick={() => setQuery('')}
              className="mt-3 text-sm font-medium px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:border-emerald-500 hover:text-emerald-700"
            >
              Hapus pencarian
            </button>
          </div>
        ) : (
          <div className="border border-slate-200 rounded-xl overflow-auto max-h-[480px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50">
                  <th className="text-left font-semibold text-slate-600 text-xs uppercase tracking-wide px-3 py-2.5 w-12">No</th>
                  <th className="text-left font-semibold text-slate-600 text-xs uppercase tracking-wide px-3 py-2.5">Komoditas</th>
                  <th className="text-left font-semibold text-slate-600 text-xs uppercase tracking-wide px-3 py-2.5 w-24">Satuan</th>
                  <th className="text-right font-semibold text-slate-600 text-xs uppercase tracking-wide px-3 py-2.5 w-36">Harga</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((it, i) => (
                  <tr key={`${it.nama}-${i}`} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2 text-slate-400 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2 text-slate-800">{it.nama}</td>
                    <td className="px-3 py-2 text-slate-500 text-xs">{it.satuan}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {formatRp(it.harga)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && data && data.daftar.length > 0 && (
          <p className="text-[11px] text-slate-400 mt-2">
            Menampilkan {rows.length} dari {data.daftar.length} komoditas - Sumber: {data.sumber}
          </p>
        )}
      </div>
    </div>
  );
};
