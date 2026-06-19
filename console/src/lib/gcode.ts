// G-code digester — turns a text G-code program into the plotter's own API
// queries (goto / line / pen), the same query strings parseJsonScript emits, so
// the existing flow-controlled streaming runner can execute them unchanged.
//
// A polar plotter only has X/Y motion + a pen. So we collapse 3-axis G-code to:
//   - pen up/down  (from Z height, spindle M3/M5, servo M280, or G0-vs-G1)
//   - pen-UP move   -> goto (rapid travel)
//   - pen-DOWN move -> line from the previous point (a drawn segment)
// Z/E/F and everything else is ignored. Coordinates are fitted into the active
// work area (see PlaceMode) because G-code is usually corner-origin, Y-up while
// the plotter is centre-origin, Y-down.

export type PenMode = 'auto' | 'z' | 'spindle' | 'servo' | 'g01';
export type PlaceMode = 'fit' | 'center' | 'rawflip' | 'raw';

export interface GcodeBounds { left: number; right: number; up: number; down: number; }

export interface GcodeOptions {
  penMode: PenMode;
  placeMode: PlaceMode;
  bounds: GcodeBounds;
}

export interface GcodeResult {
  queries: string[];          // ready-to-send API query strings
  draws: number;              // pen-down segments (line)
  travels: number;            // pen-up moves (goto)
  resolvedPen: Exclude<PenMode, 'auto'>;  // what auto-detect chose
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;  // source mm
  scale: number;              // applied scale factor (<=1 for fit)
  warnings: string[];
}

// One parsed motion/pen event in SOURCE (mm) coordinates.
type Op = { kind: 'move'; x: number; y: number } | { kind: 'pen'; down: boolean };

const NUM = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const v = parseFloat(s);
  return isFinite(v) ? v : undefined;
};

// Pull a word value out of a G-code line, e.g. field('X', 'G1 X10 Y-2') -> '10'.
function field(letter: string, line: string): string | undefined {
  const re = new RegExp(`(?:^|[^A-Za-z])${letter}(-?\\d*\\.?\\d+)`, 'i');
  const m = line.match(re);
  return m ? m[1] : undefined;
}

// Decide which pen convention the file uses (for penMode='auto').
function detectPen(lines: string[]): Exclude<PenMode, 'auto'> {
  let hasSpindle = false, hasServo = false, zMin = Infinity, zMax = -Infinity;
  for (const ln of lines) {
    const u = ln.toUpperCase();
    if (/(^|[^A-Z])M0?3(\D|$)/.test(u) || /(^|[^A-Z])M0?5(\D|$)/.test(u)) hasSpindle = true;
    if (/(^|[^A-Z])M280(\D|$)/.test(u)) hasServo = true;
    if (/(^|[^A-Z])G0?[01](\D|$)/.test(u)) {
      const z = NUM(field('Z', u));
      if (z !== undefined) { if (z < zMin) zMin = z; if (z > zMax) zMax = z; }
    }
  }
  if (hasServo) return 'servo';
  if (hasSpindle) return 'spindle';
  if (zMax - zMin > 1e-6) return 'z';   // Z actually varies -> pen is on Z
  return 'g01';
}

// Build the source->plotter coordinate transform for the chosen placement.
function makeTransform(
  mode: PlaceMode, bbox: { x0: number; y0: number; x1: number; y1: number } | null, b: GcodeBounds,
): { fn: (x: number, y: number) => [number, number]; scale: number } {
  if (mode === 'raw')     return { fn: (x, y) => [x, y], scale: 1 };
  if (mode === 'rawflip') return { fn: (x, y) => [x, -y], scale: 1 };
  if (!bbox)              return { fn: (x, y) => [x, -y], scale: 1 };

  const gw = bbox.x1 - bbox.x0, gh = bbox.y1 - bbox.y0;
  const gcx = (bbox.x0 + bbox.x1) / 2, gcy = (bbox.y0 + bbox.y1) / 2;
  // target box in firmware logical coords: x in [-left,right], y in [-down,up]
  const tcx = (b.right - b.left) / 2, tcy = (b.up - b.down) / 2;
  const tw = b.left + b.right, th = b.up + b.down;

  let scale = 1;
  if (mode === 'fit') {
    const sx = gw > 1e-6 ? tw / gw : 1;
    const sy = gh > 1e-6 ? th / gh : 1;
    scale = Math.min(1, sx, sy);   // shrink-to-fit only, never enlarge
  }
  // centre + flip Y (G-code Y-up -> plotter Y-down)
  return {
    fn: (x, y) => [tcx + (x - gcx) * scale, tcy - (y - gcy) * scale],
    scale,
  };
}

export function digestGcode(text: string, opts: GcodeOptions): GcodeResult {
  const warnings: string[] = [];
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines
    .map((l) => { const i = l.indexOf(';'); return (i >= 0 ? l.slice(0, i) : l).trim(); })
    .filter((l) => l.length > 0);

  const resolvedPen = opts.penMode === 'auto' ? detectPen(lines) : opts.penMode;

  // ---- pass 1: parse to source-space ops ----
  let abs = true;          // G90 absolute (default) / G91 relative
  let unit = 1;            // mm (G21, default); inch (G20) = 25.4
  let cx = 0, cy = 0, cz = 0;   // current position (mm)
  let ox = 0, oy = 0;      // G92 offsets (mm)
  let penDown = false;
  const ops: Op[] = [];
  const setPen = (d: boolean) => { if (d !== penDown) { penDown = d; ops.push({ kind: 'pen', down: d }); } };

  // For Z-mode, threshold = midpoint of the Z range so up/down split cleanly.
  let zThresh = 0;
  if (resolvedPen === 'z') {
    let zMin = Infinity, zMax = -Infinity;
    for (const ln of lines) {
      const z = NUM(field('Z', ln));
      if (z !== undefined) { if (z < zMin) zMin = z; if (z > zMax) zMax = z; }
    }
    if (isFinite(zMin) && isFinite(zMax)) zThresh = (zMin + zMax) / 2;
  }

  for (const ln of lines) {
    const u = ln.toUpperCase();
    if (/(^|[^A-Z])G90(\D|$)/.test(u)) abs = true;
    if (/(^|[^A-Z])G91(\D|$)/.test(u)) abs = false;
    if (/(^|[^A-Z])G20(\D|$)/.test(u)) unit = 25.4;
    if (/(^|[^A-Z])G21(\D|$)/.test(u)) unit = 1;

    if (/(^|[^A-Z])G92(\D|$)/.test(u)) {       // set position (define offset)
      const gx = NUM(field('X', u)), gy = NUM(field('Y', u));
      if (gx !== undefined) ox = cx - gx * unit;
      if (gy !== undefined) oy = cy - gy * unit;
      continue;
    }

    if (resolvedPen === 'spindle') {
      if (/(^|[^A-Z])M0?3(\D|$)/.test(u)) setPen(true);
      if (/(^|[^A-Z])M0?5(\D|$)/.test(u)) setPen(false);
    }
    if (resolvedPen === 'servo' && /(^|[^A-Z])M280(\D|$)/.test(u)) {
      const s = NUM(field('S', u));
      // firmware pen: UP=180°, DOWN=120° → higher angle = up. Split at the midpoint 150°.
      if (s !== undefined) setPen(s <= 150);
    }

    const isMove = /(^|[^A-Z])G0?[01](\D|$)/.test(u);
    if (!isMove) continue;

    const g1 = /(^|[^A-Z])G0?1(\D|$)/.test(u);
    const fx = NUM(field('X', u)), fy = NUM(field('Y', u)), fz = NUM(field('Z', u));

    if (fz !== undefined) cz = abs ? fz * unit : cz + fz * unit;
    if (resolvedPen === 'z') setPen(cz <= zThresh);
    if (resolvedPen === 'g01') setPen(g1);

    if (fx === undefined && fy === undefined) continue;   // Z-only / pen line, no XY move
    const nx = fx !== undefined ? (abs ? fx * unit + ox : cx + fx * unit) : cx;
    const ny = fy !== undefined ? (abs ? fy * unit + oy : cy + fy * unit) : cy;
    cx = nx; cy = ny;
    ops.push({ kind: 'move', x: nx, y: ny });
  }

  // ---- bbox over all moves ----
  let bbox: GcodeResult['bbox'] = null;
  for (const o of ops) {
    if (o.kind !== 'move') continue;
    if (!bbox) bbox = { x0: o.x, y0: o.y, x1: o.x, y1: o.y };
    else {
      bbox.x0 = Math.min(bbox.x0, o.x); bbox.y0 = Math.min(bbox.y0, o.y);
      bbox.x1 = Math.max(bbox.x1, o.x); bbox.y1 = Math.max(bbox.y1, o.y);
    }
  }

  const { fn: T, scale } = makeTransform(opts.placeMode, bbox, opts.bounds);

  // ---- pass 2: emit queries ----
  const queries: string[] = ['pen?pos=up'];   // known-safe start
  let draws = 0, travels = 0;
  let down = false;
  let last: [number, number] | null = null;
  const r = (n: number) => Math.round(n * 100) / 100;

  for (const o of ops) {
    if (o.kind === 'pen') {
      down = o.down;
      queries.push(`pen?pos=${down ? 'down' : 'up'}`);
      continue;
    }
    const [X, Y] = T(o.x, o.y);
    if (down && last) {
      // lift=0: the digester drives the pen explicitly (one drop per drawn run,
      // one lift before each travel), so the firmware line must NOT bob the pen
      // up/down at every segment — back-to-back segments draw continuously.
      queries.push(`line?x0=${r(last[0])}&y0=${r(last[1])}&x1=${r(X)}&y1=${r(Y)}&cycles=1&lift=0`);
      draws++;
    } else {
      queries.push(`goto?x=${r(X)}&y=${r(Y)}`);
      travels++;
    }
    last = [X, Y];
  }
  queries.push('pen?pos=up');

  if (!bbox) warnings.push('no X/Y moves found — nothing to draw');
  if (opts.placeMode === 'fit' && scale < 1)
    warnings.push(`scaled to ${(scale * 100).toFixed(0)}% to fit the work area`);
  if ((opts.placeMode === 'raw' || opts.placeMode === 'rawflip') && bbox) {
    const b = opts.bounds;
    if (bbox.x0 < -b.left || bbox.x1 > b.right || bbox.y0 < -b.up || bbox.y1 > b.down)
      warnings.push('drawing extends outside the work area — those moves may be rejected');
  }
  if (draws + travels > 8000)
    warnings.push(`${draws + travels} moves — this will take a long time to stream`);

  return { queries, draws, travels, resolvedPen, bbox, scale, warnings };
}
