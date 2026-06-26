// Compile a Frame into the firmware's own API query strings — exactly what
// streamQueries() sends. This is the single funnel every v1.3 feature flows through
// (generators, modifiers, the G-code digester), so they all share one continuous-draw
// emit. See docs/v1.3/ARCHITECTURE.md §4.
//
// Per path: travel pen-up to the start, drop the pen, then draw each segment with
// `lift=0` (the v1.2 continuous-draw flag — no pen bob between segments), lifting once
// at the end. Closed paths also draw the last→first segment.

import type { Frame, Path, Pt } from "./frame";
import { fitArcs } from "./arcfit";
import { clipPolylineToPolygon } from "./clip";

const r = (n: number) => Math.round(n * 100) / 100;   // 0.01 mm precision, short URLs
const r4 = (n: number) => Math.round(n * 10000) / 10000;   // angles need more precision

export interface CompileOpts {
  /** If > 0, fit circular runs to firmware `arc` jobs within this mm tolerance.
   *  Requires firmware with /api/arc; default off → identical line-only output. */
  arcTol?: number;
  /** Clip all paths to the work area before emitting — out-of-bounds segments are
   *  trimmed at the boundary rather than rejected by the firmware. */
  clipBounds?: { left: number; right: number; up: number; down: number };
}

function boundsRect(b: { left: number; right: number; up: number; down: number }): Pt[] {
  return [
    { x: -b.left,  y: -b.up   },
    { x:  b.right, y: -b.up   },
    { x:  b.right, y:  b.down },
    { x: -b.left,  y:  b.down },
  ];
}

function emitArcPath(path: Path, tol: number, out: string[]): void {
  const pts = path.points;
  if (pts.length === 0) return;
  const cycles = path.cycles && path.cycles > 0 ? Math.round(path.cycles) : 1;
  const ring = path.closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  out.push(`goto?x=${r(ring[0].x)}&y=${r(ring[0].y)}`);
  if (ring.length === 1) return;
  out.push("pen?pos=down");
  for (const prim of fitArcs(ring, tol)) {
    if (prim.kind === "arc") {
      out.push(`arc?cx=${r(prim.cx)}&cy=${r(prim.cy)}&r=${r(prim.r)}&a0=${r4(prim.a0)}&a1=${r4(prim.a1)}&cw=${prim.cw ? 1 : 0}&cycles=${cycles}&lift=0`);
    } else {
      for (let i = 1; i < prim.points.length; i++) {
        const a = prim.points[i - 1], b = prim.points[i];
        out.push(`line?x0=${r(a.x)}&y0=${r(a.y)}&x1=${r(b.x)}&y1=${r(b.y)}&cycles=${cycles}&lift=0`);
      }
    }
  }
  out.push("pen?pos=up");
}

function emitPath(path: Path, out: string[]): void {
  const pts = path.points;
  if (pts.length === 0) return;
  const cycles = path.cycles && path.cycles > 0 ? Math.round(path.cycles) : 1;

  out.push(`goto?x=${r(pts[0].x)}&y=${r(pts[0].y)}`);   // pen-up travel to start
  if (pts.length === 1) return;                          // a lone point: nothing to draw
  out.push("pen?pos=down");

  const seg = (a: Pt, b: Pt) =>
    out.push(`line?x0=${r(a.x)}&y0=${r(a.y)}&x1=${r(b.x)}&y1=${r(b.y)}&cycles=${cycles}&lift=0`);

  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
  if (path.closed && pts.length > 2) seg(pts[pts.length - 1], pts[0]);

  out.push("pen?pos=up");
}

/** Frame → ordered list of firmware query strings (feed straight to streamQueries).
 *  With opts.arcTol > 0, circular runs collapse to `arc` jobs (needs firmware support).
 *  With opts.clipBounds, paths are clipped to the work area — out-of-bounds segments are
 *  trimmed at the boundary so the firmware never sees coordinates it would reject. */
export function compile(frame: Frame, opts: CompileOpts = {}): string[] {
  const out: string[] = ["pen?pos=up"];   // known-safe start
  const tol = opts.arcTol ?? 0;
  const rect = opts.clipBounds ? boundsRect(opts.clipBounds) : null;

  for (const path of frame.paths) {
    if (rect) {
      // Expand closed paths to a ring, clip, emit each surviving segment independently.
      const ring = path.closed && path.points.length > 2
        ? [...path.points, path.points[0]]
        : path.points;
      const segments = clipPolylineToPolygon(ring, rect, true);
      for (const pts of segments) {
        if (pts.length < 2) continue;
        const cp: Path = { ...path, points: pts, closed: false };
        if (tol > 0) emitArcPath(cp, tol, out);
        else emitPath(cp, out);
      }
    } else {
      if (tol > 0) emitArcPath(path, tol, out);
      else emitPath(path, out);
    }
  }
  return out;
}
