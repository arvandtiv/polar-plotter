// Noised Hatches generator — the canvas is divided into an n×n grid; each cell
// gets either a backslash (\) or forward-slash (/) line depending on whether the
// cell falls inside a noise-driven blob.  Stacking multiple layers (each at a
// different position in noise-space) builds up a rich overlapping texture.
//
// Algorithm: https://www.generativehut.com/post/using-noise-to-create-looping-gifs-on-processing
// Adapted for a pen plotter: N static layers instead of an animated GIF.

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
  description: "Grid of \\ / hatch cells shaped by a noise-driven blob. N layers stack to build up texture.",
  sections: [
    { title: "Grid", fields: [
      { key: "gridN",  label: "Grid density", type: "range", min: 5,  max: 80,  step: 1,   default: 30 },
      { key: "layers", label: "Layers",        type: "range", min: 1,  max: 12,  step: 1,   default: 5  },
    ]},
    { title: "Blob", fields: [
      { key: "blobRadius",  label: "Blob radius",   type: "range", min: 5,    max: 300,  step: 1,    unit: "mm", default: 80   },
      { key: "noiseScale",  label: "Noise scale",   type: "range", min: 0.02, max: 1.0,  step: 0.01,             default: 0.15 },
      { key: "layerStep",   label: "Layer depth",   type: "range", min: 0.1,  max: 6.0,  step: 0.1,             default: 1.5  },
      { key: "seed",        label: "Seed",          type: "range", min: 0,    max: 9999, step: 1,                default: 42   },
    ]},
    { title: "Canvas", fields: [
      { key: "w",  label: "Width",  type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "h",  label: "Height", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],

  generate(params): Frame {
    const gridN      = Math.max(5, Math.round(num(params, "gridN", 30)));
    const layers     = Math.max(1, Math.round(num(params, "layers", 5)));
    const blobRadius = num(params, "blobRadius", 80);
    const noiseScale = num(params, "noiseScale", 0.15);
    const layerStep  = num(params, "layerStep", 1.5);
    const seed       = Math.round(num(params, "seed", 42));
    const w          = num(params, "w", 200);
    const h          = num(params, "h", 200);
    const cx0        = num(params, "cx", 0);
    const cy0        = num(params, "cy", 0);

    const xMin = cx0 - w / 2, xMax = cx0 + w / 2;
    const yMin = cy0 - h / 2, yMax = cy0 + h / 2;
    const cellW = w / gridN, cellH = h / gridN;

    const paths: Path[] = [];

    for (let li = 0; li < layers; li++) {
      // Each layer samples a different slice through noise-space (= "time" in the GIF).
      const t = li * layerStep;

      // Blob center wanders with t — two different noise seeds for x vs y.
      const xb = xMin + w * noise3(100, t, 0, seed);
      const yb = yMin + h * noise3(200, t, 0, seed ^ 0xdeadbeef);

      for (let col = 0; col < gridN; col++) {
        for (let row = 0; row < gridN; row++) {
          // Per-cell radius threshold driven by spatial + depth noise.
          // Maps noise [0,1] → radius [0, 2·blobRadius] — mirrors the article's
          // "radius = 100·noise + 100" where 100 is the amplitude.
          const r = 2 * blobRadius * noise3(col * noiseScale, row * noiseScale, t, seed);

          // Cell corners
          const lx = xMin + col * cellW,       rx = lx + cellW;
          const ty = yMin + row * cellH,        by = ty + cellH;
          // Cell centre for distance test
          const ccx = (lx + rx) / 2,            ccy = (ty + by) / 2;

          const d = Math.hypot(ccx - xb, ccy - yb);

          if (d < r) {
            // Inside blob → backslash \ (top-left → bottom-right)
            paths.push({ points: [{ x: lx, y: ty }, { x: rx, y: by }] });
          } else {
            // Outside blob → forward-slash / (bottom-left → top-right)
            paths.push({ points: [{ x: lx, y: by }, { x: rx, y: ty }] });
          }
        }
      }
    }

    return { widthMm: w, heightMm: h, paths, meta: { title: "Noised Hatches" } };
  },
};

register(noisedHatchesModule);
