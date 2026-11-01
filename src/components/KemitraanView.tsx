import React, { useState, useEffect, useMemo } from 'react';
import {
  Handshake,
  Sprout,
  ChevronDown,
  Plus,
  Trash2,
  Check,
  MapPin,
  RefreshCw,
} from 'lucide-react';
import { FarmerRecord, SupplierRecord, Offer, OfferStatus, FarmerNeed, NeedStatus, NeedKategori } from '../types';

function relatif(ts?: string): string {
  if (!ts) return '';
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
  if (hari < 30) return `${hari} hari lalu`;
  return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

function km(aLat: number, aLng: number, bLat: number, bLng: number): number | null {
  if (![aLat, aLng, bLat, bLng].every((v) => typeof v === 'number' && isFinite(v))) return null;
  if (aLat === 0 && aLng === 0) return null;
  const R = 6371;
  const dLa = ((bLat - aLat) * Math.PI) / 180;
  const dLn = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLa / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const OFR_BADGE: Record<OfferStatus, string> = {
  OPEN: 'bg-amber-100 text-amber-800',
  COCOK: 'bg-blue-100 text-blue-800',
  SEBAGIAN: 'bg-indigo-100 text-indigo-800',
  DEAL: 'bg-emerald-100 text-emerald-800',
  BATAL: 'bg-slate-100 text-slate-500',
};

const NEED_BADGE: Record<NeedStatus, string> = {
  BARU: 'bg-slate-100 text-slate-700',
  DIHUBUNGKAN: 'bg-blue-100 text-blue-800',
  TERPENUHI: 'bg-emerald-100 text-emerald-800',
  BATAL: 'bg-rose-100 text-rose-700',
};

const KAT_SUPPLIER: Record<NeedKategori, string[] | null> = {
  PUPUK: ['Pupuk & Saprodi'],
  OBAT: ['Pupuk & Saprodi'],
  BIBIT: ['Bibit & Benih'],
  LAINNYA: null,
};

interface Props {
  farmers: FarmerRecord[];
  suppliers: SupplierRecord[];
  requesterNoHp: string;
  onToast: (text: string, type?: 'success' | 'warning' | 'info') => void;
}

const rupiah = (n: number) => `Rp${(n || 0).toLocaleString('id-ID')}`;

const PermintaanBuyer: React.FC<{
  farmers: FarmerRecord[];
  requesterNoHp: string;
  onToast: Props['onToast'];
}> = ({ farmers, requesterNoHp, onToast }) => {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nama, setNama] = useState('');
  const [catatan, setCatatan] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/offers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOffers(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    }
  };
  useEffect(() => { load(); }, []);

  const farmerName = (id: string) => farmers.find((f) => f.id === id)?.nama || id;

  const openDetail = (o: Offer) => {
    if (openId === o.id) { setOpenId(null); return; }
    setOpenId(o.id);
    setNama(o.namaBuyer || '');
    setCatatan(o.catatan || '');
  };

  const save = async (o: Offer, followup: boolean) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/offers/${encodeURIComponent(o.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp, namaBuyer: nama, catatan, ...(followup ? { followupAt: 'now' } : {}) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const saved = await res.json();
      setOffers((prev) => (prev || []).map((x) => (x.id === saved.id ? saved : x)));
      onToast(followup ? `${o.id} ditandai sudah followup.` : `${o.id} tersimpan.`, 'success');
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Gagal menyimpan', 'warning');
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
        {error}. <button onClick={load} className="font-semibold underline cursor-pointer">Coba lagi</button>
      </p>
    );
  }
  if (!offers) {
    return (
      <div className="space-y-2 animate-pulse" aria-label="Memuat permintaan buyer">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-9 rounded-lg bg-slate-100" />)}
      </div>
    );
  }
  if (offers.length === 0) {
    return (
      <div className="py-8 text-center">
        <Handshake className="w-8 h-8 mx-auto text-slate-300" />
        <p className="mt-2 text-xs font-medium text-slate-700">Belum ada permintaan buyer</p>
        <p className="mt-1 text-[11px] text-slate-500">Muncul otomatis saat buyer chat "butuh" ke Kang Tani.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-slate-100">
      {offers.map((o) => (
        <li key={o.id}>
          <button
            onClick={() => openDetail(o)}
            className="w-full py-2.5 flex items-center gap-3 text-left cursor-pointer min-w-0"
            aria-expanded={openId === o.id}
          >
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-slate-900 truncate">
                {o.id} <span className="font-medium text-slate-500">· {o.namaBuyer || o.buyerPhone}</span>
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                {o.komoditas} · <span className="tabular-nums">{(o.qtyKg || 0).toLocaleString('id-ID')} kg</span>
                {o.budgetPerKg ? <> · budget <span className="tabular-nums">{rupiah(o.budgetPerKg)}/kg</span></> : ' · budget belum diisi'}
              </p>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${OFR_BADGE[o.status]}`}>{o.status}</span>
            <span className="text-[10px] text-slate-500 tabular-nums shrink-0 hidden sm:inline">
              {o.followupAt ? `FU ${relatif(o.followupAt)}` : 'Belum FU'}
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition ${openId === o.id ? 'rotate-180' : ''}`} />
          </button>
          {openId === o.id && (
            <div className="pb-3 pl-1 pr-1 space-y-2.5 animate-fade-in">
              <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                <p className="font-semibold text-slate-700 mb-1">Supply dari petani ({o.lines.length} jalur):</p>
                {o.lines.length === 0 ? (
                  <p className="text-slate-500">Belum dicarikan supply. Minta petani input stok via chat.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {o.lines.map((l, i) => (
                      <li key={i} className="tabular-nums">
                        {farmerName(l.farmerId)} — {(l.alokasiKg ?? l.stokKg ?? 0).toLocaleString('id-ID')} kg
                        {l.hargaPetaniPerKg ? ` @ ${rupiah(l.hargaPetaniPerKg)}/kg` : ' (harga belum masuk)'}
                        {l.cocok === false && <span className="text-rose-600"> · tidak cocok</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {o.spreadTotalRp ? <p className="mt-1">Selisih kas: <span className="font-bold tabular-nums">{rupiah(o.spreadTotalRp)}</span></p> : null}
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor={`nb-${o.id}`}>Nama buyer</label>
                  <input
                    id={`nb-${o.id}`} value={nama} onChange={(e) => setNama(e.target.value)} maxLength={60}
                    placeholder="Nama buyer / toko" className="w-full text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none placeholder:text-slate-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor={`ct-${o.id}`}>Catatan followup</label>
                  <input
                    id={`ct-${o.id}`} value={catatan} onChange={(e) => setCatatan(e.target.value)} maxLength={300}
                    placeholder="cth. sudah telepon, minta kirim Selasa" className="w-full text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none placeholder:text-slate-500"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => save(o, false)} disabled={saving}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
                >
                  Simpan
                </button>
                <button
                  onClick={() => save(o, true)} disabled={saving}
                  className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  Tandai sudah followup
                </button>
                <span className="text-[10px] text-slate-500">Status negosiasi milik chat; admin hanya mencatat.</span>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
};

const KebutuhanPetani: React.FC<Props> = ({ farmers, suppliers, requesterNoHp, onToast }) => {
  const [needs, setNeeds] = useState<FarmerNeed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fFarmer, setFFarmer] = useState('');
  const [fKat, setFKat] = useState<NeedKategori>('PUPUK');
  const [fItem, setFItem] = useState('');
  const [fJumlah, setFJumlah] = useState('');

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/farmer-needs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNeeds(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    }
  };
  useEffect(() => { load(); }, []);

  const farmerOf = (id: string) => farmers.find((f) => f.id === id);
  const supplierOf = (id?: string) => (id ? suppliers.find((s) => s.id === id) : undefined);

  const kandidat = (n: FarmerNeed) => {
    const f = farmerOf(n.farmerId);
    const katFilter = KAT_SUPPLIER[n.kategori];
    return suppliers
      .filter((s) => !katFilter || katFilter.includes(s.kategori))
      .map((s) => ({ s, d: f ? km(f.latitude, f.longitude, s.latitude, s.longitude) : null }))
      .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
  };

  const tambah = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fFarmer || !fItem.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/farmer-needs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp, farmerId: fFarmer, kategori: fKat, item: fItem.trim(), jumlah: fJumlah.trim() || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const rec = await res.json();
      setNeeds((prev) => [rec, ...(prev || [])]);
      setFItem(''); setFJumlah(''); setShowForm(false);
      onToast(`${rec.id} tercatat untuk ${farmerOf(rec.farmerId)?.nama || 'petani'}.`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal menambah', 'warning');
    } finally {
      setSaving(false);
    }
  };

  const patch = async (n: FarmerNeed, body: Record<string, unknown>, msg: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/farmer-needs/${encodeURIComponent(n.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp, ...body }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const saved = await res.json();
      setNeeds((prev) => (prev || []).map((x) => (x.id === saved.id ? saved : x)));
      onToast(msg, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal menyimpan', 'warning');
    } finally {
      setSaving(false);
    }
  };

  const hapus = async (n: FarmerNeed) => {
    if (!window.confirm(`Hapus ${n.id} (${n.item})?`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/farmer-needs/${encodeURIComponent(n.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNeeds((prev) => (prev || []).filter((x) => x.id !== n.id));
      setOpenId(null);
      onToast(`${n.id} dihapus.`, 'info');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal menghapus', 'warning');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-end mb-1">
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-900 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          {showForm ? 'Tutup' : 'Catat kebutuhan'}
        </button>
      </div>
      {showForm && (
        <form onSubmit={tambah} className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2 p-3 mb-2 bg-slate-50 border border-slate-200 rounded-xl animate-fade-in">
          <div className="lg:col-span-2">
            <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor="need-farmer">Petani</label>
            <select
              id="need-farmer" value={fFarmer} onChange={(e) => setFFarmer(e.target.value)} required
              className="w-full text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
            >
              <option value="">Pilih petani…</option>
              {farmers.map((f) => <option key={f.id} value={f.id}>{f.nama} — {f.komoditas}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor="need-kat">Kategori</label>
            <select
              id="need-kat" value={fKat} onChange={(e) => setFKat(e.target.value as NeedKategori)}
              className="w-full text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
            >
              {(['PUPUK', 'OBAT', 'BIBIT', 'LAINNYA'] as NeedKategori[]).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor="need-item">Item *</label>
            <input
              id="need-item" value={fItem} onChange={(e) => setFItem(e.target.value)} required maxLength={80}
              placeholder="cth. Urea 50 kg" className="w-full text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none placeholder:text-slate-500"
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor="need-jumlah">Jumlah</label>
              <input
                id="need-jumlah" value={fJumlah} onChange={(e) => setFJumlah(e.target.value)} maxLength={30}
                placeholder="cth. 2 karung" className="w-full text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none placeholder:text-slate-500"
              />
            </div>
            <button
              type="submit" disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold disabled:opacity-50 shrink-0 cursor-pointer"
            >
              Simpan
            </button>
          </div>
        </form>
      )}

      {error ? (
        <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          {error}. <button onClick={load} className="font-semibold underline cursor-pointer">Coba lagi</button>
        </p>
      ) : !needs ? (
        <div className="space-y-2 animate-pulse" aria-label="Memuat kebutuhan petani">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-9 rounded-lg bg-slate-100" />)}
        </div>
      ) : needs.length === 0 ? (
        <div className="py-8 text-center">
          <Sprout className="w-8 h-8 mx-auto text-slate-300" />
          <p className="mt-2 text-xs font-medium text-slate-700">Belum ada kebutuhan tercatat</p>
          <p className="mt-1 text-[11px] text-slate-500">Catat saat petani minta pupuk, obat, atau bibit.</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {needs.map((n) => {
            const f = farmerOf(n.farmerId);
            const sup = supplierOf(n.supplierId);
            const dist = f && sup ? km(f.latitude, f.longitude, sup.latitude, sup.longitude) : null;
            const isOpen = openId === n.id;
            return (
              <li key={n.id}>
                <button
                  onClick={() => setOpenId(isOpen ? null : n.id)}
                  className="w-full py-2.5 flex items-center gap-3 text-left cursor-pointer min-w-0"
                  aria-expanded={isOpen}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-900 truncate">
                      {n.id} <span className="font-medium text-slate-500">· {f?.nama || n.farmerId}</span>
                    </p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {n.kategori} · {n.item}{n.jumlah ? ` (${n.jumlah})` : ''}
                      {sup ? <> · <span className="text-emerald-700 font-medium">{sup.nama}{dist !== null ? ` (${dist.toFixed(1)} km)` : ''}</span></> : ' · belum dihubungkan'}
                    </p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${NEED_BADGE[n.status]}`}>{n.status}</span>
                  <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && (
                  <div className="pb-3 pl-1 pr-1 space-y-2.5 animate-fade-in">
                    <div className="grid sm:grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor={`sup-${n.id}`}>
                          Hubungkan ke toko mitra
                        </label>
                        <select
                          id={`sup-${n.id}`} value={n.supplierId || ''} disabled={saving}
                          onChange={(e) => patch(n, { supplierId: e.target.value }, e.target.value ? `${n.id} dihubungkan ke toko.` : `${n.id} dilepas dari toko.`)}
                          className="w-full text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                        >
                          <option value="">Belum dihubungkan…</option>
                          {kandidat(n).map(({ s, d }) => (
                            <option key={s.id} value={s.id}>
                              {s.nama} ({s.kategori}){d !== null ? ` — ${d.toFixed(1)} km` : ' — jarak?'}
                              {s.radiusLayananKm && d !== null && d > s.radiusLayananKm ? ' [lewat radius]' : ''}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-[10px] text-slate-500 flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          Urut dari yang terdekat dengan lahan petani.
                        </p>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1" htmlFor={`st-${n.id}`}>Status</label>
                        <select
                          id={`st-${n.id}`} value={n.status} disabled={saving}
                          onChange={(e) => patch(n, { status: e.target.value }, `${n.id} → ${e.target.value}.`)}
                          className="w-full text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                        >
                          {(['BARU', 'DIHUBUNGKAN', 'TERPENUHI', 'BATAL'] as NeedStatus[]).map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <p className="mt-1 text-[10px] text-slate-500">Diperbarui {relatif(n.updatedAt) || '-'}.</p>
                      </div>
                    </div>
                    {n.catatan && <p className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">{n.catatan}</p>}
                    <div>
                      <button
                        onClick={() => hapus(n)} disabled={saving}
                        className="flex items-center gap-1 text-[11px] font-medium text-rose-600 hover:text-rose-800 disabled:opacity-50 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        Hapus catatan ini
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export const KemitraanView: React.FC<Props> = (props) => {
  const [reloadKey, setReloadKey] = useState(0);
  const tile = 'bg-white rounded-2xl p-5 border border-slate-200 shadow-xs space-y-3';
  const head = (icon: React.ReactNode, title: string, sub: string) => (
    <div className="flex items-center justify-between pb-2 border-b border-slate-100">
      <div className="flex items-center gap-2">
        <span className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700">{icon}</span>
        <div>
          <h3 className="font-bold text-sm text-slate-800">{title}</h3>
          <p className="text-[11px] text-slate-500">{sub}</p>
        </div>
      </div>
      <button
        onClick={() => setReloadKey((k) => k + 1)}
        className="flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
        title="Muat ulang kedua daftar"
      >
        <RefreshCw className="w-3 h-3" />
        Segarkan
      </button>
    </div>
  );
  return (
    <div className="max-w-7xl mx-auto space-y-6" key={reloadKey}>
      <section className={tile}>
        {head(<Handshake className="w-4 h-4" />, 'Permintaan Buyer', 'Cari barang, budget, supply, dan followup')}
        <PermintaanBuyer farmers={props.farmers} requesterNoHp={props.requesterNoHp} onToast={props.onToast} />
      </section>
      <section className={tile}>
        {head(<Sprout className="w-4 h-4" />, 'Kebutuhan Petani', 'Pupuk, obat, bibit, dan toko penghubung')}
        <KebutuhanPetani {...props} />
      </section>
    </div>
  );
};
