// Detect circular-arc runs in a polyline so they can stream as ONE firmware `arc`
// job instead of many `line` segments. Pure & conservative: only emits an arc when a
// run of points genuinely lies on a circle (within tol) AND sweeps monotonically.
// Everything else stays a line run, so polygonal shapes are untouched.

import type { Pt } from "./frame";

export interface ArcSeg { kind: "arc"; cx: number; cy: number; r: number; a0: number; a1: number; cw: boolean; }
export interface LineSeg { kind: "line"; points: Pt[]; }
export type Primitive = ArcSeg | LineSeg;

const MIN_ARC_PTS = 4;      // need at least this many points to bother with an arc
const MAX_ARC_R = 1e5;      // bigger than this ⇒ effectively a straight line

// Circumcircle of three points, or null if (near-)collinear.
function circleFrom3(a: Pt, b: Pt, c: Pt): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

const cross = (ox: number, oy: number, p: Pt, q: Pt) =>
  (p.x - ox) * (q.y - oy) - (p.y - oy) * (q.x - ox);

export function fitArcs(points: Pt[], tol: number): Primitive[] {
  const n = points.length;
  if (n < MIN_ARC_PTS || tol <= 0) return [{ kind: "line", points: points.slice() }];

  const prims: Primitive[] = [];
  let lineStart = 0;
  let i = 0;
  const flushLine = (endIdx: number) => {
    if (endIdx - lineStart >= 1) prims.push({ kind: "line", points: points.slice(lineStart, endIdx + 1) });
  };

  while (i < n - 1) {
    let best = -1, bestC: { cx: number; cy: number; r: number } | null = null;
    for (let j = i + MIN_ARC_PTS - 1; j < n; j++) {
      const c = circleFrom3(points[i], points[(i + j) >> 1], points[j]);
      if (!c || c.r > MAX_ARC_R) break;
      // every point AND every chord midpoint within tol of the circle. The midpoint
      // test is what rejects polygons (a square's corners lie on a circle, but its
      // edge midpoints are far from it).
      let ok = true;
      for (let k = i; k <= j && ok; k++) if (Math.abs(Math.hypot(points[k].x - c.cx, points[k].y - c.cy) - c.r) > tol) ok = false;
      for (let k = i; k < j && ok; k++) {
        const mx = (points[k].x + points[k + 1].x) / 2, my = (points[k].y + points[k + 1].y) / 2;
        if (Math.abs(Math.hypot(mx - c.cx, my - c.cy) - c.r) > tol) ok = false;
      }
      // and the sweep turns monotonically (no back-and-forth on the circle)?
      if (ok) {
        let sign = 0;
        for (let k = i + 1; k <= j && ok; k++) {
          const s = Math.sign(cross(c.cx, c.cy, points[k - 1], points[k]));   // angular step direction
          if (s !== 0) { if (sign === 0) sign = s; else if (s !== sign) ok = false; }
        }
      }
      if (!ok) break;
      best = j; bestC = c;
    }

    if (best >= 0 && bestC && best - i >= MIN_ARC_PTS - 1) {
      flushLine(i);
      let turn = 0;
      for (let k = i + 1; k <= best; k++) turn += cross(bestC.cx, bestC.cy, points[k - 1], points[k]);
      prims.push({
        kind: "arc", cx: bestC.cx, cy: bestC.cy, r: bestC.r,
        a0: Math.atan2(points[i].y - bestC.cy, points[i].x - bestC.cx),
        a1: Math.atan2(points[best].y - bestC.cy, points[best].x - bestC.cx),
        cw: turn < 0,
      });
      i = best; lineStart = best;
    } else {
      i++;
    }
  }
  flushLine(n - 1);
  return prims;
}
