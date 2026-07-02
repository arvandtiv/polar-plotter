// Moiré Curtain generator — two straight-line gratings at slightly different angles;
// their overlap produces the moiré interference. Pure/deterministic. Registers on import.

import { register, num, type Module } from "../registry";
import { clipSegmentToRect } from "../geom";
import type { Frame, Path, Pt } from "../frame";

// Parallel lines at `angleDeg`, spaced `spacing`, covering a rect (clipped to it).
function grating(angleDeg: number, spacing: number, cx: number, cy: number,
                 rect: { x0: number; y0: number; x1: number; y1: number }): Path[] {
  const th = (angleDeg * Math.PI) / 180;
  const dir: Pt = { x: Math.cos(th), y: Math.sin(th) };       // along the line
  const nrm: Pt = { x: -Math.sin(th), y: Math.cos(th) };      // across the lines
  const diag = Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0);
  const K = Math.ceil((diag / 2) / spacing) + 1;
  const paths: Path[] = [];
  for (let k = -K; k <= K; k++) {
    const o = k * spacing;
    const px = cx + nrm.x * o, py = cy + nrm.y * o;            // a point on this line
    const a: Pt = { x: px - dir.x * diag, y: py - dir.y * diag };
    const b: Pt = { x: px + dir.x * diag, y: py + dir.y * diag };
    const seg = clipSegmentToRect(a, b, rect);
    if (seg) paths.push({ points: [seg[0], seg[1]] });
  }
  return paths;
}

export const moireCurtainModule: Module = {
  key: "moireCurtain",
  label: "Moiré Curtain",
  kind: "make",
  group: "Lines & Patterns",
  description: "Two line gratings at a small angle offset — their overlap shimmers.",
  sections: [
    { title: "Field", fields: [
      { key: "w", label: "Width", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "h", label: "Height", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "spacing", label: "Line spacing", type: "range", min: 0.5, max: 30, step: 0.5, unit: "mm", default: 4 },
    ]},
    { title: "Gratings", fields: [
      { key: "angle", label: "Base angle", type: "range", min: -90, max: 90, step: 1, unit: "°", default: 90 },
      { key: "offsetAngle", label: "Angle offset", type: "range", min: 0, max: 45, step: 0.5, unit: "°", default: 6 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const w = num(params, "w", 200), h = num(params, "h", 200);
    const spacing = Math.max(0.5, num(params, "spacing", 4));
    const angle = num(params, "angle", 90);
    const offset = num(params, "offsetAngle", 6);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const rect = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    const paths = [
      ...grating(angle, spacing, cx, cy, rect),
      ...grating(angle + offset, spacing, cx, cy, rect),
    ];
    return { widthMm: w, heightMm: h, paths, meta: { title: "Moiré Curtain" } };
  },
};

register(moireCurtainModule);
