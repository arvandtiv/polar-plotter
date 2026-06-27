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

// fetch() has NO default timeout — a board whose TCP link stalls without
// resetting the connection makes a request hang forever (never resolves, never
// rejects), which silently wedges the script runner mid-job. AbortController
// turns that stall into a typed error within `ms` so callers can retry/abort.
async function fetchT(url: string, ms: number, opts?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`timeout after ${ms}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// All firmware API calls are plain HTTP GETs. The firmware returns JSON
// { status: "ok"|"error", msg: "…" } for every endpoint.
export async function apiGet(ip: string, endpoint: string): Promise<ApiResult> {
  const base = ip ? `http://${ip}` : '';
  const r = await fetchT(`${base}/api/${endpoint}`, 8000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ApiResult>;
}

// POST /api/batch — many draw ops in one request (newline-separated query strings).
// Plain-text body keeps it a CORS "simple request" (no preflight). Returns enqueue counts.
export interface BatchResult { status: string; accepted: number; rejected: number; id?: number; }
export async function apiBatch(ip: string, body: string): Promise<BatchResult> {
  const base = ip ? `http://${ip}` : '';
  // Longer budget than a plain GET: the firmware's per-socket recv timeout is 3 s
  // and a full batch of draw ops takes a moment to enqueue.
  const r = await fetchT(`${base}/api/batch`, 12000, { method: 'POST', body });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<BatchResult>;
}

// Raw shape of GET /api/status from the firmware (see web_server.c handle_status).
// drv_ok / drv_flags are the TMC5072 driver-health fields the firmware exposes so
// the console (and the MCP) can see when a real driver fault has latched.
export interface RawStatus {
  status: string;
  enqueued: number; current: number; done: number; pending: number;
  qcap?: number; rejected?: number; peak?: number;
  idle: boolean; aborting: boolean; paused: boolean; estop?: boolean; pen_down?: boolean; job: string;
  drv_ok: boolean; drv_flags: string;
  x: number; y: number;
  bounds: { xn: number; xp: number; yn: number; yp: number; ellipse: boolean };
  motion: { vmax: number; amax: number; run_ma: number; hold_ma: number };
  matrix?: { a: number; b: number; c: number; d: number; tx: number; ty: number };
}

export async function getStatus(ip: string): Promise<RawStatus> {
  const base = ip ? `http://${ip}` : '';
  // Short budget: status is the runner's flow-control & watchdog poll — a stalled
  // status must surface fast so the watchdog reacts instead of hanging.
  const r = await fetchT(`${base}/api/status`, 6000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<RawStatus>;
}

// SSE stream URL — GET /events on the firmware serves the log + pos event stream.
export function sseUrl(ip: string): string {
  return ip ? `http://${ip}/events` : '/events';
}
