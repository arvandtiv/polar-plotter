// Wobbly generator — a closed organic loop from a radial Fourier series, mirroring
// the firmware's do_draw_wobbly. Deterministic via seededRandom. Registers on import.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

export const wobblyModule: Module = {
  key: "wobbly",
  label: "Wobbly",
  kind: "make",
  group: "Lines & Patterns",
  description: "A closed random curve built from radial harmonics.",
  sections: [
    { title: "Shape", fields: [
      { key: "r", label: "Radius", type: "range", min: 5, max: 300, step: 1, unit: "mm", default: 60 },
      { key: "wobble", label: "Wobble", type: "range", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "harmonics", label: "Harmonics", type: "range", min: 1, max: 8, step: 1, default: 3 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],
  generate(params): Frame {
    const r = num(params, "r", 60);
    const wobble = num(params, "wobble", 0.4);
    const harmonics = Math.max(1, Math.min(8, Math.round(num(params, "harmonics", 3))));
    const seed = Math.round(num(params, "seed", 42));
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));

    const rng = seededRandom(seed);
    const amp: number[] = [];
    const phase: number[] = [];
    for (let h = 0; h < harmonics; h++) {
      amp.push((wobble * r / (h + 1)) * rng());
      phase.push(rng() * 2 * Math.PI);
    }

    const n = Math.max(120, Math.min(512, harmonics * 48));
    const minR = r * 0.05;
    const points: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const theta = (2 * Math.PI * i) / n;
      let rr = r;
      for (let h = 0; h < harmonics; h++) rr += amp[h] * Math.sin((h + 1) * theta + phase[h]);
      if (rr < minR) rr = minR;
      points.push({ x: cx + rr * Math.cos(theta), y: cy + rr * Math.sin(theta) });
    }
    const path: Path = { points, closed: true, cycles };
    return { widthMm: 2 * r, heightMm: 2 * r, paths: [path], meta: { title: "Wobbly" } };
  },
};

register(wobblyModule);
