const IP_KEY = 'plotterIp';

export function getStoredIp(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(IP_KEY) ?? '';
}

export function storeIp(ip: string): void {
  localStorage.setItem(IP_KEY, ip.trim());
}

export interface ApiResult {
  status: 'ok' | 'error';
  msg: string;
}

export async function apiGet(ip: string, endpoint: string): Promise<ApiResult> {
  const base = ip ? `http://${ip}` : '';
  const r = await fetch(`${base}/api/${endpoint}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ApiResult>;
}

export function sseUrl(ip: string): string {
  return ip ? `http://${ip}/events` : '/events';
}
