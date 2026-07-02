// AI-training render harness — turns a round's designs.json into PNGs (no plotting).
//
// Each design is a Studio layer-stack; we evaluate it through the SAME pipeline the
// Studio uses (registry → evaluate → Frame) and rasterize the polylines with
// @napi-rs/canvas. Output: one PNG per design + a labeled 4×4 contact sheet, plus a
// ranking.json template for the human to fill in.
//
// Run (from console/):  npx tsx scripts/train-render.ts ../ai-training/sessions/<id>/round-01
//
// designs.json shape:
//   { "round": 1, "bounds": {left,right,up,down},
//     "designs": [ { "id":1, "title":"…", "intent":"…",
//                    "layers":[ {"module":"spirograph","params":{…},"groupId"?:"g1"} ],
//                    "groups"?: [ {"id":"g1","name":"…","tx":0,"ty":0,"rotateDeg":0} ] }, … ] }
// Each layer's params are merged over the module's defaults, so you only specify overrides.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { evaluate, type Layer, type LayerGroup } from "../src/lib/pipeline.ts";
import { getModule, defaultsOf } from "../src/lib/registry.ts";
import "../src/lib/modules/index.ts";   // side effect: register all generators/modifiers
import type { Frame } from "../src/lib/frame.ts";

type Bounds = { left: number; right: number; up: number; down: number };
interface DesignLayer { module: string; params?: Record<string, unknown>; groupId?: string; }
interface Design { id: number; title?: string; intent?: string; layers: DesignLayer[]; groups?: LayerGroup[]; }
interface DesignsFile { round: number; bounds: Bounds; designs: Design[]; }

const DEFAULT_BOUNDS: Bounds = { left: 150, right: 150, up: 150, down: 150 };

// ---- build a Frame from a design via the real pipeline -----------------------------
function frameOf(design: Design, bounds: Bounds): { frame: Frame; warnings: string[] } {
  const warnings: string[] = [];
  const layers: Layer[] = design.layers.map((l, i) => {
    const mod = getModule(l.module);
    if (!mod) warnings.push(`design ${design.id}: unknown module "${l.module}"`);
    const params = mod ? { ...defaultsOf(mod), ...(l.params ?? {}) } : (l.params ?? {});
    return { id: `d${design.id}-l${i}`, moduleKey: l.module, params, groupId: l.groupId };
  });
  return { frame: evaluate(layers, bounds, design.groups ?? []), warnings };
}

// ---- map plotter mm (centre origin, Y-down) into a pixel rect, preserving aspect ----
function mapper(bounds: Bounds, x: number, y: number, w: number, h: number, pad: number) {
  const bw = bounds.left + bounds.right, bh = bounds.up + bounds.down;
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  const ox = x + (w - bw * s) / 2, oy = y + (h - bh * s) / 2;
  return {
    s,
    X: (px: number) => ox + (px + bounds.left) * s,
    Y: (py: number) => oy + (py + bounds.up) * s,   // plotter & canvas are both Y-down
    rect: { x: ox, y: oy, w: bw * s, h: bh * s },
  };
}

function drawFrame(ctx: SKRSContext2D, frame: Frame, bounds: Bounds, x: number, y: number, w: number, h: number, pad = 14) {
  const m = mapper(bounds, x, y, w, h, pad);
  // faint frame border so we can read how each design uses the page
  ctx.strokeStyle = "#e2e5ea";
  ctx.lineWidth = 1;
  ctx.strokeRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);

  // clip to this design's region so an oversized design can't bleed into neighbours
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const path of frame.paths) {
    if (path.points.length < 2 && !path.closed) continue;
    ctx.beginPath();
    path.points.forEach((p, i) => (i === 0 ? ctx.moveTo(m.X(p.x), m.Y(p.y)) : ctx.lineTo(m.X(p.x), m.Y(p.y))));
    if (path.closed && path.points.length > 1) ctx.closePath();
    ctx.strokeStyle = path.stroke ?? "#101216";
    ctx.lineWidth = Math.max(0.8, 1.1 * Math.min(2, path.cycles ?? 1));
    ctx.stroke();
  }
  ctx.restore();
}

// ---- main --------------------------------------------------------------------------
const roundDir = resolve(process.argv[2] ?? "");
if (!roundDir || !existsSync(join(roundDir, "designs.json"))) {
  console.error("usage: tsx scripts/train-render.ts <roundDir>   (must contain designs.json)");
  process.exit(1);
}

const data: DesignsFile = JSON.parse(readFileSync(join(roundDir, "designs.json"), "utf8"));
const bounds = data.bounds ?? DEFAULT_BOUNDS;
const designs = data.designs;
const pngDir = join(roundDir, "png");
mkdirSync(pngDir, { recursive: true });

// individual PNGs
const CELL = 520;
const allWarnings: string[] = [];
const stats: { id: number; paths: number; pts: number }[] = [];
for (const d of designs) {
  const { frame, warnings } = frameOf(d, bounds);
  allWarnings.push(...warnings);
  const cv = createCanvas(CELL, CELL);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CELL, CELL);
  drawFrame(ctx, frame, bounds, 0, 0, CELL, CELL, 22);
  writeFileSync(join(pngDir, `${String(d.id).padStart(2, "0")}.png`), cv.encodeSync("png"));
  stats.push({ id: d.id, paths: frame.paths.length, pts: frame.paths.reduce((n, p) => n + p.points.length, 0) });
}

// contact sheet — 4×4, labeled
const COLS = 4, ROWS = Math.ceil(designs.length / COLS);
const TILE = 360, LABEL = 30, GAP = 14, PAD = 26;
const W = PAD * 2 + COLS * TILE + (COLS - 1) * GAP;
const H = PAD * 2 + ROWS * (TILE + LABEL) + (ROWS - 1) * GAP + 34;
const cs = createCanvas(W, H);
const cx = cs.getContext("2d");
cx.fillStyle = "#f6f7f9"; cx.fillRect(0, 0, W, H);
cx.fillStyle = "#101216"; cx.font = "bold 18px sans-serif";
cx.fillText(`Round ${data.round} — ${designs.length} designs · rank most→least interesting`, PAD, PAD + 4);

designs.forEach((d, idx) => {
  const c = idx % COLS, r = Math.floor(idx / COLS);
  const x = PAD + c * (TILE + GAP);
  const y = PAD + 30 + r * (TILE + LABEL + GAP);
  // card
  cx.fillStyle = "#ffffff"; cx.fillRect(x, y, TILE, TILE + LABEL);
  cx.strokeStyle = "#dfe3e8"; cx.lineWidth = 1; cx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE + LABEL - 1);
  // label
  cx.fillStyle = "#101216"; cx.font = "bold 14px sans-serif";
  const title = d.title ? ` · ${d.title}` : "";
  cx.fillText(`${d.id}${title}`.slice(0, 46), x + 10, y + 20);
  // art
  const { frame } = frameOf(d, bounds);
  drawFrame(cx, frame, bounds, x, y + LABEL, TILE, TILE, 16);
});
writeFileSync(join(roundDir, "contact.png"), cs.encodeSync("png"));

// ranking template (don't clobber an existing one)
const rankPath = join(roundDir, "ranking.json");
if (!existsSync(rankPath)) {
  writeFileSync(rankPath, JSON.stringify({
    round: data.round,
    ranking: [],                          // ordered design ids, best → worst
    notes: {},                            // { "<id>": "why" }
    scoredAt: "",
  }, null, 2) + "\n");
}

console.log(`✓ ${designs.length} designs → ${pngDir}/`);
console.log(`✓ contact sheet → ${join(roundDir, "contact.png")}`);
console.log(`✓ ranking template → ${rankPath}`);
for (const s of stats) if (s.paths === 0) console.log(`  ⚠ design ${s.id} produced NO paths`);
for (const w of [...new Set(allWarnings)]) console.log(`  ⚠ ${w}`);
