// Curvy-divide generator — a wall split corner-to-corner (upper-left → lower-right) by a bold
// hand-drawn CURVY line, with each side filled by open, hand-drawn directional GRAIN running a
// contrasting angle. Monochrome adaptation of LeWitt #852 ("...divided by a curvy line; left glossy
// yellow; right glossy purple") — colour dropped, the two sides distinguished by grain DIRECTION.
// Kept light/open per the session's taste. Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

export const curvyDivideModule: Module = {
  key: "curvyDivide",
  label: "Curvy divide",
  kind: "make",
  group: "Lines & Patterns",
  description: "A wall split corner-to-corner by a curvy line; each side filled with open hand-drawn grain running a contrasting direction.",
  sections: [
    { title: "Divide", fields: [
      { key: "curviness", label: "Curviness", type: "range", min: 0, max: 120, step: 2, unit: "mm", default: 40 },
      { key: "freq", label: "Waves", type: "range", min: 0.5, max: 5, step: 0.1, default: 1.6 },
    ]},
    { title: "Grain", fields: [
      { key: "leftAngle", label: "Left angle", type: "range", min: 0, max: 180, step: 1, unit: "deg", default: 35 },
      { key: "rightAngle", label: "Right angle", type: "range", min: 0, max: 180, step: 1, unit: "deg", default: 125 },
      { key: "spacing", label: "Grain spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 16 },
      { key: "swirl", label: "Flow swirl", type: "range", min: 0, max: 1.4, step: 0.05, unit: "rad", default: 0.6 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 14, step: 0.5, unit: "mm", default: 4 },
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
    const curviness = num(params, "curviness", 40), freq = num(params, "freq", 1.6);
    const spacing = Math.max(1, num(params, "spacing", 16));
    const swirl = num(params, "swirl", 0.6);
    const jitter = num(params, "jitter", 4);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const leftRad = (num(params, "leftAngle", 35) * Math.PI) / 180;
    const rightRad = (num(params, "rightAngle", 125) * Math.PI) / 180;

    // diagonal UL→LR and its unit axes
    const A = { x: cx - h, y: cy - h }, B = { x: cx + h, y: cy + h };
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;   // along diagonal
    const px = -uy, py = ux;                             // perpendicular
    const ph1 = rng() * 6.28, ph2 = rng() * 6.28;
    const curveOffset = (t: number) =>
      curviness * (0.7 * Math.sin(t * freq * 2 * Math.PI + ph1) + 0.3 * Math.sin(t * freq * 2.3 * 2 * Math.PI + ph2));
    // signed side of the curvy divide at point P (>0 = right/below, <0 = left/above)
    const sideOf = (x: number, y: number) => {
      const rx = x - A.x, ry = y - A.y;
      const t = (rx * ux + ry * uy) / L;
      const off = rx * px + ry * py;
      return off - curveOffset(t);
    };
    const inFrame = (x: number, y: number) => x >= cx - h && x <= cx + h && y >= cy - h && y <= cy + h;

    // flowing grain: streamlines integrated through a swirled flow field whose base direction is
    // `theta` (so the two sides run contrasting flows). Curving, alive — not flat hatching. Seeds on
    // a grid at `spacing`; each streamline is integrated forward+backward and kept where it is inside
    // the frame and on the matching `sign` side of the curvy divide.
    const sw1 = rng() * 6.28, sw2 = rng() * 6.28;
    const flowAngle = (x: number, y: number, base: number) =>
      base + swirl * (Math.sin(x * 0.011 + sw1) * Math.cos(y * 0.012 - sw2) + 0.5 * Math.sin((x + y) * 0.007 + sw1));
    const grain = (theta: number, sign: number): Path[] => {
      const out: Path[] = [];
      const ds = 4, half = Math.round((2.4 * h) / ds);
      for (let gx = cx - h; gx <= cx + h; gx += spacing)
        for (let gy = cy - h; gy <= cy + h; gy += spacing) {
          // only seed streamlines that start on the correct side (keeps work + look on-side)
          if (Math.sign(sideOf(gx, gy)) !== sign) continue;
          if (rng() > 0.92) continue; // slight irregularity so rows don't line up mechanically
          const seg: Pt[] = [];
          for (const dir of [1, -1]) {
            let x = gx, y = gy;
            const pts: Pt[] = [];
            for (let i = 0; i < half; i++) {
              const a = flowAngle(x, y, theta);
              x += dir * Math.cos(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
              y += dir * Math.sin(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
              if (!inFrame(x, y) || Math.sign(sideOf(x, y)) !== sign) break;
              pts.push({ x, y });
            }
            if (dir === 1) seg.push(...pts.reverse(), { x: gx, y: gy });
            else seg.push(...pts);
          }
          if (seg.length > 2) out.push({ points: seg });
        }
      return out;
    };

    const paths: Path[] = [];
    paths.push(...grain(leftRad, -1));
    paths.push(...grain(rightRad, 1));
    // the curvy divide itself — bold, hand-drawn (two close passes)
    for (let pass = 0; pass < 2; pass++) {
      const bpts: Pt[] = [];
      const jb = pass === 0 ? 0 : 1.2;
      for (let i = 0; i <= 260; i++) {
        const t = i / 260, base = { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };
        const off = curveOffset(t) + (rng() * 2 - 1) * jb;
        bpts.push({ x: base.x + px * off, y: base.y + py * off });
      }
      paths.push({ points: bpts });
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Curvy divide" } };
  },
};

register(curvyDivideModule);
