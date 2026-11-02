// Basis API terpusat. Lokal (same-origin): VITE_BACKEND_URL kosong -> fetch
// relatif seperti semula. Deploy Vercel: set VITE_BACKEND_URL ke URL publik
// backend (tunnel) saat build; credentials include agar sesi admin jalan
// lintas origin (butuh CORS + cookie SameSite=None;Secure di server).
const RAW = (((import.meta as any).env?.VITE_BACKEND_URL as string) || "").trim();

export const API_BASE = RAW.replace(/\/+$/, "");

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(API_BASE + path, { credentials: "include", ...(init || {}) });
}

// Untuk href/window.open/rumus: URL absolut ke backend saat deploy.
export function apiUrl(path: string): string {
  return API_BASE + path;
}
