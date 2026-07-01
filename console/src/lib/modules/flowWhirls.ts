// Flow-whirls generator — the whole wall FILLED with flowing streamlines through a VORTEX flow
// field (several whirl centres). Streamlines swirl around the vortices (whirls) and meander between
// them (twirls) — a rich, dynamic, full-field swirling flow, the round-25/round-11 winning look
// applied to LeWitt #1152 "Whirls and twirls". Not sparse floating spirals, not a mechanical weave.
// Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

type Vortex = { x: number; y: number; s: number; k: number };

export const flowWhirlsModule: Module = {
  key: "flowWhirls",
  label: "Flow whirls",
  kind: "make",
  group: "Lines & Patterns",
  description: "The wall filled with flowing streamlines through a vortex field — swirling whirls and twirling currents. Full-field, dynamic, hand-made.",
  sections: [
    { title: "Field", fields: [
      { key: "vortices", label: "Whirl centres", type: "range", min: 1, max: 10, step: 1, default: 4 },
      { key: "strength", label: "Swirl strength", type: "range", min: 20, max: 200, step: 5, default: 90 },
      { key: "spiralIn", label: "Spiral in/out", type: "range", min: -0.8, max: 0.8, step: 0.05, default: 0.25 },
      { key: "drift", label: "Base drift", type: "range", min: 0, max: 60, step: 1, default: 18 },
    ]},
    { title: "Streamlines", fields: [
      { key: "spacing", label: "Line spacing", type: "range", min: 6, max: 30, step: 1, unit: "mm", default: 15 },
      { key: "reach", label: "Line length", type: "range", min: 40, max: 400, step: 10, unit: "mm", default: 150 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 8, step: 0.5, unit: "mm", default: 1.5 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    ]},
    { title: "Growth & decrease (breathing)", fields: [
      { key: "growth", label: "Breathe amount", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
      { key: "growthAxis", label: "Breathe axis", type: "range", min: 0, max: 180, step: 5, unit: "deg", default: 90 },
      { key: "growthPeak", label: "Crest position", type: "range", min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: "growthWidth", label: "Crest breadth", type: "range", min: 0.1, max: 0.8, step: 0.05, default: 0.32 },
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
    const nV = Math.max(1, Math.round(num(params, "vortices", 4)));
    const strength = num(params, "strength", 90), spiralIn = num(params, "spiralIn", 0.25);
    const drift = num(params, "drift", 18);
    const spacing = Math.max(3, num(params, "spacing", 15));
    const reach = num(params, "reach", 150);
    const jitter = num(params, "jitter", 1.5);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));

    // vortices placed asymmetrically; alternating-ish spin, varied strength
    const vs: Vortex[] = [];
    for (let i = 0; i < nV; i++)
      vs.push({
        x: cx - h * 0.75 + rng() * 1.5 * h, y: cy - h * 0.75 + rng() * 1.5 * h,
        s: (rng() < 0.5 ? 1 : -1), k: strength * (0.6 + 0.8 * rng()),
      });
    const driftAng = rng() * 6.28;
    const core = 14;
    const vecAngle = (x: number, y: number): number => {
      let vx = drift * Math.cos(driftAng), vy = drift * Math.sin(driftAng);
      for (const v of vs) {
        const dx = x - v.x, dy = y - v.y, d = Math.hypot(dx, dy) + core, f = v.k / d;
        vx += ((-dy / d) * v.s + (-dx / d) * spiralIn) * f;   // tangential + spiral-in
        vy += ((dx / d) * v.s + (-dy / d) * spiralIn) * f;
      }
      return Math.atan2(vy, vx);
    };
    const inFrame = (x: number, y: number) => x >= cx - h && x <= cx + h && y >= cy - h && y <= cy + h;

    const ds = 4, half = Math.max(6, Math.round(reach / 2 / ds));  // each streamline ≈ `reach` mm total
    // growth & decrease (Klee #15): a breathing envelope along an axis — streamlines are full & dense
    // at the crest and shorter & sparser toward the edges, so the whole flow swells then decreases.
    const growth = num(params, "growth", 0);
    const gAxis = (num(params, "growthAxis", 90) * Math.PI) / 180, gax = Math.cos(gAxis), gay = Math.sin(gAxis);
    const gPeak = num(params, "growthPeak", 0.5), gWidth = num(params, "growthWidth", 0.32);
    const envAt = (x: number, y: number) => {
      if (growth <= 0) return 1;
      const u = ((x - (cx - h)) * gax + (y - (cy - h)) * gay) / (2 * h);
      const e = Math.exp(-0.5 * ((u - gPeak) / gWidth) ** 2);
      return 1 - growth + growth * e;                 // 1 (no breathe) → down to (1-growth) at edges
    };
    const paths: Path[] = [];
    for (let gx = cx - h; gx <= cx + h; gx += spacing)
      for (let gy = cy - h; gy <= cy + h; gy += spacing) {
        const e = envAt(gx, gy);
        if (rng() > 0.9 * e) continue;   // (growth=0 → 0.9, unchanged); sparser where the flow decreases
        const hi = Math.max(4, Math.round(half * e));             // shorter streamlines toward edges
        const seg: Pt[] = [];
        for (const dir of [1, -1]) {
          let x = gx, y = gy;
          const pts: Pt[] = [];
          for (let i = 0; i < hi; i++) {
            const a = vecAngle(x, y);
            x += dir * Math.cos(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
            y += dir * Math.sin(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
            if (!inFrame(x, y)) break;
            pts.push({ x, y });
          }
          if (dir === 1) seg.push(...pts.reverse(), { x: gx, y: gy });
          else seg.push(...pts);
        }
        if (seg.length > 3) paths.push({ points: seg });
      }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Flow whirls" } };
  },
};

register(flowWhirlsModule);
