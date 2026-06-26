// Pattern Maker generator — tiles a base shape across a grid with a per-cell rotation
// increment, for woven/cascading patterns. Pure/deterministic. Registers on import.

import { register, num, type Module } from "../registry";
import { rotate } from "../geom";
import type { Frame, Path, Pt } from "../frame";

function baseShape(kind: string, size: number): Pt[] {
  const h = size / 2;
  if (kind === "circle") {
    const pts: Pt[] = [];
    for (let i = 0; i < 32; i++) { const a = (2 * Math.PI * i) / 32; pts.push({ x: h * Math.cos(a), y: h * Math.sin(a) }); }
    return pts;
  }
  if (kind === "triangle") {
    return [0, 1, 2].map((i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / 3; return { x: h * Math.cos(a), y: h * Math.sin(a) }; });
  }
  return [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];   // square
}

export const patternMakerModule: Module = {
  key: "patternMaker",
  label: "Pattern Maker",
  kind: "make",
  group: "Lines & Patterns",
  description: "A base shape tiled across a grid, rotating a little more each cell.",
  sections: [
    { title: "Shape", fields: [
      { key: "shape", label: "Shape", type: "select", default: "square",
        options: [{ value: "square", label: "Square" }, { value: "circle", label: "Circle" }, { value: "triangle", label: "Triangle" }] },
      { key: "fillRatio", label: "Cell fill", type: "range", min: 0.1, max: 1, step: 0.05, default: 0.8 },
      { key: "rotateStep", label: "Rotate / cell", type: "range", min: -45, max: 45, step: 1, unit: "°", default: 7 },
    ]},
    { title: "Grid", fields: [
      { key: "cols", label: "Columns", type: "range", min: 1, max: 30, step: 1, default: 8 },
      { key: "rows", label: "Rows", type: "range", min: 1, max: 30, step: 1, default: 8 },
      { key: "cell", label: "Cell size", type: "range", min: 4, max: 80, step: 1, unit: "mm", default: 24 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const shape = String(params.shape ?? "square");
    const fillRatio = num(params, "fillRatio", 0.8);
    const rotateStep = num(params, "rotateStep", 7);
    const cols = Math.max(1, Math.round(num(params, "cols", 8)));
    const rows = Math.max(1, Math.round(num(params, "rows", 8)));
    const cell = num(params, "cell", 24);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);

    const startX = cx - ((cols - 1) * cell) / 2;
    const startY = cy - ((rows - 1) * cell) / 2;
    const size = cell * fillRatio;
    const paths: Path[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const ox = startX + c * cell, oy = startY + r * cell;
        let pts = baseShape(shape, size);
        const rot = (idx * rotateStep * Math.PI) / 180;
        if (rot) pts = rotate(pts, rot);
        pts = pts.map((p) => ({ x: p.x + ox, y: p.y + oy }));
        paths.push({ points: pts, closed: true });
      }
    }
    return { widthMm: cols * cell, heightMm: rows * cell, paths, meta: { title: "Pattern Maker" } };
  },
};

register(patternMakerModule);
