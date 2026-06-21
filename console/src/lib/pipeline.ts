// Layer pipeline — a document is an ordered stack of layers evaluated bottom→top.
// Each layer sees the composite of everything beneath it as ctx.lowerFrame: a "make"
// adds its paths, a "modify" transforms what's below. See docs/v1.3/05-modifier-pipeline.md.

import { getModule, type GenCtx, type ParamValues } from "./registry";
import type { Frame } from "./frame";

export interface Layer { id: string; moduleKey: string; params: ParamValues; }

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

/** Evaluate the stack to a single Frame. Unknown module keys are skipped. */
export function evaluate(layers: Layer[], bounds: GenCtx["bounds"]): Frame {
  let acc = emptyFrame(bounds);
  for (const layer of layers) {
    const mod = getModule(layer.moduleKey);
    if (!mod) continue;
    const out = mod.generate(layer.params, { bounds, lowerFrame: acc });
    acc = mod.kind === "modify" ? out : mergeFrames(acc, out);
  }
  return acc;
}
