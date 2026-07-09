// Fill modifier — adds hatch lines or concentric rings inside every CLOSED path of the
// layers below. kind:"modify". The console-side twin of the firmware's hatch/concentric
// fill, now available on any closed geometry (text, imports, generators). Registers on import.

import { register, num, type Module, type Section, type ParamValues } from "../registry";
import { bounds } from "../geom";
import { clipPolylineToPolygon } from "../clip";
import type { Frame, Path, Pt } from "../frame";

// Parallel lines at angleDeg, spaced `spacing`, clipped to the polygon interior.
export function hatchPolygon(poly: Pt[], spacing: number, angleDeg: number): Path[] {
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
export function concentricRings(poly: Pt[], spacing: number): Path[] {
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

/** Concentric fill around an ARBITRARY focus point — inside or even OUTSIDE the shape:
 *  circles (or one continuous spiral) centred on (fx, fy), CLIPPED to the polygon, so
 *  every arc terminates exactly on the border. Ripples from a dropped stone, truncated
 *  by the shape. Clipped circles are true circular arcs, so the compiler's arc-fitter
 *  collapses them into firmware `arc` jobs (fast, silky plotting). */
export function orbitRings(poly: Pt[], spacing: number, fx: number, fy: number, spiral = false): Path[] {
  const b = bounds(poly);
  if (!b) return [];
  const sp = Math.max(0.5, spacing);
  // radial band of the polygon as seen from the focus
  let rMaxSq = 0, rMin = Infinity;
  for (const p of poly) {
    const d = Math.hypot(p.x - fx, p.y - fy);
    rMaxSq = Math.max(rMaxSq, d * d);
    rMin = Math.min(rMin, d);
  }
  const rMax = Math.sqrt(rMaxSq);
  // inside focus → rings start at `spacing`; outside → skip the empty gap up to the shape
  const inside = pointInPoly(poly, fx, fy);
  const rStart = inside ? sp : Math.max(sp, Math.floor(rMin / sp) * sp);
  const out: Path[] = [];

  const ringPts = (r: number, a0: number, a1: number): Pt[] => {
    const n = Math.min(720, Math.max(24, Math.ceil((r * (a1 - a0)) / 1.5)));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push({ x: fx + r * Math.cos(a), y: fy + r * Math.sin(a) });
    }
    return pts;
  };

  if (spiral) {
    // one continuous Archimedean spiral r = sp·θ/2π, weaving around the focus out to
    // the border; the clip splits it into the pieces that lie inside the shape.
    const pts: Pt[] = [];
    const thMax = (rMax / sp) * 2 * Math.PI;
    let th = inside ? 0.4 : (rStart / sp) * 2 * Math.PI;
    while (th <= thMax) {
      const r = (sp * th) / (2 * Math.PI);
      pts.push({ x: fx + r * Math.cos(th), y: fy + r * Math.sin(th) });
      th += Math.min(0.3, 1.5 / Math.max(1, r));   // ~1.5 mm steps along the coil
    }
    for (const piece of clipPolylineToPolygon(pts, poly, true))
      if (piece.length > 1) out.push({ points: piece });
    return out;
  }

  for (let r = rStart; r <= rMax; r += sp) {
    const ring = ringPts(r, 0, 2 * Math.PI);
    if (inside && r < rMin) { out.push({ points: ring, closed: true }); continue; }  // fully inside: unclipped full ring
    for (const piece of clipPolylineToPolygon(ring, poly, true))
      if (piece.length > 1) out.push({ points: piece });
  }
  return out;
}

// even-odd point-in-polygon (for choosing the ring start radius)
function pointInPoly(poly: Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], bb = poly[j];
    if ((a.y > y) !== (bb.y > y) && x < ((bb.x - a.x) * (y - a.y)) / (bb.y - a.y) + a.x) c = !c;
  }
  return c;
}

/* ---- Shared shape-fill capability (ported from the firmware Draw primitives) ------
 * The old Draw tab's circle/square/wobbly cards offered fill none/hatch/concentric +
 * hatch angle/spacing + outline toggle, executed firmware-side. These two helpers give
 * the Studio shape MODULES the identical capability in one layer (the standalone Fill
 * modifier remains for filling arbitrary compositions). */
export function shapeFillSection(): Section {
  return { title: "Fill", fields: [
    { key: "fill", label: "Fill", type: "select", default: "none", options: [
      { value: "none",       label: "None (outline only)" },
      { value: "hatch",      label: "Hatch" },
      { value: "concentric", label: "Concentric" },
      { value: "orbit",      label: "Around point (rings)" },
      { value: "spiral",     label: "Around point (spiral)" },
    ]},
    { key: "hatchAngle",   label: "Hatch angle",  type: "range", min: -90, max: 90, step: 1,   unit: "°",  default: 45 },
    { key: "hatchSpacing", label: "Fill spacing", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 3 },
    { key: "focusX",       label: "Point X (around-point)", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    { key: "focusY",       label: "Point Y (around-point)", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    { key: "outline",      label: "Outline",      type: "toggle", default: true },
  ]};
}

/** Outline + optional fill paths for one closed shape polygon (firmware Draw parity).
 *  Outline carries the retrace `cycles`; fill lines are single-pass. With fill=none
 *  the outline always draws (an empty layer helps nobody). */
export function applyShapeFill(poly: Pt[], params: ParamValues, cycles: number): Path[] {
  const mode = String(params.fill ?? "none");
  const outline = params.outline !== false;
  const spacing = Math.max(0.5, num(params, "hatchSpacing", 3));
  const angle = num(params, "hatchAngle", 45);
  const paths: Path[] = [];
  const fx = num(params, "focusX", 0), fy = num(params, "focusY", 0);
  if (outline || mode === "none") paths.push({ points: poly, closed: true, cycles });
  if (mode === "hatch")           paths.push(...hatchPolygon(poly, spacing, angle));
  else if (mode === "concentric") paths.push(...concentricRings(poly, spacing));
  else if (mode === "orbit")      paths.push(...orbitRings(poly, spacing, fx, fy, false));
  else if (mode === "spiral")     paths.push(...orbitRings(poly, spacing, fx, fy, true));
  return paths;
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
        options: [
          { value: "hatch", label: "Hatch" },
          { value: "concentric", label: "Concentric" },
          { value: "orbit", label: "Around point (rings)" },
          { value: "spiral", label: "Around point (spiral)" },
        ] },
      { key: "spacing", label: "Spacing", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 3 },
      { key: "angle", label: "Hatch angle", type: "range", min: -90, max: 90, step: 1, unit: "°", default: 45 },
      { key: "fx", label: "Point X (around-point)", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "fy", label: "Point Y (around-point)", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "keepOutline", label: "Keep outlines", type: "toggle", default: true },
    ]},
  ],
  generate(params, ctx): Frame {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const mode = String(params.mode ?? "hatch");
    const spacing = Math.max(0.5, num(params, "spacing", 3));
    const angle = num(params, "angle", 45);
    const keepOutline = params.keepOutline !== false;

    const fx = num(params, "fx", 0), fy = num(params, "fy", 0);
    const out: Path[] = keepOutline ? [...lower.paths] : lower.paths.filter((p) => !p.closed);
    for (const path of lower.paths) {
      if (!path.closed || path.points.length < 3) continue;
      // around-point modes share ONE global focus — ripples run across every object
      out.push(...(mode === "concentric" ? concentricRings(path.points, spacing)
                 : mode === "orbit"      ? orbitRings(path.points, spacing, fx, fy, false)
                 : mode === "spiral"     ? orbitRings(path.points, spacing, fx, fy, true)
                 : hatchPolygon(path.points, spacing, angle)));
    }
    return { ...lower, paths: out, meta: { title: "Fill" } };
  },
};

register(fillModule);
