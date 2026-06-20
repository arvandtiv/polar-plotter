// Compile a Frame into the firmware's own API query strings — exactly what
// streamQueries() sends. This is the single funnel every v1.3 feature flows through
// (generators, modifiers, the G-code digester), so they all share one continuous-draw
// emit. See docs/v1.3/ARCHITECTURE.md §4.
//
// Per path: travel pen-up to the start, drop the pen, then draw each segment with
// `lift=0` (the v1.2 continuous-draw flag — no pen bob between segments), lifting once
// at the end. Closed paths also draw the last→first segment.

import type { Frame, Path, Pt } from "./frame";

const r = (n: number) => Math.round(n * 100) / 100;   // 0.01 mm precision, short URLs

function emitPath(path: Path, out: string[]): void {
  const pts = path.points;
  if (pts.length === 0) return;
  const cycles = path.cycles && path.cycles > 0 ? Math.round(path.cycles) : 1;

  out.push(`goto?x=${r(pts[0].x)}&y=${r(pts[0].y)}`);   // pen-up travel to start
  if (pts.length === 1) return;                          // a lone point: nothing to draw
  out.push("pen?pos=down");

  const seg = (a: Pt, b: Pt) =>
    out.push(`line?x0=${r(a.x)}&y0=${r(a.y)}&x1=${r(b.x)}&y1=${r(b.y)}&cycles=${cycles}&lift=0`);

  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
  if (path.closed && pts.length > 2) seg(pts[pts.length - 1], pts[0]);

  out.push("pen?pos=up");
}

/** Frame → ordered list of firmware query strings (feed straight to streamQueries). */
export function compile(frame: Frame): string[] {
  const out: string[] = ["pen?pos=up"];   // known-safe start
  for (const path of frame.paths) emitPath(path, out);
  return out;
}
