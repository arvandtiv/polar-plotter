// Circle generator — adaptive polygon (chord-error bounded), mirroring the firmware's
// plt_arc_segments so console and on-device output match. Registers on import.

import { register, num, type Module } from "../registry";
import type { Frame, Path, Pt } from "../frame";

const CHORD_ERR_MM = 0.2;

/** Segment count so a chord's bulge stays under maxErr (clamped 8..720). */
export function arcSegments(radiusMm: number, maxErrMm: number): number {
  if (radiusMm <= 0 || maxErrMm <= 0) return 8;
  let ratio = 1 - maxErrMm / radiusMm;
  ratio = Math.max(-1, Math.min(1, ratio));
  const a = 2 * Math.acos(ratio);
  const n = a > 1e-6 ? Math.ceil((2 * Math.PI) / a) : 720;
  return Math.max(8, Math.min(720, n));
}

export const circleModule: Module = {
  key: "circle",
  label: "Circle",
  kind: "make",
  group: "Shapes",
  description: "A circle approximated by an adaptive polygon.",
  sections: [
    { title: "Size", fields: [
      { key: "r", label: "Radius", type: "range", min: 1, max: 300, step: 1, unit: "mm", default: 50 },
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
    const r = num(params, "r", 50);
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const n = arcSegments(r, CHORD_ERR_MM);
    const points: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    const path: Path = { points, closed: true, cycles };
    return { widthMm: 2 * r, heightMm: 2 * r, paths: [path], meta: { title: "Circle" } };
  },
};

register(circleModule);
