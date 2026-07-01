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
      { key: "spacing", label: "Grain spacing", type: "range", min: 6, max: 40, step: 1, unit: "mm", default: 16 },
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

    // open hand-drawn grain at `theta`, kept only on the side matching `sign`, clipped to frame.
    const grain = (theta: number, sign: number): Path[] => {
      const dx = Math.cos(theta), dy = Math.sin(theta);
      const nx = -Math.sin(theta), ny = Math.cos(theta);
      let omin = Infinity, omax = -Infinity;
      for (const [x, y] of [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]) {
        const o = (x - cx) * nx + (y - cy) * ny; if (o < omin) omin = o; if (o > omax) omax = o;
      }
      const span = 2 * h + 20, steps = Math.max(24, Math.round(span / 3));
      const out: Path[] = [];
      for (let o = Math.ceil(omin / spacing) * spacing; o <= omax + 1e-9; o += spacing) {
        const bx = cx + o * nx, by = cy + o * ny;
        const p1 = rng() * 6.28, amp = jitter * (0.6 + 0.6 * rng()), k = 0.02 + rng() * 0.03;
        let run: Pt[] = [];
        for (let i = 0; i <= steps; i++) {
          const d = -span / 2 + (span * i) / steps;
          const wob = amp * Math.sin(d * k + p1);
          const x = bx + dx * d + nx * wob, y = by + dy * d + ny * wob;
          if (inFrame(x, y) && Math.sign(sideOf(x, y)) === sign) run.push({ x, y });
          else { if (run.length > 1) out.push({ points: run }); run = []; }
        }
        if (run.length > 1) out.push({ points: run });
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
