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
//
// As of v1.3 (S7) the digester builds a Frame and runs it through the shared
// pipeline (simplify → travel-order → compile), so imports inherit the same
// optimization as generators. Pen-up-only travels that lead to no drawing are
// dropped (they aren't geometry).

import type { Frame, Path, Pt } from './frame';
import { compile } from './compile';
import { optimizeOrder, simplifyFrame } from './toolpath';

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

// Matches firmware CIRCLE_CHORD_ERR_MM (board_config.h).  Used both for
// tessellation (below) and for fitArcs reconstruction (arcTol in compile()).
const CHORD_ERR_MM = 0.3;

// Tessellate a G2/G3 arc into intermediate points in G-code (source) space.
// Returns all points from just-after-start up to and including the end point.
// Uses the same chord-error formula as the firmware (plt_arc_segments) so the
// tessellation density matches what the firmware would draw.
function tessellateArc(
  sx: number, sy: number,     // start (current pos in source mm)
  ex: number, ey: number,     // end (X Y on the gcode line)
  I: number, J: number,       // center offset from start (source mm)
  clockwise: boolean,          // true = G2 CW, false = G3 CCW
): { x: number; y: number }[] {
  const ccx = sx + I, ccy = sy + J;
  const r = Math.hypot(sx - ccx, sy - ccy);
  if (r < 1e-6) return [{ x: ex, y: ey }];   // degenerate → straight line endpoint

  const a0 = Math.atan2(sy - ccy, sx - ccx);
  const a1 = Math.atan2(ey - ccy, ex - ccx);
  let span = a1 - a0;
  if (clockwise) {
    while (span > 1e-9) span -= 2 * Math.PI;
    if (Math.abs(span) < 1e-9) span = -2 * Math.PI;  // full circle CW
  } else {
    while (span < -1e-9) span += 2 * Math.PI;
    if (Math.abs(span) < 1e-9) span = 2 * Math.PI;   // full circle CCW
  }

  // Firmware formula: r(1 - cos(θ/2)) = CHORD_ERR_MM  →  θ = 2·arccos(1 - err/r)
  const ratio = Math.max(-1, Math.min(1, 1 - CHORD_ERR_MM / r));
  const stepAngle = 2 * Math.acos(ratio);
  const N = Math.max(3, Math.ceil(Math.abs(span) / stepAngle));

  const pts: { x: number; y: number }[] = [];
  for (let k = 1; k <= N; k++) {
    const a = a0 + span * (k / N);
    pts.push({ x: ccx + r * Math.cos(a), y: ccy + r * Math.sin(a) });
  }
  pts[pts.length - 1] = { x: ex, y: ey };   // snap to declared target
  return pts;
}

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

    const isG2 = /(^|[^A-Z])G0?2(\D|$)/.test(u);
    const isG3 = /(^|[^A-Z])G0?3(\D|$)/.test(u);
    const isMove = isG2 || isG3 || /(^|[^A-Z])G0?[01](\D|$)/.test(u);
    if (!isMove) continue;

    // G2/G3 arcs are feed-rate (pen-down) moves like G1
    const g1 = isG2 || isG3 || /(^|[^A-Z])G0?1(\D|$)/.test(u);
    const fx = NUM(field('X', u)), fy = NUM(field('Y', u)), fz = NUM(field('Z', u));

    if (fz !== undefined) cz = abs ? fz * unit : cz + fz * unit;
    if (resolvedPen === 'z') setPen(cz <= zThresh);
    if (resolvedPen === 'g01') setPen(g1);

    if (fx === undefined && fy === undefined) continue;   // Z-only / pen line, no XY move
    const nx = fx !== undefined ? (abs ? fx * unit + ox : cx + fx * unit) : cx;
    const ny = fy !== undefined ? (abs ? fy * unit + oy : cy + fy * unit) : cy;

    if (isG2 || isG3) {
      const I = (NUM(field('I', u)) ?? 0) * unit;
      const J = (NUM(field('J', u)) ?? 0) * unit;
      for (const p of tessellateArc(cx, cy, nx, ny, I, J, isG2))
        ops.push({ kind: 'move', x: p.x, y: p.y });
    } else {
      ops.push({ kind: 'move', x: nx, y: ny });
    }
    cx = nx; cy = ny;
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

  // ---- pass 2: build a Frame (group pen-down runs into paths) ----
  // A continuous pen-down stroke = one Path, starting at the gondola position when
  // the pen dropped. Pen-up moves only advance that position (no geometry).
  const paths: Path[] = [];
  let cur: Pt[] | null = null;
  let down = false;
  let pos: Pt | null = null;
  const flush = () => { if (cur && cur.length > 1) paths.push({ points: cur }); cur = null; };

  for (const o of ops) {
    if (o.kind === 'pen') {
      if (o.down && !down) cur = pos ? [pos] : [];   // start a stroke at current position
      if (!o.down && down) flush();                  // pen lifted → close the stroke
      down = o.down;
      continue;
    }
    const [X, Y] = T(o.x, o.y);
    pos = { x: X, y: Y };
    if (down) { if (!cur) cur = []; cur.push(pos); }
  }
  flush();

  const frame: Frame = { widthMm: opts.bounds.left + opts.bounds.right, heightMm: opts.bounds.up + opts.bounds.down, paths };
  // Always arc-fit: fitArcs only fires on genuinely circular runs, so G1-only files
  // with tessellated arcs (most slicer output) get collapsed too; anything else is
  // untouched. (Previously gated on the source containing G2/G3.)
  const queries = compile(optimizeOrder(simplifyFrame(frame)), { arcTol: CHORD_ERR_MM });
  // arc? queries are drawn segments just like line? — fold them into draws
  const draws = queries.filter((q) => q.startsWith('line?') || q.startsWith('arc?')).length;
  const travels = queries.filter((q) => q.startsWith('goto?')).length;

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
