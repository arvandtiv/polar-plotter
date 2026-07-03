// Wrap 3D modifier — bends the 2D composition below onto a 3D surface (cylinder,
// sphere, or a wave heightfield) and projects it isometrically. kind:"modify".
// Any generator becomes a texture on a 3D body: ruledLines on a cylinder = a shaded
// tube, flowWhirls on a sphere = a swirling globe. Cylinder/sphere hide the far side
// by default (hideBack) so the silhouette reads as a solid; the wave is a drape.
// Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { makeView, project, facingDepth, type Vec3 } from "../iso";
import type { Frame, Path, Pt } from "../frame";

export const wrap3dModule: Module = {
  key: "wrap3d",
  label: "Wrap 3D",
  kind: "modify",
  group: "3D Wireframe",
  description: "Bend the layers below onto a cylinder / sphere / wave surface and project isometrically — any 2D pattern becomes a texture on a 3D body.",
  sections: [
    { title: "Surface", fields: [
      { key: "surface", label: "Surface", type: "select", default: "cylinder", options: [
        { value: "cylinder", label: "Cylinder (X wraps around)" },
        { value: "sphere", label: "Sphere (equirectangular)" },
        { value: "wave", label: "Wave drape (heightfield)" },
      ]},
      { key: "radius", label: "Body radius", type: "range", min: 10, max: 250, step: 1, unit: "mm", default: 70 },
      { key: "waveAmp", label: "Wave height", type: "range", min: 1, max: 100, step: 1, unit: "mm", default: 28 },
      { key: "waveLen", label: "Wavelength", type: "range", min: 10, max: 300, step: 5, unit: "mm", default: 90 },
      { key: "hideBack", label: "Hide far side", type: "toggle", default: true },
    ]},
    { title: "View", fields: [
      { key: "yawDeg", label: "View yaw", type: "range", min: -180, max: 180, step: 5, unit: "°", default: 25 },
      { key: "pitchDeg", label: "View pitch", type: "range", min: 0, max: 90, step: 1, unit: "°", default: 20 },
      { key: "persp", label: "Perspective", type: "range", min: 0, max: 800, step: 10, default: 250 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params, ctx): Frame {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const surface = String(params.surface ?? "cylinder");
    const R = Math.max(5, num(params, "radius", 70));
    const wAmp = num(params, "waveAmp", 28);
    const wLen = Math.max(5, num(params, "waveLen", 90));
    const hideBack = params.hideBack !== false && surface !== "wave";
    const view = makeView(num(params, "yawDeg", 25), num(params, "pitchDeg", 20), num(params, "persp", 250));
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);

    // 2D (x, y down) → surface point + outward normal. Input x wraps around the
    // body; input y runs along the axis (cylinder) / latitude (sphere) / ground (wave).
    const map = (p: Pt): { w: Vec3; n: Vec3 } => {
      if (surface === "sphere") {
        const lon = p.x / R;
        const lat = Math.max(-1.45, Math.min(1.45, -p.y / R));
        const n: Vec3 = {
          x: Math.cos(lat) * Math.sin(lon),
          y: -Math.cos(lat) * Math.cos(lon),
          z: Math.sin(lat),
        };
        return { w: { x: n.x * R, y: n.y * R, z: n.z * R }, n };
      }
      if (surface === "wave") {
        const k = (2 * Math.PI) / wLen;
        const z = wAmp * Math.sin(p.x * k) * Math.cos(p.y * k * 0.8);
        return { w: { x: p.x, y: p.y * 0.9, z }, n: { x: 0, y: 0, z: 1 } };
      }
      // cylinder: axis vertical (z); input y down → down the axis
      const a = p.x / R;
      const n: Vec3 = { x: Math.sin(a), y: -Math.cos(a), z: 0 };
      return { w: { x: n.x * R, y: n.y * R, z: -p.y }, n };
    };

    const paths: Path[] = [];
    for (const path of lower.paths) {
      const src = path.closed && path.points.length > 2
        ? [...path.points, path.points[0]]
        : path.points;
      // resample so curves hug the surface (long straight segments would chord it)
      const fine: Pt[] = [];
      for (let i = 0; i < src.length; i++) {
        const a = src[i];
        if (i === 0) { fine.push(a); continue; }
        const b = src[i - 1];
        const len = Math.hypot(a.x - b.x, a.y - b.y);
        const steps = Math.max(1, Math.ceil(len / 2));
        for (let k = 1; k <= steps; k++)
          fine.push({ x: b.x + (a.x - b.x) * (k / steps), y: b.y + (a.y - b.y) * (k / steps) });
      }
      // map + project, splitting runs whenever the surface turns away from the viewer
      let run: Pt[] = [];
      for (const p of fine) {
        const { w, n } = map(p);
        const visible = !hideBack || facingDepth(view, n) < 0.05;
        if (visible) {
          const s = project(view, w);
          run.push({ x: cx + s.x, y: cy + s.y });
        } else if (run.length > 1) {
          paths.push({ points: run, cycles: path.cycles }); run = [];
        } else run = [];
      }
      if (run.length > 1) paths.push({ points: run, cycles: path.cycles });
    }

    return { widthMm: lower.widthMm, heightMm: lower.heightMm, paths, meta: { title: "Wrap 3D" } };
  },
};

register(wrap3dModule);
