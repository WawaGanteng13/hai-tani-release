import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import {
  Sprout,
  Users,
  Store,
  Ruler,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  Lock,
  Carrot,
  Apple,
  MessageSquare,
  MapPin,
  IdCard,
  Check,
  ArrowRight,
} from 'lucide-react';
import { MarketPriceTable } from './MarketPriceTable';
import { FarmerSupplierMapView } from './FarmerSupplierMapView';
import { FarmerRecord, SupplierRecord } from '../types';

const WA_CHAT_URL = 'https://wa.me/62881026139498?text=Halo%20Kang%20Tani';

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
    deal: number;
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

const Reveal: React.FC<{ children: React.ReactNode; delay?: number; className?: string }> = ({ children, delay = 0, className }) => {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, delay }}
    >
      {children}
    </motion.div>
  );
};

type BenefitKey = 'petani' | 'dinas' | 'kios';

const BENEFITS: Record<BenefitKey, { label: string; rows: string[] }> = {
  petani: {
    label: 'Petani',
    rows: [
      'Daftar lahan lewat chat, voice note, atau foto. Tanpa aplikasi baru.',
      'Bandingkan harga SISKAPERBAPO dan Mantung, lalu tawar langsung dengan buyer.',
      'Konsultasi hama dan takaran pupuk per hektar.',
      'Terima Kartu Tanda Registrasi resmi ber-QR.',
      'Data kosong tetap kosong. Tidak ada karangan.',
    ],
  },
  dinas: {
    label: 'Dinas dan PPL',
    rows: [
      'Daftarkan dan verifikasi petani langsung dari WhatsApp.',
      'Rekap real-time: petani, luas, proyeksi panen, sebaran.',
      'Pantau anomali harga per pasar dan per komoditas.',
      'Siapkan broadcast hama dan jadwal tanam.',
      'Ekspor CSV rapi untuk arsip dinas.',
    ],
  },
  kios: {
    label: 'Kios dan supplier',
    rows: [
      'Tampil di peta dan katalog agar petani menemukan tokomu.',
      'Catat kas, stok, dan HPP lewat chat.',
      'Terima laporan rujukan pembelian dari petani.',
      'Bangun riwayat kemitraan yang tercatat.',
    ],
  },
};

const PriceTicker: React.FC = () => {
  const [items, setItems] = useState<Array<{ nama: string; harga: number; satuan: string }>>([]);

  useEffect(() => {
    fetch('/api/harga-pasar?sumber=mantung')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.daftar?.length) setItems(j.daftar.slice(0, 12));
      })
      .catch(() => {});
  }, []);

  if (items.length === 0) return null;
  const row = [...items, ...items];
  return (
    <div className="ticker border-b border-emerald-950 bg-emerald-950 overflow-hidden" aria-label="Harga sayur terkini">
      <div className="ticker-track py-2.5">
        {row.map((it, i) => (
          <span key={i} className="flex items-center shrink-0">
            <span className="px-5 text-sm text-emerald-50 whitespace-nowrap">
              <span className="font-medium">{it.nama}</span>
              <span className="ml-2 tabular-nums text-emerald-200">Rp{(it.harga ?? 0).toLocaleString('id-ID')}</span>
            </span>
            <span className="w-px h-4 bg-emerald-800" aria-hidden="true" />
          </span>
        ))}
      </div>
    </div>
  );
};

export const PublicView: React.FC = () => {
  const [data, setData] = useState<PublikRingkas | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [benefitTab, setBenefitTab] = useState<BenefitKey>('petani');
  const [hargaTab, setHargaTab] = useState<'sayur' | 'buah'>('sayur');
  const reduceMotion = useReducedMotion();

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

  const heroAnim = reduceMotion ? {} : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 } };

  return (
    <div className="landing min-h-screen bg-white font-sans text-slate-800 antialiased">
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <a href="#atas" className="flex items-center gap-2.5 shrink-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-700 flex items-center justify-center">
              <Sprout className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-slate-900">Hai Tani</span>
          </a>
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
            <a href="#tentang" className="link-directional hover:text-slate-900">Tentang</a>
            <a href="#fitur" className="link-directional hover:text-slate-900">Fitur</a>
            <a href="#harga" className="link-directional hover:text-slate-900">Harga</a>
            <a href="#peta" className="link-directional hover:text-slate-900">Peta</a>
          </nav>
          <div className="flex items-center gap-2 shrink-0">
            <Link to="/admin" className="hidden sm:flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-2">
              <Lock className="w-3.5 h-3.5" />
              Masuk Admin
            </Link>
            <a
              href={WA_CHAT_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg px-4 py-2 transition active:scale-[0.98]"
            >
              Chat Kang Tani
            </a>
          </div>
        </div>
      </header>

      <main id="atas">
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-14 pb-12 md:pt-20 md:pb-16 grid md:grid-cols-12 gap-10 items-center">
          <motion.div className="md:col-span-7" {...heroAnim} transition={{ duration: 0.55 }}>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
              Dari petani, untuk petani. Lewat WhatsApp.
            </p>
            <h1 className="mt-3 text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05] text-slate-900">
              Ketemu buyer langsung dari chat.
            </h1>
            <p className="mt-4 text-base md:text-lg text-slate-600 leading-relaxed max-w-[52ch]">
              Hai Tani dibuat petani untuk petani. Catat lahan, cek harga, dan jual langsung ke buyer. Semua lewat WhatsApp.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a
                href={WA_CHAT_URL}
                target="_blank"
                rel="noreferrer"
                className="btn-swap text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg px-5 py-2.5 transition active:scale-[0.98]"
              >
                <span className="swap-a">Chat Kang Tani</span>
                <span className="swap-b" aria-hidden="true">Chat Kang Tani</span>
              </a>
              <a
                href="#harga"
                className="text-sm font-semibold text-slate-700 border border-slate-300 hover:border-slate-400 rounded-lg px-5 py-2.5 transition active:scale-[0.98]"
              >
                Lihat harga pasar
              </a>
            </div>
          </motion.div>
          <motion.div
            className="md:col-span-5"
            {...heroAnim}
            transition={{ duration: 0.55, delay: 0.12 }}
          >
            <img
              src="/landing-hp.jpg"
              alt="Petani memegang ponsel dan peti cabai merah di ladang"
              className="w-full aspect-[4/3] object-cover rounded-lg"
              loading="eager"
            />
          </motion.div>
        </section>

        <PriceTicker />

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
                className="flex items-center gap-1.5 text-sm font-medium text-rose-700 hover:text-rose-900 shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                Coba lagi
              </button>
            </div>
          </div>
        )}

        <section id="tentang" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-20 scroll-mt-20">
          <div className="grid md:grid-cols-2 gap-10 items-center">
            <Reveal>
              <img
                src="/landing-panen.jpg"
                alt="Petani menyerahkan peti cabai dan tomat ke buyer"
                className="w-full aspect-[4/3] object-cover rounded-lg"
                loading="lazy"
              />
            </Reveal>
            <Reveal delay={0.08}>
            <div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900">Apa itu Hai Tani</h2>
              <p className="mt-4 text-base text-slate-600 leading-relaxed">
                Hai Tani, atau Kang Tani AI, dibuat oleh petani untuk kesejahteraan petani.
                Kegunaan utamanya satu: mempertemukan petani dan buyer lewat bot WhatsApp,
                supaya panen terjual adil tanpa rantai tengkulak berlapis.
              </p>
              <p className="mt-3 text-base text-slate-600 leading-relaxed">
                Di sekelilingnya ada pendataan lahan, harga pasar live, peta sebaran,
                dan kartu registrasi. Tidak ada aplikasi untuk dipasang. Cukup WhatsApp.
              </p>
              <a href="#gabung" className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 hover:text-emerald-800">
                Cara bergabung
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
            </Reveal>
          </div>
        </section>

        <section id="fitur" className="max-w-7xl mx-auto px-4 sm:px-6 pb-16 md:pb-20 scroll-mt-20">
          <Reveal>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900">Yang dikerjakan Hai Tani</h2>
          </Reveal>
          <div className="mt-8 grid md:grid-cols-3 gap-6">
            <Reveal delay={0.05} className="md:col-span-2">
              <div className="bg-emerald-950 rounded-lg p-6 md:p-8 h-full flex flex-col justify-between min-h-[240px]">
                <div>
                  <h3 className="text-lg font-bold text-white">Ketemu buyer langsung</h3>
                  <p className="mt-1.5 text-sm text-emerald-200 leading-relaxed max-w-md">
                    Fitur utama Hai Tani. Sampaikan butuh atau stok lewat chat, tawar harga,
                    tutup deal. Tercatat di kas.
                  </p>
                </div>
                <p className="mt-6 text-5xl font-bold tabular-nums text-white">
                  {(s?.deal ?? 0).toLocaleString('id-ID')}
                  <span className="ml-2 text-sm font-medium text-emerald-300">kesepakatan tercatat</span>
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.1} className="h-full">
              <div className="h-full flex flex-col">
                <img
                  src="/landing-pasar.jpg"
                  alt="Los sayur di pasar tradisional"
                  className="w-full flex-1 min-h-[160px] object-cover rounded-lg"
                  loading="lazy"
                />
                <h3 className="mt-4 font-bold text-slate-900">Harga pasar live</h3>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                  Sayur Mantung Malang dan buah InfoPangan DKI. Bandingkan sebelum jual.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="border-t-2 border-slate-900 pt-4">
                <MessageSquare className="w-5 h-5 text-emerald-700" />
                <h3 className="mt-3 font-bold text-slate-900">Chatbot WhatsApp</h3>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                  Daftar lahan, cek harga, konsultasi hama. Teks, voice note, foto.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.05}>
              <div className="border-t-2 border-slate-900 pt-4">
                <MapPin className="w-5 h-5 text-emerald-700" />
                <h3 className="mt-3 font-bold text-slate-900">Peta sebaran</h3>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                  Titik hijau petani dan biru kios, lengkap dengan jarak dan rute.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="border-t-2 border-slate-900 pt-4">
                <IdCard className="w-5 h-5 text-emerald-700" />
                <h3 className="mt-3 font-bold text-slate-900">Kartu registrasi QR</h3>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                  Setiap petani terima kartu PDF resmi yang bisa dipindai.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="border-y border-slate-200 bg-slate-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-20">
            <Reveal>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900">Manfaat bergabung</h2>
              <div className="mt-6 inline-flex rounded-lg border border-slate-300 bg-white p-1" role="tablist" aria-label="Manfaat per peran">
                {(Object.keys(BENEFITS) as BenefitKey[]).map((k) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={benefitTab === k}
                    onClick={() => setBenefitTab(k)}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition cursor-pointer ${
                      benefitTab === k ? 'bg-emerald-700 text-white' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {BENEFITS[k].label}
                  </button>
                ))}
              </div>
            </Reveal>
            <div role="tabpanel" className="mt-6 max-w-2xl">
              <ul className="space-y-3">
                {BENEFITS[benefitTab].rows.map((row) => (
                  <li key={row} className="flex items-start gap-3 text-[15px] text-slate-700 leading-relaxed">
                    <span className="mt-0.5 w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3 text-emerald-700" />
                    </span>
                    {row}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="gabung" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-20 scroll-mt-20">
          <Reveal>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900">Mulai dalam tiga langkah</h2>
          </Reveal>
          <div className="mt-8 grid sm:grid-cols-3 gap-8">
            {[
              { verb: 'Sapa', text: 'Buka chat Kang Tani, ketik daftar.' },
              { verb: 'Catat', text: 'Kirim nama, komoditas, luas, lokasi. Teks, voice, atau foto.' },
              { verb: 'Terima', text: 'Dapatkan kartu QR dan mulai terima tawaran buyer.' },
            ].map((st, i) => (
              <Reveal key={st.verb} delay={i * 0.07}>
                <div className={i > 0 ? 'sm:border-l sm:border-slate-200 sm:pl-8' : ''}>
                  <p className="text-xl font-bold text-slate-900">{st.verb}</p>
                  <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{st.text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="relative overflow-hidden">
          <img
            src="/landing-sawah.jpg"
            alt="Teras sawah saat matahari terbit"
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-emerald-950/85" aria-hidden="true" />
          <div className="relative max-w-3xl mx-auto px-4 sm:px-6 py-16 md:py-20 text-center">
            <Reveal>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white">
                Dari Petani, untuk Kesejahteraan Petani.
              </h2>
              <div className="mt-8 divide-y divide-white/15 border-y border-white/15">
                {[
                  'Harga adil lewat pertemuan langsung petani dan buyer.',
                  'Tanpa rantai tengkulak berlapis.',
                  'Tanpa aplikasi baru. Cukup WhatsApp.',
                ].map((line) => (
                  <p key={line} className="py-4 text-base text-emerald-50 leading-relaxed">
                    {line}
                  </p>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <section id="harga" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-20 scroll-mt-20">
          <Reveal>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900">Harga sayur dan buah</h2>
            <p className="mt-2 text-sm text-slate-500">Harga acuan pasar, diperbarui berkala dari sumber resmi.</p>
            <div className="mt-5 inline-flex rounded-lg border border-slate-300 bg-white p-1" role="tablist" aria-label="Kelompok harga">
              <button
                role="tab"
                aria-selected={hargaTab === 'sayur'}
                onClick={() => setHargaTab('sayur')}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition cursor-pointer ${
                  hargaTab === 'sayur' ? 'bg-emerald-700 text-white' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Carrot className="w-4 h-4" />
                Sayur
              </button>
              <button
                role="tab"
                aria-selected={hargaTab === 'buah'}
                onClick={() => setHargaTab('buah')}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition cursor-pointer ${
                  hargaTab === 'buah' ? 'bg-emerald-700 text-white' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Apple className="w-4 h-4" />
                Buah
              </button>
            </div>
          </Reveal>
          <div className="mt-6" role="tabpanel">
            {hargaTab === 'sayur' ? (
              <MarketPriceTable sumber="mantung" badge="Pasar Mantung" title="Harga Sayur Terkini" />
            ) : (
              <MarketPriceTable sumber="buah" badge="InfoPangan" title="Harga Buah Terkini" />
            )}
          </div>
        </section>

        <section id="peta" className="border-t border-slate-200 scroll-mt-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-14 pb-4">
            <Reveal>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900">Peta sebaran</h2>
              <p className="mt-2 text-sm text-slate-500">
                Titik hijau petani, biru kios mitra. Nomor kontak tidak ditampilkan di halaman publik.
              </p>
            </Reveal>
          </div>
          <FarmerSupplierMapView farmers={farmers} suppliers={suppliers} hidePrivate />
        </section>

        <section className="bg-emerald-950">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-14 md:py-16 grid md:grid-cols-2 gap-10 items-center">
            <Reveal>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white">
                Siap jual langsung ke buyer?
              </h2>
              <p className="mt-3 text-sm text-emerald-200 leading-relaxed max-w-md">
                Kios dan buyer sudah menunggu di peta. Gratis, cukup nomor WhatsApp aktif.
              </p>
              <a
                href={WA_CHAT_URL}
                target="_blank"
                rel="noreferrer"
                className="btn-swap mt-6 text-sm font-semibold text-emerald-950 bg-white hover:bg-emerald-50 rounded-lg px-6 py-3 transition active:scale-[0.98]"
              >
                <span className="swap-a">Chat Kang Tani</span>
                <span className="swap-b" aria-hidden="true">Chat Kang Tani</span>
              </a>
            </Reveal>
            <Reveal delay={0.08}>
              <img
                src="/landing-kios.jpg"
                alt="Pemilik kios saprodi di tokonya"
                className="w-full aspect-[4/3] object-cover rounded-lg"
                loading="lazy"
              />
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-700 flex items-center justify-center">
              <Sprout className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900">Hai Tani</p>
              <p className="text-xs text-slate-500">Data per {updated || '-'}</p>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
            <a href="#tentang" className="hover:text-slate-900">Tentang</a>
            <a href="#fitur" className="hover:text-slate-900">Fitur</a>
            <a href="#gabung" className="hover:text-slate-900">Gabung</a>
            <Link to="/admin" className="hover:text-slate-900">Masuk Admin</Link>
          </nav>
        </div>
        <div className="border-t border-slate-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap gap-x-6 gap-y-1 justify-between text-xs text-slate-400">
            <span>Dari Petani, untuk Kesejahteraan Petani.</span>
            <span>© 2026 Hai Tani.</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
