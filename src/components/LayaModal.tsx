import React, { useState } from 'react';
import {
  X,
  Zap,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Cpu,
  Layers,
  ShieldCheck,
  Send,
  ExternalLink,
  Sliders,
  Database,
  ArrowRight,
} from 'lucide-react';
import { LayaStatus, LayaDecisionResult } from '../types';

interface LayaModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: LayaStatus | null;
  onRefresh: () => void;
  isLoading: boolean;
}

const SAMPLE_PROMPTS = [
  'Saya mau daftarkan sawah 1.5 Ha di Subang komoditas padi ciherang',
  'Berapa harga cabai rawit merah dan bawang merah di pasar hari ini?',
  'Tanaman daun padi menguning kena hama wereng batang coklat, minta dosis pupuk urea',
  'Cari kios pupuk resmi atau toko saprodi pertanian terdekat',
];

export const LayaModal: React.FC<LayaModalProps> = ({
  isOpen,
  onClose,
  status,
  onRefresh,
  isLoading,
}) => {
  const [testText, setTestText] = useState(SAMPLE_PROMPTS[0]);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<LayaDecisionResult | null>(null);

  if (!isOpen) return null;

  const handleTestDecision = async (overrideText?: string) => {
    const textToTest = overrideText || testText;
    if (!textToTest.trim()) return;
    setTestLoading(true);
    try {
      const res = await fetch('/api/laya/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToTest }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult(null);
    } finally {
      setTestLoading(false);
    }
  };

  const isHealthy = status?.healthy;
  const isCircuitOpen = status?.circuitBreakerActive;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fadeIn">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden text-slate-100 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-800/80 border-b border-slate-700/80 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  Laya Decision Engine (System-1)
                </h3>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Sub-50ms Router
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Non-Autoregressive Decision Engine (convaiinnovations/laya)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
          {/* Status Banner */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700/80">
              <div className="text-slate-400 mb-1 flex items-center space-x-1.5">
                <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                <span>Status Engine</span>
              </div>
              <div className="flex items-center space-x-2">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    isHealthy
                      ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50 animate-pulse'
                      : isCircuitOpen
                      ? 'bg-amber-500'
                      : 'bg-emerald-400'
                  }`}
                />
                <span className="font-semibold text-slate-200">
                  {isHealthy
                    ? 'Online (Sidecar)'
                    : isCircuitOpen
                    ? `Cooldown (${status?.circuitBreakerCooldownRemainingSec || 0}s)`
                    : 'Siap Melayani'}
                </span>
              </div>
              <p className="text-[10px] text-slate-500 mt-1 font-mono">
                {status?.url || '127.0.0.1:8787'}
              </p>
            </div>

            <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700/80">
              <div className="text-slate-400 mb-1 flex items-center space-x-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Latensi Inferensi</span>
              </div>
              <div className="font-mono text-base font-bold text-emerald-400">
                {status?.latencyMs !== undefined ? `${status.latencyMs} ms` : '< 20 ms'}
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                Zero-token System-1 classifier
              </p>
            </div>

            <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700/80">
              <div className="text-slate-400 mb-1 flex items-center space-x-1.5">
                <Database className="w-3.5 h-3.5 text-blue-400" />
                <span>Memory Cache</span>
              </div>
              <div className="font-mono text-base font-bold text-blue-400">
                {status?.cacheStats?.cachedKeysCount ?? 0}
                <span className="text-slate-500 text-xs font-normal"> / 500 keys</span>
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                TTL 10 menit (LRU auto-evict)
              </p>
            </div>
          </div>

          {/* Interactive Live Testing Sandbox */}
          <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Sliders className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-slate-200">Uji Langsung Klasifikasi Intent Laya</span>
              </div>
              <span className="text-[10px] text-slate-400">POST /api/laya/decide</span>
            </div>

            <div className="space-y-2">
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleTestDecision()}
                  placeholder="Ketik kalimat petani (contoh: daftarkan lahan, harga cabai, wereng)..."
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
                <button
                  onClick={() => handleTestDecision()}
                  disabled={testLoading || !testText.trim()}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg text-xs flex items-center space-x-1.5 transition cursor-pointer"
                >
                  {testLoading ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  <span>Uji</span>
                </button>
              </div>

              {/* Sample Prompts */}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SAMPLE_PROMPTS.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setTestText(prompt);
                      handleTestDecision(prompt);
                    }}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[10px] transition border border-slate-700/60 truncate max-w-full text-left cursor-pointer"
                  >
                    💡 {prompt.slice(0, 42)}...
                  </button>
                ))}
              </div>
            </div>

            {/* Test Result Display */}
            {testResult && (
              <div className="mt-3 p-3 rounded-lg bg-slate-900 border border-emerald-900/50 space-y-2">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400 text-[11px]">Hasil Intent:</span>
                    <span className="px-2 py-0.5 rounded font-mono font-bold text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      {testResult.result?.intent || 'lain'}
                    </span>
                  </div>
                  <div className="flex items-center space-x-3 text-[10px] text-slate-400 font-mono">
                    <span>Keyakinan: {((testResult.result?.confidence || 0) * 100).toFixed(1)}%</span>
                    <span>Latensi: {testResult.latencyMs} ms</span>
                  </div>
                </div>

                {/* Probabilities bar */}
                <div className="space-y-1 pt-1">
                  <div className="text-[10px] text-slate-500 flex justify-between">
                    <span>Tingkat Keyakinan (Confidence Gate &gt;= 50%)</span>
                    <span className="font-mono text-emerald-400">
                      {((testResult.result?.confidence || 0) * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, (testResult.result?.confidence || 0) * 100)}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 pt-1 flex items-center justify-between">
                  <span>Sumber Routing: <span className="font-mono text-slate-300">{testResult.source}</span></span>
                  <span>Model: <span className="font-mono text-slate-300">{testResult.result?.model || 'laya-multilingual'}</span></span>
                </div>
              </div>
            )}
          </div>

          {/* Audit & Engineering Compliance */}
          <div className="space-y-3">
            <h4 className="font-bold text-slate-200 flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Kepatuhan Audit & Arsitektur Laya</span>
            </h4>

            <div className="space-y-2">
              <div className="p-2.5 rounded-lg bg-slate-800/40 border border-slate-700/60 flex items-start space-x-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-200">Primitif Pertanyaan &apos;choice&apos; (Non-Autoregressive)</div>
                  <div className="text-slate-400 text-[11px] mt-0.5">
                    Menggunakan primitif <code>choice</code> untuk 5 intent pertanian. Menghindari kerentanan sensitivitas label pada <code>noul</code> (#156) dan bias urutan pertama pada <code>score</code> (#131).
                  </div>
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-800/40 border border-slate-700/60 flex items-start space-x-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-200">Gating Confidence Kalibrasi (Bukan act_probability)</div>
                  <div className="text-slate-400 text-[11px] mt-0.5">
                    Merujuk temuan repo Laya: <code>action.act_probability</code> memiliki AUROC rendah (0.30), sedangkan <code>confidence</code> mencapai AUROC 0.77. Ambang batas diatur pada <code>&gt;= 0.50</code>.
                  </div>
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-800/40 border border-slate-700/60 flex items-start space-x-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-200">Thread Affinity &amp; Serialized Inference Lock</div>
                  <div className="text-slate-400 text-[11px] mt-0.5">
                    Mematuhi pedoman <code>serve.py</code> Laya: membatasi <code>torch.set_num_threads</code> pada core fisik tanpa oversubscribing hyperthreads, dan membungkus inferensi dengan <code>threading.Lock</code> untuk thread-safety.
                  </div>
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-800/40 border border-slate-700/60 flex items-start space-x-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-200">Zero-Token Lazy Architecture &amp; Circuit Breaker</div>
                  <div className="text-slate-400 text-[11px] mt-0.5">
                    Regex dicek terlebih dahulu (0ms); sidecar dipanggil secara asinkron hanya jika regex ragu; dilengkapi timeout 1.2 detik, LRU cache 10 menit, dan cooldown 30 detik saat sidecar tidak tersedia.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-800/80 border-t border-slate-700/80 flex items-center justify-between">
          <div className="flex items-center space-x-3 text-[11px] text-slate-400">
            <a
              href="https://github.com/NandhaKishorM/laya"
              target="_blank"
              rel="noreferrer"
              className="flex items-center space-x-1 text-emerald-400 hover:text-emerald-300 transition"
            >
              <span>GitHub Repo Laya</span>
              <ExternalLink className="w-3 h-3" />
            </a>
            <span>•</span>
            <a
              href="https://huggingface.co/convaiinnovations/laya"
              target="_blank"
              rel="noreferrer"
              className="flex items-center space-x-1 text-slate-400 hover:text-slate-300 transition"
            >
              <span>HuggingFace</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh Status</span>
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition cursor-pointer"
            >
              Tutup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
