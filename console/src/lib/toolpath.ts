// Toolpath optimization over a Frame — runs before compile so EVERY output (shapes,
// generators, imported G-code) plots with less pen-up travel. Geometry is never
// changed: paths are only reordered and optionally reversed. See docs/v1.3/04-*.md.

import { dist, simplifyRDP, polylineLength } from "./geom";
import { clonePath, type Frame, type Path, type Pt } from "./frame";

// total drawn length of a path (incl. the closing segment for closed paths)
function pathLength(p: Path): number {
  let len = polylineLength(p.points);
  if (p.closed && p.points.length > 2) len += dist(p.points[p.points.length - 1], p.points[0]);
  return len;
}

/** Reveal the toolpath up to `pct` (0..1) of its total drawn length — preview scrubber.
 *  Pure; does not change what gets streamed. */
export function buildProgressPaths(frame: Frame, pct: number): Frame {
  if (pct >= 1) return frame;
  if (pct <= 0) return { ...frame, paths: [] };
  const total = frame.paths.reduce((s, p) => s + pathLength(p), 0);
  let budget = total * pct;
  const out: Path[] = [];
  for (const p of frame.paths) {
    const len = pathLength(p);
    if (budget >= len) { out.push(p); budget -= len; continue; }
    if (budget <= 1e-6) break;
    const ring = p.closed && p.points.length > 2 ? [...p.points, p.points[0]] : p.points;
    const partial: Pt[] = [{ ...ring[0] }];
    let acc = 0;
    for (let i = 1; i < ring.length; i++) {
      const d = dist(ring[i - 1], ring[i]);
      if (acc + d >= budget) {
        const t = d > 1e-9 ? (budget - acc) / d : 0;
        partial.push({ x: ring[i - 1].x + (ring[i].x - ring[i - 1].x) * t, y: ring[i - 1].y + (ring[i].y - ring[i - 1].y) * t });
        break;
      }
      partial.push({ ...ring[i] }); acc += d;
    }
    if (partial.length >= 2) out.push({ points: partial });
    break;
  }
  return { ...frame, paths: out };
}

/** Simplify every path in the frame (RDP) within `tol` mm. Default 0.2 mm (sub-pen).
 *  Closed paths keep their closure flag; fewer points → fewer firmware jobs. */
export function simplifyFrame(frame: Frame, tol = 0.2): Frame {
  if (tol <= 0) return frame;
  const paths: Path[] = frame.paths.map((p) =>
    p.points.length > 2 ? { ...p, points: simplifyRDP(p.points, tol) } : clonePath(p));
  return { ...frame, paths };
}

const ORIGIN: Pt = { x: 0, y: 0 };

/** Sum of pen-up gaps between consecutive paths, starting from `start`. */
export function travelDistance(frame: Frame, start: Pt = ORIGIN): number {
  let cur = start;
  let total = 0;
  for (const p of frame.paths) {
    if (!p.points.length) continue;
    total += dist(cur, p.points[0]);
    cur = p.points[p.points.length - 1];
  }
  return total;
}

/**
 * Greedy nearest-neighbour reordering: from the current pen point repeatedly pick the
 * path whose nearest endpoint (start OR end) is closest, reversing it if its end was
 * nearer. Deterministic (ties: lowest path index, start preferred over end — the same
 * rules as the original O(n²) scan).
 *
 * Accelerated with a uniform spatial grid over path endpoints: each pick searches
 * expanding cell rings around the pen and stops once no unsearched ring can beat the
 * best candidate — ~O(n) in practice vs the old O(n²) full scan + O(n) splice, which
 * took seconds on >10k-path artworks and froze the UI on every param change.
 */
export function optimizeOrder(frame: Frame, start: Pt = ORIGIN): Frame {
  const paths = frame.paths.filter((p) => p.points.length > 0).map(clonePath);
  const n = paths.length;
  if (n < 2) return { ...frame, paths };

  // endpoint records: 2 per path (start, end)
  const ex = new Float64Array(2 * n), ey = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    const pts = paths[k].points;
    ex[2 * k] = pts[0].x;                  ey[2 * k] = pts[0].y;
    ex[2 * k + 1] = pts[pts.length - 1].x; ey[2 * k + 1] = pts[pts.length - 1].y;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 2 * n; i++) {
    if (ex[i] < x0) x0 = ex[i]; if (ex[i] > x1) x1 = ex[i];
    if (ey[i] < y0) y0 = ey[i]; if (ey[i] > y1) y1 = ey[i];
  }
  const span = Math.max(x1 - x0, y1 - y0, 1e-6);
  const cell = Math.max(1e-6, span / Math.max(4, Math.ceil(Math.sqrt(n))));
  const cols = Math.floor((x1 - x0) / cell) + 1;
  const rows = Math.floor((y1 - y0) / cell) + 1;
  const gx = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - x0) / cell)));
  const gy = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / cell)));
  const grid: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < 2 * n; i++) grid[gy(ey[i]) * cols + gx(ex[i])].push(i);

  const used = new Uint8Array(n);
  const ordered: Path[] = [];
  let cx = start.x, cy = start.y;

  for (let picked = 0; picked < n; picked++) {
    let bestK = -1, bestRev = false, bestD2 = Infinity;
    const consider = (i: number) => {
      const k = i >> 1;
      if (used[k]) return;
      const dx = ex[i] - cx, dy = ey[i] - cy;
      const d2 = dx * dx + dy * dy;
      const rev = (i & 1) === 1;
      // strict-< scan-order tie rules of the original implementation
      if (d2 < bestD2 || (d2 === bestD2 && bestK >= 0 && (k < bestK || (k === bestK && !rev && bestRev)))) {
        bestD2 = d2; bestK = k; bestRev = rev;
      }
    };
    const cgx = gx(cx), cgy = gy(cy);
    for (let r = 0; r < Math.max(cols, rows); r++) {
      // any endpoint in ring r is at least (r-1)·cell away — stop once that can't win
      if (bestK >= 0 && (r - 1) * cell > Math.sqrt(bestD2)) break;
      const xa = cgx - r, xb = cgx + r, ya = cgy - r, yb = cgy + r;
      for (let X = Math.max(0, xa); X <= Math.min(cols - 1, xb); X++) {
        for (let Y = Math.max(0, ya); Y <= Math.min(rows - 1, yb); Y++) {
          if (r > 0 && X !== xa && X !== xb && Y !== ya && Y !== yb) continue;   // ring shell only
          for (const i of grid[Y * cols + X]) consider(i);
        }
      }
    }
    const chosen = paths[bestK];
    used[bestK] = 1;
    if (bestRev) chosen.points.reverse();
    ordered.push(chosen);
    const last = chosen.points[chosen.points.length - 1];
    cx = last.x; cy = last.y;
  }

  return { ...frame, paths: ordered };
}
