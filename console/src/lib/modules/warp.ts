// Warp / Ripple modifier — displaces the layers below by a field. kind:"modify".
//   water:   glassy sinusoidal warp (offset by sin of the orthogonal coordinate)
//   droplet: radial rings from a centre, decaying with distance (a dropped stone)
// Resamples paths first so the displacement is smooth. Registers on import.

import { register, num, type Module } from "../registry";
import { resample } from "../geom";
import type { Frame, Path, Pt } from "../frame";

export const warpModule: Module = {
  key: "warp",
  label: "Warp / Ripple",
  kind: "modify",
  group: "Modifiers",
  description: "Displaces the geometry below with a water warp or droplet ripples.",
  sections: [
    { title: "Ripple", fields: [
      { key: "mode", label: "Mode", type: "select", default: "water",
        options: [{ value: "water", label: "Water" }, { value: "droplet", label: "Droplet" }] },
      { key: "amplitude", label: "Amplitude", type: "range", min: 0, max: 40, step: 0.5, unit: "mm", default: 8 },
      { key: "wavelength", label: "Wavelength", type: "range", min: 5, max: 200, step: 1, unit: "mm", default: 60 },
      { key: "falloff", label: "Falloff", type: "range", min: 0, max: 0.05, step: 0.001, default: 0.01 },
      { key: "resample", label: "Resample", type: "toggle", default: true },
    ]},
    { title: "Center", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params, ctx): Frame {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const droplet = String(params.mode ?? "water") === "droplet";
    const amp = num(params, "amplitude", 8);
    const wl = Math.max(1, num(params, "wavelength", 60));
    const falloff = num(params, "falloff", 0.01);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const doResample = params.resample !== false;
    const k = (2 * Math.PI) / wl;

    const displace = (p: Pt): Pt => {
      if (droplet) {
        const dx = p.x - cx, dy = p.y - cy;
        const r = Math.hypot(dx, dy);
        if (r < 1e-6) return { ...p };
        const d = amp * Math.sin(k * r) * Math.exp(-falloff * r);
        return { x: p.x + (dx / r) * d, y: p.y + (dy / r) * d };
      }
      return { x: p.x + amp * Math.sin(k * (p.y - cy)), y: p.y + amp * Math.sin(k * (p.x - cx)) };
    };

    const spacing = Math.max(1, wl / 8);
    const paths: Path[] = lower.paths.map((path) => {
      const src = doResample && path.points.length > 1 ? resample(path.points, spacing) : path.points;
      return { ...path, points: src.map(displace) };
    });
    return { ...lower, paths, meta: { title: "Warp / Ripple" } };
  },
};

register(warpModule);
