// Clip polylines to a polygon region — the correct operation for a pen plotter, whose
// geometry is mostly OPEN strokes (a polygon-area boolean lib can't do this). Pure.
// Used by the Shape Mask modifier; reusable for any region-based keep/remove.

import type { Pt } from "./frame";

/** Ray-casting point-in-polygon (poly = ring of points, implicitly closed). */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > p.y) !== (b.y > p.y)) &&
        (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)) {
      inside = !inside;
    }
  }
  return inside;
}

// Parameter t along p→q where it crosses segment a→b, or null if they don't.
function segCrossT(p: Pt, q: Pt, a: Pt, b: Pt): number | null {
  const rx = q.x - p.x, ry = q.y - p.y;
  const sx = b.x - a.x, sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
  const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/**
 * Split a polyline at every crossing of `poly`'s edges and keep the runs whose
 * midpoint is inside (keepInside=true) or outside the polygon. Returns sub-polylines.
 */
export function clipPolylineToPolygon(points: Pt[], poly: Pt[], keepInside: boolean): Pt[][] {
  if (points.length < 2 || poly.length < 3) return [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const at = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const ts: number[] = [];
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      const t = segCrossT(a, b, poly[k], poly[j]);
      if (t !== null && t > 1e-9 && t < 1 - 1e-9) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    const cuts = [0, ...ts, 1];
    for (let c = 0; c < cuts.length - 1; c++) {
      const t0 = cuts[c], t1 = cuts[c + 1];
      const keep = pointInPolygon(at(a, b, (t0 + t1) / 2), poly) === keepInside;
      if (keep) {
        if (cur.length === 0) cur.push(at(a, b, t0));
        cur.push(at(a, b, t1));
      } else if (cur.length >= 2) {
        out.push(cur); cur = [];
      } else {
        cur = [];
      }
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}
