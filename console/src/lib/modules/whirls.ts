// Whirls generator — bold organic spiraling gestures (LeWitt #1152 "Whirls and twirls"). Places a
// few hand-drawn log-spiral WHIRLS of varied size/direction plus small TWIRL flourishes, composed
// asymmetrically with open space. Each whirl is a continuous line spiralling outward with a gentle
// organic breathing + per-point hand jitter — energetic swirl, never a mechanical spirograph or a
// dense texture. Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

// one continuous log-spiral whirl about (ox,oy): r grows r0→maxR over `turns`, rotated/squashed,
// hand-wobbled. `dir` ±1 sets spin direction.
function whirl(ox: number, oy: number, r0: number, maxR: number, turns: number, dir: number, phase: number, squash: number, rot: number, jitter: number, rng: () => number): Pt[] {
  const total = turns * 2 * Math.PI;
  const k = Math.log(maxR / r0) / total;
  const steps = Math.max(48, Math.round(total / 0.11));
  const wob1 = rng() * 6.28, breath = 0.04 + rng() * 0.05;
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const th = (total * i) / steps;
    const r = r0 * Math.exp(k * th) * (1 + breath * Math.sin(th * 2.5 + wob1));
    const ang = dir * th + phase;
    const x = r * Math.cos(ang), y = r * Math.sin(ang) * squash;
    const rx = x * ca - y * sa, ry = x * sa + y * ca;
    pts.push({ x: ox + rx + (rng() * 2 - 1) * jitter, y: oy + ry + (rng() * 2 - 1) * jitter });
  }
  return pts;
}

export const whirlsModule: Module = {
  key: "whirls",
  label: "Whirls",
  kind: "make",
  group: "Lines & Patterns",
  description: "Bold organic spiralling whirls of varied size/direction + small twirl flourishes, composed asymmetrically with open space.",
  sections: [
    { title: "Whirls", fields: [
      { key: "count", label: "Whirls", type: "range", min: 1, max: 10, step: 1, default: 3 },
      { key: "maxR", label: "Max radius", type: "range", min: 20, max: 160, step: 2, unit: "mm", default: 100 },
      { key: "turns", label: "Turns", type: "range", min: 1, max: 6, step: 0.25, default: 3.2 },
      { key: "squash", label: "Squash", type: "range", min: 0.4, max: 1, step: 0.05, default: 0.85 },
    ]},
    { title: "Twirls", fields: [
      { key: "twirls", label: "Twirls", type: "range", min: 0, max: 16, step: 1, default: 4 },
    ]},
    { title: "Hand", fields: [
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 10, step: 0.5, unit: "mm", default: 2 },
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
    const count = Math.max(1, Math.round(num(params, "count", 3)));
    const maxR = num(params, "maxR", 100), turns = num(params, "turns", 3.2);
    const squash = num(params, "squash", 0.85);
    const twirls = Math.max(0, Math.round(num(params, "twirls", 4)));
    const jitter = num(params, "jitter", 2);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));

    const paths: Path[] = [];
    const place = (rmax: number, trn: number) => {
      const R = rmax * (0.5 + 0.5 * rng());
      const m = Math.min(h * 0.85, R * 0.7);              // let big whirls run near/over the edge
      const ox = cx - h + m + rng() * (2 * (h - m));
      const oy = cy - h + m + rng() * (2 * (h - m));
      const dir = rng() < 0.5 ? 1 : -1;
      const t = trn * (0.6 + 0.5 * rng());
      paths.push({ points: whirl(ox, oy, 2, Math.max(6, R), t, dir, rng() * 6.28, squash + (rng() * 2 - 1) * 0.12, rng() * 6.28, jitter, rng) });
    };
    for (let i = 0; i < count; i++) place(maxR, turns);
    for (let i = 0; i < twirls; i++) place(maxR * 0.22, 1.6 + rng() * 1.4);
    return { widthMm: size, heightMm: size, paths, meta: { title: "Whirls" } };
  },
};

register(whirlsModule);
