import React, { useState, useEffect, useCallback } from 'react';
import { Apple, Plus, Trash2 } from 'lucide-react';
import { FruitPrice } from '../types';
import { api } from '../api';

export const FruitPriceManager: React.FC = () => {
  const [rows, setRows] = useState<FruitPrice[]>([]);
  const [mePhone, setMePhone] = useState('');
  const [nama, setNama] = useState('');
  const [harga, setHarga] = useState('');
  const [satuan, setSatuan] = useState('kg');
  const [pasar, setPasar] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const meRes = await api('/api/auth/me');
      if (meRes.ok) {
        const me = await meRes.json();
        setMePhone(me?.noHp || '');
      }
      const res = await api('/api/fruit-prices');
      if (res.ok) setRows(await res.json());
    } catch {
      /* abaikan: panel ikut render kosong */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await api('/api/fruit-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp: mePhone, nama, satuan, harga: Number(harga), pasar }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setRows((r) => [j, ...r]);
      setNama('');
      setHarga('');
      setPasar('');
      setMsg({ kind: 'ok', text: `${j.id} tersimpan dan tampil di tab Buah publik.` });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Gagal menyimpan.' });
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    setMsg(null);
    try {
      const res = await api(`/api/fruit-prices/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp: mePhone }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setRows((r) => r.filter((x) => x.id !== id));
      setMsg({ kind: 'ok', text: `${id} dihapus.` });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Gagal menghapus.' });
    }
  };

  return (
    <div className="mt-6 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
          <Apple className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-base font-bold text-slate-900">Harga Buah (Input Admin)</h2>
          <p className="text-xs text-slate-500">Digabung baris live InfoPangan di tab Buah publik.</p>
        </div>
      </div>

      {rows.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-slate-400">{r.id}</span>
              <span className="font-medium text-slate-800 flex-1 truncate">{r.nama}</span>
              {r.pasar && <span className="text-xs text-slate-500 truncate">{r.pasar}</span>}
              <span className="tabular-nums text-slate-900">Rp{r.harga.toLocaleString('id-ID')}/{r.satuan}</span>
              <button
                type="button"
                onClick={() => del(r.id)}
                title={`Hapus ${r.id}`}
                aria-label={`Hapus ${r.nama}`}
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <input
          type="text"
          value={nama}
          onChange={(e) => setNama(e.target.value)}
          placeholder="Nama buah"
          aria-label="Nama buah"
          required
          maxLength={60}
          className="col-span-2 sm:col-span-2 text-sm border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
        />
        <input
          type="number"
          value={harga}
          onChange={(e) => setHarga(e.target.value)}
          placeholder="Harga"
          aria-label="Harga"
          required
          min={1}
          className="text-sm border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 tabular-nums"
        />
        <input
          type="text"
          value={satuan}
          onChange={(e) => setSatuan(e.target.value)}
          placeholder="Satuan"
          aria-label="Satuan"
          maxLength={12}
          className="text-sm border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
        />
        <input
          type="text"
          value={pasar}
          onChange={(e) => setPasar(e.target.value)}
          placeholder="Pasar (opsional)"
          aria-label="Pasar"
          maxLength={60}
          className="text-sm border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
        />
        <button
          type="submit"
          disabled={busy}
          className="col-span-2 sm:col-span-1 flex items-center justify-center gap-1.5 text-sm font-medium px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Tambah
        </button>
      </form>

      {msg && (
        <p className={`mt-3 text-xs ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-rose-600'}`}>{msg.text}</p>
      )}
    </div>
  );
};
