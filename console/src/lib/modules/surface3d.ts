// Surface 3D — the 80s "mountain mesh": a z = f(x,y) heightfield drawn as a
// wireframe (u/v parameter lines, isometric view) or as RIDGELINES (front-view
// horizontal slices with keep-the-max occlusion — the Unknown Pleasures look).
// Height sources: seeded value noise (terrain), radial waves (sombrero), or a
// gaussian peak cluster. Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import { makeView, project, makeValueNoise, type Vec3 } from "../iso";
import type { Frame, Path, Pt } from "../frame";

export const surface3dModule: Module = {
  key: "surface3d",
  label: "Surface 3D",
  kind: "make",
  group: "3D Wireframe",
  description: "z = f(x,y) heightfield as an isometric wireframe mesh, or front-view ridgelines with occlusion (Unknown Pleasures). Noise terrain, radial waves, or peaks.",
  sections: [
    { title: "Surface", fields: [
      { key: "mode", label: "Render", type: "select", default: "mesh", options: [
        { value: "mesh",  label: "Wireframe mesh (isometric)" },
        { value: "ridge", label: "Ridgelines (front view + occlusion)" },
      ]},
      { key: "relief", label: "Height source", type: "select", default: "noise", options: [
        { value: "noise", label: "Noise terrain" },
        { value: "waves", label: "Radial waves (sombrero)" },
        { value: "peaks", label: "Gaussian peaks" },
      ]},
      { key: "size", label: "Ground size", type: "range", min: 40, max: 500, step: 5, unit: "mm", default: 260 },
      { key: "amp", label: "Height", type: "range", min: 2, max: 150, step: 1, unit: "mm", default: 45 },
      { key: "freq", label: "Detail / frequency", type: "range", min: 0.5, max: 8, step: 0.25, default: 2 },
      { key: "rows", label: "Lines", type: "range", min: 6, max: 120, step: 1, default: 36 },
      { key: "bothDirs", label: "Mesh: both directions", type: "toggle", default: true },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
    ]},
    { title: "View", fields: [
      { key: "yawDeg", label: "View yaw (mesh)", type: "range", min: -180, max: 180, step: 5, unit: "°", default: 45 },
      { key: "pitchDeg", label: "View pitch", type: "range", min: 5, max: 90, step: 1, unit: "°", default: 40 },
      { key: "persp", label: "Perspective", type: "range", min: 0, max: 800, step: 10, default: 0 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const mode = String(params.mode ?? "mesh");
    const relief = String(params.relief ?? "noise");
    const size = num(params, "size", 260), half = size / 2;
    const amp = num(params, "amp", 45);
    const freq = num(params, "freq", 2);
    const rows = Math.max(4, Math.round(num(params, "rows", 36)));
    const seed = Math.round(num(params, "seed", 42));
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const cols = Math.max(24, rows * 2);          // samples along each line

    // ---- height function ----
    const noise = makeValueNoise(seed, 12);
    const rng = seededRandom(seed);
    const peaks: { px: number; py: number; s: number; a: number }[] = [];
    for (let i = 0; i < 5; i++) {
      peaks.push({ px: (rng() * 2 - 1) * 0.6, py: (rng() * 2 - 1) * 0.6,
                   s: 0.12 + rng() * 0.2, a: 0.4 + rng() * 0.6 });
    }
    const height = (u: number, vv: number): number => {   // u,vv ∈ [-1,1]
      if (relief === "waves") {
        const r = Math.hypot(u, vv) * freq * Math.PI;
        return amp * Math.cos(r) / (1 + r * 0.6);
      }
      if (relief === "peaks") {
        let z = 0;
        for (const p of peaks) {
          const d2 = ((u - p.px) ** 2 + (vv - p.py) ** 2) / (2 * p.s * p.s);
          z += p.a * Math.exp(-d2);
        }
        return amp * z;
      }
      return amp * noise(u * freq + 3.1, vv * freq + 5.7);
    };

    const paths: Path[] = [];

    if (mode === "ridge") {
      // Front view (yaw 0): rows from NEAR to FAR; each sample column keeps the
      // highest silhouette so far — later (farther) rows are hidden below it.
      const view = makeView(0, num(params, "pitchDeg", 40), num(params, "persp", 0));
      const minY = new Array<number>(cols + 1).fill(Infinity);   // screen y (down): smaller = higher
      for (let ri = 0; ri <= rows; ri++) {
        const vv = -1 + (2 * ri) / rows;              // near (−1) → far (+1)
        let run: Pt[] = [];
        for (let ci = 0; ci <= cols; ci++) {
          const u = -1 + (2 * ci) / cols;
          const w: Vec3 = { x: u * half, y: vv * half, z: height(u, vv) };
          const s = project(view, w);
          const visible = s.y < minY[ci] - 0.05;
          if (visible) {
            run.push({ x: cx + s.x, y: cy + s.y });
            minY[ci] = Math.min(minY[ci], s.y);
          } else if (run.length > 1) {
            paths.push({ points: run }); run = [];
          } else run = [];
        }
        if (run.length > 1) paths.push({ points: run });
      }
    } else {
      const view = makeView(num(params, "yawDeg", 45), num(params, "pitchDeg", 40), num(params, "persp", 0));
      const line = (fixedV: boolean, t: number): Pt[] => {
        const pts: Pt[] = [];
        for (let ci = 0; ci <= cols; ci++) {
          const s = -1 + (2 * ci) / cols;
          const u = fixedV ? s : t;
          const vv = fixedV ? t : s;
          const w: Vec3 = { x: u * half, y: vv * half, z: height(u, vv) };
          const p = project(view, w);
          pts.push({ x: cx + p.x, y: cy + p.y });
        }
        return pts;
      };
      for (let ri = 0; ri <= rows; ri++) {
        const t = -1 + (2 * ri) / rows;
        paths.push({ points: line(true, t) });
        if (params.bothDirs !== false) paths.push({ points: line(false, t) });
      }
    }

    return { widthMm: size, heightMm: size, paths, meta: { title: "Surface 3D" } };
  },
};

register(surface3dModule);
