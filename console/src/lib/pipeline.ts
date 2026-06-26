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

function applyGroupTransform(frame: Frame, g: LayerGroup): Frame {
  if (g.tx === 0 && g.ty === 0 && g.rotateDeg === 0) return frame;
  const rad = g.rotateDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    ...frame,
    paths: frame.paths.map(path => ({
      ...path,
      points: path.points.map(p => ({
        x: p.x * cos - p.y * sin + g.tx,
        y: p.x * sin + p.y * cos + g.ty,
      })),
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
): Frame {
  const groupMap = new Map(groups.map(g => [g.id, g]));
  let acc = emptyFrame(bounds);
  for (const layer of layers) {
    const mod = getModule(layer.moduleKey);
    if (!mod) continue;
    let out = mod.generate(layer.params, { bounds, lowerFrame: acc, image });
    if (mod.kind === "make" && layer.groupId) {
      const g = groupMap.get(layer.groupId);
      if (g) out = applyGroupTransform(out, g);
    }
    acc = mod.kind === "modify" ? out : mergeFrames(acc, out);
  }
  return acc;
}
