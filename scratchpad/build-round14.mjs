import { writeFileSync } from "node:fs";

// Round 14 — LeWitt #138: circles & arcs from the four SIDE MIDPOINTS, executed asymmetrically
// (the R13 fix: break the ARRANGEMENT's symmetry, not just the line). Each design = one arcs layer.
const A = (p) => ({ module: "arcs", params: { centres: "midpoints", size: 300, cx: 0, cy: 0, ...p } });

const designs = [
  { id: 1, title: "gentle off-axis", intent: "midpoints nudged off the cross — first break from symmetry (Klee #8, asymmetric weight).",
    layers: [A({ count: 10, maxR: 300, jitter: 3, jitterSeed: 201, centreJitter: 30, countJitter: 3, radiusJitter: 0.2 })] },
  { id: 2, title: "more offset", intent: "families drift apart; spacing loosens (Klee #8).",
    layers: [A({ count: 12, maxR: 320, jitter: 4, jitterSeed: 202, centreJitter: 60, countJitter: 4, radiusJitter: 0.3 })] },
  { id: 3, title: "strong offset", intent: "midpoints wander far — no axis of mirror survives (Klee #8, #3).",
    layers: [A({ count: 12, maxR: 340, jitter: 4, jitterSeed: 203, centreJitter: 90, countJitter: 5, radiusJitter: 0.4 })] },
  { id: 4, title: "wild offset", intent: "maximal wander + energetic hand — organic scatter of families (Klee #3).",
    layers: [A({ count: 12, maxR: 340, jitter: 5, jitterSeed: 204, centreJitter: 120, countJitter: 6, radiusJitter: 0.5 })] },
  { id: 5, title: "dense asymmetric", intent: "many arcs per wandering centre — dense interference, no symmetry (Klee #6, #5).",
    layers: [A({ count: 18, maxR: 340, jitter: 4, jitterSeed: 205, centreJitter: 70, countJitter: 5, radiusJitter: 0.3 })] },
  { id: 6, title: "true circles", intent: "centres pulled inward + tight radius -> whole CIRCLES bloom, not just arcs (Klee #1, form).",
    layers: [A({ count: 14, maxR: 230, jitter: 4, jitterSeed: 206, centreJitter: 100, countJitter: 5, radiusJitter: 0.4 })] },
  { id: 7, title: "full sweep", intent: "big asymmetric arcs reach across the field (Klee #6).",
    layers: [A({ count: 14, maxR: 440, jitter: 5, jitterSeed: 207, centreJitter: 60, countJitter: 5, radiusJitter: 0.3 })] },
  { id: 8, title: "+corners, wandering", intent: "eight wandering families (midpoints + corners), all off-axis (Klee #6, complex).",
    layers: [A({ centres: "cornersMid", count: 8, maxR: 300, jitter: 4, jitterSeed: 208, centreJitter: 80, countJitter: 4, radiusJitter: 0.4 })] },
  { id: 9, title: "dense wild", intent: "dense, wild-handed, far-wandering — maximal organic interference (Klee #3, #5).",
    layers: [A({ count: 20, maxR: 380, jitter: 5, jitterSeed: 209, centreJitter: 90, countJitter: 6, radiusJitter: 0.5 })] },
  { id: 10, title: "irregular spacing", intent: "spacing very uneven — concentric rhythm broken (Klee #5, tone as interval).",
    layers: [A({ count: 16, maxR: 320, jitter: 4, jitterSeed: 210, centreJitter: 50, countJitter: 4, radiusJitter: 0.7 })] },
  { id: 11, title: "lighter, off-axis", intent: "fewer families, still strongly asymmetric + lively hand — a lighter option, not calm (Klee #7).",
    layers: [A({ count: 9, maxR: 320, jitter: 5, jitterSeed: 211, centreJitter: 85, countJitter: 4, radiusJitter: 0.4 })] },
  { id: 12, title: "scattered blooms", intent: "small circles far off the midpoints — blooms scattered asymmetrically (Klee #1, #8).",
    layers: [A({ count: 10, maxR: 200, jitter: 5, jitterSeed: 212, centreJitter: 130, countJitter: 6, radiusJitter: 0.5 })] },
  { id: 13, title: "very dense asymmetric", intent: "very dense wandering families — a woven, off-axis vault (Klee #6, #5).",
    layers: [A({ count: 22, maxR: 360, jitter: 5, jitterSeed: 213, centreJitter: 80, countJitter: 6, radiusJitter: 0.5 })] },
  { id: 14, title: "+corners, dense wild", intent: "eight families, dense + wild + wandering (Klee #6, #3).",
    layers: [A({ centres: "cornersMid", count: 12, maxR: 340, jitter: 5, jitterSeed: 214, centreJitter: 90, countJitter: 6, radiusJitter: 0.5 })] },
  { id: 15, title: "energetic hand", intent: "strongest wobble on asymmetric arcs — the living line at full voice (Klee #3).",
    layers: [A({ count: 14, maxR: 340, jitter: 6, jitterSeed: 215, centreJitter: 70, countJitter: 5, radiusJitter: 0.4 })] },
  { id: 16, title: "maximal", intent: "densest, wildest, most-wandering — the extreme of the asymmetric take (Klee #3, #5).",
    layers: [A({ count: 20, maxR: 400, jitter: 6, jitterSeed: 216, centreJitter: 100, countJitter: 8, radiusJitter: 0.6 })] },
];

const out = {
  round: 14,
  rule: { lewittId: 138, instruction: "Circles and arcs from the midpoints of four sides. (ACG 59)", year: 1972 },
  bounds: { left: 150, right: 150, up: 150, down: 150 },
  designs,
};
const path = "/Users/babi/Documents/polar_plotter/ai-training/sessions/2026-06-30-foundations/round-14/designs.json";
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log("wrote", designs.length, "designs");
