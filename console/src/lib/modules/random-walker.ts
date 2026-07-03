// Random Walker generator — multiple agents share the same initial velocity (flow
// direction) and accumulate random perturbations, so paths begin parallel and
// slowly diverge from one another.
// Algorithm: https://www.generativehut.com/post/random-walkers
//   vx₀ = maxVel·cos(flowAngle) , vy₀ = maxVel·sin(flowAngle)
//   vx += random(-velStep, +velStep)  [clamped to ±maxVel]
//   x  += vx  ;  y += vy
//   stop when (x,y) leaves the work area.
//
// PIPE mode: the walk still wanders generatively, but the line itself is NOT drawn —
// it becomes the invisible SPINE for a series of circles laid along it, radius
// growing from rMin at the path's start to rMax at its end (a tapered tube). Each
// circle is hand-wobbled (pipeJitter) so nothing reads crisp.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import { parseSizeStops, pipeAlongSpine } from "../pipe";
import type { Frame, Path, Pt } from "../frame";

export const randomWalkerModule: Module = {
  key: "randomWalker",
  label: "Random Walker",
  kind: "make",
  group: "Lines & Patterns",
  description: "Agents drift with accumulating velocity, each tracing a line until they leave the canvas. Pipe mode draws growing circles along the invisible walk instead of the line.",
  sections: [
    { title: "Pipe", fields: [
      { key: "mode", label: "Draw as", type: "select", default: "walk", options: [
        { value: "walk", label: "Line (classic walk)" },
        { value: "pipe", label: "Pipe (circles along path)" },
      ]},
      { key: "rMin",        label: "Start radius (min r)", type: "range", min: 0.5, max: 30, step: 0.5, unit: "mm", default: 1 },
      { key: "rMax",        label: "End radius (max r)",   type: "range", min: 0.5, max: 60, step: 0.5, unit: "mm", default: 8 },
      { key: "sizeStops",   label: "Size stops", type: "text", placeholder: "e.g. 1,8,2,10  (overrides min/max)", default: "" },
      { key: "pipeSpacing", label: "Circle spacing",       type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 6 },
      { key: "pipeJitter",  label: "Hand jitter",          type: "range", min: 0,   max: 4,  step: 0.1, unit: "mm", default: 0.8 },
    ]},
    { title: "Walkers", fields: [
      { key: "count",     label: "Walkers",       type: "range", min: 1,   max: 500,   step: 1,   default: 20  },
      { key: "steps",     label: "Max steps",     type: "range", min: 100, max: 10000, step: 100, default: 2000 },
      { key: "flowAngle", label: "Flow direction", type: "range", min: 0,   max: 360,   step: 1,   unit: "°",  default: 90 },
      { key: "velStep",   label: "Divergence Δ",  type: "range", min: 0.1, max: 5,     step: 0.1, unit: "mm", default: 0.5 },
      { key: "maxVel",    label: "Max speed",     type: "range", min: 0.5, max: 20,    step: 0.5, unit: "mm", default: 4   },
      { key: "seed",      label: "Seed",          type: "range", min: 0,   max: 9999,  step: 1,   default: 42  },
    ]},
    { title: "Start line", fields: [
      { key: "x1", label: "X1", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "y1", label: "Y1", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "x2", label: "X2", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "y2", label: "Y2", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],

  generate(params, ctx): Frame {
    const count     = Math.max(1,  Math.round(num(params, "count",   20)));
    const steps     = Math.max(100, Math.round(num(params, "steps",  2000)));
    const flowAngle = num(params, "flowAngle", 90) * (Math.PI / 180);
    const velStep   = num(params, "velStep", 0.5);
    const maxVel    = Math.max(velStep, num(params, "maxVel", 4));
    const seed      = Math.round(num(params, "seed", 42));
    const x1        = num(params, "x1", 0);
    const y1        = num(params, "y1", 0);
    const x2        = num(params, "x2", 0);
    const y2        = num(params, "y2", 0);
    const cycles    = Math.max(1, Math.round(num(params, "cycles", 1)));
    const mode      = String(params.mode ?? "walk");
    const rMin      = Math.max(0.1, num(params, "rMin", 1));
    const rMax      = Math.max(0.1, num(params, "rMax", 8));
    const pipeSpacing = Math.max(0.5, num(params, "pipeSpacing", 6));
    const pipeJitter  = Math.max(0, num(params, "pipeJitter", 0.8));

    const rng = seededRandom(seed);

    const pipeOpts = {
      rMin, rMax,
      sizeStops: parseSizeStops(params.sizeStops),
      spacing: pipeSpacing,
      jitter: pipeJitter,
      rng,
    };

    // Shared initial velocity — all walkers begin heading in flowAngle.
    const vx0 = maxVel * Math.cos(flowAngle);
    const vy0 = maxVel * Math.sin(flowAngle);

    const { left, right, up, down } = ctx.bounds;
    const xMin = -left, xMax = right;
    const yMin = -up,   yMax = down;
    const w = xMax - xMin, h = yMax - yMin;

    const clamp = (v: number, lo: number, hi: number) =>
      v < lo ? lo : v > hi ? hi : v;

    const paths: Path[] = [];

    for (let wi = 0; wi < count; wi++) {
      // Pick a random position along the start line (t=0 → (x1,y1), t=1 → (x2,y2)).
      // Collapsed line (x1=x2, y1=y2) = single origin; longer line = sparser starts.
      const t = rng();
      let x = x1 + t * (x2 - x1);
      let y = y1 + t * (y2 - y1);
      let vx = vx0, vy = vy0;

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

      if (pts.length > 1) {
        if (mode === "pipe") pipeAlongSpine(pts, pipeOpts, paths, cycles);   // spine invisible — circles only
        else paths.push({ points: pts, closed: false, cycles });
      }
    }

    return { widthMm: w, heightMm: h, paths, meta: { title: mode === "pipe" ? "Random Walker — pipe" : "Random Walker" } };
  },
};

register(randomWalkerModule);
