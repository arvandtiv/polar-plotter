// Square generator — equal-sided box with optional rotation. Registers on import.

import { register, num, type Module } from "../registry";
import { rotate } from "../geom";
import type { Frame, Path, Pt } from "../frame";

export const squareModule: Module = {
  key: "square",
  label: "Square",
  kind: "make",
  group: "Shapes",
  description: "A square with optional rotation.",
  sections: [
    { title: "Size", fields: [
      { key: "size", label: "Size", type: "range", min: 1, max: 600, step: 1, unit: "mm", default: 100 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "rotation", label: "Rotation", type: "range", min: -180, max: 180, step: 1, unit: "°", default: 0 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],
  generate(params): Frame {
    const s = num(params, "size", 100);
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const rot = (num(params, "rotation", 0) * Math.PI) / 180;
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const h = s / 2;
    let pts: Pt[] = [
      { x: cx - h, y: cy - h }, { x: cx + h, y: cy - h },
      { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h },
    ];
    if (rot) pts = rotate(pts, rot, cx, cy);
    const path: Path = { points: pts, closed: true, cycles };
    return { widthMm: s, heightMm: s, paths: [path], meta: { title: "Square" } };
  },
};

register(squareModule);
