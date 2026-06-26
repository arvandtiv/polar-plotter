// Fill modifier — adds hatch lines or concentric rings inside every CLOSED path of the
// layers below. kind:"modify". The console-side twin of the firmware's hatch/concentric
// fill, now available on any closed geometry (text, imports, generators). Registers on import.

import { register, num, type Module } from "../registry";
import { bounds } from "../geom";
import { clipPolylineToPolygon } from "../clip";
import type { Frame, Path, Pt } from "../frame";

// Parallel lines at angleDeg, spaced `spacing`, clipped to the polygon interior.
function hatchPolygon(poly: Pt[], spacing: number, angleDeg: number): Path[] {
  const b = bounds(poly);
  if (!b) return [];
  const th = (angleDeg * Math.PI) / 180;
  const dir: Pt = { x: Math.cos(th), y: Math.sin(th) };
  const nrm: Pt = { x: -Math.sin(th), y: Math.cos(th) };
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
  const K = Math.ceil((diag / 2) / spacing) + 1;
  const out: Path[] = [];
  for (let k = -K; k <= K; k++) {
    const o = k * spacing;
    const px = cx + nrm.x * o, py = cy + nrm.y * o;
    const a: Pt = { x: px - dir.x * diag, y: py - dir.y * diag };
    const c: Pt = { x: px + dir.x * diag, y: py + dir.y * diag };
    for (const piece of clipPolylineToPolygon([a, c], poly, true)) out.push({ points: piece });
  }
  return out;
}

// Concentric rings by scaling the path toward its centroid (matches firmware concentric).
function concentricRings(poly: Pt[], spacing: number): Path[] {
  const b = bounds(poly);
  if (!b) return [];
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  const radius = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2;
  const step = Math.min(0.5, Math.max(0.02, spacing / Math.max(1, radius)));
  const out: Path[] = [];
  for (let s = 1 - step; s > 0.02; s -= step) {
    out.push({ points: poly.map((p) => ({ x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s })), closed: true });
  }
  return out;
}

export const fillModule: Module = {
  key: "fill",
  label: "Fill",
  kind: "modify",
  group: "Modifiers",
  description: "Hatches or concentrically fills every closed shape in the layers below.",
  sections: [
    { title: "Fill", fields: [
      { key: "mode", label: "Mode", type: "select", default: "hatch",
        options: [{ value: "hatch", label: "Hatch" }, { value: "concentric", label: "Concentric" }] },
      { key: "spacing", label: "Spacing", type: "range", min: 1, max: 20, step: 0.5, unit: "mm", default: 3 },
      { key: "angle", label: "Hatch angle", type: "range", min: -90, max: 90, step: 1, unit: "°", default: 45 },
      { key: "keepOutline", label: "Keep outlines", type: "toggle", default: true },
    ]},
  ],
  generate(params, ctx): Frame {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const mode = String(params.mode ?? "hatch");
    const spacing = Math.max(0.5, num(params, "spacing", 3));
    const angle = num(params, "angle", 45);
    const keepOutline = params.keepOutline !== false;

    const out: Path[] = keepOutline ? [...lower.paths] : lower.paths.filter((p) => !p.closed);
    for (const path of lower.paths) {
      if (!path.closed || path.points.length < 3) continue;
      out.push(...(mode === "concentric" ? concentricRings(path.points, spacing) : hatchPolygon(path.points, spacing, angle)));
    }
    return { ...lower, paths: out, meta: { title: "Fill" } };
  },
};

register(fillModule);
