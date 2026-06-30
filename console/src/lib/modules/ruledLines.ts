// Ruled-lines generator — fills a rectangular region with evenly-spaced STRAIGHT parallel
// lines in any combination of the four LeWitt directions (vertical, horizontal, and the two
// diagonals), superimposed. This is the workhorse for Sol LeWitt's line-direction wall
// drawings (#11, #16, #17, #19, #47, #56, #85 …): "kinds of lines" = these four directions.
// Registers on import. Pure; diagonals are clipped to the region with clipSegmentToRect.

import { register, num, type Module } from "../registry";
import { clipSegmentToRect, seededRandom } from "../geom";
import type { Frame, Path } from "../frame";

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Parallel lines through `rect` at angle `theta` (screen coords, y-down), spaced `spacing`.
 *  `jitter` > 0 makes them NOT straight: each line is resampled and pushed sideways by smooth
 *  seeded noise (a hand-drawn / Klee "living line" quality). `rng` is shared for determinism. */
function ruledDir(rect: Rect, theta: number, spacing: number, jitter: number, rng: () => number): Path[] {
  const s = Math.max(0.5, spacing);
  const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
  const dx = Math.cos(theta), dy = Math.sin(theta);     // line direction
  const nx = -Math.sin(theta), ny = Math.cos(theta);    // perpendicular (offset axis)
  // project corners onto the normal to find the band of offsets the rect occupies
  let omin = Infinity, omax = -Infinity;
  for (const [x, y] of [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]]) {
    const o = (x - cx) * nx + (y - cy) * ny;
    if (o < omin) omin = o;
    if (o > omax) omax = o;
  }
  const L = (rect.x1 - rect.x0) + (rect.y1 - rect.y0) + 10;   // long enough to span, then clip
  const out: Path[] = [];
  for (let o = Math.ceil(omin / s) * s; o <= omax + 1e-9; o += s) {
    const bx = cx + o * nx, by = cy + o * ny;
    const seg = clipSegmentToRect({ x: bx - L * dx, y: by - L * dy }, { x: bx + L * dx, y: by + L * dy }, rect);
    if (!seg) continue;
    if (jitter <= 0) { out.push({ points: [seg[0], seg[1]] }); continue; }
    // not-straight: resample the clipped segment and offset interior points perpendicular by a
    // smooth two-harmonic wave (random amp/phase per line) — endpoints stay on the rect edge.
    const [a, b] = seg;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.round(len / 5));
    const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
    const k1 = 1 + Math.floor(rng() * 2), k2 = 2 + Math.floor(rng() * 3);
    const amp = jitter * (0.7 + 0.6 * rng());
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const env = Math.sin(Math.PI * t);   // taper to 0 at both ends so lines meet the edges
      const off = amp * env * (0.6 * Math.sin(t * k1 * 2 * Math.PI + p1) + 0.4 * Math.sin(t * k2 * 2 * Math.PI + p2));
      pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
    }
    out.push({ points: pts });
  }
  return out;
}

export const ruledLinesModule: Module = {
  key: "ruledLines",
  label: "Ruled lines",
  kind: "make",
  group: "Lines & Patterns",
  description: "Straight parallel lines filling a rectangle, in any mix of the four LeWitt directions (│ ─ ╱ ╲), superimposed.",
  sections: [
    { title: "Region", fields: [
      { key: "w", label: "Width", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 150 },
      { key: "h", label: "Height", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 150 },
      { key: "spacing", label: "Line spacing", type: "range", min: 2, max: 40, step: 0.5, unit: "mm", default: 12 },
    ]},
    { title: "Directions", fields: [
      { key: "vertical", label: "Vertical │", type: "toggle", default: true },
      { key: "horizontal", label: "Horizontal ─", type: "toggle", default: true },
      { key: "diagRight", label: "Diagonal ╱", type: "toggle", default: false },
      { key: "diagLeft", label: "Diagonal ╲", type: "toggle", default: false },
    ]},
    { title: "Hand-drawn (not straight)", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 20, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const w = num(params, "w", 150), h = num(params, "h", 150);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const spacing = num(params, "spacing", 12);
    const jitter = num(params, "jitter", 0);
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7)));
    const rect: Rect = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    const paths: Path[] = [];
    if (params.horizontal !== false) paths.push(...ruledDir(rect, 0, spacing, jitter, rng));            // ─
    if (params.vertical !== false) paths.push(...ruledDir(rect, Math.PI / 2, spacing, jitter, rng));     // │
    if (params.diagRight) paths.push(...ruledDir(rect, -Math.PI / 4, spacing, jitter, rng));             // ╱
    if (params.diagLeft) paths.push(...ruledDir(rect, Math.PI / 4, spacing, jitter, rng));               // ╲
    return { widthMm: w, heightMm: h, paths, meta: { title: "Ruled lines" } };
  },
};

register(ruledLinesModule);
