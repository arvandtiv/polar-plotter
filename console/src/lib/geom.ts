// Shared geometry toolkit for v1.3 — pure, dependency-free (like kinematics.h).
// Every generator, modifier, and the compiler/optimizer call into here.
// See docs/v1.3/03-geometry-core.md.

import { frameBounds, type Frame, type Path, type Pt } from "./frame";

export const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Total length of a polyline (open). */
export function polylineLength(points: Pt[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

/** Axis-aligned bounds of a point list, or null if empty. */
export function bounds(points: Pt[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!points.length) return null;
  let x0 = points[0].x, y0 = points[0].y, x1 = x0, y1 = y0;
  for (const p of points) {
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/** Even arc-length resampling at ~spacingMm; first & last points preserved. */
export function resample(points: Pt[], spacingMm: number): Pt[] {
  if (points.length < 2 || spacingMm <= 0) return points.map((p) => ({ ...p }));
  const out: Pt[] = [{ ...points[0] }];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    let a = out[out.length - 1];
    const b = points[i];
    let segLen = dist(a, b);
    // emit points along this segment while there's a full spacing left
    while (acc + segLen >= spacingMm) {
      const t = (spacingMm - acc) / segLen;
      const np = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(np);
      a = np;
      segLen = dist(a, b);
      acc = 0;
    }
    acc += segLen;
  }
  const last = points[points.length - 1];
  if (dist(out[out.length - 1], last) > 1e-9) out.push({ ...last });
  return out;
}

// ---- affine transforms (operate on a point list, return a new list) ----

export function translate(points: Pt[], dx: number, dy: number): Pt[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function scale(points: Pt[], sx: number, sy = sx, cx = 0, cy = 0): Pt[] {
  return points.map((p) => ({ x: cx + (p.x - cx) * sx, y: cy + (p.y - cy) * sy }));
}

export function rotate(points: Pt[], angleRad: number, cx = 0, cy = 0): Pt[] {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return points.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}

/** Cubic Bézier sampled into n+1 points (t = 0..1 inclusive). */
export function sampleBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  const steps = Math.max(1, Math.floor(n));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
  return out;
}

/** Perpendicular distance from p to the (infinite) line through a–b. */
function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Ramer–Douglas–Peucker: drop points that stay within `tol` of the simplified line. */
export function simplifyRDP(points: Pt[], tol: number): Pt[] {
  if (points.length < 3 || tol <= 0) return points.map((p) => ({ ...p }));
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointLineDistance(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > tol) { keep[idx] = true; stack.push([lo, idx], [idx, hi]); }
  }
  return points.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}

/** Drop a midpoint that lies within `tol` of the line through its neighbours. */
export function filterCollinear(points: Pt[], tol: number): Pt[] {
  if (points.length < 3 || tol <= 0) return points.map((p) => ({ ...p }));
  const out: Pt[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    if (pointLineDistance(points[i], out[out.length - 1], points[i + 1]) > tol) {
      out.push({ ...points[i] });
    }
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

/** Deterministic PRNG (mulberry32). seededRandom(42)() always gives the same stream. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fit a frame's geometry into a target rectangle: uniform scale (≤1 by default —
 * shrink to fit, never enlarge) + centre. Aspect ratio preserved. Reused by
 * generators (fit to work area) and, later, the G-code digester placement.
 */
export function fitToBounds(
  frame: Frame,
  rect: { x0: number; y0: number; x1: number; y1: number },
  opts: { scaleUp?: boolean } = {},
): Frame {
  const b = frameBounds(frame);
  if (!b) return frame;
  const gw = b.x1 - b.x0, gh = b.y1 - b.y0;
  const tw = rect.x1 - rect.x0, th = rect.y1 - rect.y0;
  const sx = gw > 1e-9 ? tw / gw : 1;
  const sy = gh > 1e-9 ? th / gh : 1;
  let s = Math.min(sx, sy);
  if (!opts.scaleUp) s = Math.min(1, s);
  const gcx = (b.x0 + b.x1) / 2, gcy = (b.y0 + b.y1) / 2;
  const tcx = (rect.x0 + rect.x1) / 2, tcy = (rect.y0 + rect.y1) / 2;
  const map = (p: Pt): Pt => ({ x: tcx + (p.x - gcx) * s, y: tcy + (p.y - gcy) * s });
  const paths: Path[] = frame.paths.map((pa) => ({ ...pa, points: pa.points.map(map) }));
  return { ...frame, paths };
}
