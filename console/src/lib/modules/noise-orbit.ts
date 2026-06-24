// Noise Orbit generator — concentric N-sided polygons, each vertex nudged by a
// noise-derived angle, then smoothed with Chaikin's algorithm.  Multiple layers
// (different z-slices through noise space) stack into an orbital texture.
//
// Algorithm: https://www.generativehut.com/post/recreating-the-noise-orbit

import { register, num, type Module } from "../registry";
import type { Frame, Path, Pt } from "../frame";

// ---- smooth 3D value noise (same kernel as noised-hatches) ------------------

function _hash(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2246822519 + seed * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}
function _fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
function _lerp(a: number, b: number, t: number) { return a + t * (b - a); }
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = _fade(x - ix), fy = _fade(y - iy), fz = _fade(z - iz);
  const v = (dx: number, dy: number, dz: number) => _hash(ix+dx, iy+dy, iz+dz, seed);
  return _lerp(
    _lerp(_lerp(v(0,0,0), v(1,0,0), fx), _lerp(v(0,1,0), v(1,1,0), fx), fy),
    _lerp(_lerp(v(0,0,1), v(1,0,1), fx), _lerp(v(0,1,1), v(1,1,1), fx), fy),
    fz,
  );
}

// ---- Chaikin smoothing (closed polygon) -------------------------------------
// Each iteration: replace every edge AB with two new points at 0.75A+0.25B and
// 0.25A+0.75B.  Four iterations rounds a polygon into a smooth closed curve.

function chaikin(pts: Pt[], iterations: number): Pt[] {
  let p = pts;
  for (let i = 0; i < iterations; i++) {
    const next: Pt[] = [];
    const n = p.length;
    for (let k = 0; k < n; k++) {
      const a = p[k], b = p[(k + 1) % n];
      next.push(
        { x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y },
        { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y },
      );
    }
    p = next;
  }
  return p;
}

// -----------------------------------------------------------------------------

export const noiseOrbitModule: Module = {
  key: "noiseOrbit",
  label: "Noise Orbit",
  kind: "make",
  group: "Lines & Patterns",
  description: "Concentric rings distorted by a noise field and smoothed with Chaikin's algorithm. Layers stack different noise slices.",
  sections: [
    { title: "Rings", fields: [
      { key: "numCircles", label: "Rings",        type: "range", min: 2,  max: 80,  step: 1,   default: 30 },
      { key: "minRadius",  label: "Inner radius", type: "range", min: 1,  max: 300, step: 1,   unit: "mm", default: 10  },
      { key: "maxRadius",  label: "Outer radius", type: "range", min: 5,  max: 300, step: 1,   unit: "mm", default: 100 },
      { key: "numSides",   label: "Sides",        type: "range", min: 6,  max: 60,  step: 1,   default: 20 },
      { key: "chaikin",    label: "Smoothing",    type: "range", min: 0,  max: 6,   step: 1,   unit: "×",  default: 4  },
    ]},
    { title: "Noise", fields: [
      { key: "nudge",     label: "Nudge",       type: "range", min: 0,   max: 100, step: 0.5, unit: "mm", default: 15  },
      { key: "layers",    label: "Layers",      type: "range", min: 1,   max: 12,  step: 1,              default: 5   },
      { key: "layerStep", label: "Layer depth", type: "range", min: 0.1, max: 6,   step: 0.1,            default: 1.5 },
      { key: "seed",      label: "Seed",        type: "range", min: 0,   max: 9999,step: 1,              default: 42  },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],

  generate(params): Frame {
    const numCircles = Math.max(2, Math.round(num(params, "numCircles", 30)));
    const minRadius  = num(params, "minRadius", 10);
    const maxRadius  = Math.max(minRadius + 1, num(params, "maxRadius", 100));
    const numSides   = Math.max(6, Math.round(num(params, "numSides", 20)));
    const chaikinN   = Math.round(num(params, "chaikin", 4));
    const nudgeMm    = num(params, "nudge", 15);
    const layers     = Math.max(1, Math.round(num(params, "layers", 5)));
    const layerStep  = num(params, "layerStep", 1.5);
    const seed       = Math.round(num(params, "seed", 42));
    const cx0        = num(params, "cx", 0);
    const cy0        = num(params, "cy", 0);

    // Work in normalized [0,1] coords (centre = 0.5,0.5; max radius = 0.5).
    const scale = 2 * maxRadius;          // mm → normalized conversion factor
    const nudgeN = nudgeMm / scale;       // nudge in normalized units

    const paths: Path[] = [];

    for (let li = 0; li < layers; li++) {
      // Two z rates like the article: z drives noise depth, z2 offsets input coords.
      const z  = li * layerStep;
      const z2 = li * layerStep * 2.5;

      for (let ci = 0; ci < numCircles; ci++) {
        const r  = minRadius + (maxRadius - minRadius) * (ci / Math.max(1, numCircles - 1));
        const rN = r / scale;   // normalized radius

        const raw: Pt[] = [];
        for (let si = 0; si < numSides; si++) {
          const theta = (2 * Math.PI * si) / numSides;
          const xN = 0.5 + rN * Math.cos(theta);
          const yN = 0.5 + rN * Math.sin(theta);

          // Noise inputs: spatial coords × distance × 2, plus time offsets.
          // The offset constants (0.31, -1.73) from the article avoid the zero
          // region at the origin where Perlin noise tends to be flat.
          const d = Math.hypot(xN - 0.5, yN - 0.5);   // ≈ rN
          const noiseX = (xN + 0.31) * d * 2 + z2;
          const noiseY = (yN - 1.73) * d * 2 + z2;
          const nv = noise3(noiseX, noiseY, z, seed);

          // Convert noise value → nudge direction → new position
          const angle = nv * Math.PI * 3;
          const nx = xN + nudgeN * Math.cos(angle);
          const ny = yN + nudgeN * Math.sin(angle);

          // Back to mm (relative to centre)
          raw.push({ x: cx0 + (nx - 0.5) * scale, y: cy0 + (ny - 0.5) * scale });
        }

        const pts = chaikinN > 0 ? chaikin(raw, chaikinN) : raw;
        // Close the loop: append the first point so the last segment is explicit
        paths.push({ points: [...pts, pts[0]], closed: false });
      }
    }

    return { widthMm: scale, heightMm: scale, paths, meta: { title: "Noise Orbit" } };
  },
};

register(noiseOrbitModule);
