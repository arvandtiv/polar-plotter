// Orbital Weave generator — a single continuous trace: a small ellipse (the "loop")
// whose centre orbits the page, weaving harmonograph-style knots. Pure/deterministic.
// point(s) = orbit(orbitTurns·s) + loop(traceTurns·s);  closes when both turns integer.

import { register, num, type Module } from "../registry";
import type { Frame, Path, Pt } from "../frame";

export const orbitalWeaveModule: Module = {
  key: "orbitalWeave",
  label: "Orbital Weave",
  kind: "make",
  group: "Lines & Patterns",
  description: "A continuous orbiting trace that folds into airy woven knots.",
  sections: [
    { title: "Orbit", fields: [
      { key: "orbitRadius", label: "Orbit radius", type: "range", min: 0, max: 250, step: 1, unit: "mm", default: 50 },
      { key: "orbitTurns", label: "Orbit turns", type: "range", min: 1, max: 24, step: 1, default: 1 },
    ]},
    { title: "Loop", fields: [
      { key: "majorRadius", label: "Loop major", type: "range", min: 0, max: 200, step: 1, unit: "mm", default: 24 },
      { key: "minorRadius", label: "Loop minor", type: "range", min: 0, max: 200, step: 1, unit: "mm", default: 24 },
      { key: "traceTurns", label: "Trace turns", type: "range", min: 1, max: 400, step: 1, default: 13 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],
  generate(params): Frame {
    const orbitR = num(params, "orbitRadius", 50);
    const orbitTurns = Math.max(1, Math.round(num(params, "orbitTurns", 1)));
    const majorR = num(params, "majorRadius", 24);
    const minorR = num(params, "minorRadius", 24);
    const traceTurns = Math.max(1, Math.round(num(params, "traceTurns", 13)));
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));

    const n = Math.max(240, Math.min(8000, traceTurns * 120));
    const points: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const phi = 2 * Math.PI * orbitTurns * s;
      const theta = 2 * Math.PI * traceTurns * s;
      const x = orbitR * Math.cos(phi) + majorR * Math.cos(theta);
      const y = orbitR * Math.sin(phi) + minorR * Math.sin(theta);
      points.push({ x: cx + x, y: cy + y });
    }
    const path: Path = { points, closed: false, cycles };
    const span = orbitR + Math.max(majorR, minorR);
    return { widthMm: 2 * span, heightMm: 2 * span, paths: [path], meta: { title: "Orbital Weave" } };
  },
};

register(orbitalWeaveModule);
