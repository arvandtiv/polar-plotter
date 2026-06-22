// Frame → G-code export — the inverse of the digester. Turns a Studio design into a
// .gcode program for OTHER machines (our own plotter doesn't need this — it draws from
// the Frame pipeline directly). Pure string in/out. See docs/v1.3/06 / reference gcode-*.

import type { Frame, Pt } from "./frame";

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
}

export const DEFAULT_EXPORT: GcodeExportOpts = {
  profile: "generic", penMode: "z", penUpZ: 5, penDownZ: 0,
  drawFeed: 1200, travelFeed: 3000, flipY: true,
};

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
  const lines: string[] = [`; Polar Plotter Studio export — profile ${opts.profile}, pen ${opts.penMode}`];
  lines.push(...header[opts.profile]);

  const penUp = () => (opts.penMode === "spindle" ? "M5 ; pen up" : `G0 Z${n(opts.penUpZ)}`);
  const penDown = () => (opts.penMode === "spindle" ? "M3 ; pen down" : `G1 Z${n(opts.penDownZ)} F${n(opts.travelFeed)}`);

  lines.push(penUp());
  let feedSet = false;
  for (const path of frame.paths) {
    const pts: Pt[] = path.closed && path.points.length > 2 ? [...path.points, path.points[0]] : path.points;
    if (pts.length < 2) continue;
    lines.push(`G0 X${n(pts[0].x)} Y${n(fy(pts[0].y))}`);   // rapid travel to start (pen up)
    lines.push(penDown());
    for (let i = 1; i < pts.length; i++) {
      // first cut sets the feed; subsequent G1s inherit it
      lines.push(`G1 X${n(pts[i].x)} Y${n(fy(pts[i].y))}${feedSet ? "" : ` F${n(opts.drawFeed)}`}`);
      feedSet = true;
    }
    lines.push(penUp());
  }
  lines.push(...footer[opts.profile]);
  return lines.join("\n") + "\n";
}
