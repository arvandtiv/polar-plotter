// Iso Forms — 80s isometric solids: cube, LeWitt-style cube stacks (#766), pyramid,
// icosahedron, and a lathe (solid of revolution, vase-like). Convex solids get
// BACKFACE CULLING (clean hidden-face look without a real HLR engine) and optional
// LIGHT SHADING: visible faces are hatched with line density ∝ darkness (N·L) —
// "shaders" in pen-plotter terms. X-ray mode draws every edge instead (pure
// wireframe). `jitter` runs the geometry through the hand-drawn lens. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import { hatchPolygon } from "./fill";
import { makeView, project, facingDepth, norm, sub, cross, dot, type Vec3, type IsoView } from "../iso";
import type { Frame, Path, Pt } from "../frame";

interface Mesh { verts: Vec3[]; faces: number[][]; }

function cubeMesh(px: number, py: number, s: number): Mesh {
  const h = s / 2;
  const v: Vec3[] = [
    { x: px - h, y: py - h, z: 0 }, { x: px + h, y: py - h, z: 0 },
    { x: px + h, y: py + h, z: 0 }, { x: px - h, y: py + h, z: 0 },
    { x: px - h, y: py - h, z: s }, { x: px + h, y: py - h, z: s },
    { x: px + h, y: py + h, z: s }, { x: px - h, y: py + h, z: s },
  ];
  // outward-wound faces (CCW seen from outside)
  const f = [
    [0, 1, 5, 4],   // front  (−y)
    [1, 2, 6, 5],   // right  (+x)
    [2, 3, 7, 6],   // back   (+y)
    [3, 0, 4, 7],   // left   (−x)
    [4, 5, 6, 7],   // top    (+z)
    [3, 2, 1, 0],   // bottom (−z)
  ];
  return { verts: v, faces: f };
}

function pyramidMesh(s: number): Mesh {
  const h = s / 2;
  const v: Vec3[] = [
    { x: -h, y: -h, z: 0 }, { x: h, y: -h, z: 0 }, { x: h, y: h, z: 0 }, { x: -h, y: h, z: 0 },
    { x: 0, y: 0, z: s * 1.1 },
  ];
  return { verts: v, faces: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [3, 2, 1, 0]] };
}

function icosaMesh(s: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: [number, number, number][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const k = s / (2 * Math.hypot(1, t));
  const verts = raw.map(([x, y, z]) => ({ x: x * k, y: y * k, z: z * k + s * 0.55 }));
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { verts, faces };
}

/** Resample a projected polygon edge-wise and hand-perturb interior points. */
function handPoly(pts: Pt[], jitter: number, rng: () => number): Pt[] {
  if (jitter <= 0) return pts;
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.round(len / 8));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const wob = k === 0 ? 0.4 : 1;   // corners wobble less than edge interiors
      out.push({
        x: a.x + (b.x - a.x) * t + (rng() - 0.5) * 2 * jitter * wob,
        y: a.y + (b.y - a.y) * t + (rng() - 0.5) * 2 * jitter * wob,
      });
    }
  }
  return out;
}

function drawMesh(mesh: Mesh, view: IsoView, cx: number, cy: number, o: {
  xray: boolean; shade: boolean; light: Vec3; shadeSpacing: number;
  jitter: number; rng: () => number; cycles: number;
}, out: Path[]): void {
  if (o.xray) {
    // every unique edge once
    const seen = new Set<string>();
    for (const f of mesh.faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pa = project(view, mesh.verts[a]), pb = project(view, mesh.verts[b]);
        const seg = handPoly([{ x: cx + pa.x, y: cy + pa.y }, { x: cx + pb.x, y: cy + pb.y }], o.jitter, o.rng);
        out.push({ points: seg.length > 2 ? seg : [{ x: cx + pa.x, y: cy + pa.y }, { x: cx + pb.x, y: cy + pb.y }], cycles: o.cycles });
      }
    }
    return;
  }
  for (const f of mesh.faces) {
    const a = mesh.verts[f[0]], b = mesh.verts[f[1]], c = mesh.verts[f[2]];
    const n = norm(cross(sub(b, a), sub(c, a)));
    if (facingDepth(view, n) >= 0) continue;          // backface → hidden
    const poly: Pt[] = f.map((vi) => {
      const p = project(view, mesh.verts[vi]);
      return { x: cx + p.x, y: cy + p.y };
    });
    const drawn = handPoly(poly, o.jitter, o.rng);
    out.push({ points: drawn, closed: true, cycles: o.cycles });
    if (o.shade) {
      const bright = Math.max(0, dot(n, o.light));    // 1 = lit, 0 = dark
      if (bright < 0.85) {
        const spacing = o.shadeSpacing * (0.6 + 3 * bright);
        for (const h of hatchPolygon(poly, spacing, 45)) {
          out.push({ points: handPoly(h.points, o.jitter * 0.5, o.rng).length > 2 && o.jitter > 0
            ? handPoly(h.points, o.jitter * 0.5, o.rng) : h.points });
        }
      }
    }
  }
}

export const isoFormsModule: Module = {
  key: "isoForms",
  label: "Iso Forms",
  kind: "make",
  group: "3D Wireframe",
  description: "Isometric solids: cube / LeWitt cube stack / pyramid / icosahedron / lathe vase. Backface-culled with light-density face shading, or X-ray wireframe. Hand jitter optional.",
  sections: [
    { title: "Form", fields: [
      { key: "form", label: "Form", type: "select", default: "stack", options: [
        { value: "cube", label: "Cube" },
        { value: "stack", label: "Cube stack (LeWitt #766)" },
        { value: "pyramid", label: "Pyramid" },
        { value: "icosa", label: "Icosahedron" },
        { value: "lathe", label: "Lathe (vase of revolution)" },
      ]},
      { key: "size", label: "Size", type: "range", min: 10, max: 250, step: 1, unit: "mm", default: 90 },
      { key: "count", label: "Stack: cubes", type: "range", min: 2, max: 24, step: 1, default: 7 },
      { key: "spread", label: "Stack: spread", type: "range", min: 20, max: 300, step: 5, unit: "mm", default: 150 },
      { key: "detail", label: "Lathe: detail", type: "range", min: 6, max: 32, step: 1, default: 14 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
    ]},
    { title: "Render", fields: [
      { key: "xray", label: "X-ray (all edges)", type: "toggle", default: false },
      { key: "shade", label: "Shade faces by light", type: "toggle", default: true },
      { key: "lightDeg", label: "Light direction", type: "range", min: -180, max: 180, step: 5, unit: "°", default: -60 },
      { key: "shadeSpacing", label: "Shade spacing", type: "range", min: 0.5, max: 12, step: 0.5, unit: "mm", default: 2.5 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 3, step: 0.1, unit: "mm", default: 0.5 },
    ]},
    { title: "View", fields: [
      { key: "yawDeg", label: "View yaw", type: "range", min: -180, max: 180, step: 5, unit: "°", default: 45 },
      { key: "pitchDeg", label: "View pitch", type: "range", min: 5, max: 90, step: 1, unit: "°", default: 35 },
      { key: "persp", label: "Perspective", type: "range", min: 0, max: 800, step: 10, default: 0 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 20 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],
  generate(params): Frame {
    const form = String(params.form ?? "stack");
    const size = num(params, "size", 90);
    const seed = Math.round(num(params, "seed", 42));
    const rng = seededRandom(seed);
    const view = makeView(num(params, "yawDeg", 45), num(params, "pitchDeg", 35), num(params, "persp", 0));
    const cx = num(params, "cx", 0), cy = num(params, "cy", 20);
    const az = (num(params, "lightDeg", -60) * Math.PI) / 180;
    const alt = Math.PI / 4;
    const o = {
      xray: params.xray === true,
      shade: params.shade !== false,
      light: norm({ x: Math.cos(alt) * Math.cos(az), y: Math.cos(alt) * Math.sin(az), z: Math.sin(alt) }),
      shadeSpacing: Math.max(0.5, num(params, "shadeSpacing", 2.5)),
      jitter: Math.max(0, num(params, "jitter", 0.5)),
      rng,
      cycles: Math.max(1, Math.round(num(params, "cycles", 1))),
    };

    const paths: Path[] = [];

    if (form === "lathe") {
      // Vase: seeded harmonic profile revolved about z — meridians + parallels (X-ray).
      const det = Math.max(6, Math.round(num(params, "detail", 14)));
      const H = size * 1.6;
      const ph1 = rng() * Math.PI * 2, ph2 = rng() * Math.PI * 2;
      const prof = (t: number) =>
        (size / 2) * (0.55 + 0.30 * Math.sin(Math.PI * (0.15 + 0.7 * t))
                      + 0.18 * Math.sin(2 * Math.PI * t + ph1)
                      + 0.08 * Math.sin(4 * Math.PI * t + ph2));
      const meridians = det, parallels = Math.max(4, Math.round(det * 0.8)), tSteps = det * 3;
      for (let m = 0; m < meridians; m++) {
        const a = (m / meridians) * 2 * Math.PI;
        const pts: Pt[] = [];
        for (let i = 0; i <= tSteps; i++) {
          const t = i / tSteps;
          const r = Math.max(1, prof(t));
          const p = project(view, { x: r * Math.cos(a), y: r * Math.sin(a), z: t * H });
          pts.push({ x: cx + p.x, y: cy + p.y + (H / 2) * view.cosP });
        }
        paths.push({ points: handPoly(pts, o.jitter * 0.4, rng).length > 2 && o.jitter > 0 ? handPoly(pts, o.jitter * 0.4, rng) : pts, cycles: o.cycles });
      }
      for (let k = 0; k <= parallels; k++) {
        const t = k / parallels;
        const r = Math.max(1, prof(t));
        const n = Math.max(24, Math.round(r));
        const pts: Pt[] = [];
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * 2 * Math.PI;
          const p = project(view, { x: r * Math.cos(a), y: r * Math.sin(a), z: t * H });
          pts.push({ x: cx + p.x, y: cy + p.y + (H / 2) * view.cosP });
        }
        paths.push({ points: pts, cycles: o.cycles });
      }
    } else if (form === "stack") {
      // LeWitt #766: cubes of varying sizes scattered on the ground plane; drawn
      // far-to-near so shading overlaps read naturally (X-ray overlaps stay 80s).
      const count = Math.max(2, Math.round(num(params, "count", 7)));
      const spread = num(params, "spread", 150);
      const cubes: { px: number; py: number; s: number }[] = [];
      for (let i = 0; i < count; i++) {
        cubes.push({
          px: (rng() * 2 - 1) * spread / 2,
          py: (rng() * 2 - 1) * spread / 2,
          s: size * (0.25 + rng() * 0.75),
        });
      }
      cubes.sort((a, b) => project(view, { x: b.px, y: b.py, z: 0 }).depth
                         - project(view, { x: a.px, y: a.py, z: 0 }).depth);
      for (const c of cubes) drawMesh(cubeMesh(c.px, c.py, c.s), view, cx, cy, o, paths);
    } else {
      const mesh = form === "pyramid" ? pyramidMesh(size)
                 : form === "icosa" ? icosaMesh(size)
                 : cubeMesh(0, 0, size);
      drawMesh(mesh, view, cx, cy, o, paths);
    }

    const ext = form === "stack" ? num(params, "spread", 150) + size * 2 : size * 2.2;
    return { widthMm: ext, heightMm: ext, paths, meta: { title: "Iso Forms" } };
  },
};

register(isoFormsModule);
