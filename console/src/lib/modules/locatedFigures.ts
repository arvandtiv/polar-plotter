// Located-figures generator — places several irregular figures (trapezoids) at asymmetric
// locations and draws a hand-drawn "location web": not-straight lines from the NEAREST
// architectural anchor points (corners / edge midpoints / centre) to each figure's vertices,
// the way LeWitt's "location of a figure" pieces fix a shape by measured construction lines.
// Built for #237 (trapezoid), #238 (parallelogram), #274 (six figures). Registers on import. Pure.
//
// Executed through the governing organic lens: figures are placed asymmetrically, vertices are
// hand-skewed (irregular), and every line is not-straight. Density is CAPPED (each figure links to
// only its nearest few anchors, each anchor to its nearest few vertices) so no anchor/corner ever
// saturates — respecting the paper-rip limit.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

function anchorsFor(preset: string, h: number, cx: number, cy: number): Pt[] {
  const C: Pt[] = [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
  const M: Pt[] = [{ x: cx, y: cy - h }, { x: cx + h, y: cy }, { x: cx, y: cy + h }, { x: cx - h, y: cy }];
  const center: Pt = { x: cx, y: cy };
  switch (preset) {
    case "corners": return C;
    case "cornersMid": return [...C, ...M];
    case "cornersMidCenter": return [...C, ...M, center];
    default: return [...C, ...M, center];
  }
}

/** Straight-or-hand-drawn line a→b (endpoints fixed, interior offset by a smooth seeded wave). */
function joinLine(a: Pt, b: Pt, jitter: number, rng: () => number): Path {
  if (jitter <= 0) return { points: [a, b] };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return { points: [a, b] };
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
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

/** An irregular figure — a trapezoid (parallel top/bottom of differing widths) or a sheared
 *  parallelogram (`shear` = horizontal shear factor k, x += k·y) — rotated and each vertex
 *  hand-skewed for a hand-placed, organic look. */
function figureVerts(kind: string, fx: number, fy: number, w: number, hgt: number, topRatio: number, ang: number, shear: number, skew: number, rng: () => number): Pt[] {
  const hy = hgt / 2, bw = w / 2;
  let base: Pt[];
  if (kind === "parallelogram") {
    const k = shear;
    base = [{ x: -bw - k * hy, y: -hy }, { x: bw - k * hy, y: -hy }, { x: bw + k * hy, y: hy }, { x: -bw + k * hy, y: hy }];
  } else if (kind === "irregular") {
    // a hand-built irregular angular polygon: 5–8 vertices at jittered angles and strongly varied
    // radii, so no two edges match — asymmetric, not a tidy regular polygon.
    const n = 5 + Math.floor(rng() * 4);
    const angles: number[] = [];
    for (let i = 0; i < n; i++) angles.push((2 * Math.PI * i) / n + (rng() * 2 - 1) * (Math.PI / n) * 0.85);
    angles.sort((a, b) => a - b);
    base = angles.map((a) => {
      const r = bw * (0.45 + rng() * 0.8);
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    });
  } else {
    const tw = (w * topRatio) / 2;
    base = [{ x: -tw, y: -hy }, { x: tw, y: -hy }, { x: bw, y: hy }, { x: -bw, y: hy }];
  }
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return base.map((p) => ({
    x: fx + (p.x * ca - p.y * sa) + (rng() * 2 - 1) * skew,
    y: fy + (p.x * sa + p.y * ca) + (rng() * 2 - 1) * skew,
  }));
}

export const locatedFiguresModule: Module = {
  key: "locatedFigures",
  label: "Located figures",
  kind: "make",
  group: "Lines & Patterns",
  description: "Irregular trapezoids placed asymmetrically, each fixed by a hand-drawn 'location web' of not-straight lines to the nearest architectural anchor points. Density-capped so no corner saturates.",
  sections: [
    { title: "Figures", fields: [
      { key: "figure", label: "Figure", type: "select", default: "trapezoid", options: [
        { value: "trapezoid", label: "Trapezoid" },
        { value: "parallelogram", label: "Parallelogram" },
        { value: "irregular", label: "Irregular polygon" },
      ]},
      { key: "count", label: "Figures", type: "range", min: 1, max: 12, step: 1, default: 4 },
      { key: "sizeMin", label: "Min size", type: "range", min: 20, max: 150, step: 1, unit: "mm", default: 45 },
      { key: "sizeMax", label: "Max size", type: "range", min: 30, max: 220, step: 1, unit: "mm", default: 95 },
      { key: "shear", label: "Shear (parallelogram)", type: "range", min: 0, max: 1.5, step: 0.05, default: 0.6 },
      { key: "rotMax", label: "Orientation spread", type: "range", min: 0, max: 1.2, step: 0.05, unit: "rad", default: 0.5 },
      { key: "skew", label: "Vertex skew", type: "range", min: 0, max: 30, step: 1, unit: "mm", default: 6 },
      { key: "cluster", label: "Cluster", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
      { key: "figSeed", label: "Placement seed", type: "range", min: 0, max: 9999, step: 1, default: 5 },
    ]},
    { title: "Location web", fields: [
      { key: "anchors", label: "Anchor points", type: "select", default: "cornersMidCenter", options: [
        { value: "corners", label: "4 corners" },
        { value: "cornersMid", label: "Corners + midpoints" },
        { value: "cornersMidCenter", label: "Corners + midpoints + center" },
      ]},
      { key: "anchorsPerFigure", label: "Anchors per figure", type: "range", min: 1, max: 9, step: 1, default: 3 },
      { key: "vertsPerAnchor", label: "Verts per anchor", type: "range", min: 1, max: 4, step: 1, default: 2 },
    ]},
    { title: "Hand-drawn (not straight)", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 16, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    ]},
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 280 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const size = num(params, "size", 280), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const kind = String(params.figure ?? "trapezoid");
    const count = Math.max(1, Math.round(num(params, "count", 4)));
    const sizeMin = num(params, "sizeMin", 45), sizeMax = Math.max(sizeMin + 1, num(params, "sizeMax", 95));
    const shear = num(params, "shear", 0.6), rotMax = num(params, "rotMax", 0.5);
    const skew = num(params, "skew", 6);
    const anchors = anchorsFor(String(params.anchors ?? "cornersMidCenter"), h, cx, cy);
    const anchorsPerFigure = Math.max(1, Math.round(num(params, "anchorsPerFigure", 3)));
    const vertsPerAnchor = Math.max(1, Math.round(num(params, "vertsPerAnchor", 2)));
    const jitter = num(params, "jitter", 0);
    const frng = seededRandom(Math.round(num(params, "figSeed", 5)));   // placement/shape
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7))); // line wobble
    const margin = Math.min(h * 0.7, sizeMax * 0.6);

    // placement region: full frame by default; `cluster` shrinks it and shoves it to an asymmetric
    // off-centre spot, so the figures group into a dense knot with open wall around them.
    const cluster = num(params, "cluster", 0);
    let ccx = cx, ccy = cy, pr = h - margin;
    if (cluster > 0) {
      const oang = frng() * 2 * Math.PI, offR = (h - margin) * 0.55 * cluster;
      ccx = cx + Math.cos(oang) * offR;
      ccy = cy + Math.sin(oang) * offR;
      pr = (h - margin) * (1 - 0.55 * cluster);
    }

    // place the figures asymmetrically within the placement region
    const figs: { c: Pt; verts: Pt[] }[] = [];
    for (let i = 0; i < count; i++) {
      const w = sizeMin + frng() * (sizeMax - sizeMin);
      const hgt = (sizeMin + frng() * (sizeMax - sizeMin)) * 0.75;
      const topRatio = 0.35 + frng() * 0.55;
      const ang = (frng() * 2 - 1) * rotMax;
      const fx = ccx - pr + frng() * (2 * pr);
      const fy = ccy - pr + frng() * (2 * pr);
      figs.push({ c: { x: fx, y: fy }, verts: figureVerts(kind, fx, fy, w, hgt, topRatio, ang, shear, skew, frng) });
    }

    const paths: Path[] = [];
    // figure outlines (each edge hand-drawn)
    for (const f of figs)
      for (let k = 0; k < f.verts.length; k++) paths.push(joinLine(f.verts[k], f.verts[(k + 1) % f.verts.length], jitter, rng));
    // location web: nearest anchors → nearest vertices, capped so no anchor saturates
    const d2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    for (const f of figs) {
      const near = [...anchors].sort((a, b) => d2(a, f.c) - d2(b, f.c)).slice(0, anchorsPerFigure);
      for (const a of near) {
        const vs = [...f.verts].sort((p, q) => d2(a, p) - d2(a, q)).slice(0, vertsPerAnchor);
        for (const v of vs) paths.push(joinLine(a, v, jitter, rng));
      }
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Located figures" } };
  },
};

register(locatedFiguresModule);
