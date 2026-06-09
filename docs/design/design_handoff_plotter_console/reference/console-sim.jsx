// console-sim.jsx — plotter state machine + command simulation
const { useState, useRef, useEffect, useCallback } = React;

// ---- defaults ----
const DEFAULTS = {
  motion: {
    vmax: 200000,   // µstep/t
    amax: 500,      // AMAX = DMAX
    run: 600,       // mA
    hold: 200,      // mA
  },
  bounds: { left: 300, right: 300, up: 200, down: 200 }, // mm from origin
};

const PALETTE = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c'];

let LOG_ID = 0;
function mkLog(kind, text) {
  return { id: ++LOG_ID, kind, text, t: Date.now() };
}

// Build the point list (machine coords, mm) for each command type.
function buildPath(cmd) {
  const pts = [];
  if (cmd.type === 'goto') {
    pts.push({ x: cmd.x, y: cmd.y, pen: false });
  } else if (cmd.type === 'line') {
    pts.push({ x: cmd.x0, y: cmd.y0, pen: false });
    pts.push({ x: cmd.x1, y: cmd.y1, pen: true });
  } else if (cmd.type === 'square') {
    const h = cmd.sz / 2;
    const a = (cmd.angle || 0) * Math.PI / 180;
    const rot = (px, py) => ({
      x: cmd.cx + (px * Math.cos(a) - py * Math.sin(a)),
      y: cmd.cy + (px * Math.sin(a) + py * Math.cos(a)),
    });
    const ringCount = cmd.fill ? Math.max(1, Math.floor(h / Math.max(0.5, cmd.spacing))) : 1;
    for (let r = 0; r < ringCount; r++) {
      const inset = cmd.fill ? r * cmd.spacing : 0;
      const hh = h - inset;
      if (hh <= 0) break;
      const corners = [rot(-hh, -hh), rot(hh, -hh), rot(hh, hh), rot(-hh, hh), rot(-hh, -hh)];
      corners.forEach((p, i) => pts.push({ x: p.x, y: p.y, pen: !(r === 0 && i === 0) }));
    }
  } else if (cmd.type === 'circle') {
    const cycles = Math.max(1, cmd.cycles || 1);
    const ringCount = cmd.fill ? Math.max(1, Math.floor(cmd.r / Math.max(0.5, cmd.spacing))) : cycles;
    for (let r = 0; r < ringCount; r++) {
      const rad = cmd.fill ? cmd.r - r * cmd.spacing : cmd.r;
      if (rad <= 0) break;
      const seg = Math.max(24, Math.floor(rad * 1.4));
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2 + (cmd.angle || 0) * Math.PI / 180;
        pts.push({ x: cmd.cx + rad * Math.cos(th), y: cmd.cy + rad * Math.sin(th), pen: !(r === 0 && i === 0) });
      }
    }
  } else if (cmd.type === 'bullseye') {
    for (let r = 0; r < 4; r++) {
      const rad = 20 + r * 20;
      const seg = 48;
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        pts.push({ x: cmd.cx + rad * Math.cos(th), y: cmd.cy + rad * Math.sin(th), pen: i !== 0 });
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

// Compact URL-style echo of a command (matches firmware query format)
function cmdToQuery(cmd) {
  switch (cmd.type) {
    case 'goto': return `goto?x=${cmd.x}&y=${cmd.y}`;
    case 'line': return `line?x0=${cmd.x0}&y0=${cmd.y0}&x1=${cmd.x1}&y1=${cmd.y1}&cycles=${cmd.cycles}`;
    case 'square': return `square?cx=${cmd.cx}&cy=${cmd.cy}&sz=${cmd.sz}&cycles=${cmd.cycles}&fill=${cmd.fill ? 1 : 0}&angle=${cmd.angle}&spacing=${cmd.spacing}`;
    case 'circle': return `circle?cx=${cmd.cx}&cy=${cmd.cy}&r=${cmd.r}&cycles=${cmd.cycles}&fill=${cmd.fill ? 1 : 0}&angle=${cmd.angle}&spacing=${cmd.spacing}`;
    case 'bullseye': return `bullseye?cx=${cmd.cx}&cy=${cmd.cy}`;
    case 'grid': return `grid?cx=${cmd.cx}&cy=${cmd.cy}`;
    case 'home': return 'home';
    case 'sethome': return 'sethome';
    case 'pen': return `pen?pos=${cmd.pos}`;
    default: return cmd.type;
  }
}

function usePlotter() {
  const [pen, setPen] = useState({ x: 0, y: 0, down: false });
  const [moving, setMoving] = useState(false);
  const [connected, setConnected] = useState(true);
  const [motion, setMotion] = useState({ ...DEFAULTS.motion });
  const [bounds, setBounds] = useState({ ...DEFAULTS.bounds });
  const [paths, setPaths] = useState([]);     // committed drawn polylines
  const [activePath, setActivePath] = useState(null); // currently drawing
  const [queue, setQueue] = useState([]);     // pending command labels
  const [log, setLog] = useState([
    mkLog('sys', 'console ready · firmware v2.4'),
  ]);

  const penRef = useRef(pen);
  penRef.current = pen;
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const connRef = useRef(connected);
  connRef.current = connected;
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const colorRef = useRef(0);

  const pushLog = useCallback((kind, text) => {
    setLog((l) => [...l.slice(-180), mkLog(kind, text)]);
  }, []);

  // Animate the pen through a list of points at current vmax.
  // Time-based interval ticker (robust across environments).
  const animatePath = useCallback((pts, penColor) => new Promise((resolve) => {
    if (!pts.length) return resolve();
    let idx = 0;
    let cur = { x: penRef.current.x, y: penRef.current.y };
    let from = { ...cur };
    const drawn = [];        // committed strokes this command
    let curStroke = null;
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
        if (target.pen && curStroke) curStroke.points.push({ x: target.x, y: target.y });
        idx++;
        if (idx >= pts.length) return finish();
        beginSeg();
      }
    }, 16);
  }), []);

  // queue processor
  const pump = useCallback(async (cmds) => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = false;
    setMoving(true);
    for (const cmd of cmds) {
      if (cancelRef.current) break;
      if (!connRef.current) {
        pushLog('err', `${cmdToQuery(cmd)} → dropped (link down)`);
        continue;
      }
      pushLog('cmd', `> ${cmdToQuery(cmd)}`);

      if (cmd.type === 'pen') {
        await new Promise((r) => setTimeout(r, 160));
        setPen((p) => ({ ...p, down: cmd.pos === 'down' }));
        pushLog('ok', `[ok] pen ${cmd.pos}`);
        continue;
      }
      if (cmd.type === 'home') {
        await animatePath([{ x: 0, y: 0, pen: false }]);
        pushLog('ok', '[ok] homed → 0,0');
        continue;
      }
      if (cmd.type === 'sethome') {
        await new Promise((r) => setTimeout(r, 120));
        pushLog('ok', `[ok] home set @ ${penRef.current.x.toFixed(0)},${penRef.current.y.toFixed(0)}`);
        continue;
      }
      const color = PALETTE[colorRef.current % PALETTE.length];
      colorRef.current++;
      const pts = buildPath(cmd);
      await animatePath(pts, color);
      if (!cancelRef.current) pushLog('ok', `[ok] ${cmd.type} drawn`);
      setQueue((q) => q.slice(1));
    }
    runningRef.current = false;
    setMoving(false);
    setQueue([]);
  }, [animatePath, pushLog]);

  const enqueue = useCallback((cmd) => {
    if (!connRef.current) { pushLog('err', `${cmdToQuery(cmd)} → dropped (link down)`); return; }
    setQueue((q) => [...q, cmd.type]);
    pump([cmd]);
  }, [pump, pushLog]);

  const stop = useCallback(() => {
    cancelRef.current = true;
    runningRef.current = false;
    setMoving(false);
    setQueue([]);
    setActivePath(null);
    setPen((p) => ({ ...p, down: false }));
    pushLog('warn', '!! STOP — queue flushed, motors released');
  }, [pushLog]);

  // motion config setters with echo
  const applyMotion = useCallback((key, val) => {
    setMotion((m) => ({ ...m, [key]: val }));
  }, []);
  const commitMotion = useCallback((key, val) => {
    const map = { vmax: `speed?vmax=${val}`, amax: `accel?amax=${val}`, run: `cur?run=${val}&hold=${motionRef.current.hold}`, hold: `cur?run=${motionRef.current.run}&hold=${val}` };
    const q = key === 'run' || key === 'hold' ? `cur?run=${key === 'run' ? val : motionRef.current.run}&hold=${key === 'hold' ? val : motionRef.current.hold}` : map[key];
    pushLog('cmd', `> ${q}`);
    if (connRef.current) pushLog('ok', `[ok] applied`);
    else pushLog('err', `→ dropped (link down)`);
  }, [pushLog]);

  const commitBounds = useCallback((b) => {
    pushLog('cmd', `> bounds?l=${b.left}&r=${b.right}&u=${b.up}&d=${b.down}`);
    if (connRef.current) pushLog('ok', `[ok] work area set`);
    else pushLog('err', `→ dropped (link down)`);
  }, [pushLog]);

  const clearPaths = useCallback(() => { setPaths([]); setActivePath(null); }, []);

  const toggleConn = useCallback(() => {
    setConnected((c) => {
      const next = !c;
      pushLog(next ? 'ok' : 'err', next ? '[net] link re-established' : '[net] log stream disconnected');
      return next;
    });
  }, [pushLog]);

  return {
    pen, moving, connected, motion, bounds, paths, activePath, queue, log,
    setMotion: applyMotion, commitMotion, setBounds, commitBounds,
    enqueue, stop, clearPaths, toggleConn, pushLog,
    DEFAULTS,
  };
}

Object.assign(window, { usePlotter, DEFAULTS, PALETTE });
