// Unified studio pipeline — every surface (Studio Run, Script "generate", MCP)
// flows through the same evaluate → simplify → optimize → compile chain.
// See docs/STUDIO_ARCHITECTURE.md.

import { compile, type CompileOpts } from "./compile";
import { evaluate, type Layer, type LayerGroup } from "./pipeline";
import { getModule, type GenCtx, type GrayImage, type ParamValues } from "./registry";
import type { Frame } from "./frame";
import { optimizeOrder, simplifyFrame } from "./toolpath";

export interface PipelineBounds {
  left: number;
  right: number;
  up: number;
  down: number;
}

export interface GeneratorSpec {
  key: string;
  params: ParamValues;
  warp?: { mode: string; params: Record<string, number> };
}

export interface RunPipelineOpts {
  /** RDP simplification tolerance (mm). Default 0.2; 0 = skip. */
  simplifyTol?: number;
  /** If > 0, fit circular runs to firmware arc jobs within this mm tolerance. */
  arcTol?: number;
}

function clipBounds(b: PipelineBounds): CompileOpts["clipBounds"] {
  return { left: b.left, right: b.right, up: b.up, down: b.down };
}

/** Frame → simplified, reordered, clipped query strings. */
export function compileFrame(
  frame: Frame,
  bounds: PipelineBounds,
  opts: RunPipelineOpts = {},
): string[] {
  const tol = opts.simplifyTol ?? 0.2;
  const opt = optimizeOrder(tol > 0 ? simplifyFrame(frame, tol) : frame);
  return compile(opt, { clipBounds: clipBounds(bounds), arcTol: opts.arcTol });
}

/** Run one registered generator (optional warp modifier) through the full pipeline. */
export function expandGenerator(
  spec: GeneratorSpec,
  bounds: PipelineBounds,
  opts: RunPipelineOpts = {},
): string[] {
  const mod = getModule(spec.key);
  if (!mod) throw new Error(`Unknown generator: "${spec.key}"`);
  let frame = mod.generate(spec.params, { bounds });
  if (spec.warp) {
    const warpMod = getModule("warp");
    if (warpMod) {
      frame = warpMod.generate(
        { mode: spec.warp.mode, ...spec.warp.params },
        { bounds, lowerFrame: frame },
      );
    }
  }
  return compileFrame(frame, bounds, opts);
}

/** Evaluate a full layer stack (Studio document) through the full pipeline. */
export function runLayerStack(
  layers: Layer[],
  bounds: PipelineBounds,
  groups: LayerGroup[] = [],
  image?: GrayImage,
  opts: RunPipelineOpts = {},
): string[] {
  const frame = evaluate(layers, bounds, groups, image);
  return compileFrame(frame, bounds, opts);
}

/** Convert firmware status bounds (xn/xp/yn/yp) to pipeline bounds. */
export function boundsFromFirmware(b: {
  xn?: number;
  xp?: number;
  yn?: number;
  yp?: number;
}): PipelineBounds {
  return {
    left: -(b.xn ?? 0),
    right: b.xp ?? 0,
    up: -(b.yn ?? 0),
    down: b.yp ?? 0,
  };
}

/** PlotterBounds / GenCtx shape → pipeline bounds. */
export function boundsFromPlotter(b: PipelineBounds): PipelineBounds {
  return { left: b.left, right: b.right, up: b.up, down: b.down };
}