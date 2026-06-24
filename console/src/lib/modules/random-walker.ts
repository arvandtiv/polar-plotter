// Random Walker generator — multiple agents accumulate velocity with random perturbations,
// each drawing a continuous line until it exits the boundary.
// Algorithm: https://www.generativehut.com/post/random-walkers
//   vx += random(-velStep, +velStep)
//   vy += random(-velStep, +velStep)
//   x  += vx  ;  y += vy
//   stop when (x,y) leaves the work area.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

export const randomWalkerModule: Module = {
  key: "randomWalker",
  label: "Random Walker",
  kind: "make",
  group: "Lines & Patterns",
  description: "Agents drift with accumulating velocity, each tracing a line until they leave the canvas.",
  sections: [
    { title: "Walkers", fields: [
      { key: "count",   label: "Walkers",    type: "range", min: 1,   max: 50,    step: 1,   default: 20  },
      { key: "steps",   label: "Max steps",  type: "range", min: 100, max: 10000, step: 100, default: 2000 },
      { key: "velStep", label: "Velocity Δ", type: "range", min: 0.1, max: 5,     step: 0.1, unit: "mm", default: 0.5 },
      { key: "maxVel",  label: "Max speed",  type: "range", min: 0.5, max: 20,    step: 0.5, unit: "mm", default: 4   },
      { key: "seed",    label: "Seed",       type: "range", min: 0,   max: 9999,  step: 1,   default: 42  },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],

  generate(params, ctx): Frame {
    const count   = Math.max(1,  Math.round(num(params, "count",   20)));
    const steps   = Math.max(100, Math.round(num(params, "steps",  2000)));
    const velStep = num(params, "velStep", 0.5);
    const maxVel  = Math.max(velStep, num(params, "maxVel", 4));
    const seed    = Math.round(num(params, "seed", 42));
    const cycles  = Math.max(1, Math.round(num(params, "cycles", 1)));

    const rng = seededRandom(seed);

    const { left, right, up, down } = ctx.bounds;
    const xMin = -left, xMax = right;
    const yMin = -up,   yMax = down;
    const w = xMax - xMin, h = yMax - yMin;

    const clamp = (v: number, lo: number, hi: number) =>
      v < lo ? lo : v > hi ? hi : v;

    const paths: Path[] = [];

    for (let wi = 0; wi < count; wi++) {
      // Random start anywhere inside the work area
      let x = xMin + rng() * w;
      let y = yMin + rng() * h;
      let vx = 0, vy = 0;

      const pts: Pt[] = [{ x, y }];

      for (let s = 0; s < steps; s++) {
        // Perturb velocity by a random amount in [-velStep, +velStep]
        vx = clamp(vx + (rng() - 0.5) * 2 * velStep, -maxVel, maxVel);
        vy = clamp(vy + (rng() - 0.5) * 2 * velStep, -maxVel, maxVel);
        x += vx;
        y += vy;

        if (x < xMin || x > xMax || y < yMin || y > yMax) break;
        pts.push({ x, y });
      }

      if (pts.length > 1) paths.push({ points: pts, closed: false, cycles });
    }

    return { widthMm: w, heightMm: h, paths, meta: { title: "Random Walker" } };
  },
};

register(randomWalkerModule);
