// IP is persisted in localStorage so it survives page reloads.
// Default is the plotter's typical DHCP address on the home network.
const IP_KEY = 'plotterIp';
const DEFAULT_IP = '192.168.1.71';

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
  id?: number;   // job id returned by enqueue endpoints
}

// All firmware API calls are plain HTTP GETs. The firmware returns JSON
// { status: "ok"|"error", msg: "…" } for every endpoint.
export async function apiGet(ip: string, endpoint: string): Promise<ApiResult> {
  const base = ip ? `http://${ip}` : '';
  const r = await fetch(`${base}/api/${endpoint}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ApiResult>;
}

// Raw shape of GET /api/status from the firmware (see web_server.c handle_status).
// drv_ok / drv_flags are the TMC5072 driver-health fields the firmware exposes so
// the console (and the MCP) can see when a real driver fault has latched.
export interface RawStatus {
  status: string;
  enqueued: number; current: number; done: number; pending: number;
  idle: boolean; aborting: boolean; job: string;
  drv_ok: boolean; drv_flags: string;
  x: number; y: number;
  bounds: { xn: number; xp: number; yn: number; yp: number; ellipse: boolean };
  motion: { vmax: number; amax: number; run_ma: number; hold_ma: number };
}

export async function getStatus(ip: string): Promise<RawStatus> {
  const base = ip ? `http://${ip}` : '';
  const r = await fetch(`${base}/api/status`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<RawStatus>;
}

// SSE stream URL — GET /events on the firmware serves the log + pos event stream.
export function sseUrl(ip: string): string {
  return ip ? `http://${ip}/events` : '/events';
}
