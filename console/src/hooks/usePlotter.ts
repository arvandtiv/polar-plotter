import { useState, useRef, useEffect, useCallback } from 'react';
import { apiGet, getStoredIp, storeIp, sseUrl } from '../lib/api';

// ---- types -------------------------------------------------------

export type FillMode = 0 | 1 | 2;   // 0=none  1=hatch  2=concentric

export interface PlotterBounds { left: number; right: number; up: number; down: number; }
export interface MotionParams  { vmax: number; amax: number; run: number; hold: number; }

export interface CircleCmd   { type: 'circle';   cx: number; cy: number; r: number;    cycles: number; fillMode: FillMode; angle: number; spacing: number; }
export interface SquareCmd   { type: 'square';   cx: number; cy: number; size: number; cycles: number; fillMode: FillMode; angle: number; spacing: number; }
export interface LineCmd     { type: 'line';     x0: number; y0: number; x1: number; y1: number; cycles: number; }
export interface GotoCmd     { type: 'goto';     x: number;  y: number; }
export interface HomeCmd     { type: 'home'; }
export interface SetHomeCmd  { type: 'sethome'; }
export interface PenCmd      { type: 'pen';      pos: 'up' | 'down'; }
export interface BullseyeCmd { type: 'bullseye'; cx: number; cy: number; }
export interface GridCmd     { type: 'grid';     cx: number; cy: number; }
export type PlotCmd = CircleCmd | SquareCmd | LineCmd | GotoCmd | HomeCmd | SetHomeCmd | PenCmd | BullseyeCmd | GridCmd;

export interface LogEntry { id: number; kind: 'cmd' | 'ok' | 'err' | 'warn' | 'sys' | 'fw'; text: string; t: number; }
export interface PenState  { x: number; y: number; down: boolean; }
export interface Stroke    { color: string; points: { x: number; y: number }[]; }

// ---- constants ---------------------------------------------------

export const DEFAULTS = {
  motion: { vmax: 200000, amax: 500, run: 600, hold: 200 },
  bounds: { left: 300, right: 300, up: 200, down: 200 },
};

const PALETTE = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c'];

let LOG_ID = 0;
const mkLog = (kind: LogEntry['kind'], text: string): LogEntry => ({
  id: ++LOG_ID, kind, text, t: Date.now(),
});

// ---- API query builders ------------------------------------------

export function cmdToQuery(cmd: PlotCmd): string {
  switch (cmd.type) {
    case 'goto':     return `goto?x=${cmd.x}&y=${cmd.y}`;
    case 'line':     return `line?x0=${cmd.x0}&y0=${cmd.y0}&x1=${cmd.x1}&y1=${cmd.y1}&cycles=${cmd.cycles}`;
    case 'square':   return `square?cx=${cmd.cx}&cy=${cmd.cy}&size=${cmd.size}&cycles=${cmd.cycles}&fill=${cmd.fillMode}&angle=${cmd.angle}&spacing=${cmd.spacing}`;
    case 'circle':   return `circle?cx=${cmd.cx}&cy=${cmd.cy}&r=${cmd.r}&cycles=${cmd.cycles}&fill=${cmd.fillMode}&angle=${cmd.angle}&spacing=${cmd.spacing}`;
    case 'bullseye': return `bullseye?cx=${cmd.cx}&cy=${cmd.cy}`;
    case 'grid':     return `grid?cx=${cmd.cx}&cy=${cmd.cy}`;
    case 'home':     return 'home';
    case 'sethome':  return 'sethome';
    case 'pen':      return `pen?pos=${cmd.pos}`;
  }
}

export function boundsToQuery(b: PlotterBounds): string {
  // Firmware params: xn = X−, xp = X+, yn = Y−, yp = Y+
  return `bounds?xn=${-b.left}&xp=${b.right}&yn=${-b.down}&yp=${b.up}`;
}

export function motionToQuery(key: keyof MotionParams, val: number, m: MotionParams): string {
  if (key === 'vmax') return `speed?vmax=${val}`;
  if (key === 'amax') return `accel?amax=${val}`;
  if (key === 'run')  return `cur?run=${val}&hold=${m.hold}`;
  if (key === 'hold') return `cur?run=${m.run}&hold=${val}`;
  return '';
}

// ---- canvas path simulation (for visual animation) ---------------

export function buildPath(cmd: PlotCmd): { x: number; y: number; pen: boolean }[] {
  const pts: { x: number; y: number; pen: boolean }[] = [];
  if (cmd.type === 'goto') {
    pts.push({ x: cmd.x, y: cmd.y, pen: false });
  } else if (cmd.type === 'line') {
    pts.push({ x: cmd.x0, y: cmd.y0, pen: false });
    pts.push({ x: cmd.x1, y: cmd.y1, pen: true });
  } else if (cmd.type === 'square') {
    const h = cmd.size / 2;
    const a = (cmd.angle || 0) * Math.PI / 180;
    const rot = (px: number, py: number) => ({
      x: cmd.cx + (px * Math.cos(a) - py * Math.sin(a)),
      y: cmd.cy + (px * Math.sin(a) + py * Math.cos(a)),
    });
    const ringCount = cmd.fillMode === 2
      ? Math.max(1, Math.floor(h / Math.max(0.5, cmd.spacing)))
      : 1;
    for (let ri = 0; ri < ringCount; ri++) {
      const inset = cmd.fillMode === 2 ? ri * cmd.spacing : 0;
      const hh = h - inset;
      if (hh <= 0) break;
      const corners = [rot(-hh, -hh), rot(hh, -hh), rot(hh, hh), rot(-hh, hh), rot(-hh, -hh)];
      corners.forEach((p, i) => pts.push({ x: p.x, y: p.y, pen: !(ri === 0 && i === 0) }));
    }
    if (cmd.fillMode === 1) {
      const theta = (cmd.angle || 0) * Math.PI / 180;
      const cos_t = Math.cos(theta + Math.PI / 2), sin_t = Math.sin(theta + Math.PI / 2);
      const extent = h * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)));
      for (let t = -extent + cmd.spacing; t < extent; t += cmd.spacing) {
        pts.push({ x: cmd.cx + t * cos_t - extent * Math.cos(theta), y: cmd.cy + t * sin_t - extent * Math.sin(theta), pen: false });
        pts.push({ x: cmd.cx + t * cos_t + extent * Math.cos(theta), y: cmd.cy + t * sin_t + extent * Math.sin(theta), pen: true });
      }
    }
  } else if (cmd.type === 'circle') {
    const ringCount = cmd.fillMode === 2
      ? Math.max(1, Math.floor(cmd.r / Math.max(0.5, cmd.spacing)))
      : (cmd.cycles || 1);
    for (let ri = 0; ri < ringCount; ri++) {
      const rad = cmd.fillMode === 2 ? cmd.r - ri * cmd.spacing : cmd.r;
      if (rad <= 0) break;
      const seg = Math.max(24, Math.floor(rad * 1.4));
      for (let k = 0; k <= seg; k++) {
        const th = (k / seg) * Math.PI * 2 + (cmd.angle || 0) * Math.PI / 180;
        pts.push({ x: cmd.cx + rad * Math.cos(th), y: cmd.cy + rad * Math.sin(th), pen: !(ri === 0 && k === 0) });
      }
    }
    if (cmd.fillMode === 1) {
      const theta = (cmd.angle || 0) * Math.PI / 180;
      for (let t = -cmd.r + cmd.spacing; t < cmd.r; t += cmd.spacing) {
        const half = Math.sqrt(Math.max(0, cmd.r * cmd.r - t * t));
        const lx = cmd.cx + t * (-Math.sin(theta)), ly = cmd.cy + t * Math.cos(theta);
        pts.push({ x: lx + half * Math.cos(theta), y: ly + half * Math.sin(theta), pen: false });
        pts.push({ x: lx - half * Math.cos(theta), y: ly - half * Math.sin(theta), pen: true });
      }
    }
  } else if (cmd.type === 'bullseye') {
    for (let ri = 0; ri < 4; ri++) {
      const rad = 20 + ri * 20;
      const seg = 48;
      for (let k = 0; k <= seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        pts.push({ x: cmd.cx + rad * Math.cos(th), y: cmd.cy + rad * Math.sin(th), pen: k !== 0 });
      }
    }
  } else if (cmd.type === 'grid') {
    const step = 40, n = 3;
    for (let i = -n; i <= n; i++) {
      pts.push({ x: cmd.cx + i * step, y: cmd.cy - n * step, pen: false });
      pts.push({ x: cmd.cx + i * step, y: cmd.cy + n * step, pen: true });
    }
    for (let j = -n; j <= n; j++) {
      pts.push({ x: cmd.cx - n * step, y: cmd.cy + j * step, pen: false });
      pts.push({ x: cmd.cx + n * step, y: cmd.cy + j * step, pen: true });
    }
  }
  return pts;
}

// ---- hook --------------------------------------------------------

export function usePlotter() {
  const [ip, setIpState]           = useState<string>(() => getStoredIp());
  const [pen, setPen]              = useState<PenState>({ x: 0, y: 0, down: false });
  const [moving, setMoving]        = useState(false);
  const [connected, setConnected]  = useState(false);
  const [motion, setMotionState]   = useState<MotionParams>({ ...DEFAULTS.motion });
  const [bounds, setBoundsState]   = useState<PlotterBounds>({ ...DEFAULTS.bounds });
  const [paths, setPaths]          = useState<Stroke[]>([]);
  const [activePath, setActivePath] = useState<Stroke | null>(null);
  const [queue, setQueue]          = useState<string[]>([]);
  const [log, setLog]              = useState<LogEntry[]>([mkLog('sys', 'console ready')]);

  const penRef    = useRef(pen);       penRef.current    = pen;
  const motionRef = useRef(motion);    motionRef.current = motion;
  const ipRef     = useRef(ip);        ipRef.current     = ip;
  const cancelRef = useRef(false);
  const colorRef  = useRef(0);

  const pushLog = useCallback((kind: LogEntry['kind'], text: string) => {
    setLog((l) => [...l.slice(-199), mkLog(kind, text)]);
  }, []);

  const setIp = useCallback((val: string) => {
    storeIp(val);
    setIpState(val.trim());
  }, []);

  // ---- SSE connection ------------------------------------------
  useEffect(() => {
    if (!ip) return;
    const url = sseUrl(ip);
    const es = new EventSource(url);

    es.onopen = () => {
      setConnected(true);
      pushLog('sys', `linked · http://${ip}/`);
    };

    es.onmessage = (e) => {
      // unnamed events = log messages from web_log()
      const text = e.data as string;
      const kind: LogEntry['kind'] = text.startsWith('!! ') ? 'warn' : 'fw';
      pushLog(kind, text);
    };

    // named position events from web_pos_event()
    es.addEventListener('pos', (e) => {
      try {
        const { x, y } = JSON.parse((e as MessageEvent).data) as { x: number; y: number };
        setPen((p) => ({ ...p, x, y }));
      } catch { /* ignore malformed */ }
    });

    es.onerror = () => {
      setConnected(false);
      pushLog('err', '[net] stream disconnected (auto-retrying…)');
    };

    return () => { es.close(); setConnected(false); };
  }, [ip, pushLog]);

  // ---- animation -----------------------------------------------
  const animatePath = useCallback((pts: ReturnType<typeof buildPath>, penColor: string) =>
    new Promise<void>((resolve) => {
      if (!pts.length) return resolve();
      let idx = 0;
      let cur = { x: penRef.current.x, y: penRef.current.y };
      let from = { ...cur };
      const drawn: Stroke[] = [];
      let curStroke: Stroke | null = null;
      let segStart = performance.now();
      let segDur = 0;

      const mmPerSec = () => 30 + (motionRef.current.vmax / 200000) * 220;

      const beginSeg = () => {
        const target = pts[idx];
        from = { ...cur };
        const dist = Math.hypot(target.x - cur.x, target.y - cur.y);
        segDur = Math.max(40, (dist / mmPerSec()) * 1000);
        segStart = performance.now();
        if (target.pen) {
          if (!curStroke) curStroke = { color: penColor, points: [{ x: from.x, y: from.y }] };
        } else {
          if (curStroke && curStroke.points.length > 1) drawn.push(curStroke);
          curStroke = null;
        }
      };

      const finish = () => {
        clearInterval(timer);
        if (curStroke && curStroke.points.length > 1) drawn.push(curStroke);
        if (drawn.length && !cancelRef.current) setPaths((p) => [...p, ...drawn]);
        setActivePath(null);
        resolve();
      };

      beginSeg();
      const timer = setInterval(() => {
        if (cancelRef.current) { clearInterval(timer); setActivePath(null); return resolve(); }
        const target = pts[idx];
        const k = Math.min(1, (performance.now() - segStart) / segDur);
        const nx = from.x + (target.x - from.x) * k;
        const ny = from.y + (target.y - from.y) * k;
        setPen((p) => ({ ...p, x: nx, y: ny, down: target.pen }));
        if (target.pen && curStroke) {
          setActivePath({ color: penColor, points: [...curStroke.points, { x: nx, y: ny }] });
        }
        if (k >= 1) {
          cur = { x: target.x, y: target.y };
          if (target.pen && curStroke) curStroke.points.push(cur);
          idx++;
          if (idx >= pts.length) return finish();
          beginSeg();
        }
      }, 16) as unknown as number;
    }), []);

  // ---- API send ------------------------------------------------
  const send = useCallback(async (endpoint: string) => {
    if (!ipRef.current) { pushLog('warn', `> ${endpoint} → no IP set`); return; }
    try {
      const d = await apiGet(ipRef.current, endpoint);
      if (d.status === 'ok') pushLog('ok', `[ok] ${d.msg}`);
      else pushLog('err', `[err] ${d.msg}`);
    } catch (e) {
      setConnected(false);
      pushLog('err', `[net] ${String(e)}`);
    }
  }, [pushLog]);

  // ---- enqueue (animate + send) --------------------------------
  const enqueue = useCallback(async (cmd: PlotCmd) => {
    cancelRef.current = false;
    const ep = cmdToQuery(cmd);
    pushLog('cmd', `> ${ep}`);

    if (cmd.type === 'pen') {
      setMoving(true);
      await Promise.all([
        send(ep),
        new Promise<void>((r) => setTimeout(r, 160)).then(() =>
          setPen((p) => ({ ...p, down: cmd.pos === 'down' }))
        ),
      ]);
      setMoving(false);
      return;
    }
    if (cmd.type === 'home' || cmd.type === 'sethome') {
      setMoving(true);
      const pts = cmd.type === 'home' ? [{ x: 0, y: 0, pen: false }] : [];
      await Promise.all([send(ep), animatePath(pts, '#38bdf8')]);
      setMoving(false);
      return;
    }

    const color = PALETTE[colorRef.current++ % PALETTE.length];
    const pts = buildPath(cmd);
    setQueue((q) => [...q, cmd.type]);
    setMoving(true);
    await Promise.all([send(ep), animatePath(pts, color)]);
    setMoving(false);
    setQueue((q) => q.slice(1));
  }, [send, animatePath, pushLog]);

  const stop = useCallback(() => {
    cancelRef.current = true;
    setMoving(false);
    setQueue([]);
    setActivePath(null);
    setPen((p) => ({ ...p, down: false }));
    if (ipRef.current) send('stop');
    pushLog('warn', '!! STOP — queue flushed');
  }, [send, pushLog]);

  // Motion setters
  const setMotion = useCallback((key: keyof MotionParams, val: number) => {
    setMotionState((m) => ({ ...m, [key]: val }));
  }, []);

  const commitMotion = useCallback((key: keyof MotionParams, val: number) => {
    const ep = motionToQuery(key, val, motionRef.current);
    pushLog('cmd', `> ${ep}`);
    if (ipRef.current) send(ep);
  }, [send, pushLog]);

  // Bounds setters
  const setBounds = useCallback((b: PlotterBounds | ((prev: PlotterBounds) => PlotterBounds)) => {
    setBoundsState(b);
  }, []);

  const commitBounds = useCallback((b: PlotterBounds) => {
    const ep = boundsToQuery(b);
    pushLog('cmd', `> ${ep}`);
    if (ipRef.current) send(ep);
  }, [send, pushLog]);

  const clearPaths = useCallback(() => { setPaths([]); setActivePath(null); }, []);

  return {
    ip, setIp,
    pen, moving, connected,
    motion, bounds,
    paths, activePath,
    queue, log,
    setMotion, commitMotion,
    setBounds, commitBounds,
    enqueue, stop, clearPaths, pushLog,
    DEFAULTS,
  };
}
