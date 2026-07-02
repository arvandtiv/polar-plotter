// Ruled-lines generator — fills a rectangular region with evenly-spaced STRAIGHT parallel
// lines in any combination of the four LeWitt directions (vertical, horizontal, and the two
// diagonals), superimposed. This is the workhorse for Sol LeWitt's line-direction wall
// drawings (#11, #16, #17, #19, #47, #56, #85 …): "kinds of lines" = these four directions.
// Registers on import. Pure; diagonals are clipped to the region with clipSegmentToRect.

import { register, num, type Module } from "../registry";
import { clipSegmentToRect, seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Drop offsets closer than `minGap` to the previously kept one (a paper-rip guard so dense
 *  density peaks can't saturate to a solid). `minGap <= 0` disables it. */
function clampGap(offs: number[], minGap: number): number[] {
  if (minGap <= 0) return offs;
  const out: number[] = [];
  let last = -Infinity;
  for (const o of offs) {
    if (o - last >= minGap) { out.push(o); last = o; }
  }
  return out;
}

/** Build the line offsets across a band [omin, omax].
 *  - `stops` (≥2) = a MULTI-POINT density profile d(u), u∈[0,1] at evenly-spaced control points,
 *    piecewise-linear interpolated. Lines are placed by the inverse-CDF of d, so local spacing
 *    ∝ 1/density and `s` sets the overall scale. u=0 is the omin (+normal) end. A 0 stop = a gap.
 *  - else `gradient` > 0 = the single-ended power ramp (packs toward omin).
 *  - else uniform. */
function bandOffsets(omin: number, omax: number, s: number, gradient: number, stops: number[], minGap: number): number[] {
  const span = omax - omin;
  if (span <= 0) return [omin];

  if (stops.length >= 2) {
    const dens = (u: number): number => {
      const x = u * (stops.length - 1);
      const i = Math.min(stops.length - 2, Math.floor(x));
      const f = x - i;
      return Math.max(0, stops[i] * (1 - f) + stops[i + 1] * f);
    };
    // sample the density fine, integrate to a CDF (trapezoid), then invert to equal-ink offsets
    const M = 400;
    const cdf = new Array<number>(M + 1);
    cdf[0] = 0;
    for (let i = 1; i <= M; i++) cdf[i] = cdf[i - 1] + 0.5 * (dens((i - 1) / M) + dens(i / M)) / M;
    const total = cdf[M];
    if (total > 1e-9) {
      const N = Math.max(1, Math.round(span / s));
      const offs: number[] = [];
      let j = 0;
      for (let k = 0; k <= N; k++) {
        const target = (k / N) * total;
        while (j < M && cdf[j + 1] < target) j++;
        const segLen = cdf[j + 1] - cdf[j];
        const f = segLen > 1e-12 ? (target - cdf[j]) / segLen : 0;
        offs.push(omin + span * ((j + f) / M));
      }
      return clampGap(offs, minGap);
    }
    // total density 0 → fall through to uniform
  }

  const offs: number[] = [];
  if (gradient > 0) {
    const N = Math.max(1, Math.round(span / s)), p = 1 + 2 * gradient;
    for (let k = 0; k <= N; k++) offs.push(omin + span * Math.pow(k / N, p));
  } else {
    for (let o = Math.ceil(omin / s) * s; o <= omax + 1e-9; o += s) offs.push(o);
  }
  return clampGap(offs, minGap);
}

/** Parallel lines through `rect` at angle `theta` (screen coords, y-down), spaced `spacing`.
 *  `jitter` > 0 makes them NOT straight: each line is resampled and pushed sideways by smooth
 *  seeded noise (a hand-drawn / Klee "living line" quality). `rng` is shared for determinism. */

/** Not-straight line a→b as a chain of GENUINE circular arcs (G1 tangent-continuous —
 *  the heading never jumps, so bows flow into each other with no sharp deviations).
 *  Each arc's sagitta ≈ jitter, bow side alternating, chord ~35–75 mm randomized per
 *  line. Built from the origin heading +x, then rotated+uniformly-scaled onto a→b
 *  (endpoints land EXACTLY on the rect edges; scaling keeps circles circular, so the
 *  compiler's arc-fitter collapses each bow into a single firmware `arc` job). */
function arcSnake(a: Pt, b: Pt, jitter: number, rng: () => number): Pt[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return [a, b];
  const per = 35 + rng() * 40;                       // nominal chord per bow
  const n = Math.max(1, Math.round(len / per));
  const chord = len / n;

  let x = 0, y = 0, h = 0;                            // position + heading along the chain
  const pts: Pt[] = [{ x: 0, y: 0 }];
  let sign = rng() < 0.5 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const sag = Math.min(jitter * (0.5 + rng()), chord * 0.45);   // keep bows gentle vs chord
    const theta = 4 * Math.atan((2 * sag) / chord) * sign;         // subtended angle (signed)
    if (Math.abs(theta) < 1e-4) {                                  // ~straight leg
      x += Math.cos(h) * chord; y += Math.sin(h) * chord;
      pts.push({ x, y });
    } else {
      const R = chord / (2 * Math.sin(Math.abs(theta) / 2));
      // centre sits on the left/right normal of the current heading; walk the EXACT circle
      const cxA = x + (theta > 0 ? R : -R) * -Math.sin(h);
      const cyA = y + (theta > 0 ? R : -R) *  Math.cos(h);
      const phi0 = Math.atan2(y - cyA, x - cxA);
      const steps = Math.min(200, Math.max(6, Math.ceil((R * Math.abs(theta)) / 2)));
      for (let k = 1; k <= steps; k++) {
        const phi = phi0 + theta * (k / steps);
        pts.push({ x: cxA + R * Math.cos(phi), y: cyA + R * Math.sin(phi) });
      }
      x = pts[pts.length - 1].x; y = pts[pts.length - 1].y;
      h += theta;
    }
    sign = -sign;
  }
  // Map the chain's end onto b: rotate + uniform-scale about the origin, translate to a.
  const ex = x, ey = y;
  const elen = Math.hypot(ex, ey);
  if (elen < 1e-6) return [a, b];
  const rot = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(ey, ex);
  const sc = len / elen;
  const cr = Math.cos(rot) * sc, sr = Math.sin(rot) * sc;
  return pts.map((p) => ({ x: a.x + p.x * cr - p.y * sr, y: a.y + p.x * sr + p.y * cr }));
}

function ruledDir(rect: Rect, theta: number, spacing: number, jitter: number, rng: () => number, gradient = 0, stops: number[] = [], minGap = 0, style = "arc"): Path[] {
  const s = Math.max(0.5, spacing);
  const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
  const dx = Math.cos(theta), dy = Math.sin(theta);     // line direction
  const nx = -Math.sin(theta), ny = Math.cos(theta);    // perpendicular (offset axis)
  // project corners onto the normal to find the band of offsets the rect occupies
  let omin = Infinity, omax = -Infinity;
  for (const [x, y] of [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]]) {
    const o = (x - cx) * nx + (y - cy) * ny;
    if (o < omin) omin = o;
    if (o > omax) omax = o;
  }
  // Line offsets across the band: multi-point density profile (`stops`) > single ramp (`gradient`)
  // > uniform. omin is the rect's +normal end (RIGHT for │, TOP for ─), so a positive gradient or a
  // front-loaded stops list thickens toward the top-right (LeWitt #142's accumulation).
  const offsets = bandOffsets(omin, omax, s, gradient, stops, minGap);
  const L = (rect.x1 - rect.x0) + (rect.y1 - rect.y0) + 10;   // long enough to span, then clip
  const out: Path[] = [];
  for (const o of offsets) {
    const bx = cx + o * nx, by = cy + o * ny;
    const seg = clipSegmentToRect({ x: bx - L * dx, y: by - L * dy }, { x: bx + L * dx, y: by + L * dy }, rect);
    if (!seg) continue;
    if (jitter <= 0) { out.push({ points: [seg[0], seg[1]] }); continue; }
    if (style === "arc") {
      // not-straight as SMOOTH ARCS: gentle tangent-continuous circular bows instead of
      // the wavier polyline — and each bow compiles into a firmware arc job.
      out.push({ points: arcSnake(seg[0], seg[1], jitter, rng) });
      continue;
    }
    // not-straight: resample the clipped segment and offset interior points perpendicular by a
    // smooth two-harmonic wave (random amp/phase per line) — endpoints stay on the rect edge.
    const [a, b] = seg;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.round(len / 5));
    const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
    const k1 = 1 + Math.floor(rng() * 2), k2 = 2 + Math.floor(rng() * 3);
    const amp = jitter * (0.7 + 0.6 * rng());
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const env = Math.sin(Math.PI * t);   // taper to 0 at both ends so lines meet the edges
      const off = amp * env * (0.6 * Math.sin(t * k1 * 2 * Math.PI + p1) + 0.4 * Math.sin(t * k2 * 2 * Math.PI + p2));
      pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
    }
    out.push({ points: pts });
  }
  return out;
}

export const ruledLinesModule: Module = {
  key: "ruledLines",
  label: "Ruled lines",
  kind: "make",
  group: "Lines & Patterns",
  description: "Straight parallel lines filling a rectangle, in any mix of the four LeWitt directions (│ ─ ╱ ╲), superimposed.",
  sections: [
    { title: "Region", fields: [
      { key: "w", label: "Width", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 150 },
      { key: "h", label: "Height", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 150 },
      { key: "spacing", label: "Line spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 12 },
    ]},
    { title: "Directions", fields: [
      { key: "vertical", label: "Vertical │", type: "toggle", default: true },
      { key: "horizontal", label: "Horizontal ─", type: "toggle", default: true },
      { key: "diagRight", label: "Diagonal ╱", type: "toggle", default: false },
      { key: "diagLeft", label: "Diagonal ╲", type: "toggle", default: false },
    ]},
    { title: "Hand-drawn (not straight)", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 20, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterStyle", label: "Deviation", type: "select", default: "arc", options: [
        { value: "arc", label: "Arcs (smooth bows)" },
        { value: "wave", label: "Waves (hand wobble)" },
      ]},
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    ]},
    { title: "Density ramp", fields: [
      { key: "gradient", label: "Gradient", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
      { key: "densityStops", label: "Density stops", type: "text", placeholder: "e.g. 1,0.2,1  (overrides gradient)", default: "" },
      { key: "minGap", label: "Min line gap", type: "range", min: 0, max: 20, step: 0.5, unit: "mm", default: 0 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const w = num(params, "w", 150), h = num(params, "h", 150);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const spacing = num(params, "spacing", 12);
    const jitter = num(params, "jitter", 0);
    const gradient = num(params, "gradient", 0);
    const minGap = num(params, "minGap", 0);
    // multi-point density profile: comma/space-separated non-negative weights (≥2 to take effect)
    const stops = String(params.densityStops ?? "").split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
    const style = String(params.jitterStyle ?? "arc");
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7)));
    const rect: Rect = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    const paths: Path[] = [];
    if (params.horizontal !== false) paths.push(...ruledDir(rect, 0, spacing, jitter, rng, gradient, stops, minGap, style));            // ─
    if (params.vertical !== false) paths.push(...ruledDir(rect, Math.PI / 2, spacing, jitter, rng, gradient, stops, minGap, style));     // │
    if (params.diagRight) paths.push(...ruledDir(rect, -Math.PI / 4, spacing, jitter, rng, gradient, stops, minGap, style));             // ╱
    if (params.diagLeft) paths.push(...ruledDir(rect, Math.PI / 4, spacing, jitter, rng, gradient, stops, minGap, style));               // ╲
    return { widthMm: w, heightMm: h, paths, meta: { title: "Ruled lines" } };
  },
};

register(ruledLinesModule);
