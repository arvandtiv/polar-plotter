// Branching generator — organic dendritic GROWTH that fills the wall: trees / coral / river-delta /
// veins. Grows from an origin, splits into an irregular number of children at irregular angles with
// hand-drawn curved segments and shrinking length, so it reads as living growth (never a mechanical
// symmetric fractal). Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

type Node = { x: number; y: number; ang: number; len: number; gen: number };

export const branchingModule: Module = {
  key: "branching",
  label: "Branching",
  kind: "make",
  group: "Lines & Patterns",
  description: "Organic dendritic growth (tree / coral / delta / veins) that fills the wall — irregular splits, hand-drawn curved branches, shrinking length.",
  sections: [
    { title: "Growth", fields: [
      { key: "origin", label: "Grows from", type: "select", default: "bottom", options: [
        { value: "bottom", label: "Bottom (up)" },
        { value: "top", label: "Top (down)" },
        { value: "left", label: "Left (right)" },
        { value: "center", label: "Centre (radial)" },
      ]},
      { key: "roots", label: "Roots / seeds", type: "range", min: 1, max: 12, step: 1, default: 3 },
      { key: "depth", label: "Generations", type: "range", min: 3, max: 10, step: 1, default: 7 },
      { key: "initLen", label: "First length", type: "range", min: 20, max: 140, step: 2, unit: "mm", default: 66 },
      { key: "decay", label: "Length decay", type: "range", min: 0.5, max: 0.92, step: 0.02, default: 0.72 },
    ]},
    { title: "Split", fields: [
      { key: "spread", label: "Branch spread", type: "range", min: 0.1, max: 1.4, step: 0.05, unit: "rad", default: 0.6 },
      { key: "tropism", label: "Grow-direction pull", type: "range", min: 0, max: 0.6, step: 0.05, default: 0.15 },
      { key: "curve", label: "Branch curve", type: "range", min: 0, max: 0.8, step: 0.05, default: 0.25 },
      { key: "coreR", label: "Core scatter (radial)", type: "range", min: 0, max: 80, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Hand", fields: [
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 6, step: 0.5, unit: "mm", default: 1.2 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
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
    const origin = String(params.origin ?? "bottom");
    const roots = Math.max(1, Math.round(num(params, "roots", 3)));
    const depth = Math.max(1, Math.round(num(params, "depth", 7)));
    const initLen = num(params, "initLen", 66), decay = num(params, "decay", 0.72);
    const spread = num(params, "spread", 0.6), tropism = num(params, "tropism", 0.15);
    const curve = num(params, "curve", 0.25), jitter = num(params, "jitter", 1.2);
    const coreR = num(params, "coreR", 0);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));

    // a curved hand-drawn branch segment; returns its polyline + end point/heading
    const segment = (x: number, y: number, ang: number, len: number): { pts: Pt[]; ex: number; ey: number; ea: number } => {
      const steps = Math.max(3, Math.round(len / 6));
      const drift = curve * (rng() * 2 - 1);
      let a = ang, px = x, py = y;
      const pts: Pt[] = [{ x, y }];
      for (let i = 1; i <= steps; i++) {
        a += drift / steps;
        px += Math.cos(a) * (len / steps) + (rng() * 2 - 1) * jitter * 0.25;
        py += Math.sin(a) * (len / steps) + (rng() * 2 - 1) * jitter * 0.25;
        pts.push({ x: px, y: py });
      }
      return { pts, ex: px, ey: py, ea: a };
    };

    // seed nodes
    const stack: Node[] = [];
    const growDir: Record<string, number> = { bottom: -Math.PI / 2, top: Math.PI / 2, left: 0, center: 0 };
    for (let i = 0; i < roots; i++) {
      let x = cx, y = cy, ang = growDir[origin] ?? -Math.PI / 2;
      const f = roots === 1 ? 0.5 : (i + 0.5) / roots;
      if (origin === "bottom") { x = cx - h + f * 2 * h; y = cy + h; }
      else if (origin === "top") { x = cx - h + f * 2 * h; y = cy - h; }
      else if (origin === "left") { x = cx - h; y = cy - h + f * 2 * h; }
      else {
        // radial: scatter roots across a small core disc, each heading outward → a dense messy
        // core with arms spraying out (a real splat), instead of a hollow hub of even spokes.
        const rr = Math.sqrt(rng()) * coreR;
        const th = rng() * 2 * Math.PI;
        x = cx + Math.cos(th) * rr;
        y = cy + Math.sin(th) * rr;
        ang = coreR > 0.001 ? th + (rng() * 2 - 1) * 0.5 : f * 2 * Math.PI;
      }
      stack.push({ x, y, ang: ang + (rng() * 2 - 1) * 0.2, len: initLen, gen: 0 });
    }
    const gd = growDir[origin] ?? -Math.PI / 2;

    const paths: Path[] = [];
    let guard = 0;
    while (stack.length && guard++ < 200000) {
      const nd = stack.pop()!;
      if (nd.gen > depth || nd.len < 5) continue;
      const seg = segment(nd.x, nd.y, nd.ang, nd.len);
      paths.push({ points: seg.pts });
      const nch = rng() < 0.55 ? 2 : 3;                    // irregular split count
      for (let k = 0; k < nch; k++) {
        const base = seg.ea + spread * ((k + 0.5) / nch * 2 - 1) + (rng() * 2 - 1) * 0.28;
        // gentle pull toward the global growth direction (radial: skip)
        const pulled = origin === "center" ? base : base + tropism * Math.atan2(Math.sin(gd - base), Math.cos(gd - base));
        stack.push({ x: seg.ex, y: seg.ey, ang: pulled, len: nd.len * decay * (0.8 + 0.4 * rng()), gen: nd.gen + 1 });
      }
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Branching" } };
  },
};

register(branchingModule);
