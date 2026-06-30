// Connect-dots generator — places a set of "architectural points" and joins ALL pairs with
// straight lines (a complete-graph web). Built for LeWitt #51 ("all architectural points
// connected by straight lines") and the string-art / network genre generally. Lines can be
// hand-drawn (jitter). Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

function pointsFor(preset: string, h: number, cx: number, cy: number, count: number, seed: number): Pt[] {
  const C: Pt[] = [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
  const M: Pt[] = [{ x: cx, y: cy - h }, { x: cx + h, y: cy }, { x: cx, y: cy + h }, { x: cx - h, y: cy }];
  const center: Pt = { x: cx, y: cy };
  switch (preset) {
    case "corners": return C;
    case "cornersCenter": return [...C, center];
    case "cornersMid": return [...C, ...M];
    case "cornersMidCenter": return [...C, ...M, center];
    case "perimeter": {
      const n = Math.max(3, Math.round(count));
      const side = 2 * h, total = 4 * side, out: Pt[] = [];
      for (let k = 0; k < n; k++) {
        let d = (k * total) / n;
        if (d < side) out.push({ x: cx - h + d, y: cy - h });
        else if (d < 2 * side) { d -= side; out.push({ x: cx + h, y: cy - h + d }); }
        else if (d < 3 * side) { d -= 2 * side; out.push({ x: cx + h - d, y: cy + h }); }
        else { d -= 3 * side; out.push({ x: cx - h, y: cy + h - d }); }
      }
      return out;
    }
    case "grid": {
      const m = Math.max(2, Math.round(count)), out: Pt[] = [];
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++)
        out.push({ x: cx - h + (2 * h * i) / (m - 1), y: cy - h + (2 * h * j) / (m - 1) });
      return out;
    }
    case "random": {
      const n = Math.max(3, Math.round(count)), rng = seededRandom(seed), out: Pt[] = [];
      for (let k = 0; k < n; k++) out.push({ x: cx - h + rng() * 2 * h, y: cy - h + rng() * 2 * h });
      return out;
    }
    default: return C;
  }
}

/** Straight (or hand-drawn) line a→b. */
function joinLine(a: Pt, b: Pt, jitter: number, rng: () => number): Path {
  if (jitter <= 0) return { points: [a, b] };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return { points: [a, b] };
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;   // unit perpendicular
  const steps = Math.max(2, Math.round(len / 8));
  const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
  const k1 = 1 + Math.floor(rng() * 2), k2 = 2 + Math.floor(rng() * 2);
  const amp = jitter * (0.7 + 0.6 * rng());
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, env = Math.sin(Math.PI * t);
    const off = amp * env * (0.6 * Math.sin(t * k1 * 2 * Math.PI + p1) + 0.4 * Math.sin(t * k2 * 2 * Math.PI + p2));
    pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
  }
  return { points: pts };
}

export const connectDotsModule: Module = {
  key: "connectDots",
  label: "Connect dots",
  kind: "make",
  group: "Lines & Patterns",
  description: "Places architectural points (corners / midpoints / perimeter / grid / random) and joins every pair with a straight (or hand-drawn) line — a complete-graph web.",
  sections: [
    { title: "Points", fields: [
      { key: "preset", label: "Point set", type: "select", default: "cornersMidCenter", options: [
        { value: "corners", label: "4 corners" },
        { value: "cornersCenter", label: "Corners + center" },
        { value: "cornersMid", label: "Corners + edge midpoints" },
        { value: "cornersMidCenter", label: "Corners + midpoints + center" },
        { value: "perimeter", label: "Perimeter (count)" },
        { value: "grid", label: "Grid (count × count)" },
        { value: "random", label: "Random (count)" },
      ]},
      { key: "count", label: "Count", type: "range", min: 3, max: 24, step: 1, default: 12 },
      { key: "pointSeed", label: "Point seed", type: "range", min: 0, max: 9999, step: 1, default: 3 },
    ]},
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 260 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Hand-drawn (not straight)", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 16, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    ]},
  ],
  generate(params): Frame {
    const size = num(params, "size", 260), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const pts = pointsFor(String(params.preset ?? "cornersMidCenter"), h, cx, cy,
      num(params, "count", 12), Math.round(num(params, "pointSeed", 3)));
    const jitter = num(params, "jitter", 0);
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7)));
    const paths: Path[] = [];
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        paths.push(joinLine(pts[i], pts[j], jitter, rng));
    return { widthMm: size, heightMm: size, paths, meta: { title: "Connect dots" } };
  },
};

register(connectDotsModule);
