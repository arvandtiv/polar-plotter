import { writeFileSync } from "node:fs";

// Round 19 — LeWitt #365: a square in four equal parts, each a progressively darker gray. The user's
// twist: build the different grays from DIFFERENT line methods (direction count / spacing / hand),
// not one trick. Each design = 4 ruledLines layers (one per quadrant). Tone stays capped (paper-rip).

// quadrant centres (frame 300x300, origin centre): TL/TR/BL/BR
const Q = { TL: [-75, -75], TR: [75, -75], BL: [-75, 75], BR: [75, 75] };
const DIRS = {
  v: { vertical: true }, h: { horizontal: true }, r: { diagRight: true }, l: { diagLeft: true },
  vh: { vertical: true, horizontal: true }, rl: { diagRight: true, diagLeft: true },
  vhr: { vertical: true, horizontal: true, diagRight: true },
  vhrl: { vertical: true, horizontal: true, diagRight: true, diagLeft: true },
};
// one quadrant fill: q=corner key, sp=spacing, code=direction preset, j=jitter, size, seed
const box = (q, sp, code, j, size, seed) => ({
  module: "ruledLines",
  params: {
    cx: Q[q][0], cy: Q[q][1], w: size, h: size, spacing: sp,
    vertical: false, horizontal: false, diagRight: false, diagLeft: false, ...DIRS[code],
    jitter: j, jitterSeed: seed,
  },
});

// helper: light->dark over [TL,TR,BL,BR] with per-level {sp,code,j}; size + seed base
const ramp = (levels, size, sb) =>
  ["TL", "TR", "BL", "BR"].map((q, i) => box(q, levels[i].sp, levels[i].code, levels[i].j, size, sb + i));

const G = 140, S = 150; // gutter (legible parts) vs seamless

const designs = [
  { id: 1, title: "spacing ramp, vertical", intent: "tone by SPACING only, all vertical lines (Klee #5, density=tone).",
    layers: ramp([{ sp: 30, code: "v", j: 3 }, { sp: 20, code: "v", j: 3 }, { sp: 13, code: "v", j: 3 }, { sp: 8, code: "v", j: 3 }], G, 701) },
  { id: 2, title: "spacing ramp, cross-hatch", intent: "tone by spacing, cross-hatched (v+h) throughout (Klee #5).",
    layers: ramp([{ sp: 34, code: "vh", j: 3 }, { sp: 22, code: "vh", j: 3 }, { sp: 14, code: "vh", j: 3 }, { sp: 9, code: "vh", j: 3 }], G, 711) },
  { id: 3, title: "direction-count ramp", intent: "tone by NUMBER OF DIRECTIONS: single -> hatch -> cross -> four-way, same spacing (Klee #5, #6).",
    layers: ramp([{ sp: 12, code: "v", j: 3 }, { sp: 12, code: "vh", j: 3 }, { sp: 12, code: "vhr", j: 3 }, { sp: 12, code: "vhrl", j: 3 }], G, 721) },
  { id: 4, title: "direction ramp, fine", intent: "direction-count tone on a finer grid (Klee #5).",
    layers: ramp([{ sp: 9, code: "v", j: 3 }, { sp: 9, code: "vh", j: 3 }, { sp: 9, code: "vhr", j: 3 }, { sp: 9, code: "vhrl", j: 3 }], G, 731) },
  { id: 5, title: "hybrid ramp", intent: "tone by BOTH more directions AND tighter spacing (Klee #5, #6).",
    layers: ramp([{ sp: 22, code: "v", j: 3 }, { sp: 16, code: "vh", j: 3 }, { sp: 11, code: "vhr", j: 3 }, { sp: 8, code: "vhrl", j: 3 }], G, 741) },
  { id: 6, title: "spacing ramp, diagonal", intent: "tone by spacing, all one diagonal direction (Klee #5).",
    layers: ramp([{ sp: 30, code: "r", j: 3 }, { sp: 20, code: "r", j: 3 }, { sp: 13, code: "r", j: 3 }, { sp: 8, code: "r", j: 3 }], G, 751) },
  { id: 7, title: "different direction per box", intent: "each box a different line METHOD + spacing: v / diag / cross / four-way (user's 'other ways').",
    layers: ramp([{ sp: 26, code: "v", j: 3 }, { sp: 18, code: "r", j: 3 }, { sp: 12, code: "vh", j: 3 }, { sp: 8, code: "vhrl", j: 3 }], G, 761) },
  { id: 8, title: "direction ramp, energetic", intent: "direction-count tone, strong wobble — living lines (Klee #3).",
    layers: ramp([{ sp: 12, code: "v", j: 5 }, { sp: 12, code: "vh", j: 5 }, { sp: 12, code: "vhr", j: 5 }, { sp: 12, code: "vhrl", j: 5 }], G, 771) },
  { id: 9, title: "angle + spacing ramp", intent: "rotating direction (v -> diagR -> h -> diagL) with tightening spacing (Klee #5, #6).",
    layers: ramp([{ sp: 28, code: "v", j: 3 }, { sp: 19, code: "r", j: 3 }, { sp: 12, code: "h", j: 3 }, { sp: 8, code: "l", j: 3 }], G, 781) },
  { id: 10, title: "cross-hatch density, wavy", intent: "cross-hatch tone by spacing, hand-drawn medium (Klee #5, #3).",
    layers: ramp([{ sp: 30, code: "vh", j: 4 }, { sp: 20, code: "vh", j: 4 }, { sp: 13, code: "vh", j: 4 }, { sp: 9, code: "vh", j: 4 }], G, 791) },
  { id: 11, title: "seamless spacing ramp", intent: "no gutter — a continuous vertical density gradient across the whole square (Klee #5).",
    layers: ramp([{ sp: 30, code: "v", j: 3 }, { sp: 20, code: "v", j: 3 }, { sp: 13, code: "v", j: 3 }, { sp: 8, code: "v", j: 3 }], S, 801) },
  { id: 12, title: "seamless direction ramp", intent: "no gutter — direction-count tone with parts meeting edge to edge (Klee #6).",
    layers: ramp([{ sp: 11, code: "v", j: 3 }, { sp: 11, code: "vh", j: 3 }, { sp: 11, code: "vhr", j: 3 }, { sp: 11, code: "vhrl", j: 3 }], S, 811) },
  { id: 13, title: "hybrid, fine", intent: "hybrid tone pushed finer — darkest box near-solid but still open (paper-rip cap) (Klee #5).",
    layers: ramp([{ sp: 18, code: "v", j: 3 }, { sp: 13, code: "vh", j: 3 }, { sp: 9, code: "vhr", j: 3 }, { sp: 7, code: "vhrl", j: 3 }], G, 821) },
  { id: 14, title: "gentle-to-wild hand", intent: "light boxes calm, dark boxes energetic — hand energy tracks tone (Klee #3).",
    layers: ramp([{ sp: 30, code: "vh", j: 2 }, { sp: 20, code: "vh", j: 3 }, { sp: 13, code: "vh", j: 4 }, { sp: 9, code: "vh", j: 5 }], G, 831) },
  { id: 15, title: "diagonal method ramp", intent: "diagonal-based methods: one diag -> crossed diags -> +cross -> four-way (Klee #6).",
    layers: ramp([{ sp: 26, code: "r", j: 3 }, { sp: 18, code: "rl", j: 3 }, { sp: 12, code: "vhr", j: 3 }, { sp: 8, code: "vhrl", j: 3 }], G, 841) },
  { id: 16, title: "hybrid, wavy", intent: "hybrid method+spacing tone with a lively hand throughout (Klee #5, #3).",
    layers: ramp([{ sp: 22, code: "v", j: 4 }, { sp: 16, code: "vh", j: 4 }, { sp: 11, code: "vhr", j: 4 }, { sp: 8, code: "vhrl", j: 4 }], G, 851) },
];

const out = {
  round: 19,
  rule: { lewittId: 365, instruction: "A square divided horizontally and vertically into four equal parts, each with a progressively darker gradation of gray.", year: 1984 },
  bounds: { left: 150, right: 150, up: 150, down: 150 },
  designs,
};
writeFileSync("/Users/babi/Documents/polar_plotter/ai-training/sessions/2026-06-30-foundations/round-19/designs.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote", designs.length, "designs");
