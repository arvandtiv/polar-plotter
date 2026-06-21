// Shape Mask modifier — clips the layers below to (or away from) a shape region.
// kind:"modify" → reads ctx.lowerFrame. Registers on import.

import { register, num, type Module } from "../registry";
import { rotate } from "../geom";
import { clipPolylineToPolygon } from "../clip";
import type { Frame, Path, Pt } from "../frame";

function maskPolygon(shape: string, size: number, sides: number, rotDeg: number, cx: number, cy: number): Pt[] {
  let pts: Pt[];
  if (shape === "square") {
    pts = [{ x: -size, y: -size }, { x: size, y: -size }, { x: size, y: size }, { x: -size, y: size }];
  } else {
    const n = shape === "circle" ? 64 : Math.max(3, Math.round(sides));
    pts = [];
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pts.push({ x: size * Math.cos(a), y: size * Math.sin(a) }); }
  }
  const rot = (rotDeg * Math.PI) / 180;
  if (rot) pts = rotate(pts, rot);
  return pts.map((p) => ({ x: p.x + cx, y: p.y + cy }));
}

export const maskModule: Module = {
  key: "mask",
  label: "Shape Mask",
  kind: "modify",
  group: "Modifiers",
  description: "Keeps the geometry below only inside (or outside) a shape region.",
  sections: [
    { title: "Mask", fields: [
      { key: "shape", label: "Shape", type: "select", default: "circle",
        options: [{ value: "circle", label: "Circle" }, { value: "square", label: "Square" }, { value: "polygon", label: "Polygon" }] },
      { key: "mode", label: "Keep", type: "select", default: "inside",
        options: [{ value: "inside", label: "Inside" }, { value: "outside", label: "Outside" }] },
      { key: "size", label: "Size", type: "range", min: 5, max: 300, step: 1, unit: "mm", default: 80 },
      { key: "sides", label: "Polygon sides", type: "range", min: 3, max: 12, step: 1, default: 6 },
      { key: "rotation", label: "Rotation", type: "range", min: -180, max: 180, step: 1, unit: "°", default: 0 },
      { key: "showMask", label: "Draw mask outline", type: "toggle", default: false },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params, ctx): Frame {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const keepInside = String(params.mode ?? "inside") !== "outside";
    const poly = maskPolygon(
      String(params.shape ?? "circle"), num(params, "size", 80), num(params, "sides", 6),
      num(params, "rotation", 0), num(params, "cx", 0), num(params, "cy", 0));

    const out: Path[] = [];
    for (const path of lower.paths) {
      const pts = path.closed && path.points.length > 2 ? [...path.points, path.points[0]] : path.points;
      for (const piece of clipPolylineToPolygon(pts, poly, keepInside)) {
        out.push({ points: piece, cycles: path.cycles, stroke: path.stroke });
      }
    }
    if (params.showMask === true) out.push({ points: poly, closed: true });
    return { ...lower, paths: out, meta: { title: "Shape Mask" } };
  },
};

register(maskModule);
