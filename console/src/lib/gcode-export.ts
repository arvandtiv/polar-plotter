// Frame → G-code export — the inverse of the digester. Turns a Studio design into a
// .gcode program for OTHER machines (our own plotter doesn't need this — it draws from
// the Frame pipeline directly). Pure string in/out. See docs/v1.3/06 / reference gcode-*.
//
// Arc fitting: after the pipeline the paths are polylines. fitArcs() detects genuine
// circular runs and promotes them to G2/G3. Lines that aren't circular stay as G1.

import type { Frame, Pt } from "./frame";
import { fitArcs } from "./arcfit";

export type GcodeProfile = "generic" | "grbl" | "mach4";
export type PenMode = "z" | "spindle";

export interface GcodeExportOpts {
  profile: GcodeProfile;
  penMode: PenMode;
  penUpZ: number;       // z mode
  penDownZ: number;
  drawFeed: number;     // mm/min
  travelFeed: number;   // mm/min (used in z mode for the Z plunge; XY travels are G0)
  flipY: boolean;       // plotter Y is down; most G-code machines want Y up
  arcFit: boolean;      // collapse circular polyline runs into G2/G3 arcs
}

export const DEFAULT_EXPORT: GcodeExportOpts = {
  profile: "generic", penMode: "z", penUpZ: 5, penDownZ: 0,
  drawFeed: 1200, travelFeed: 3000, flipY: true, arcFit: true,
};

// Arc detection tolerance in mm — matches the firmware's chord-error budget so
// circles exported here and re-imported come back as a single arc each.
const ARC_TOL = 0.2;

const header: Record<GcodeProfile, string[]> = {
  generic: ["G21 ; mm", "G90 ; absolute", "G94 ; units/min"],
  grbl:    ["G21", "G90", "G94"],
  mach4:   ["G21 ; mm", "G90 ; absolute", "G17 ; XY plane", "G40 ; cancel cutter comp", "G49 ; cancel tool len", "G94 ; units/min"],
};
const footer: Record<GcodeProfile, string[]> = {
  generic: ["M2"], grbl: ["M2"], mach4: ["M30"],
};

export function exportGcode(frame: Frame, opts: GcodeExportOpts = DEFAULT_EXPORT): string {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const fy = (y: number) => (opts.flipY ? -y : y);
  const lines: string[] = [`; Polar Plotter Studio export — profile ${opts.profile}, pen ${opts.penMode}, arcs ${opts.arcFit ? 'on' : 'off'}`];
  lines.push(...header[opts.profile]);

  const penUp   = () => (opts.penMode === "spindle" ? "M5 ; pen up"   : `G0 Z${n(opts.penUpZ)}`);
  const penDown = () => (opts.penMode === "spindle" ? "M3 ; pen down" : `G1 Z${n(opts.penDownZ)} F${n(opts.travelFeed)}`);

  lines.push(penUp());
  let feedSet = false;

  for (const path of frame.paths) {
    const rawPts: Pt[] = path.closed && path.points.length > 2 ? [...path.points, path.points[0]] : path.points;
    if (rawPts.length < 2) continue;

    const primitives = opts.arcFit
      ? fitArcs(rawPts, ARC_TOL)
      : [{ kind: "line" as const, points: rawPts }];

    // Travel (pen up) to the very first point of this path.
    const first = primitives[0];
    const fp: Pt = first.kind === "line"
      ? first.points[0]
      : { x: first.cx + first.r * Math.cos(first.a0), y: first.cy + first.r * Math.sin(first.a0) };
    lines.push(`G0 X${n(fp.x)} Y${n(fy(fp.y))}`);
    lines.push(penDown());

    for (const prim of primitives) {
      if (prim.kind === "line") {
        // points[0] is always the current machine position (either the G0 destination
        // or the endpoint of the previous primitive) — skip it, emit the rest as G1.
        for (let i = 1; i < prim.points.length; i++) {
          const p = prim.points[i];
          lines.push(`G1 X${n(p.x)} Y${n(fy(p.y))}${feedSet ? "" : ` F${n(opts.drawFeed)}`}`);
          feedSet = true;
        }
      } else {
        // ArcSeg: machine is at the arc start — emit a single G2/G3 to the arc end.
        const sx = prim.cx + prim.r * Math.cos(prim.a0);
        const sy = prim.cy + prim.r * Math.sin(prim.a0);
        const ex = prim.cx + prim.r * Math.cos(prim.a1);
        const ey = prim.cy + prim.r * Math.sin(prim.a1);
        // I/J are the offset from the current XY to the arc centre.
        // When flipY the Y sense reverses, which also flips CW↔CCW:
        //   plotter CW (Y-down) + no flip  → G2 ; + flipY → G3
        //   plotter CCW (Y-down) + no flip → G3 ; + flipY → G2
        const cmd = (prim.cw !== opts.flipY) ? "G2" : "G3";
        const I = n(prim.cx - sx);
        const J = n(fy(prim.cy) - fy(sy));
        lines.push(`${cmd} X${n(ex)} Y${n(fy(ey))} I${I} J${J}${feedSet ? "" : ` F${n(opts.drawFeed)}`}`);
        feedSet = true;
      }
    }

    lines.push(penUp());
  }

  lines.push(...footer[opts.profile]);
  return lines.join("\n") + "\n";
}
