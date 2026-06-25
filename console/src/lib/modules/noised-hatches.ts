// Noised Hatches generator — the canvas is divided into an n×n grid; each cell
// gets a line at `angle` or its perpendicular depending on whether the cell
// falls inside a noise-driven blob.
//
// Algorithm: https://www.generativehut.com/post/using-noise-to-create-looping-gifs-on-processing

import { register, num, type Module } from "../registry";
import type { Frame, Path } from "../frame";

// ---- smooth 3D value noise (no external dependency) -------------------------

function _hash(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2246822519 + seed * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

function _fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
function _lerp(a: number, b: number, t: number): number { return a + t * (b - a); }

/** Smooth 3D value noise → [0, 1]. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = _fade(x - ix), fy = _fade(y - iy), fz = _fade(z - iz);
  const v = (dx: number, dy: number, dz: number) => _hash(ix + dx, iy + dy, iz + dz, seed);
  return _lerp(
    _lerp(_lerp(v(0,0,0), v(1,0,0), fx), _lerp(v(0,1,0), v(1,1,0), fx), fy),
    _lerp(_lerp(v(0,0,1), v(1,0,1), fx), _lerp(v(0,1,1), v(1,1,1), fx), fy),
    fz,
  );
}

// -----------------------------------------------------------------------------

export const noisedHatchesModule: Module = {
  key: "noisedHatches",
  label: "Noised Hatches",
  kind: "make",
  group: "Lines & Patterns",
  description: "Grid of hatch cells shaped by a noise-driven blob. Cells inside the blob use one angle, outside use the perpendicular.",
  sections: [
    { title: "Grid", fields: [
      { key: "gridN",    label: "Grid density",  type: "range", min: 5,   max: 80,  step: 1,   default: 30 },
      { key: "angleDeg", label: "Hatch angle",   type: "range", min: 0,   max: 180, step: 1,   unit: "°",  default: 45 },
    ]},
    { title: "Blob", fields: [
      { key: "blobRadius", label: "Blob radius", type: "range", min: 5,    max: 300,  step: 1,    unit: "mm", default: 80   },
      { key: "noiseScale", label: "Noise scale", type: "range", min: 0.02, max: 1.0,  step: 0.01,             default: 0.15 },
      { key: "seed",       label: "Seed",        type: "range", min: 0,    max: 9999, step: 1,                default: 42   },
    ]},
    { title: "Canvas", fields: [
      { key: "w",  label: "Width",    type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "h",  label: "Height",   type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],

  generate(params): Frame {
    const gridN      = Math.max(5, Math.round(num(params, "gridN", 30)));
    const angleDeg   = num(params, "angleDeg", 45);
    const blobRadius = num(params, "blobRadius", 80);
    const noiseScale = num(params, "noiseScale", 0.15);
    const seed       = Math.round(num(params, "seed", 42));
    const w          = num(params, "w", 200);
    const h          = num(params, "h", 200);
    const cx0        = num(params, "cx", 0);
    const cy0        = num(params, "cy", 0);

    const xMin = cx0 - w / 2, xMax = cx0 + w / 2;
    const yMin = cy0 - h / 2, yMax = cy0 + h / 2;
    const cellW = w / gridN, cellH = h / gridN;

    // Two perpendicular hatch angles (radians)
    const angleRad = (angleDeg * Math.PI) / 180;
    const perpRad  = angleRad + Math.PI / 2;

    // Static blob center derived from seed (noise at z=0)
    const xb = xMin + w * noise3(100, 0, 0, seed);
    const yb = yMin + h * noise3(200, 0, 0, seed ^ 0xdeadbeef);

    const paths: Path[] = [];

    for (let col = 0; col < gridN; col++) {
      for (let row = 0; row < gridN; row++) {
        const r = 2 * blobRadius * noise3(col * noiseScale, row * noiseScale, 0, seed);

        const lx  = xMin + col * cellW;
        const ty  = yMin + row * cellH;
        const ccx = lx + cellW / 2;
        const ccy = ty + cellH / 2;
        const d   = Math.hypot(ccx - xb, ccy - yb);

        // Choose direction, then compute half-length from center to nearest cell wall
        const a    = d < r ? angleRad : perpRad;
        const cosA = Math.cos(a), sinA = Math.sin(a);
        const hx   = cellW / 2 / (Math.abs(cosA) || 1e-10);
        const hy   = cellH / 2 / (Math.abs(sinA) || 1e-10);
        const hl   = Math.min(hx, hy);

        paths.push({ points: [
          { x: ccx - hl * cosA, y: ccy - hl * sinA },
          { x: ccx + hl * cosA, y: ccy + hl * sinA },
        ]});
      }
    }

    return { widthMm: w, heightMm: h, paths, meta: { title: "Noised Hatches" } };
  },
};

register(noisedHatchesModule);
