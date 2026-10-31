import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { Header } from './components/Header';
import { PublicView } from './components/PublicView';
import { AgriProfessionalDashboard } from './components/AgriProfessionalDashboard';
import { WhatsAppChatbot } from './components/WhatsAppChatbot';
import { GoogleSheetsView } from './components/GoogleSheetsView';
import { MarketAnomalyView } from './components/MarketAnomalyView';
import { MarketPriceTable } from './components/MarketPriceTable';
import { FruitPriceManager } from './components/FruitPriceManager';
import { DataScientistPortal } from './components/DataScientistPortal';
import { FarmerSupplierMapView } from './components/FarmerSupplierMapView';
import { WebhookModal } from './components/WebhookModal';
import { AddFarmerModal } from './components/AddFarmerModal';
import { AddSupplierModal } from './components/AddSupplierModal';
import { AdminManagerModal } from './components/AdminManagerModal';
import { LayaModal } from './components/LayaModal';
import { TechnicalWhitepaperModal } from './components/TechnicalWhitepaperModal';
import { FarmerRecord, MarketCommodity, AnomalyNotification, StrategicRecommendation, AdminUser, LayaStatus, SupplierRecord } from './types';
import {
  INITIAL_FARMERS,
  INITIAL_COMMODITIES,
  INITIAL_NOTIFICATIONS,
  INITIAL_STRATEGIC_RECOMMENDATION,
  INITIAL_ADMINS,
  INITIAL_SUPPLIERS,
} from './data/mockData';
import { CheckCircle2, AlertTriangle, Info, X, Sprout } from 'lucide-react';

const TAB_TITLES = {
  dashboard: 'Ringkasan',
  chat: 'Simulator Chat',
  sheets: 'Data',
  market: 'Harga & Anomali',
  datascientist: 'Data Scientist',
  map: 'Peta',
} as const;

function AdminApp() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'chat' | 'sheets' | 'market' | 'datascientist' | 'map'>('dashboard');
  const [farmers, setFarmers] = useState<FarmerRecord[]>(INITIAL_FARMERS);
  const [commodities, setCommodities] = useState<MarketCommodity[]>(INITIAL_COMMODITIES);
  const [notifications, setNotifications] = useState<AnomalyNotification[]>(INITIAL_NOTIFICATIONS);
  const [recommendation, setRecommendation] = useState<StrategicRecommendation>(INITIAL_STRATEGIC_RECOMMENDATION);
  const [admins, setAdmins] = useState<AdminUser[]>(INITIAL_ADMINS);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>(INITIAL_SUPPLIERS);

  const [loading, setLoading] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [isWebhookModalOpen, setIsWebhookModalOpen] = useState(false);
  const [isAddFarmerModalOpen, setIsAddFarmerModalOpen] = useState(false);
  const [isAddSupplierModalOpen, setIsAddSupplierModalOpen] = useState(false);
  const [isAdminManagerOpen, setIsAdminManagerOpen] = useState(false);
  const [isLayaModalOpen, setIsLayaModalOpen] = useState(false);
  const [isWhitepaperModalOpen, setIsWhitepaperModalOpen] = useState(false);
  const [layaStatus, setLayaStatus] = useState<LayaStatus | null>(null);
  const [sheetsStatus, setSheetsStatus] = useState<{ workerOn?: boolean; queueDepth?: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layaLoading, setLayaLoading] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'warning' | 'info'; text: string } | null>(null);
  const [me, setMe] = useState<{ nama: string; role: string; noHp: string } | null>(null);
  const [loginNoHp, setLoginNoHp] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const showToast = (text: string, type: 'success' | 'warning' | 'info' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noHp: loginNoHp, password: loginPassword }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Login gagal');
      }
      setLoginPassword('');
      await loadData();
    } catch (err: any) {
      setLoginError(err.message || 'Login gagal');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
  };

  const fetchLayaStatus = async () => {
    setLayaLoading(true);
    try {
      const res = await fetch('/api/laya/status');
      if (res.ok) {
        const data = await res.json();
        setLayaStatus(data);
      }
    } catch (e) {
      console.error('Error fetching laya status:', e);
    } finally {
      setLayaLoading(false);
    }
  };

  // Fetch initial data from server
  const loadData = async () => {
    try {
      const meRes = await fetch('/api/auth/me');
      if (!meRes.ok) { setMe(null); setLoading(false); return; }
      setMe(await meRes.json());
    } catch {
      setMe(null); setLoading(false); return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [fRes, cRes, nRes, rRes, aRes, sRes] = await Promise.all([
        fetch('/api/farmers'),
        fetch('/api/commodities'),
        fetch('/api/notifications'),
        fetch('/api/strategic-recommendation'),
        fetch('/api/admins'),
        fetch('/api/suppliers'),
      ]);

      fetchLayaStatus();
      try {
        const shRes = await fetch('/api/sheets/status');
        if (shRes.ok) setSheetsStatus(await shRes.json());
      } catch {
        /* abaikan: indikator ikut status terakhir */
      }

      if (fRes.ok) {
        const fData = await fRes.json();
        if (Array.isArray(fData) && fData.length > 0) setFarmers(fData);
      }
      if (cRes.ok) {
        const cData = await cRes.json();
        if (Array.isArray(cData) && cData.length > 0) setCommodities(cData);
      }
      if (nRes.ok) {
        const nData = await nRes.json();
        if (Array.isArray(nData) && nData.length > 0) setNotifications(nData);
      }
      if (rRes.ok) {
        const rData = await rRes.json();
        if (rData && rData.judul) setRecommendation(rData);
      }
      if (aRes.ok) {
        const aData = await aRes.json();
        if (Array.isArray(aData) && aData.length > 0) setAdmins(aData);
      }
      if (sRes.ok) {
        const sData = await sRes.json();
        if (Array.isArray(sData) && sData.length > 0) setSuppliers(sData);
      }
    } catch (err) {
      console.error('Error fetching data:', err);
      setLoadError(err instanceof Error ? err.message : 'Koneksi gagal');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Handle adding admin
  const handleAddAdmin = async (newAdmin: Omit<AdminUser, 'id' | 'waktuTerdaftar'>, requesterNoHp: string) => {
    try {
      const res = await fetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newAdmin, requesterNoHp }),
      });
      if (res.ok) {
        const saved = await res.json();
        setAdmins((prev) => [saved, ...prev]);
        showToast(`Nomor ${saved.nama} (${saved.noHp}) berhasil didaftarkan sebagai ${saved.role}!`, 'success');
      } else {
        const err = await res.json();
        throw new Error(err.error || 'Gagal menambahkan admin');
      }
    } catch (err: any) {
      showToast(err.message || 'Gagal menambahkan admin', 'warning');
      throw err;
    }
  };

  // Handle deleting admin
  const handleDeleteAdmin = async (id: string, requesterNoHp: string) => {
    try {
      const res = await fetch(`/api/admins/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp }),
      });
      if (res.ok) {
        setAdmins((prev) => prev.filter((a) => a.id !== id));
        showToast('Nomor admin berhasil dicabut dari otorisasi Tani AI.', 'info');
      }
    } catch (err) {
      console.error(err);
      showToast('Gagal menghapus admin', 'warning');
    }
  };

  // Handle farmer added via WhatsApp Chatbot
  const handleFarmerRegistered = (newRecord: FarmerRecord) => {
    setFarmers((prev) => [newRecord, ...prev.filter((f) => f.id !== newRecord.id)]);
    showToast(`Data ${newRecord.nama} (${newRecord.komoditas}) berhasil dicatat & disinkronkan ke Google Sheets!`, 'success');
  };

  // Nomor operator dashboard (admin aktif pertama) untuk jejak audit tulis.
  const operatorNoHp = () => admins.find((a) => a.aktif)?.noHp ?? '';

  // Handle manual farmer addition
  const handleAddFarmerManual = async (farmerData: Partial<FarmerRecord>) => {
    try {
      const res = await fetch('/api/farmers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...farmerData, requesterNoHp: operatorNoHp() }),
      });
      if (res.ok) {
        const newRecord = await res.json();
        setFarmers((prev) => [newRecord, ...prev]);
        showToast(`Data ${newRecord.nama} berhasil ditambahkan ke baris Google Sheets.`, 'success');
      }
    } catch (err) {
      console.error(err);
      showToast('Gagal menyimpan data petani.', 'warning');
    }
  };

  // Handle farmer delete
  const handleDeleteFarmer = async (id: string) => {
    try {
      await fetch(`/api/farmers/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp: operatorNoHp() }),
      });
      setFarmers((prev) => prev.filter((f) => f.id !== id));
      showToast(`Data petani ${id} berhasil dihapus dari Google Sheets.`, 'info');
    } catch (err) {
      console.error(err);
    }
  };

  // Handle supplier registered via WhatsApp or modal
  const handleSupplierRegistered = (newRecord: SupplierRecord) => {
    setSuppliers((prev) => [newRecord, ...prev.filter((s) => s.id !== newRecord.id)]);
    showToast(`Supplier ${newRecord.nama} (${newRecord.kategori}) berhasil disimpan ke Lembar 2 Google Sheets!`, 'success');
  };

  // Handle manual supplier addition
  const handleAddSupplierManual = async (supplierData: Partial<SupplierRecord>) => {
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...supplierData, requesterNoHp: operatorNoHp() }),
      });
      if (res.ok) {
        const newRecord = await res.json();
        setSuppliers((prev) => [newRecord, ...prev]);
        showToast(`Supplier ${newRecord.nama} berhasil ditambahkan ke Lembar 2 Google Sheets.`, 'success');
      }
    } catch (err) {
      console.error(err);
      showToast('Gagal menyimpan data supplier.', 'warning');
    }
  };

  // Handle supplier delete
  const handleDeleteSupplier = async (id: string) => {
    try {
      await fetch(`/api/suppliers/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterNoHp: operatorNoHp() }),
      });
      setSuppliers((prev) => prev.filter((s) => s.id !== id));
      showToast(`Data supplier ${id} berhasil dihapus dari Google Sheets.`, 'info');
    } catch (err) {
      console.error(err);
    }
  };

  // Handle price update / anomaly trigger
  const handleUpdateCommodityPrice = async (id: string, newPrice: number, reason: string) => {
    try {
      const res = await fetch('/api/commodities/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, hargaBaru: newPrice, penyebab: reason, requesterNoHp: operatorNoHp() }),
      });
      if (res.ok) {
        const updated = await res.json();
        setCommodities((prev) => prev.map((c) => (c.id === id ? updated : c)));
        if (updated.statusAnomali === 'LONJAKAN_EKSTREM' || updated.statusAnomali === 'PENURUNAN_DRASTIS') {
          showToast(`⚠️ Anomali terdeteksi pada ${updated.nama}! Status: ${updated.statusAnomali}`, 'warning');
        } else {
          showToast(`Harga ${updated.nama} berhasil diperbarui menjadi Rp ${updated.hargaSekarang.toLocaleString('id-ID')}/kg`, 'info');
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Handle broadcast notification
  const handleBroadcastNotification = async (commodityId: string) => {
    try {
      const res = await fetch('/api/notifications/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ komoditasId: commodityId, requesterNoHp: operatorNoHp() }),
      });
      if (res.ok) {
        const data = await res.json();
        setNotifications((prev) => [data.notification, ...prev]);
        showToast(`Pesan broadcast anomali berhasil dikirim ke ${data.recipientsCount} petani melalui WhatsApp.`, 'success');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Handle generating new AI recommendation
  const handleGenerateRecommendation = async () => {
    setAiGenerating(true);
    try {
      const res = await fetch('/api/strategic-recommendation/generate', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setRecommendation(data);
        showToast('Laporan rekomendasi strategis baru berhasil di-generate oleh AI!', 'success');
      }
    } catch (err) {
      console.error(err);
      showToast('Gagal memproses analisis AI.', 'warning');
    } finally {
      setAiGenerating(false);
    }
  };

  const anomaliesCount = commodities.filter(
    (c) => c.statusAnomali === 'LONJAKAN_EKSTREM' || c.statusAnomali === 'PENURUNAN_DRASTIS'
  ).length;

  if (!me && !loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 font-sans">
        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-3xl grid md:grid-cols-2 overflow-hidden">
          <div className="relative hidden md:block">
            <img
              src="/landing-sawah.jpg"
              alt="Petani memotret sawah saat matahari terbenam"
              className="absolute inset-0 w-full h-full object-cover"
            />
            <p className="absolute bottom-4 left-4 right-4 text-sm font-medium text-white bg-emerald-950/70 backdrop-blur rounded-lg px-3 py-2">
              Dibuat oleh petani, untuk kesejahteraan petani.
            </p>
          </div>
          <form onSubmit={handleLogin} className="p-8 space-y-4">
          <div className="text-center">
            <div className="w-11 h-11 mx-auto mb-2 rounded-xl bg-emerald-700 flex items-center justify-center">
              <Sprout className="w-6 h-6 text-white" />
            </div>
            <h1 className="font-display font-bold text-slate-900 text-lg">Hai Tani</h1>
            <p className="text-xs text-slate-500">Masuk dengan nomor admin + password</p>
          </div>
          {loginError && (
            <div role="alert" className="bg-rose-50 text-rose-700 text-xs p-2 rounded-lg border border-rose-200">{loginError}</div>
          )}
          <div>
            <label htmlFor="login-nohp" className="block text-xs font-medium text-slate-700 mb-1">No. WhatsApp admin</label>
            <input
              id="login-nohp" type="text" value={loginNoHp} onChange={(e) => setLoginNoHp(e.target.value)}
              placeholder="cth. 62812xxxxxxx" required autoComplete="username"
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-1 focus:ring-emerald-500 focus:outline-none placeholder:text-slate-400"
            />
          </div>
          <div>
            <label htmlFor="login-pass" className="block text-xs font-medium text-slate-700 mb-1">Password</label>
            <input
              id="login-pass" type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="Password" required autoComplete="current-password"
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-1 focus:ring-emerald-500 focus:outline-none placeholder:text-slate-400"
            />
          </div>
          <button type="submit" disabled={loginBusy} className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
            {loginBusy ? 'Memeriksa...' : 'Masuk'}
          </button>
          <Link to="/publik" className="block text-[11px] text-emerald-700 hover:text-emerald-900 text-center">Lihat halaman publik tanpa login</Link>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 flex font-sans text-slate-800 antialiased selection:bg-emerald-500 selection:text-white">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenWebhookModal={() => setIsWebhookModalOpen(true)}
        onOpenAdminModal={() => setIsAdminManagerOpen(true)}
        onOpenLayaModal={() => setIsLayaModalOpen(true)}
        onOpenWhitepaperModal={() => setIsWhitepaperModalOpen(true)}
        farmersCount={farmers.length}
        anomaliesCount={anomaliesCount}
        adminsCount={admins.length}
        layaActive={!!layaStatus?.healthy}
        meName={me?.nama}
        meRole={me?.role}
        onLogout={handleLogout}
      />

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md animate-slide-in">
          <div
            className={`p-3.5 rounded-2xl shadow-xl border flex items-center space-x-3 text-xs font-medium ${
              toastMessage.type === 'success'
                ? 'bg-emerald-900 text-emerald-100 border-emerald-700'
                : toastMessage.type === 'warning'
                ? 'bg-amber-900 text-amber-100 border-amber-700'
                : 'bg-slate-900 text-slate-100 border-slate-700'
            }`}
          >
            {toastMessage.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : toastMessage.type === 'warning' ? (
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            ) : (
              <Info className="w-5 h-5 text-sky-400 shrink-0" />
            )}
            <span className="flex-1 leading-snug">{toastMessage.text}</span>
            <button
              onClick={() => setToastMessage(null)}
              className="text-white/60 hover:text-white p-1 rounded-full cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        <div className="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 flex items-center justify-between shrink-0">
          <h1 className="font-display text-lg font-bold text-slate-900">{TAB_TITLES[activeTab]}</h1>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="hidden sm:inline tabular-nums">
              {new Date().toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
            <span className="hidden sm:inline w-px h-3.5 bg-slate-200" aria-hidden="true" />
            <span className="flex items-center gap-1.5 tabular-nums" title="Status sinkronisasi Google Sheets">
              <span className={`w-2 h-2 rounded-full ${sheetsStatus?.workerOn ? 'bg-emerald-500' : 'bg-slate-300'}`} />
              <span>{sheetsStatus ? (sheetsStatus.workerOn ? `Sheets antre ${sheetsStatus.queueDepth ?? 0}` : 'Sheets mati') : 'Sheets…'}</span>
            </span>
          </div>
        </div>
        {loadError && (
          <div className="mx-4 sm:mx-6 lg:mx-8 mt-4 flex items-center justify-between gap-3 bg-rose-50 border border-rose-200 rounded-lg px-4 py-2.5">
            <p className="text-xs text-rose-700">Gagal memuat data ({loadError}). Menampilkan data terakhir.</p>
            <button onClick={loadData} className="text-xs font-medium text-rose-700 hover:text-rose-900 shrink-0 cursor-pointer">Muat ulang</button>
          </div>
        )}

      {/* Main Content Area */}
      <main className={activeTab === 'map' ? 'h-[calc(100vh-4rem)] overflow-hidden shrink-0' : 'flex-1 px-4 sm:px-6 lg:px-8 py-6'}>
        <div key={activeTab} className="animate-fade-in">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <AgriProfessionalDashboard
              farmers={farmers}
              commodities={commodities}
              recommendation={recommendation}
              onRefreshData={loadData}
              loading={loading}
              onNavigateToSheets={() => setActiveTab('sheets')}
            />
            <MarketPriceTable />
          </div>
        )}

        {activeTab === 'chat' && (
          <WhatsAppChatbot
            onFarmerRegistered={handleFarmerRegistered}
            onSupplierRegistered={handleSupplierRegistered}
            onNavigateToSheets={() => setActiveTab('sheets')}
            admins={admins}
            onOpenAdminManager={() => setIsAdminManagerOpen(true)}
            layaStatus={layaStatus}
            onOpenLayaModal={() => setIsLayaModalOpen(true)}
          />
        )}

        {activeTab === 'sheets' && (
          <GoogleSheetsView
            farmers={farmers}
            suppliers={suppliers}
            onAddFarmer={() => setIsAddFarmerModalOpen(true)}
            onAddSupplier={() => setIsAddSupplierModalOpen(true)}
            onDeleteFarmer={handleDeleteFarmer}
            onDeleteSupplier={handleDeleteSupplier}
            onRefresh={loadData}
            loading={loading}
            admins={admins}
          />
        )}

        {activeTab === 'market' && (
          <>
          <MarketAnomalyView
            commodities={commodities}
            notifications={notifications}
            farmers={farmers}
            onUpdateCommodityPrice={handleUpdateCommodityPrice}
            onBroadcastNotification={handleBroadcastNotification}
          />
          <FruitPriceManager />
          </>
        )}

        {activeTab === 'datascientist' && (
          <DataScientistPortal
            farmers={farmers}
            commodities={commodities}
            recommendation={recommendation}
            onGenerateNewRecommendation={handleGenerateRecommendation}
            loading={aiGenerating}
          />
        )}

        {activeTab === 'map' && (
          <FarmerSupplierMapView
            farmers={farmers}
            suppliers={suppliers}
            onRefreshData={loadData}
            onAddFarmerClick={() => setIsAddFarmerModalOpen(true)}
            operatorNoHp={admins.find((a) => a.aktif)?.noHp ?? ''}
          />
        )}
        </div>
      </main>
      </div>

      {/* Modals */}
      <WebhookModal
        isOpen={isWebhookModalOpen}
        onClose={() => setIsWebhookModalOpen(false)}
      />

      <AddFarmerModal
        isOpen={isAddFarmerModalOpen}
        onClose={() => setIsAddFarmerModalOpen(false)}
        onAdd={handleAddFarmerManual}
      />

      <AddSupplierModal
        isOpen={isAddSupplierModalOpen}
        onClose={() => setIsAddSupplierModalOpen(false)}
        onAdd={handleAddSupplierManual}
      />

      <AdminManagerModal
        isOpen={isAdminManagerOpen}
        onClose={() => setIsAdminManagerOpen(false)}
        admins={admins}
        onAddAdmin={handleAddAdmin}
        onDeleteAdmin={handleDeleteAdmin}
      />

      <LayaModal
        isOpen={isLayaModalOpen}
        onClose={() => setIsLayaModalOpen(false)}
        status={layaStatus}
        onRefresh={fetchLayaStatus}
        isLoading={layaLoading}
      />

      <TechnicalWhitepaperModal
        isOpen={isWhitepaperModalOpen}
        onClose={() => setIsWhitepaperModalOpen(false)}
      />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/publik" replace />} />
      <Route path="/publik" element={<PublicView />} />
      <Route path="/admin" element={<AdminApp />} />
      <Route path="*" element={<Navigate to="/publik" replace />} />
    </Routes>
  );
}
