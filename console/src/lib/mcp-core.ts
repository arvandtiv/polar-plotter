/**
 * Node/MCP entry — bundles the same studio pipeline the browser uses.
 * Build: cd plotter-mcp && npm run build:core  →  core.js
 */
import "./modules/index";
import { listModules, getModule, defaultsOf } from "./registry";
import { compile } from "./compile";
import type { Frame } from "./frame";
import {
  compileFrame,
  expandGenerator,
  expandGeneratorFitted,
  frameFitsBounds,
  runLayerStack,
  boundsFromFirmware,
  type GeneratorSpec,
  type PipelineBounds,
  type RunPipelineOpts,
  type FitOpts,
  type FittedExpansion,
} from "./runPipeline";
import type { Layer, LayerGroup } from "./pipeline";

export {
  gridCtxFromMetadata,
  gridCtxFromPlotterBounds,
  firmwareWorkAreaFromPlotter,
  normalizeMetadataWorkArea,
  computeCell,
  resolveGridCtx,
  gridClearQueries,
  hydrateGridCommands,
  isIdentityMatrix,
} from "./gridScript";
export type { GridCtx, CellLayout } from "./gridScript";

export {
  compile,
  compileFrame,
  expandGenerator,
  expandGeneratorFitted,
  frameFitsBounds,
  runLayerStack,
  boundsFromFirmware,
  getModule,
  defaultsOf,
  listModules,
};
export type { GeneratorSpec, PipelineBounds, RunPipelineOpts, FitOpts, FittedExpansion, Layer, LayerGroup };

/** Summary for plot_list_generators — mirrors the old pipeline.js shape. */
export function listGenerators(): {
  key: string;
  label: string;
  description: string;
  paramKeys: string[];
}[] {
  return listModules("make").map((m) => ({
    key: m.key,
    label: m.label,
    description: m.description ?? "",
    paramKeys: m.sections.flatMap((s) => s.fields.map((f) => f.key)),
  }));
}

type RawPath = { points: { x: number; y: number }[]; closed?: boolean; cycles?: number };

function pathsToFrame(paths: RawPath[], bounds: PipelineBounds): Frame {
  return {
    widthMm: bounds.left + bounds.right,
    heightMm: bounds.up + bounds.down,
    paths: paths.map((p) => {
      const path: Frame['paths'][number] = { points: p.points };
      if (p.closed !== undefined) path.closed = p.closed;
      if (p.cycles !== undefined) path.cycles = p.cycles;
      return path;
    }),
  };
}

/** Raw paths → queries via the unified compile path (for plot_polylines). */
export function compilePaths(
  paths: RawPath[],
  bounds: PipelineBounds,
  opts: RunPipelineOpts = {},
): string[] {
  return compileFrame(pathsToFrame(paths, bounds), bounds, opts);
}

/** Raw paths with optional warp modifier → queries (plot_polylines warp_mode). */
export function compilePathsWithWarp(
  paths: RawPath[],
  bounds: PipelineBounds,
  warp: { mode: string; params?: Record<string, number> } | null,
  opts: RunPipelineOpts = {},
): string[] {
  let frame = pathsToFrame(paths, bounds);
  if (warp && warp.mode !== "none") {
    const warpMod = getModule("warp");
    if (warpMod) {
      frame = warpMod.generate(
        { mode: warp.mode, ...warp.params },
        { bounds, lowerFrame: frame },
      );
    }
  }
  return compileFrame(frame, bounds, opts);
}