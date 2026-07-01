// Scribble generator — hand-made looping scribble marks whose DENSITY follows a tonal form, so a
// soft graphite-like tone emerges from denser scribbling (LeWitt's late "Scribbles" series, e.g.
// #1185 "Inverted curve"). Each mark is an irregular random-walk squiggle (never a regular wave —
// that would read mechanical); marks are placed by rejection sampling against the tonal field, so
// the form appears where scribbling is dense and open negative space remains where it is light.
// Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

// tonal field T(x,y) in [0,1] (1 = darkest). "invertedCurveH": a horizontal inverted arch (∩) —
// the dark band peaks UP in the middle and drops toward the sides; open above and below it.
function toneFn(form: string, x: number, y: number, cx: number, cy: number, h: number, archH: number, sigma: number): number {
  const u = (x - (cx - h)) / (2 * h);            // 0..1 left→right
  if (form === "gradientV") return Math.min(1, Math.max(0, (y - (cy - h)) / (2 * h)));
  if (form === "band") {
    const d = (y - cy) / sigma; return Math.exp(-0.5 * d * d);
  }
  // invertedCurveH (default): dark along an inverted arch
  const archY = cy - archH * h * (1 - Math.pow(2 * u - 1, 2));
  const d = (y - archY) / sigma;
  return Math.exp(-0.5 * d * d);
}

// one irregular looping scribble mark: a short random walk with wandering heading (curls/loops).
function squiggle(px: number, py: number, size: number, loops: number, jitter: number, rng: () => number): Pt[] {
  const steps = Math.max(4, Math.round(loops));
  const stepLen = size / 3.2;
  let x = px, y = py, th = rng() * 2 * Math.PI;
  const pts: Pt[] = [{ x, y }];
  for (let i = 0; i < steps; i++) {
    th += (rng() * 2 - 1) * 1.15;                 // strong heading wander → loops, never periodic
    x += Math.cos(th) * stepLen + (rng() * 2 - 1) * jitter * 0.3;
    y += Math.sin(th) * stepLen + (rng() * 2 - 1) * jitter * 0.3;
    pts.push({ x, y });
  }
  return pts;
}

export const scribbleModule: Module = {
  key: "scribble",
  label: "Scribble",
  kind: "make",
  group: "Lines & Patterns",
  description: "Hand-made looping scribble marks whose density forms a tonal shape (e.g. an inverted curve). Open, gestural, never mechanical.",
  sections: [
    { title: "Form", fields: [
      { key: "form", label: "Tonal form", type: "select", default: "invertedCurveH", options: [
        { value: "invertedCurveH", label: "Inverted curve (horizontal)" },
        { value: "band", label: "Horizontal band" },
        { value: "gradientV", label: "Vertical gradient" },
      ]},
      { key: "archH", label: "Arch height", type: "range", min: 0, max: 0.9, step: 0.05, default: 0.45 },
      { key: "sigma", label: "Band width", type: "range", min: 10, max: 160, step: 1, unit: "mm", default: 55 },
    ]},
    { title: "Scribble", fields: [
      { key: "marks", label: "Marks", type: "range", min: 20, max: 900, step: 10, default: 260 },
      { key: "markSize", label: "Mark size", type: "range", min: 4, max: 60, step: 1, unit: "mm", default: 16 },
      { key: "loops", label: "Loopiness", type: "range", min: 4, max: 24, step: 1, default: 10 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 12, step: 0.5, unit: "mm", default: 3 },
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
    const form = String(params.form ?? "invertedCurveH");
    const archH = num(params, "archH", 0.45), sigma = num(params, "sigma", 55);
    const marks = Math.max(1, Math.round(num(params, "marks", 260)));
    const markSize = num(params, "markSize", 16);
    const loops = num(params, "loops", 10);
    const jitter = num(params, "jitter", 3);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));

    const paths: Path[] = [];
    let placed = 0, attempts = 0, maxAttempts = marks * 40;
    while (placed < marks && attempts < maxAttempts) {
      attempts++;
      const px = cx - h + rng() * 2 * h;
      const py = cy - h + rng() * 2 * h;
      // rejection sampling against the tonal field → marks concentrate where the form is dark,
      // leaving open negative space where it is light.
      if (rng() > toneFn(form, px, py, cx, cy, h, archH, sigma)) continue;
      paths.push({ points: squiggle(px, py, markSize, loops, jitter, rng) });
      placed++;
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Scribble" } };
  },
};

register(scribbleModule);
