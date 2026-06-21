// Spirograph generator — hypotrochoid / epitrochoid roulette curve. Pure & closed-form
// (no RNG), so it's fully deterministic. Registers on import.
//   hypo: x=(R-r)cos t + d cos(((R-r)/r) t),  y=(R-r)sin t - d sin(((R-r)/r) t)
//   epi:  x=(R+r)cos t - d cos(((R+r)/r) t),  y=(R+r)sin t - d sin(((R+r)/r) t)
// Curve closes after t spans 2π·(r/gcd(R,r)).

import { register, num, type Module } from "../registry";
import type { Frame, Path, Pt } from "../frame";

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
  while (b) { const t = b; b = a % b; a = t; }
  return a || 1;
}

export const spirographModule: Module = {
  key: "spirograph",
  label: "Spirograph",
  kind: "make",
  group: "Lines & Patterns",
  description: "A hypotrochoid / epitrochoid roulette curve (the classic gear toy).",
  sections: [
    { title: "Gears", fields: [
      { key: "R", label: "Fixed radius", type: "range", min: 10, max: 200, step: 1, unit: "mm", default: 80 },
      { key: "r", label: "Rolling radius", type: "range", min: 3, max: 150, step: 1, unit: "mm", default: 30 },
      { key: "d", label: "Pen offset", type: "range", min: 0, max: 150, step: 1, unit: "mm", default: 50 },
      { key: "type", label: "Type", type: "select", default: "hypo",
        options: [{ value: "hypo", label: "Hypotrochoid" }, { value: "epi", label: "Epitrochoid" }] },
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
    const R = num(params, "R", 80);
    const r = Math.max(1, num(params, "r", 30));
    const d = num(params, "d", 50);
    const epi = String(params.type ?? "hypo") === "epi";
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));

    const turns = Math.max(1, Math.min(200, Math.round(r) / gcd(R, r)));   // closes here
    const n = Math.max(200, Math.min(6000, Math.round(turns * 180)));
    const base = epi ? R + r : R - r;
    const k = base / r;
    const points: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = 2 * Math.PI * turns * (i / n);
      const x = base * Math.cos(t) + (epi ? -1 : 1) * d * Math.cos(k * t);
      const y = base * Math.sin(t) - d * Math.sin(k * t);
      points.push({ x: cx + x, y: cy + y });
    }
    const path: Path = { points, closed: false, cycles };
    const span = Math.abs(base) + d;
    return { widthMm: 2 * span, heightMm: 2 * span, paths: [path], meta: { title: "Spirograph" } };
  },
};

register(spirographModule);
