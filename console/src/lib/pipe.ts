// Pipe engine — a series of hand-wobbled circles laid along an invisible SPINE,
// radius controlled either by a simple rMin→rMax ramp or a MULTI-POINT size profile
// (`sizeStops`, same convention as ruledLines' densityStops: comma-separated values at
// evenly spaced positions along the path, piecewise-linear interpolated).
// Shared by the randomWalker pipe mode and the standalone `pipe` module (arc/line spine).

import type { Path, Pt } from "./frame";

/** Parse "1, 8, 2, 10" → [1,8,2,10]; anything non-finite/≤0 dropped. <2 values = none. */
export function parseSizeStops(raw: unknown): number[] {
  const v = String(raw ?? "").split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  return v.length >= 2 ? v : [];
}

/** Radius at path fraction t∈[0,1]: multi-point stops when given, else rMin→rMax lerp. */
export function radiusAt(t: number, stops: number[], rMin: number, rMax: number): number {
  if (stops.length >= 2) {
    const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    return stops[i] * (1 - f) + stops[i + 1] * f;
  }
  return rMin + (rMax - rMin) * t;
}

export interface PipeOpts {
  rMin: number;
  rMax: number;
  sizeStops: number[];   // ≥2 values → overrides rMin/rMax
  spacing: number;       // distance between circle centres along the spine (mm)
  jitter: number;        // hand-wobble per circle (mm); 0 = true circles (arc-fit friendly)
  rng: () => number;
}

/** One hand-wobbled circle: radius modulated by two low-order harmonics with a random
 *  phase/mix per circle — a living ring, never CAD-crisp (unless jitter=0, in which
 *  case the compiler's arc-fitter collapses it into a single firmware arc job). */
export function wobblyRing(cx: number, cy: number, r: number, jitter: number, rng: () => number): Pt[] {
  const n = Math.min(96, Math.max(12, Math.round((2 * Math.PI * r) / 1.5)));
  const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
  const k1 = 2 + Math.floor(rng() * 2), k2 = 3 + Math.floor(rng() * 3);
  const amp = jitter * (0.7 + 0.6 * rng());
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const rr = r + amp * (0.6 * Math.sin(a * k1 + p1) + 0.4 * Math.sin(a * k2 + p2));
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
  }
  return pts;
}

/** Circles along a spine polyline: one every `spacing` mm of arc length; radius from
 *  radiusAt(t) with t = arc-length fraction (0 = spine start, 1 = spine end). */
export function pipeAlongSpine(spine: Pt[], o: PipeOpts, out: Path[], cycles = 1): void {
  let total = 0;
  for (let i = 1; i < spine.length; i++)
    total += Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y);
  if (total < 1e-6) return;
  const spacing = Math.max(0.5, o.spacing);
  let seg = 0;
  let segStart = 0;
  let segLen = Math.hypot(spine[1].x - spine[0].x, spine[1].y - spine[0].y);
  for (let d = 0; d <= total; d += spacing) {
    while (d > segStart + segLen && seg < spine.length - 2) {
      segStart += segLen;
      seg++;
      segLen = Math.hypot(spine[seg + 1].x - spine[seg].x, spine[seg + 1].y - spine[seg].y);
    }
    const f = segLen > 1e-9 ? (d - segStart) / segLen : 0;
    const cx = spine[seg].x + (spine[seg + 1].x - spine[seg].x) * f;
    const cy = spine[seg].y + (spine[seg + 1].y - spine[seg].y) * f;
    const r = radiusAt(d / total, o.sizeStops, o.rMin, o.rMax);
    if (r > 0.05) out.push({ points: wobblyRing(cx, cy, r, o.jitter, o.rng), closed: true, cycles });
  }
}
