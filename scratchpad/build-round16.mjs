import { writeFileSync } from "node:fs";

// Round 16 — LeWitt #237 "The location of a trapezoid": multiple irregular trapezoids placed
// asymmetrically, each fixed by a hand-drawn location web to the nearest architectural anchors.
// One locatedFigures layer per design. Density capped (paper-rip limit).
const F = (p) => ({ module: "locatedFigures", params: { size: 280, cx: 0, cy: 0, ...p } });

const designs = [
  { id: 1, title: "three, sparse (corners)", intent: "three located trapezoids, web only to the 4 corners — spare, LeWitt-literal (Klee #7).",
    layers: [F({ count: 3, anchors: "corners", anchorsPerFigure: 2, vertsPerAnchor: 1, sizeMin: 55, sizeMax: 110, jitter: 4, skew: 6, figSeed: 401, jitterSeed: 411 })] },
  { id: 2, title: "three, richer web", intent: "three figures fixed to corners+mids+centre — a fuller anchoring (Klee #8).",
    layers: [F({ count: 3, anchors: "cornersMidCenter", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 55, sizeMax: 110, jitter: 4, skew: 6, figSeed: 402, jitterSeed: 412 })] },
  { id: 3, title: "four, medium web", intent: "four figures, medium web from corners+mids (Klee #8, directed weight).",
    layers: [F({ count: 4, anchors: "cornersMid", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 45, sizeMax: 95, jitter: 4, skew: 7, figSeed: 403, jitterSeed: 413 })] },
  { id: 4, title: "six small, light web", intent: "six small scattered trapezoids, light webs — constellation (Klee #7, #8).",
    layers: [F({ count: 6, anchors: "cornersMidCenter", anchorsPerFigure: 2, vertsPerAnchor: 2, sizeMin: 32, sizeMax: 62, jitter: 4, skew: 6, figSeed: 404, jitterSeed: 414 })] },
  { id: 5, title: "four, dense web", intent: "four figures, dense anchoring (5 anchors each) — richer web (Klee #6).",
    layers: [F({ count: 4, anchors: "cornersMidCenter", anchorsPerFigure: 5, vertsPerAnchor: 2, sizeMin: 45, sizeMax: 95, jitter: 4, skew: 7, figSeed: 405, jitterSeed: 415 })] },
  { id: 6, title: "seven, toward #274", intent: "seven located figures — the #274 'six geometric figures' energy (Klee #8, complex).",
    layers: [F({ count: 7, anchors: "cornersMid", anchorsPerFigure: 2, vertsPerAnchor: 1, sizeMin: 34, sizeMax: 68, jitter: 4, skew: 6, figSeed: 406, jitterSeed: 416 })] },
  { id: 7, title: "three big, sparse", intent: "three large trapezoids, minimal corner web — bold figures on open ground (Klee #1, #7).",
    layers: [F({ count: 3, anchors: "corners", anchorsPerFigure: 2, vertsPerAnchor: 2, sizeMin: 75, sizeMax: 140, jitter: 4, skew: 8, figSeed: 407, jitterSeed: 417 })] },
  { id: 8, title: "four, energetic hand", intent: "four figures, medium web, strong wobble — living construction lines (Klee #3).",
    layers: [F({ count: 4, anchors: "cornersMidCenter", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 45, sizeMax: 95, jitter: 5, skew: 8, figSeed: 408, jitterSeed: 418 })] },
  { id: 9, title: "four, gentle hand", intent: "four figures, calm careful line (Klee #3 quiet).",
    layers: [F({ count: 4, anchors: "cornersMid", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 45, sizeMax: 95, jitter: 3, skew: 5, figSeed: 409, jitterSeed: 419 })] },
  { id: 10, title: "six, medium web", intent: "six figures with medium webs — busy but capped (Klee #8, #5).",
    layers: [F({ count: 6, anchors: "cornersMidCenter", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 36, sizeMax: 72, jitter: 4, skew: 7, figSeed: 410, jitterSeed: 420 })] },
  { id: 11, title: "eight tiny, light", intent: "eight tiny trapezoids, single-line webs — dense scatter of located marks (Klee #7).",
    layers: [F({ count: 8, anchors: "cornersMid", anchorsPerFigure: 2, vertsPerAnchor: 1, sizeMin: 26, sizeMax: 52, jitter: 4, skew: 6, figSeed: 421, jitterSeed: 431 })] },
  { id: 12, title: "mixed sizes", intent: "four figures spanning tiny->large, medium web, lively hand (Klee #8 tension).",
    layers: [F({ count: 4, anchors: "cornersMidCenter", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 30, sizeMax: 130, jitter: 5, skew: 8, figSeed: 422, jitterSeed: 432 })] },
  { id: 13, title: "five, corner web", intent: "five figures anchored only to the corners — long crossing construction lines (Klee #6).",
    layers: [F({ count: 5, anchors: "corners", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 42, sizeMax: 88, jitter: 4, skew: 7, figSeed: 423, jitterSeed: 433 })] },
  { id: 14, title: "three, wild web", intent: "three figures, rich web (4 anchors x 3 verts), wild skew+hand — a hand-built web (Klee #3).",
    layers: [F({ count: 3, anchors: "cornersMidCenter", anchorsPerFigure: 4, vertsPerAnchor: 3, sizeMin: 55, sizeMax: 110, jitter: 5, skew: 12, figSeed: 424, jitterSeed: 434 })] },
  { id: 15, title: "six, light web", intent: "six figures, minimal webs — figures dominate, location whispered (Klee #7).",
    layers: [F({ count: 6, anchors: "cornersMidCenter", anchorsPerFigure: 2, vertsPerAnchor: 1, sizeMin: 38, sizeMax: 76, jitter: 4, skew: 6, figSeed: 425, jitterSeed: 435 })] },
  { id: 16, title: "five, balanced", intent: "five figures, balanced web+hand — the rounded showcase (Klee #8).",
    layers: [F({ count: 5, anchors: "cornersMidCenter", anchorsPerFigure: 3, vertsPerAnchor: 2, sizeMin: 42, sizeMax: 92, jitter: 4, skew: 8, figSeed: 426, jitterSeed: 436 })] },
];

const out = {
  round: 16,
  rule: { lewittId: 237, instruction: "The location of a trapezoid.", year: 1974 },
  bounds: { left: 150, right: 150, up: 150, down: 150 },
  designs,
};
writeFileSync("/Users/babi/Documents/polar_plotter/ai-training/sessions/2026-06-30-foundations/round-16/designs.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote", designs.length, "designs");
