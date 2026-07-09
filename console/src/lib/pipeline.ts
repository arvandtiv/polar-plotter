// Layer pipeline — a document is an ordered stack of layers evaluated bottom→top.
// Each layer sees the composite of everything beneath it as ctx.lowerFrame: a "make"
// adds its paths, a "modify" transforms what's below. See docs/v1.3/05-modifier-pipeline.md.

import { getModule, type GenCtx, type ParamValues } from "./registry";
import type { Frame } from "./frame";

export interface Layer { id: string; moduleKey: string; params: ParamValues; groupId?: string; }

/** A named group of layers that share an X/Y/rotate transform applied after generation. */
export interface LayerGroup {
  id: string;
  name: string;
  tx: number;
  ty: number;
  rotateDeg: number;
}

export function emptyFrame(bounds: GenCtx["bounds"]): Frame {
  return { widthMm: bounds.left + bounds.right, heightMm: bounds.up + bounds.down, paths: [] };
}

export function mergeFrames(a: Frame, b: Frame): Frame {
  return {
    widthMm: Math.max(a.widthMm, b.widthMm),
    heightMm: Math.max(a.heightMm, b.heightMm),
    paths: [...a.paths, ...b.paths],
    meta: b.meta ?? a.meta,
  };
}

/** Rotation pivots on the GROUP's own content centre (px, py) — the combined bbox
 *  centre of every member layer — so R° spins the group in place; tx/ty then offset
 *  it. (Previously rotation was about the wall origin, which made off-origin groups
 *  ORBIT the wall centre instead of rotating around themselves.) */
function applyGroupTransform(frame: Frame, g: LayerGroup, px: number, py: number): Frame {
  if (g.tx === 0 && g.ty === 0 && g.rotateDeg === 0) return frame;
  const rad = g.rotateDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    ...frame,
    paths: frame.paths.map(path => ({
      ...path,
      points: path.points.map(p => {
        const x = p.x - px, y = p.y - py;
        return {
          x: x * cos - y * sin + px + g.tx,
          y: x * sin + y * cos + py + g.ty,
        };
      }),
    })),
  };
}

/**
 * Evaluate the stack to a single Frame. Unknown module keys are skipped.
 * Each make-layer that belongs to a group has the group's transform applied to its
 * own output before it is merged into the accumulator — so groups offset/rotate their
 * content independently of everything else.
 */
export function evaluate(
  layers: Layer[],
  bounds: GenCtx["bounds"],
  groups: LayerGroup[] = [],
  image?: GenCtx["image"],
  font?: GenCtx["font"],
): Frame {
  const groupMap = new Map(groups.map(g => [g.id, g]));

  // Pre-pass: generate every grouped make-layer once (make output is deterministic —
  // it never reads the accumulator) and find each group's combined content centre,
  // the rotation pivot shared by ALL its members so the group turns as one body.
  const memberCache = new Map<string, Frame>();
  const ext = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (const layer of layers) {
    if (!layer.groupId || !groupMap.has(layer.groupId)) continue;
    const mod = getModule(layer.moduleKey);
    if (!mod || mod.kind !== "make") continue;
    const out = mod.generate(layer.params, { bounds, lowerFrame: emptyFrame(bounds), image, font });
    memberCache.set(layer.id, out);
    const e = ext.get(layer.groupId) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const path of out.paths) for (const p of path.points) {
      if (p.x < e.x0) e.x0 = p.x; if (p.x > e.x1) e.x1 = p.x;
      if (p.y < e.y0) e.y0 = p.y; if (p.y > e.y1) e.y1 = p.y;
    }
    ext.set(layer.groupId, e);
  }

  let acc = emptyFrame(bounds);
  for (const layer of layers) {
    const mod = getModule(layer.moduleKey);
    if (!mod) continue;
    let out = memberCache.get(layer.id)
      ?? mod.generate(layer.params, { bounds, lowerFrame: acc, image, font });
    if (mod.kind === "make" && layer.groupId) {
      const g = groupMap.get(layer.groupId);
      const e = ext.get(layer.groupId);
      if (g) {
        const px = e && e.x0 <= e.x1 ? (e.x0 + e.x1) / 2 : 0;
        const py = e && e.y0 <= e.y1 ? (e.y0 + e.y1) / 2 : 0;
        out = applyGroupTransform(out, g, px, py);
      }
    }
    acc = mod.kind === "modify" ? out : mergeFrames(acc, out);
  }
  return acc;
}
