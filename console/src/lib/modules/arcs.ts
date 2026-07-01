// Arcs generator — concentric arcs swung from one or more centres (corners / edge midpoints /
// centre), clipped to the frame, optionally hand-drawn (radial wobble). Built for LeWitt's arc
// pieces (#130 arcs from four corners, #138 from midpoints, #462, #915). Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

type Rect = { x0: number; y0: number; x1: number; y1: number };
const inside = (p: Pt, r: Rect) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

function centresFor(preset: string, h: number, cx: number, cy: number): Pt[] {
  const C = [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
  const M = [{ x: cx, y: cy - h }, { x: cx + h, y: cy }, { x: cx, y: cy + h }, { x: cx - h, y: cy }];
  switch (preset) {
    case "corners": return C;
    case "midpoints": return M;
    case "cornersMid": return [...C, ...M];
    case "center": return [{ x: cx, y: cy }];
    default: return C;
  }
}

/** One concentric arc of radius R about `c`, clipped to `rect`, as contiguous inside-runs. */
function arcRuns(c: Pt, R: number, rect: Rect, jitter: number, rng: () => number): Path[] {
  const steps = Math.max(48, Math.round(R * 0.9));
  const p1 = rng() * 6.28, p2 = rng() * 6.28, k1 = 2 + Math.floor(rng() * 2), k2 = 3 + Math.floor(rng() * 3);
  const runs: Path[] = [];
  let cur: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    const rr = R + (jitter > 0 ? jitter * (0.6 * Math.sin(a * k1 + p1) + 0.4 * Math.sin(a * k2 + p2)) : 0);
    const p = { x: c.x + rr * Math.cos(a), y: c.y + rr * Math.sin(a) };
    if (inside(p, rect)) cur.push(p);
    else { if (cur.length > 1) runs.push({ points: cur }); cur = []; }
  }
  if (cur.length > 1) runs.push({ points: cur });
  return runs;
}

export const arcsModule: Module = {
  key: "arcs",
  label: "Arcs",
  kind: "make",
  group: "Lines & Patterns",
  description: "Concentric arcs swung from chosen centres (corners / edge midpoints / centre), clipped to the frame. Optionally hand-drawn.",
  sections: [
    { title: "Arcs", fields: [
      { key: "centres", label: "Swung from", type: "select", default: "corners", options: [
        { value: "corners", label: "Four corners" },
        { value: "midpoints", label: "Edge midpoints" },
        { value: "cornersMid", label: "Corners + midpoints" },
        { value: "center", label: "Centre" },
      ]},
      { key: "count", label: "Arcs per centre", type: "range", min: 1, max: 40, step: 1, default: 12 },
      { key: "maxR", label: "Max radius", type: "range", min: 20, max: 500, step: 5, unit: "mm", default: 300 },
    ]},
    { title: "Hand-drawn", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 16, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    ]},
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const rect: Rect = { x0: cx - h, y0: cy - h, x1: cx + h, y1: cy + h };
    const centres = centresFor(String(params.centres ?? "corners"), h, cx, cy);
    const count = Math.max(1, Math.round(num(params, "count", 12)));
    const maxR = num(params, "maxR", 300);
    const jitter = num(params, "jitter", 0);
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7)));
    const paths: Path[] = [];
    for (const c of centres)
      for (let k = 1; k <= count; k++)
        paths.push(...arcRuns(c, (k * maxR) / count, rect, jitter, rng));
    return { widthMm: size, heightMm: size, paths, meta: { title: "Arcs" } };
  },
};

register(arcsModule);
