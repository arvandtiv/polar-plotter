// Stroke-field generator — many short line segments placed on a jittered grid (so they cover
// the wall EVENLY) at a chosen orientation: random, a smooth flow field, or aligned. Strokes can
// be hand-drawn (jitter). Built for LeWitt #86 ("ten thousand lines ~10in long, covering the wall
// evenly") and the dense organic stroke-field genre. Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom as rngOf } from "../geom";
import type { Frame, Path, Pt } from "../frame";

function curve(a: Pt, b: Pt, jitter: number, rng: () => number): Path {
  if (jitter <= 0) return { points: [a, b] };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return { points: [a, b] };
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const steps = Math.max(2, Math.round(len / 8));
  const p1 = rng() * 2 * Math.PI, amp = jitter * (0.6 + 0.5 * rng());
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, off = amp * Math.sin(Math.PI * t) * Math.sin(t * 2 * Math.PI + p1);
    pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
  }
  return { points: pts };
}

export const strokeFieldModule: Module = {
  key: "strokeField",
  label: "Stroke field",
  kind: "make",
  group: "Lines & Patterns",
  description: "A field of many short strokes covering the wall evenly (jittered grid), oriented randomly, by a smooth flow field, or aligned. Optionally hand-drawn.",
  sections: [
    { title: "Field", fields: [
      { key: "count", label: "Strokes", type: "range", min: 50, max: 2000, step: 10, default: 600 },
      { key: "length", label: "Stroke length", type: "range", min: 5, max: 120, step: 1, unit: "mm", default: 40 },
      { key: "lengthVar", label: "Length variation", type: "range", min: 0, max: 1, step: 0.05, default: 0.4 },
      { key: "spread", label: "Position jitter", type: "range", min: 0, max: 1, step: 0.05, default: 0.7 },
    ]},
    { title: "Orientation", fields: [
      { key: "orient", label: "Mode", type: "select", default: "flow", options: [
        { value: "random", label: "Random" }, { value: "flow", label: "Flow field" }, { value: "aligned", label: "Aligned" },
      ]},
      { key: "angleDeg", label: "Angle / base", type: "range", min: 0, max: 180, step: 1, unit: "°", default: 0 },
      { key: "flowScale", label: "Flow scale", type: "range", min: 0.2, max: 4, step: 0.1, default: 1.2 },
      { key: "flowSeed", label: "Flow / pos seed", type: "range", min: 0, max: 9999, step: 1, default: 5 },
    ]},
    { title: "Hand-drawn", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 12, step: 0.5, unit: "mm", default: 0 },
    ]},
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 290 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const count = Math.round(num(params, "count", 600));
    const len = num(params, "length", 40), lvar = num(params, "lengthVar", 0.4), spread = num(params, "spread", 0.7);
    const orient = String(params.orient ?? "flow");
    const base = (num(params, "angleDeg", 0) * Math.PI) / 180;
    const fScale = num(params, "flowScale", 1.2) / 100;     // → spatial frequency
    const jitter = num(params, "jitter", 0);
    const size = num(params, "size", 290), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const rng = rngOf(Math.round(num(params, "flowSeed", 5)));
    const fp1 = rng() * 6.28, fp2 = rng() * 6.28, fk = 1 + rng();   // flow field params

    const n = Math.max(2, Math.round(Math.sqrt(count)));
    const pitch = size / n;
    const paths: Path[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const px = cx - h + pitch * (i + 0.5) + (rng() - 0.5) * pitch * spread;
        const py = cy - h + pitch * (j + 0.5) + (rng() - 0.5) * pitch * spread;
        let ang: number;
        if (orient === "aligned") ang = base + (rng() - 0.5) * 0.25;
        else if (orient === "flow")
          ang = base + 1.4 * Math.sin(px * fScale * fk + py * fScale + fp1) + 0.8 * Math.sin(py * fScale * 1.7 - px * fScale + fp2);
        else ang = rng() * Math.PI;
        const L = len * (1 + lvar * (rng() * 2 - 1));
        const dx = Math.cos(ang) * L / 2, dy = Math.sin(ang) * L / 2;
        paths.push(curve({ x: px - dx, y: py - dy }, { x: px + dx, y: py + dy }, jitter, rng));
      }
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Stroke field" } };
  },
};

register(strokeFieldModule);
