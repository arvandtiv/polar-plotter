// Unified studio pipeline — every surface (Studio Run, Script "generate", MCP)
// flows through the same evaluate → simplify → optimize → compile chain.
// See docs/OVERVIEW.md (§5 The Studio).

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
  const tol = (opts.simplifyTol ?? 0.2);
  // noSimplify: frame was precisely tessellated by its generator (e.g. circle at exact
  // chord-error intervals) — RDP at the same tolerance would destroy the detail.
  const skipSimplify = frame.meta?.noSimplify || tol <= 0;
  const opt = optimizeOrder(skipSimplify ? frame : simplifyFrame(frame, tol));
  return compile(opt, { clipBounds: clipBounds(bounds), arcTol: opts.arcTol });
}

/** Build one generator's Frame (generate + optional warp), no compile/clip yet. */
function buildGeneratorFrame(
  spec: GeneratorSpec,
  bounds: PipelineBounds,
  paramsOverride?: ParamValues,
): Frame {
  const mod = getModule(spec.key);
  if (!mod) throw new Error(`Unknown generator: "${spec.key}"`);
  let frame = mod.generate(paramsOverride ?? spec.params, { bounds });
  if (spec.warp) {
    const warpMod = getModule("warp");
    if (warpMod) {
      frame = warpMod.generate(
        { mode: spec.warp.mode, ...spec.warp.params },
        { bounds, lowerFrame: frame },
      );
    }
  }
  return frame;
}

/** Run one registered generator (optional warp modifier) through the full pipeline. */
export function expandGenerator(
  spec: GeneratorSpec,
  bounds: PipelineBounds,
  opts: RunPipelineOpts = {},
): string[] {
  return compileFrame(buildGeneratorFrame(spec, bounds), bounds, opts);
}

/** True when every point of `frame` lies within the work area (rect, or the
 *  inscribed ellipse). `tolMm` widens the test region — 0 = strictly inside the
 *  edge, positive tolerates that much overshoot. The compile step still clips, so
 *  this is purely a "would this draw spill outside the cell?" predicate for reseeding. */
export function frameFitsBounds(
  frame: Frame,
  bounds: PipelineBounds,
  tolMm = 0,
  ellipse = false,
): boolean {
  const xMin = -bounds.left - tolMm, xMax = bounds.right + tolMm;
  const yMin = -bounds.up - tolMm, yMax = bounds.down + tolMm;
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
  const rx = (xMax - xMin) / 2, ry = (yMax - yMin) / 2;
  for (const path of frame.paths) {
    for (const p of path.points) {
      if (ellipse) {
        if (rx <= 0 || ry <= 0) return false;
        const nx = (p.x - cx) / rx, ny = (p.y - cy) / ry;
        if (nx * nx + ny * ny > 1) return false;
      } else if (p.x < xMin || p.x > xMax || p.y < yMin || p.y > yMax) {
        return false;
      }
    }
  }
  return true;
}

export interface FittedExpansion {
  /** Compiled, clipped query strings (pen-up gaps for any spill — never edge-walk). */
  queries: string[];
  /** Did the chosen frame fit fully inside the bounds? */
  fit: boolean;
  /** The seed that produced `queries` (the fitting one, or the base when not reseeding). */
  seed: number | null;
  /** How many seeds were tried. */
  attempts: number;
  /** Whether this generator exposes a `seed` param (false → reseeding is a no-op). */
  hasSeed: boolean;
}

export interface FitOpts extends RunPipelineOpts {
  /** Reseed until the art fits inside the bounds. Off → single shot (still clipped). */
  fit?: boolean;
  /** Max distinct seeds to try before giving up (default 2000). */
  maxSeeds?: number;
  /** First seed to try; defaults to the spec's own seed param. Sweeps base..base+N. */
  baseSeed?: number;
  /** Overshoot tolerance for the fit test (mm, default 0). */
  fitTolMm?: number;
  /** Test against the inscribed ellipse instead of the rectangle. */
  ellipse?: boolean;
}

/**
 * Expand a generator, optionally reseeding until its art fits inside the bounds.
 * When `fit` is off (or the generator has no seed), this is one clipped pass.
 * When on, it sweeps seeds base..base+maxSeeds and returns the first that fits; if
 * none fit, it returns the last attempt (still clipped to pen-up gaps) with fit=false
 * so the caller can count and report the miss. The compile step ALWAYS clips, so a
 * spill is drawn as pen-up/pen-down gaps — it never walks the cell boundary.
 */
export function expandGeneratorFitted(
  spec: GeneratorSpec,
  bounds: PipelineBounds,
  o: FitOpts = {},
): FittedExpansion {
  const mod = getModule(spec.key);
  if (!mod) throw new Error(`Unknown generator: "${spec.key}"`);
  const hasSeed = mod.sections.some((s) => s.fields.some((f) => f.key === "seed"));
  const tol = o.fitTolMm ?? 0;

  // Single shot: feature off, or nothing to vary. Still clipped → pen-up gaps.
  if (!o.fit || !hasSeed) {
    const frame = buildGeneratorFrame(spec, bounds);
    return {
      queries: compileFrame(frame, bounds, o),
      fit: frameFitsBounds(frame, bounds, tol, o.ellipse),
      seed: hasSeed ? Math.round(Number(spec.params.seed ?? 0)) : null,
      attempts: 1,
      hasSeed,
    };
  }

  const maxSeeds = Math.max(1, Math.floor(o.maxSeeds ?? 2000));
  const base = Number.isFinite(o.baseSeed)
    ? Number(o.baseSeed)
    : Math.round(Number(spec.params.seed ?? 0));
  let lastFrame: Frame | null = null;
  let lastSeed = base;
  for (let k = 0; k < maxSeeds; k++) {
    const seed = ((base + k) % 10000 + 10000) % 10000;   // module seed range is 0..9999
    const frame = buildGeneratorFrame(spec, bounds, { ...spec.params, seed });
    if (frameFitsBounds(frame, bounds, tol, o.ellipse)) {
      return { queries: compileFrame(frame, bounds, o), fit: true, seed, attempts: k + 1, hasSeed };
    }
    lastFrame = frame;
    lastSeed = seed;
  }
  // Nothing fit — draw the last attempt (clipped), flagged so the caller can log it.
  return {
    queries: compileFrame(lastFrame as Frame, bounds, o),
    fit: false,
    seed: lastSeed,
    attempts: maxSeeds,
    hasSeed,
  };
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