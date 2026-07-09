// Text Path generator — text FOLLOWING A PATH: each glyph is placed at its arc-length
// station along an invisible spine and rotated to the local tangent. Spines: a seeded
// RANDOM WALK (heading drift — wandering hand-written lines), a wave serpentine, or a
// circle (text on a ring). Built-in stroke fonts; optional repeat-to-fill; hand jitter.
// Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import { strokeFontDriver, STROKE_FONTS, type StrokeFontName } from "../strokefont";
import type { Frame, Path, Pt } from "../frame";

export const textPathModule: Module = {
  key: "textPath",
  label: "Text Path",
  kind: "make",
  group: "Shapes",
  description: "Text following a path — glyphs ride an invisible random-walk / wave / circle spine, rotated to the local direction. Repeat-to-fill for endless ribbons.",
  sections: [
    { title: "Text", fields: [
      { key: "text", label: "Text", type: "text", placeholder: "WANDERING WORDS", default: "WANDERING WORDS" },
      { key: "font", label: "Font", type: "select", default: "sans",
        options: STROKE_FONTS.map((f) => ({ value: f.value, label: f.label })) },
      { key: "size", label: "Letter size", type: "range", min: 3, max: 60, step: 0.5, unit: "mm", default: 14 },
      { key: "letterSpacing", label: "Letter spacing", type: "range", min: -5, max: 20, step: 0.5, unit: "mm", default: 1 },
      { key: "repeat", label: "Repeat to fill path", type: "toggle", default: true },
    ]},
    { title: "Path", fields: [
      { key: "spine", label: "Path", type: "select", default: "walk", options: [
        { value: "walk", label: "Random walk" },
        { value: "wave", label: "Wave serpentine" },
        { value: "circle", label: "Circle (ring text)" },
      ]},
      { key: "length", label: "Path length", type: "range", min: 50, max: 2000, step: 10, unit: "mm", default: 500 },
      { key: "wander", label: "Walk wander", type: "range", min: 0, max: 3, step: 0.05, default: 0.8 },
      { key: "headingDeg", label: "Start heading", type: "range", min: -180, max: 180, step: 5, unit: "°", default: 0 },
      { key: "waveAmp", label: "Wave height", type: "range", min: 2, max: 150, step: 1, unit: "mm", default: 40 },
      { key: "waveLen", label: "Wavelength", type: "range", min: 20, max: 400, step: 5, unit: "mm", default: 140 },
      { key: "circleR", label: "Circle radius", type: "range", min: 10, max: 280, step: 1, unit: "mm", default: 80 },
      { key: "x0", label: "Start X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: -120 },
      { key: "y0", label: "Start Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Hand", fields: [
      { key: "baseline", label: "Baseline", type: "select", default: "center", options: [
        { value: "center", label: "Centered on path" },
        { value: "above", label: "Sitting on path" },
      ]},
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 3, step: 0.1, unit: "mm", default: 0.3 },
      { key: "bob", label: "Letter bob / tilt", type: "range", min: 0, max: 1, step: 0.05, default: 0.15 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],
  generate(params): Frame {
    const rawText = String(params.text ?? "WANDERING WORDS");
    const text = rawText.length ? rawText : "WANDERING WORDS";
    const font = strokeFontDriver((params.font === "bold" ? "bold" : "sans") as StrokeFontName);
    const size = Math.max(1, num(params, "size", 14));
    const ls = num(params, "letterSpacing", 1);
    const repeat = params.repeat !== false;
    const spineKind = String(params.spine ?? "walk");
    const L = Math.max(20, num(params, "length", 500));
    const wander = num(params, "wander", 0.8);
    const jitter = Math.max(0, num(params, "jitter", 0.3));
    const bob = Math.max(0, num(params, "bob", 0.15));
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const x0 = num(params, "x0", -120), y0 = num(params, "y0", 0);
    const rng = seededRandom(Math.round(num(params, "seed", 42)));

    // ---- build the spine at ~uniform 2 mm steps (station lookup = index math) ----
    const STEP = 2;
    const spine: Pt[] = [];
    if (spineKind === "circle") {
      const r = Math.max(5, num(params, "circleR", 80));
      const n = Math.max(16, Math.ceil((2 * Math.PI * r) / STEP));
      const a0 = (num(params, "headingDeg", 0) * Math.PI) / 180 - Math.PI / 2;
      for (let i = 0; i <= n; i++) {
        const a = a0 + (2 * Math.PI * i) / n;
        spine.push({ x: x0 + r * Math.cos(a), y: y0 + r * Math.sin(a) });
      }
    } else if (spineKind === "wave") {
      const A = num(params, "waveAmp", 40), wl = Math.max(10, num(params, "waveLen", 140));
      const h = (num(params, "headingDeg", 0) * Math.PI) / 180;
      const ch = Math.cos(h), sh = Math.sin(h);
      const n = Math.ceil(L / STEP);
      for (let i = 0; i <= n; i++) {
        const t = i * STEP;
        const yy = A * Math.sin((2 * Math.PI * t) / wl);
        spine.push({ x: x0 + t * ch - yy * sh, y: y0 + t * sh + yy * ch });
      }
    } else {
      // random walk: heading drifts with clamped curvature so letters flow, not jumble
      let h = (num(params, "headingDeg", 0) * Math.PI) / 180;
      let px = x0, py = y0;
      let drift = 0;
      const n = Math.ceil(L / STEP);
      for (let i = 0; i <= n; i++) {
        spine.push({ x: px, y: py });
        drift = Math.max(-0.06, Math.min(0.06, drift + (rng() - 0.5) * 0.03 * wander));
        h += drift;
        px += STEP * Math.cos(h);
        py += STEP * Math.sin(h);
      }
    }
    // cumulative arc length (uniform STEP except the circle's exactness — good enough)
    const total = (spine.length - 1) * STEP;
    const at = (s: number): { p: Pt; ang: number } => {
      const f = Math.max(0, Math.min(spine.length - 2, s / STEP));
      const i = Math.floor(f), t = f - i;
      const a = spine[i], b = spine[i + 1];
      return {
        p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        ang: Math.atan2(b.y - a.y, b.x - a.x),
      };
    };

    // ---- lay glyphs along the spine ----
    const paths: Path[] = [];
    const baselineOff = params.baseline === "above" ? -size : -size / 2;   // glyph y: 0..size down
    let s = 0;
    let idx = 0;
    const sep = repeat ? " " : "";
    for (let guard = 0; guard < 4000; guard++) {
      if (idx >= text.length) {
        if (!repeat) break;
        idx = 0;
        if (sep) s += font.measureRun(" ", size, 0) + ls;
      }
      const ch = text[idx];
      idx++;
      const w = font.measureRun(ch, size, 0);
      if (s + w > total) break;
      const { p, ang } = at(s + w / 2);
      const tilt = ang + (rng() - 0.5) * 0.35 * bob;
      const rise = (rng() - 0.5) * size * 0.3 * bob;
      const cosA = Math.cos(tilt), sinA = Math.sin(tilt);
      for (const stroke of font.renderRun(ch, size, 0)) {
        if (stroke.length < 2) continue;
        const pts = stroke.map((g) => {
          const lx = g.x - w / 2 + (jitter ? (rng() - 0.5) * 2 * jitter * 0.4 : 0);
          const ly = g.y + baselineOff + rise + (jitter ? (rng() - 0.5) * 2 * jitter * 0.4 : 0);
          return { x: p.x + lx * cosA - ly * sinA, y: p.y + lx * sinA + ly * cosA };
        });
        paths.push({ points: pts, cycles });
      }
      s += w + ls;
    }

    return { widthMm: L, heightMm: L, paths, meta: { title: "Text Path" } };
  },
};

register(textPathModule);
