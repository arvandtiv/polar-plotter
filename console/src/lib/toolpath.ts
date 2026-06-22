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
 * nearer. O(n²) — fine for thousands of paths. Deterministic.
 */
export function optimizeOrder(frame: Frame, start: Pt = ORIGIN): Frame {
  const remaining = frame.paths.filter((p) => p.points.length > 0).map(clonePath);
  const ordered: Path[] = [];
  let cur = start;

  while (remaining.length) {
    let best = 0, bestD = Infinity, bestRev = false;
    for (let k = 0; k < remaining.length; k++) {
      const pts = remaining[k].points;
      const ds = dist(cur, pts[0]);
      const de = dist(cur, pts[pts.length - 1]);
      if (ds < bestD) { bestD = ds; best = k; bestRev = false; }
      if (de < bestD) { bestD = de; best = k; bestRev = true; }
    }
    const chosen = remaining.splice(best, 1)[0];
    if (bestRev) chosen.points.reverse();
    ordered.push(chosen);
    cur = chosen.points[chosen.points.length - 1];
  }

  return { ...frame, paths: ordered };
}
