import React from 'react';
import { Link } from 'react-router-dom';
import {
  Sprout,
  LayoutDashboard,
  Table,
  MessageSquare,
  TrendingUp,
  Cpu,
  MapPin,
  Radio,
  Users,
  Zap,
  FileText,
  LogOut,
  Globe,
} from 'lucide-react';

export type AdminTab = 'dashboard' | 'chat' | 'sheets' | 'market' | 'datascientist' | 'map';

type Icon = React.ComponentType<{ className?: string }>;

interface HeaderProps {
  activeTab: AdminTab;
  setActiveTab: (tab: AdminTab) => void;
  onOpenWebhookModal: () => void;
  onOpenAdminModal?: () => void;
  onOpenLayaModal?: () => void;
  onOpenWhitepaperModal?: () => void;
  farmersCount: number;
  anomaliesCount: number;
  adminsCount?: number;
  layaActive?: boolean;
  meName?: string;
  meRole?: string;
  onLogout?: () => void;
}

const NAV_MAIN: Array<{ id: AdminTab; label: string; icon: Icon }> = [
  { id: 'dashboard', label: 'Ringkasan', icon: LayoutDashboard },
  { id: 'sheets', label: 'Data', icon: Table },
  { id: 'market', label: 'Harga & Anomali', icon: TrendingUp },
  { id: 'map', label: 'Peta', icon: MapPin },
];

const NavButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: Icon;
  label: string;
  badge?: React.ReactNode;
}> = ({ active, onClick, icon: ItemIcon, label, badge }) => (
  <button
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition cursor-pointer ${
      active
        ? 'bg-emerald-700 text-white font-semibold shadow-sm'
        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
    }`}
  >
    <ItemIcon className="w-4 h-4 shrink-0" />
    <span className="flex-1 text-left truncate">{label}</span>
    {badge}
  </button>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-3 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{children}</p>
);

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  onOpenWebhookModal,
  onOpenAdminModal,
  onOpenLayaModal,
  onOpenWhitepaperModal,
  farmersCount,
  anomaliesCount,
  adminsCount = 0,
  layaActive = false,
  meName,
  meRole,
  onLogout,
}) => {
  return (
    <aside className="w-60 shrink-0 bg-white border-r border-slate-200 flex flex-col h-screen sticky top-0">
      <div className="h-16 px-4 flex items-center gap-2.5 border-b border-slate-200">
        <div className="w-9 h-9 rounded-lg bg-emerald-700 flex items-center justify-center shrink-0">
          <Sprout className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <p className="font-display font-bold text-slate-900 leading-tight">Hai Tani</p>
          <p className="text-xs text-slate-500 leading-tight">Konsol Admin</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        <SectionLabel>Menu</SectionLabel>
        <div className="space-y-0.5">
          {NAV_MAIN.map((n) => (
            <NavButton
              key={n.id}
              active={activeTab === n.id}
              onClick={() => setActiveTab(n.id)}
              icon={n.icon}
              label={n.label}
              badge={
                n.id === 'sheets' ? (
                  <span className="bg-slate-100 text-slate-600 text-[11px] px-1.5 py-0.5 rounded tabular-nums">
                    {farmersCount}
                  </span>
                ) : n.id === 'market' && anomaliesCount > 0 ? (
                  <span className="bg-rose-100 text-rose-700 text-[11px] px-1.5 py-0.5 rounded tabular-nums font-semibold">
                    {anomaliesCount}
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>

        <SectionLabel>Analisis</SectionLabel>
        <div className="space-y-0.5">
          <NavButton
            active={activeTab === 'datascientist'}
            onClick={() => setActiveTab('datascientist')}
            icon={Cpu}
            label="Data Scientist"
          />
        </div>

        <SectionLabel>Perkakas</SectionLabel>
        <div className="space-y-0.5">
          <NavButton
            active={activeTab === 'chat'}
            onClick={() => setActiveTab('chat')}
            icon={MessageSquare}
            label="Simulator Chat"
          />
          <NavButton active={false} onClick={onOpenWebhookModal} icon={Radio} label="Webhook" />
          {onOpenAdminModal && (
            <NavButton
              active={false}
              onClick={onOpenAdminModal}
              icon={Users}
              label="Kelola Admin"
              badge={
                <span className="bg-slate-100 text-slate-600 text-[11px] px-1.5 py-0.5 rounded tabular-nums">
                  {adminsCount}
                </span>
              }
            />
          )}
          {onOpenLayaModal && (
            <NavButton
              active={false}
              onClick={onOpenLayaModal}
              icon={Zap}
              label="Laya"
              badge={
                <span
                  className={`w-2 h-2 rounded-full ${layaActive ? 'bg-emerald-500' : 'bg-slate-300'}`}
                  title={layaActive ? 'Aktif' : 'Siaga'}
                />
              }
            />
          )}
          {onOpenWhitepaperModal && (
            <NavButton active={false} onClick={onOpenWhitepaperModal} icon={FileText} label="Arsitektur" />
          )}
        </div>
      </nav>

      <div className="border-t border-slate-200 p-3 space-y-2">
        <Link
          to="/publik"
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition"
        >
          <Globe className="w-4 h-4 shrink-0" />
          <span>Lihat Halaman Publik</span>
        </Link>
        {meName && (
          <div className="flex items-center gap-2.5 px-3 py-1">
            <div className="w-8 h-8 rounded-full bg-emerald-700 text-white flex items-center justify-center text-xs font-bold shrink-0">
              {meName.slice(0, 1).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">{meName}</p>
              <p className="text-xs text-slate-500 truncate">{meRole}</p>
            </div>
            {onLogout && (
              <button
                onClick={onLogout}
                title="Keluar"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
