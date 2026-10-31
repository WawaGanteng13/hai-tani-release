import React, { useState, useMemo } from 'react';
import {
  CalendarClock,
  Stethoscope,
  Activity,
  RefreshCw,
  FlaskConical,
  Handshake,
  Tag,
  Flag,
  BellRing,
  UserPlus,
  Info,
} from 'lucide-react';
import { FarmerRecord } from '../types';
import type { AgronomyRecommendationResult } from '../utils/agronomy';

const BULAN: Record<string, number> = {
  januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
  juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11,
};

function parsePanen(s: string): Date | null {
  const m = String(s || '').trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const idx = BULAN[m[1].toLowerCase()];
  if (idx === undefined) return null;
  return new Date(Number(m[2]), idx, 1);
}

function relatif(ts: string): string {
  const t = new Date(ts).getTime();
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 0) return 'baru saja';
  const mnt = Math.floor(d / 60000);
  if (mnt < 1) return 'baru saja';
  if (mnt < 60) return `${mnt} mnt lalu`;
  const jam = Math.floor(mnt / 60);
  if (jam < 24) return `${jam} jam lalu`;
  const hari = Math.floor(jam / 24);
  if (hari < 7) return `${hari} hari lalu`;
  return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

const Tile: React.FC<{ icon: React.ReactNode; title: string; sub: string; children: React.ReactNode; wide?: boolean }> = ({
  icon, title, sub, children, wide,
}) => (
  <section className={`bg-white rounded-2xl p-5 border border-slate-200 shadow-xs space-y-3 ${wide ? 'lg:col-span-2' : ''}`}>
    <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
      <span className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700">{icon}</span>
      <div>
        <h3 className="font-bold text-sm text-slate-800">{title}</h3>
        <p className="text-[11px] text-slate-500">{sub}</p>
      </div>
    </div>
    {children}
  </section>
);

const SiapPanen: React.FC<{ farmers: FarmerRecord[] }> = ({ farmers }) => {
  const rows = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const batas = new Date(now);
    batas.setDate(batas.getDate() + 120);
    return farmers
      .map((f) => ({ f, tgl: parsePanen(f.estimasiPanen) }))
      .filter((r): r is { f: FarmerRecord; tgl: Date } => !!r.tgl && r.tgl >= now && r.tgl <= batas)
      .sort((a, b) => a.tgl.getTime() - b.tgl.getTime())
      .slice(0, 6);
  }, [farmers]);
  const totalTon = rows.reduce((n, r) => n + (Number(r.f.estimasiHasilTon) || 0), 0);

  if (rows.length === 0) {
    return (
      <div className="py-6 text-center">
        <CalendarClock className="w-8 h-8 mx-auto text-slate-300" />
        <p className="mt-2 text-xs font-medium text-slate-700">Belum ada panen 120 hari ke depan</p>
        <p className="mt-1 text-[11px] text-slate-500">Jadwal muncul otomatis dari data lahan petani.</p>
      </div>
    );
  }
  return (
    <div>
      <ul className="divide-y divide-slate-100">
        {rows.map(({ f }) => (
          <li key={f.id} className="py-2 flex items-center gap-3 min-w-0">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-800 truncate">{f.nama}</p>
              <p className="text-[11px] text-slate-500 truncate">{f.komoditas}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs font-bold text-slate-900 tabular-nums">
                {(Number(f.estimasiHasilTon) || 0).toLocaleString('id-ID')} Ton
              </p>
              <p className="text-[11px] text-emerald-700 font-medium">{f.estimasiPanen}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="pt-2 mt-1 border-t border-slate-100 text-[11px] text-slate-500">
        Total <span className="font-bold text-slate-800 tabular-nums">{totalTon.toLocaleString('id-ID')} Ton</span> siap diserap pasar.
      </p>
    </div>
  );
};

const KlinikTanaman: React.FC<{ crops: string[]; onUjiChat?: () => void }> = ({ crops, onUjiChat }) => {
  const [crop, setCrop] = useState(crops[0] || 'Padi');
  const [ha, setHa] = useState('1');
  const [hasil, setHasil] = useState<AgronomyRecommendationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hitung = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agronomy/fertilizer?crop=${encodeURIComponent(crop)}&ha=${encodeURIComponent(ha)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHasil(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menghitung');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_72px_auto] gap-2">
        <div>
          <label htmlFor="klinik-crop" className="block text-[11px] font-semibold text-slate-600 mb-1">Komoditas</label>
          <input
            id="klinik-crop" list="klinik-crops" value={crop} onChange={(e) => setCrop(e.target.value)}
            className="w-full text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
          />
          <datalist id="klinik-crops">
            {crops.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div>
          <label htmlFor="klinik-ha" className="block text-[11px] font-semibold text-slate-600 mb-1">Ha</label>
          <input
            id="klinik-ha" inputMode="decimal" value={ha} onChange={(e) => setHa(e.target.value)}
            className="w-full text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none"
          />
        </div>
        <div className="flex items-end">
          <button
            onClick={hitung} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
          >
            <FlaskConical className="w-3.5 h-3.5" />
            {loading ? '...' : 'Hitung'}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-2">
          {error}. <button onClick={hitung} className="font-semibold underline cursor-pointer">Coba lagi</button>
        </p>
      )}
      {hasil ? (
        <div className="space-y-2">
          <ul className="divide-y divide-slate-100 border-y border-slate-100">
            {hasil.pupuk.slice(0, 4).map((p) => (
              <li key={p.jenis} className="py-1.5 flex items-center justify-between gap-2 text-[11px]">
                <span className="text-slate-700 truncate">{p.jenis}</span>
                <span className="font-bold text-slate-900 tabular-nums shrink-0">
                  {(p.totalKg ?? 0).toLocaleString('id-ID')} kg
                </span>
              </li>
            ))}
          </ul>
          {hasil.jadwalAplikasi[0] && (
            <p className="text-[11px] text-slate-500 leading-snug">
              <span className="font-semibold text-slate-700">{hasil.jadwalAplikasi[0].fase}:</span> {hasil.jadwalAplikasi[0].komposisi}
            </p>
          )}
          <p className="text-[11px] text-slate-400">Acuan Balitbangtan/Kementan untuk {hasil.luasLahanHa} Ha.</p>
        </div>
      ) : !error && (
        <p className="text-[11px] text-slate-500 leading-snug">
          Dosis pupuk per hektar sesuai acuan Balitbangtan. Ada gejala hama? Jepret fotonya, kirim ke Kang Tani lewat chat.
        </p>
      )}
      {onUjiChat && (
        <button onClick={onUjiChat} className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900 cursor-pointer">
          Uji konsultasi di Simulator
        </button>
      )}
    </div>
  );
};

interface AktivitasItem { ts: string; aksi: string; teks: string }

function ikonAksi(aksi: string) {
  const cls = 'w-3.5 h-3.5 shrink-0';
  if (aksi === 'deal') return <Handshake className={`${cls} text-emerald-600`} />;
  if (aksi === 'create' || aksi === 'onboarded_weak') return <UserPlus className={`${cls} text-blue-600`} />;
  if (aksi === 'price' || aksi === 'budget') return <Tag className={`${cls} text-amber-600`} />;
  if (aksi === 'flagged' || aksi === 'followup_fail') return <Flag className={`${cls} text-rose-600`} />;
  if (aksi === 'followup') return <BellRing className={`${cls} text-indigo-600`} />;
  return <Info className={`${cls} text-slate-400`} />;
}

const ArusAktivitas: React.FC = () => {
  const [items, setItems] = useState<AktivitasItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/aktivitas');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    }
  };

  React.useEffect(() => { load(); }, []);

  if (error) {
    return (
      <p role="alert" className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-2">
        {error}. <button onClick={load} className="font-semibold underline cursor-pointer">Coba lagi</button>
      </p>
    );
  }
  if (!items) {
    return (
      <div className="grid sm:grid-cols-2 gap-x-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="py-2 flex items-center gap-2.5 animate-pulse">
            <div className="w-4 h-4 rounded bg-slate-200" />
            <div className="h-3.5 flex-1 rounded bg-slate-100" />
          </div>
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return <p className="text-[11px] text-slate-500 py-4 text-center">Belum ada aktivitas tercatat.</p>;
  }
  return (
    <ul className="grid sm:grid-cols-2 gap-x-6 divide-y sm:divide-y-0 divide-slate-100">
      {items.slice(0, 10).map((it, i) => (
        <li key={`${it.ts}-${i}`} className="py-2 flex items-center gap-2.5 min-w-0 sm:border-b sm:border-slate-100">
          {ikonAksi(it.aksi)}
          <span className="flex-1 min-w-0 text-[11px] text-slate-700 truncate">{it.teks}</span>
          <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">{relatif(it.ts)}</span>
        </li>
      ))}
    </ul>
  );
};

export const OperasiLapangan: React.FC<{ farmers: FarmerRecord[]; onUjiChat?: () => void }> = ({ farmers, onUjiChat }) => {
  const crops = useMemo(() => {
    const set = new Set<string>();
    farmers.forEach((f) => { if (f.komoditas) set.add(f.komoditas); });
    return Array.from(set).sort();
  }, [farmers]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Tile icon={<CalendarClock className="w-4 h-4" />} title="Siap Panen" sub="Panen 120 hari ke depan">
        <SiapPanen farmers={farmers} />
      </Tile>
      <Tile icon={<Stethoscope className="w-4 h-4" />} title="Klinik Tanaman" sub="Dosis pupuk dan jalur lapor hama">
        <KlinikTanaman crops={crops} onUjiChat={onUjiChat} />
      </Tile>
      <div className="lg:col-span-2">
        <Tile icon={<Activity className="w-4 h-4" />} title="Arus Aktivitas" sub="Kesepakatan, penawaran, dan pendaftaran terbaru">
          <div className="flex justify-end -mt-1">
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
              title="Muat ulang seluruh dasbor"
            >
              <RefreshCw className="w-3 h-3" />
              Segarkan
            </button>
          </div>
          <ArusAktivitas />
        </Tile>
      </div>
    </div>
  );
};
