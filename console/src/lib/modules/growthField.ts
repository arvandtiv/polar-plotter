// Growth-field generator — Klee's "Wachsen und Abnehmen" (growth and decrease, principle #15): a
// field of organic hand-drawn curved strokes covering the wall, each stroke's SIZE breathing along
// an axis — small → swelling to a crest → shrinking away — so repetition turns into a living tonal
// wave. Fills the wall (not sparse), curved/organic (not hatched), directional. Registers on import.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

// a short bowed (comma-like) organic stroke centred at (mx,my), length `s`, heading `th`, bow `curve`.
function stroke(mx: number, my: number, s: number, th: number, curve: number, jitter: number, rng: () => number): Pt[] {
  const dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
  const n = Math.max(4, Math.round(s / 3));
  const bowPhase = rng() * 6.28, bowAmt = curve * s * (0.7 + 0.5 * rng());
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n - 0.5;                      // -0.5..0.5 along the stroke
    const along = t * s;
    const bow = bowAmt * Math.cos(Math.PI * t + bowPhase * 0.0) * (0.25 - t * t) * 4; // bowed, 0 at ends
    pts.push({
      x: mx + dx * along + nx * bow + (rng() * 2 - 1) * jitter,
      y: my + dy * along + ny * bow + (rng() * 2 - 1) * jitter,
    });
  }
  return pts;
}

export const growthFieldModule: Module = {
  key: "growthField",
  label: "Growth field",
  kind: "make",
  group: "Lines & Patterns",
  description: "A field of organic curved strokes whose size breathes (grows then shrinks) along an axis — Klee's growth-and-decrease as a living tonal wave.",
  sections: [
    { title: "Growth", fields: [
      { key: "axisAngle", label: "Growth axis", type: "range", min: 0, max: 180, step: 5, unit: "deg", default: 90 },
      { key: "peak", label: "Crest position", type: "range", min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: "width", label: "Crest breadth", type: "range", min: 0.1, max: 0.8, step: 0.05, default: 0.32 },
      { key: "radial", label: "Radial", type: "toggle", default: false },
    ]},
    { title: "Strokes", fields: [
      { key: "spacing", label: "Spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 18 },
      { key: "sizeMin", label: "Min size", type: "range", min: 2, max: 40, step: 1, unit: "mm", default: 6 },
      { key: "sizeMax", label: "Max size", type: "range", min: 10, max: 80, step: 1, unit: "mm", default: 34 },
      { key: "curve", label: "Stroke curve", type: "range", min: 0, max: 0.6, step: 0.02, default: 0.28 },
      { key: "flowVary", label: "Orientation vary", type: "range", min: 0, max: 1.4, step: 0.05, unit: "rad", default: 0.4 },
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
    const axis = (num(params, "axisAngle", 90) * Math.PI) / 180;
    const peak = num(params, "peak", 0.5), width = num(params, "width", 0.32);
    const radial = params.radial === true;
    const spacing = Math.max(4, num(params, "spacing", 18));
    const sizeMin = num(params, "sizeMin", 6), sizeMax = Math.max(sizeMin + 1, num(params, "sizeMax", 34));
    const curve = num(params, "curve", 0.28), flowVary = num(params, "flowVary", 0.4);
    const jitter = num(params, "jitter", 1.2);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const ax = Math.cos(axis), ay = Math.sin(axis);           // growth axis unit

    const env = (x: number, y: number): number => {
      let u: number;
      if (radial) u = Math.min(1, Math.hypot(x - cx, y - cy) / h);
      else u = ((x - (cx - h)) * ax + (y - (cy - h)) * ay) / (2 * h); // 0..1 along axis
      return Math.exp(-0.5 * ((u - peak) / width) ** 2);      // swell to crest, shrink away
    };

    const paths: Path[] = [];
    const baseTh = axis + Math.PI / 2;                         // strokes lie across the growth axis
    for (let gx = cx - h; gx <= cx + h; gx += spacing)
      for (let gy = cy - h; gy <= cy + h; gy += spacing) {
        const jx = gx + (rng() * 2 - 1) * spacing * 0.35, jy = gy + (rng() * 2 - 1) * spacing * 0.35;
        if (jx < cx - h || jx > cx + h || jy < cy - h || jy > cy + h) continue;
        const s = sizeMin + (sizeMax - sizeMin) * env(jx, jy);
        const th = baseTh + (rng() * 2 - 1) * flowVary;
        paths.push({ points: stroke(jx, jy, s, th, curve, jitter, rng) });
      }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Growth field" } };
  },
};

register(growthFieldModule);
