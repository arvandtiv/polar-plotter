// Tube 3D — the pipe, lifted into 3D: rings swept along a THREE-dimensional spine
// (dive into the page, helix, tilted arc, 3D random walk) and projected isometrically.
// Rings become foreshortened ellipses; depth is cued the 80s way — ring spacing opens
// up as the tube recedes (far = sparse/light, near = dense/dark) — and ring size runs
// rMin→rMax or a multi-point `sizeStops` profile. Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import { parseSizeStops, radiusAt } from "../pipe";
import { makeView, project, ringFrame, norm, sub, type Vec3 } from "../iso";
import type { Frame, Path, Pt } from "../frame";

export const tube3dModule: Module = {
  key: "tube3d",
  label: "Tube 3D",
  kind: "make",
  group: "3D Wireframe",
  description: "Rings along a 3D spine (dive / helix / arc / 3D walk), projected isometrically — a wireframe tube with depth-cued ring density and multi-point size stops.",
  sections: [
    { title: "Spine", fields: [
      { key: "spine", label: "Spine", type: "select", default: "dive", options: [
        { value: "dive",  label: "Dive (straight, into the page)" },
        { value: "helix", label: "Helix" },
        { value: "arc3d", label: "Tilted arc" },
        { value: "walk3d", label: "3D random walk" },
      ]},
      { key: "length", label: "Length / height", type: "range", min: 20, max: 500, step: 5, unit: "mm", default: 220 },
      { key: "spineR", label: "Helix / arc radius", type: "range", min: 5, max: 200, step: 1, unit: "mm", default: 70 },
      { key: "turns", label: "Helix turns", type: "range", min: 0.25, max: 8, step: 0.25, default: 2 },
      { key: "tiltDeg", label: "Arc tilt", type: "range", min: 0, max: 90, step: 5, unit: "°", default: 60 },
      { key: "wander", label: "Walk wander", type: "range", min: 0, max: 3, step: 0.1, default: 1.2 },
    ]},
    { title: "Rings", fields: [
      { key: "rMin", label: "Start radius (min r)", type: "range", min: 0.5, max: 80, step: 0.5, unit: "mm", default: 6 },
      { key: "rMax", label: "End radius (max r)", type: "range", min: 0.5, max: 80, step: 0.5, unit: "mm", default: 22 },
      { key: "sizeStops", label: "Size stops", type: "text", placeholder: "e.g. 4,18,6,24  (overrides min/max)", default: "" },
      { key: "spacing", label: "Ring spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 5 },
      { key: "depthCue", label: "Depth fade (spacing)", type: "range", min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 4, step: 0.1, unit: "mm", default: 0.6 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
    ]},
    { title: "View", fields: [
      { key: "yawDeg", label: "View yaw", type: "range", min: -180, max: 180, step: 5, unit: "°", default: 45 },
      { key: "pitchDeg", label: "View pitch", type: "range", min: 0, max: 90, step: 1, unit: "°", default: 35 },
      { key: "persp", label: "Perspective", type: "range", min: 0, max: 800, step: 10, default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],
  generate(params): Frame {
    const spineKind = String(params.spine ?? "dive");
    const L = num(params, "length", 220);
    const SR = num(params, "spineR", 70);
    const rng = seededRandom(Math.round(num(params, "seed", 42)));
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const jitter = Math.max(0, num(params, "jitter", 0.6));
    const stops = parseSizeStops(params.sizeStops);
    const rMin = Math.max(0.1, num(params, "rMin", 6));
    const rMax = Math.max(0.1, num(params, "rMax", 22));
    const baseSpacing = Math.max(0.5, num(params, "spacing", 5));
    const depthCue = Math.max(0, Math.min(1, num(params, "depthCue", 0.5)));
    const view = makeView(num(params, "yawDeg", 45), num(params, "pitchDeg", 35), num(params, "persp", 300));
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);

    // ---- build the 3D spine (sampled ~2 mm) ----
    const spine: Vec3[] = [];
    if (spineKind === "helix") {
      const n = Math.max(24, Math.ceil(L / 2));
      const turns = num(params, "turns", 2);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const a = t * turns * 2 * Math.PI;
        spine.push({ x: SR * Math.cos(a), y: SR * Math.sin(a), z: L * (t - 0.5) });
      }
    } else if (spineKind === "arc3d") {
      const tilt = (num(params, "tiltDeg", 60) * Math.PI) / 180;
      const R = Math.max(10, L / 2);
      const n = Math.max(24, Math.ceil((Math.PI * R) / 2));
      for (let i = 0; i <= n; i++) {
        const a = Math.PI * (i / n);           // half circle
        const px = R * Math.cos(a), pz = R * Math.sin(a);
        spine.push({ x: px, y: pz * Math.sin(tilt), z: pz * Math.cos(tilt) - R / 2 });
      }
    } else if (spineKind === "walk3d") {
      const wander = num(params, "wander", 1.2);
      const stepLen = 3;
      const n = Math.max(10, Math.ceil(L / stepLen));
      let p: Vec3 = { x: 0, y: -L / 2, z: 0 };
      let d: Vec3 = { x: 0, y: 1, z: 0 };      // heading into the page
      for (let i = 0; i <= n; i++) {
        spine.push({ ...p });
        d = norm({
          x: d.x + (rng() - 0.5) * 0.4 * wander,
          y: d.y + (rng() - 0.5) * 0.2 * wander,
          z: d.z + (rng() - 0.5) * 0.4 * wander,
        });
        p = { x: p.x + d.x * stepLen, y: p.y + d.y * stepLen, z: p.z + d.z * stepLen };
      }
    } else {
      // dive: straight into the page, drifting slightly right & down for a dynamic angle
      spine.push({ x: -L * 0.18, y: -L / 2, z: L * 0.12 });
      spine.push({ x: L * 0.18, y: L / 2, z: -L * 0.12 });
    }

    // resample helper: walk arc length, place rings; spacing widens with depth (cue)
    const seglen = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    let total = 0;
    for (let i = 1; i < spine.length; i++) total += seglen(spine[i - 1], spine[i]);
    if (total < 1e-6) return { widthMm: 10, heightMm: 10, paths: [], meta: { title: "Tube 3D" } };

    // depth range for the cue (project spine endpoints & mid to estimate)
    let dMin = Infinity, dMax = -Infinity;
    for (const p of spine) {
      const d = project(view, p).depth;
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
    const dSpan = Math.max(1e-6, dMax - dMin);

    const paths: Path[] = [];
    let seg = 0, segStart = 0, segLen = seglen(spine[0], spine[1]);
    for (let d = 0; d <= total; ) {
      while (d > segStart + segLen && seg < spine.length - 2) {
        segStart += segLen; seg++;
        segLen = seglen(spine[seg], spine[seg + 1]);
      }
      const f = segLen > 1e-9 ? (d - segStart) / segLen : 0;
      const C: Vec3 = {
        x: spine[seg].x + (spine[seg + 1].x - spine[seg].x) * f,
        y: spine[seg].y + (spine[seg + 1].y - spine[seg].y) * f,
        z: spine[seg].z + (spine[seg + 1].z - spine[seg].z) * f,
      };
      const T = sub(spine[seg + 1], spine[seg]);
      const { N, B } = ringFrame(T);
      const r = radiusAt(d / total, stops, rMin, rMax);

      const depthN = (project(view, C).depth - dMin) / dSpan;   // 0 = nearest, 1 = farthest
      if (r > 0.05) {
        const npts = Math.min(96, Math.max(12, Math.round((2 * Math.PI * r) / 1.5)));
        const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
        const k1 = 2 + Math.floor(rng() * 2), k2 = 3 + Math.floor(rng() * 3);
        const amp = jitter * (0.7 + 0.6 * rng());
        const ring: Pt[] = [];
        for (let i = 0; i < npts; i++) {
          const a = (i / npts) * 2 * Math.PI;
          const rr = r + amp * (0.6 * Math.sin(a * k1 + p1) + 0.4 * Math.sin(a * k2 + p2));
          const w: Vec3 = {
            x: C.x + rr * (N.x * Math.cos(a) + B.x * Math.sin(a)),
            y: C.y + rr * (N.y * Math.cos(a) + B.y * Math.sin(a)),
            z: C.z + rr * (N.z * Math.cos(a) + B.z * Math.sin(a)),
          };
          const s = project(view, w);
          ring.push({ x: cx + s.x, y: cy + s.y });
        }
        paths.push({ points: ring, closed: true, cycles });
      }
      // 80s depth fog: farther rings sit farther apart (up to 3× at full cue)
      d += baseSpacing * (1 + depthCue * 2 * depthN);
    }

    const ext = L + 2 * Math.max(rMax, ...(stops.length ? stops : [0]));
    return { widthMm: ext, heightMm: ext, paths, meta: { title: "Tube 3D" } };
  },
};

register(tube3dModule);
