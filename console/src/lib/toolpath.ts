// Toolpath optimization over a Frame — runs before compile so EVERY output (shapes,
// generators, imported G-code) plots with less pen-up travel. Geometry is never
// changed: paths are only reordered and optionally reversed. See docs/v1.3/04-*.md.

import { dist } from "./geom";
import { clonePath, type Frame, type Path, type Pt } from "./frame";

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
