// IP is persisted in localStorage so it survives page reloads.
// Default is the plotter's typical DHCP address on the home network.
const IP_KEY = 'plotterIp';
const DEFAULT_IP = '192.168.1.53';

export function getStoredIp(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_IP;
  return localStorage.getItem(IP_KEY) ?? DEFAULT_IP;
}

export function storeIp(ip: string): void {
  localStorage.setItem(IP_KEY, ip.trim());
}

export interface ApiResult {
  status: 'ok' | 'error';
  msg: string;
}

// All firmware API calls are plain HTTP GETs. The firmware returns JSON
// { status: "ok"|"error", msg: "…" } for every endpoint.
export async function apiGet(ip: string, endpoint: string): Promise<ApiResult> {
  const base = ip ? `http://${ip}` : '';
  const r = await fetch(`${base}/api/${endpoint}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ApiResult>;
}

// SSE stream URL — GET /events on the firmware serves the log + pos event stream.
export function sseUrl(ip: string): string {
  return ip ? `http://${ip}/events` : '/events';
}
