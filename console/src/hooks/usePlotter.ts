import { useState, useRef, useEffect, useCallback } from 'react';
import { apiGet, apiBatch, getStatus, getStoredIp, storeIp, sseUrl, type RawStatus } from '../lib/api';
import { loadPapers, savePapers, type Paper } from '../lib/papers';
export type { Paper } from '../lib/papers';
import { loadMatrices, saveMatrices, type Matrix } from '../lib/matrices';
export type { Matrix } from '../lib/matrices';

// ---- types -------------------------------------------------------

export type FillMode = 0 | 1 | 2;   // 0=none  1=hatch  2=concentric

export type BoundsShape = 'rect' | 'ellipse';
export interface PlotterBounds { left: number; right: number; up: number; down: number; shape: BoundsShape; }
export interface MotionParams  { vmax: number; amax: number; run: number; hold: number; }
export interface MatrixParams  { a: number; b: number; c: number; d: number; tx: number; ty: number; }
export const IDENTITY_PARAMS: MatrixParams = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export interface CircleCmd   { type: 'circle';   cx: number; cy: number; r: number;    cycles: number; fillMode: FillMode; angle: number; spacing: number; outline: boolean; }
export interface SquareCmd   { type: 'square';   cx: number; cy: number; size: number; cycles: number; fillMode: FillMode; angle: number; spacing: number; outline: boolean; }
export interface LineCmd     { type: 'line';     x0: number; y0: number; x1: number; y1: number; cycles: number; }
export interface GotoCmd     { type: 'goto';     x: number;  y: number; }
export interface HomeCmd     { type: 'home'; }
export interface SetHomeCmd  { type: 'sethome'; }
export interface PenCmd      { type: 'pen';      pos: 'up' | 'down'; }
export interface BullseyeCmd { type: 'bullseye'; cx: number; cy: number; }
export interface GridCmd     { type: 'grid';     cx: number; cy: number; }
// Border = trace the work-area limit path once. Carries the current bounds so the
// canvas can preview the exact perimeter (the firmware uses its own stored bounds).
export interface BorderCmd   { type: 'border';   left: number; right: number; up: number; down: number; shape: BoundsShape; }
export interface WobblyCmd   { type: 'wobbly';   cx: number; cy: number; r: number; boundR: number;
                               wobble: number; harmonics: number; seed: number; cycles: number;
                               fillMode: FillMode; angle: number; spacing: number; outline: boolean; }
// Truchet (Carlson 2018 winged motifs, single scale): white ribbons + hatched ground.
// Carries the current bounds (like BorderCmd) so the preview can mirror the firmware's
// work-area grid + clipping; the firmware itself uses its own stored bounds.
export interface TruchetCmd  { type: 'truchet';  n: number; spacing: number; angle: number; seed: number; motifs: number;
                               left: number; right: number; up: number; down: number; shape: BoundsShape; }
export type PlotCmd = CircleCmd | SquareCmd | LineCmd | GotoCmd | HomeCmd | SetHomeCmd | PenCmd | BullseyeCmd | GridCmd | BorderCmd | WobblyCmd | TruchetCmd;

export interface LogEntry { id: number; kind: 'cmd' | 'ok' | 'err' | 'warn' | 'sys' | 'fw'; text: string; t: number; }
export interface PenState  { x: number; y: number; down: boolean; }
export interface Stroke    { color: string; points: { x: number; y: number }[]; }

// Live firmware job/driver state, polled from /api/status for the Autonomous tab.
export interface PlotterStatus {
  enqueued: number; current: number; done: number; pending: number;
  idle: boolean; aborting: boolean; paused: boolean; estop: boolean; job: string;
  drvOk: boolean; drvFlags: string;
  motion?: { vmax: number; amax: number; run_ma: number; hold_ma: number };
  matrix?: { a: number; b: number; c: number; d: number; tx: number; ty: number };
}
// One row in the Autonomous job list. The firmware only tracks job CURSORS (not the
// MCP's full plan), so labels are captured as `current` advances; not-yet-run jobs
// are known only by count and shown as unlabeled "pending".
export interface JobEntry { id: number; label: string; state: 'done' | 'doing' | 'pending'; }

// ---- constants ---------------------------------------------------

export const DEFAULTS = {
  // run de-rated 600→400 mA to match the firmware default (board_config.h) — a pen
  // gondola needs little torque and run current is the multi-hour-plot heat source.
  motion: { vmax: 350000, amax: 1690, run: 940, hold: 440 },
  bounds: { left: 276, right: 263, up: 115, down: 273, shape: 'rect' as BoundsShape },
};

// ---- bounds localStorage persistence --------------------------------
// The UI is the source of truth for bounds — firmware resets on every reboot.
// On connect the UI pushes its stored bounds to the firmware (see boundsSeeded logic).
const BOUNDS_KEY = 'plotterBounds';
function loadBounds(): PlotterBounds {
  try {
    const raw = localStorage.getItem(BOUNDS_KEY);
    if (raw) {
      const b = JSON.parse(raw);
      if (typeof b.left === 'number' && typeof b.right === 'number' &&
          typeof b.up   === 'number' && typeof b.down  === 'number') {
        return { left: b.left, right: b.right, up: b.up, down: b.down,
                 shape: b.shape === 'ellipse' ? 'ellipse' : 'rect' };
      }
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS.bounds };
}
function saveBounds(b: PlotterBounds): void {
  try { localStorage.setItem(BOUNDS_KEY, JSON.stringify(b)); } catch { /* ignore */ }
}

// Light-theme stroke palette (deepened for contrast on white) — Claude Design tokens.
const PALETTE = ['#0284c7', '#059669', '#d97706', '#db2777', '#7c3aed', '#ea580c'];

let LOG_ID = 0;
const mkLog = (kind: LogEntry['kind'], text: string): LogEntry => ({
  id: ++LOG_ID, kind, text, t: Date.now(),
});

// ---- API query builders ------------------------------------------

export function cmdToQuery(cmd: PlotCmd): string {
  switch (cmd.type) {
    case 'goto':     return `goto?x=${cmd.x}&y=${cmd.y}`;
    case 'line':     return `line?x0=${cmd.x0}&y0=${cmd.y0}&x1=${cmd.x1}&y1=${cmd.y1}&cycles=${cmd.cycles}`;
    case 'square':   return `square?cx=${cmd.cx}&cy=${cmd.cy}&size=${cmd.size}&cycles=${cmd.cycles}&fill=${cmd.fillMode}&angle=${cmd.angle}&spacing=${cmd.spacing}&outline=${cmd.outline ? 1 : 0}`;
    case 'circle':   return `circle?cx=${cmd.cx}&cy=${cmd.cy}&r=${cmd.r}&cycles=${cmd.cycles}&fill=${cmd.fillMode}&angle=${cmd.angle}&spacing=${cmd.spacing}&outline=${cmd.outline ? 1 : 0}`;
    case 'bullseye': return `bullseye?cx=${cmd.cx}&cy=${cmd.cy}`;
    case 'grid':     return `grid?cx=${cmd.cx}&cy=${cmd.cy}`;
    case 'border':   return 'border';   // firmware traces its own stored bounds
    case 'wobbly':   return `wobbly?cx=${cmd.cx}&cy=${cmd.cy}&r=${cmd.r}&bound_r=${cmd.boundR}` +
                            `&wobble=${cmd.wobble}&harmonics=${cmd.harmonics}&seed=${cmd.seed}&cycles=${cmd.cycles}` +
                            `&fill=${cmd.fillMode}&angle=${cmd.angle}&spacing=${cmd.spacing}&outline=${cmd.outline ? 1 : 0}`;
    case 'truchet':  return `truchet?n=${cmd.n}&spacing=${cmd.spacing}&angle=${cmd.angle}&seed=${cmd.seed}&motifs=${cmd.motifs}`;
    case 'home':     return 'home';
    case 'sethome':  return 'sethome';
    case 'pen':      return `pen?pos=${cmd.pos}`;
  }
}

// ---- Copy-paste JSON form ----------------------------------------
// Emits the command as a JSON object using the SAME field names parseJsonScript
// accepts (fill_mode, hatch_angle, bound_r, position …), so a logged line drops
// straight into the Script tab (wrap in [ ] or { "commands": [ ] }).
export function cmdToJson(cmd: PlotCmd): string {
  switch (cmd.type) {
    case 'goto':     return JSON.stringify({ type: 'goto', x: cmd.x, y: cmd.y });
    case 'line':     return JSON.stringify({ type: 'line', x0: cmd.x0, y0: cmd.y0, x1: cmd.x1, y1: cmd.y1, cycles: cmd.cycles });
    case 'circle':   return JSON.stringify({ type: 'circle', cx: cmd.cx, cy: cmd.cy, r: cmd.r, cycles: cmd.cycles, fill_mode: cmd.fillMode, hatch_angle: cmd.angle, spacing: cmd.spacing, outline: cmd.outline ? 1 : 0 });
    case 'square':   return JSON.stringify({ type: 'square', cx: cmd.cx, cy: cmd.cy, size: cmd.size, cycles: cmd.cycles, fill_mode: cmd.fillMode, hatch_angle: cmd.angle, spacing: cmd.spacing, outline: cmd.outline ? 1 : 0 });
    case 'wobbly':   return JSON.stringify({ type: 'wobbly', cx: cmd.cx, cy: cmd.cy, r: cmd.r, bound_r: cmd.boundR, wobble: cmd.wobble, harmonics: cmd.harmonics, seed: cmd.seed, cycles: cmd.cycles, fill_mode: cmd.fillMode, hatch_angle: cmd.angle, spacing: cmd.spacing, outline: cmd.outline ? 1 : 0 });
    case 'truchet':  return JSON.stringify({ type: 'truchet', n: cmd.n, spacing: cmd.spacing, angle: cmd.angle, seed: cmd.seed, motifs: cmd.motifs });
    case 'bullseye': return JSON.stringify({ type: 'bullseye', cx: cmd.cx, cy: cmd.cy });
    case 'grid':     return JSON.stringify({ type: 'grid', cx: cmd.cx, cy: cmd.cy });
    case 'pen':      return JSON.stringify({ type: 'pen', position: cmd.pos });
    case 'home':     return JSON.stringify({ type: 'home' });
    case 'sethome':  return JSON.stringify({ type: 'sethome' });
    case 'border':   return JSON.stringify({ type: 'border' });
  }
}

// ---- Human-readable job label ------------------------------------
// Mirrors the firmware's g_job_desc formatting so the console shows the same
// description whether the label comes from the client (pending) or from a
// firmware status poll (running / done).
export function cmdLabel(cmd: PlotCmd): string {
  const f = (n: number) => n.toFixed(0);
  const rep = (n: number) => n > 1 ? ` ×${n}` : '';
  switch (cmd.type) {
    case 'line':     return `line (${f(cmd.x0)},${f(cmd.y0)})→(${f(cmd.x1)},${f(cmd.y1)})${rep(cmd.cycles)}`;
    case 'circle':   return `circle (${f(cmd.cx)},${f(cmd.cy)}) r=${f(cmd.r)}${rep(cmd.cycles)}`;
    case 'square':   return `square (${f(cmd.cx)},${f(cmd.cy)}) s=${f(cmd.size)}${rep(cmd.cycles)}`;
    case 'goto':     return `goto (${f(cmd.x)},${f(cmd.y)})`;
    case 'bullseye': return `bullseye (${f(cmd.cx)},${f(cmd.cy)})`;
    case 'grid':     return `grid (${f(cmd.cx)},${f(cmd.cy)})`;
    case 'wobbly':   return `wobbly (${f(cmd.cx)},${f(cmd.cy)}) r=${f(cmd.r)}${rep(cmd.cycles)}`;
    case 'truchet':  return `truchet ${cmd.n}×${cmd.n} sp=${cmd.spacing} ang=${cmd.angle}°`;
    case 'border':   return 'border';
    case 'home':     return 'home';
    case 'sethome':  return 'sethome';
    case 'pen':      return `pen ${cmd.pos}`;
  }
}

// ---- JSON script parser ------------------------------------------
// Accepts EITHER a bare JSON array of command objects, OR an object that wraps
// them under a "commands" (or "script") key — e.g. { "commands": [ … ] } — and
// converts each to an API query string. Same object shape as plot_script in the
// MCP, so scripts are copy-pasteable between Claude Desktop and this console.
import type { GeneratorSpec } from '../lib/runPipeline';
import {
  gridCtxFromMetadata,
  gridCtxFromPlotterBounds,
  computeCell,
  gridClearQueries,
  hydrateGridCommands,
  type GridCtx,
} from '../lib/gridScript';
export type { GeneratorSpec };

export interface ParsedLine {
  idx: number;      // 0-based index in the JSON array (-1 = top-level error)
  raw: string;      // compact JSON of the item (for display)
  query?: string;   // present for regular firmware commands
  generator?: GeneratorSpec;  // present for "generate" items — expanded at run time
  gridSelect?: { col: number; row: number; gc: GridCtx };
  gridClear?: { gc: GridCtx };
  error?: string;   // present when validation failed
}

export function parseJsonScript(
  text: string,
  opts?: { plotterBounds?: PlotterBounds },
): ParsedLine[] {
  const t = text.trim();
  if (!t) return [];

  let arr: unknown[];
  let gridCtx: GridCtx | null = null;
  const rn = (n: number) => Math.round(n * 100) / 100;

  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === 'object') {
      // Unwrap { commands: [ … ] } or { script: [ … ] }.
      // Also extract grid context from outer metadata (klee-style composition files).
      const wrap = parsed as Record<string, unknown>;
      gridCtx = gridCtxFromMetadata(wrap as { metadata?: { work_area?: Record<string, number>; grid?: Record<string, number> } });
      if (gridCtx && opts?.plotterBounds) {
        gridCtx = gridCtxFromPlotterBounds(opts.plotterBounds, gridCtx);
      }
      const inner = Array.isArray(wrap.commands) ? wrap.commands
                  : Array.isArray(wrap.script)   ? wrap.script
                  : null;
      if (!inner)
        return [{ idx: -1, raw: '', error: 'Expected a JSON array [ … ] or an object with a "commands" array' }];
      arr = hydrateGridCommands(inner as { type?: string }[], gridCtx) as unknown[];
    } else {
      return [{ idx: -1, raw: '', error: 'Expected a JSON array [ … ] or an object with a "commands" array' }];
    }
  } catch (e) {
    return [{ idx: -1, raw: '', error: `JSON syntax: ${(e as Error).message}` }];
  }

  const results: ParsedLine[] = [];

  arr.forEach((item, idx) => {
    const raw = JSON.stringify(item);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      results.push({ idx, raw, error: 'each item must be an object' });
      return;
    }

    const o = item as Record<string, unknown>;
    const type = String(o.type ?? '').toLowerCase();
    const num = (k: string, def: number): number => {
      const v = Number(o[k]);
      return isFinite(v) ? v : def;
    };
    const req = (...keys: string[]): string | null => {
      for (const k of keys) if (!isFinite(Number(o[k]))) return `missing "${k}"`;
      return null;
    };

    // Silently skip comment-only objects (no type), preflight status checks, and
    // planning-only commands — they carry no executable firmware action.
    if (!type || type === 'status' || type === 'grid_plan') return;

    switch (type) {
      case 'goto': {
        const e = req('x', 'y'); if (e) { results.push({ idx, raw, error: `goto: ${e}` }); return; }
        results.push({ idx, raw, query: `goto?x=${num('x',0)}&y=${num('y',0)}` });
        return;
      }
      case 'pen': {
        const pos = String(o.position ?? o.pos ?? '').toLowerCase();
        if (pos !== 'up' && pos !== 'down') { results.push({ idx, raw, error: 'pen: "position" must be "up" or "down"' }); return; }
        results.push({ idx, raw, query: `pen?pos=${pos}` });
        return;
      }
      case 'home':    results.push({ idx, raw, query: 'home' });    return;
      case 'sethome': results.push({ idx, raw, query: 'sethome' }); return;
      case 'stop':    results.push({ idx, raw, query: 'stop' });    return;
      case 'border':  results.push({ idx, raw, query: 'border' });  return;
      case 'line': {
        const e = req('x0','y0','x1','y1'); if (e) { results.push({ idx, raw, error: `line: ${e}` }); return; }
        results.push({ idx, raw, query:
          `line?x0=${num('x0',0)}&y0=${num('y0',0)}&x1=${num('x1',0)}&y1=${num('y1',0)}&cycles=${num('cycles',1)}` });
        return;
      }
      case 'circle': {
        const e = req('cx','cy','r'); if (e) { results.push({ idx, raw, error: `circle: ${e}` }); return; }
        const ol = o.outline === false || o.outline === 0 ? 0 : 1;
        results.push({ idx, raw, query:
          `circle?cx=${num('cx',0)}&cy=${num('cy',0)}&r=${num('r',0)}&cycles=${num('cycles',1)}&fill=${num('fill_mode',0)}&angle=${num('hatch_angle',0)}&spacing=${num('spacing',3)}&outline=${ol}` });
        return;
      }
      case 'square': {
        const e = req('cx','cy','size'); if (e) { results.push({ idx, raw, error: `square: ${e}` }); return; }
        const ol = o.outline === false || o.outline === 0 ? 0 : 1;
        results.push({ idx, raw, query:
          `square?cx=${num('cx',0)}&cy=${num('cy',0)}&size=${num('size',0)}&cycles=${num('cycles',1)}&fill=${num('fill_mode',0)}&angle=${num('hatch_angle',0)}&spacing=${num('spacing',3)}&outline=${ol}` });
        return;
      }
      case 'wobbly': {
        const e = req('cx','cy','r'); if (e) { results.push({ idx, raw, error: `wobbly: ${e}` }); return; }
        const ol = o.outline === false || o.outline === 0 ? 0 : 1;
        results.push({ idx, raw, query:
          `wobbly?cx=${num('cx',0)}&cy=${num('cy',0)}&r=${num('r',0)}&bound_r=${num('bound_r',0)}&wobble=${num('wobble',0.4)}&harmonics=${num('harmonics',3)}&seed=${num('seed',42)}&cycles=${num('cycles',1)}&fill=${num('fill_mode',0)}&angle=${num('hatch_angle',0)}&spacing=${num('spacing',3)}&outline=${ol}` });
        return;
      }
      case 'truchet': {
        results.push({ idx, raw, query:
          `truchet?n=${num('n',4)}&spacing=${num('spacing',3)}&angle=${num('angle',45)}&seed=${num('seed',42)}&motifs=${num('motifs',0)}` });
        return;
      }
      case 'bullseye':
        results.push({ idx, raw, query: `bullseye?cx=${num('cx',0)}&cy=${num('cy',0)}` }); return;
      case 'grid':
        results.push({ idx, raw, query: `grid?cx=${num('cx',0)}&cy=${num('cy',0)}` }); return;
      case 'arc': {
        const e = req('cx','cy','r','a0','a1'); if (e) { results.push({ idx, raw, error: `arc: ${e}` }); return; }
        results.push({ idx, raw, query:
          `arc?cx=${num('cx',0)}&cy=${num('cy',0)}&r=${num('r',10)}&a0=${num('a0',0)}&a1=${num('a1',0)}&cw=${num('cw',0)}&cycles=${num('cycles',1)}&lift=${num('lift',1)}` });
        return;
      }
      case 'bounds': {
        const e = req('xn','xp','yn','yp'); if (e) { results.push({ idx, raw, error: `bounds: ${e}` }); return; }
        results.push({ idx, raw, query:
          `bounds?xn=${num('xn',0)}&xp=${num('xp',0)}&yn=${num('yn',0)}&yp=${num('yp',0)}&shape=${num('shape',0)}` });
        return;
      }
      case 'matrix': {
        results.push({ idx, raw, query:
          `matrix?a=${num('a',1)}&b=${num('b',0)}&c=${num('c',0)}&d=${num('d',1)}&tx=${num('tx',0)}&ty=${num('ty',0)}` });
        return;
      }
      case 'speed':
      case 'set_speed': {
        const e = req('vmax'); if (e) { results.push({ idx, raw, error: `${type}: ${e}` }); return; }
        results.push({ idx, raw, query: `speed?vmax=${num('vmax',0)}` });
        return;
      }
      case 'accel': {
        const e = req('amax'); if (e) { results.push({ idx, raw, error: `accel: ${e}` }); return; }
        results.push({ idx, raw, query: `accel?amax=${num('amax',0)}` });
        return;
      }
      case 'cur':
      case 'current':
      case 'set_current': {
        // Accept both 'run'/'hold' (console style) and 'run_ma'/'hold_ma' (MCP/klee style).
        const runVal = isFinite(Number(o.run_ma)) ? Number(o.run_ma) : num('run', 0);
        const holdVal = isFinite(Number(o.hold_ma)) ? Number(o.hold_ma) : num('hold', 200);
        if (!isFinite(runVal) || runVal === 0) { results.push({ idx, raw, error: `${type}: missing "run" or "run_ma"` }); return; }
        results.push({ idx, raw, query: `cur?run=${runVal}&hold=${holdVal}` });
        return;
      }
      case 'grid_select': {
        let gc: GridCtx | null = gridCtx;
        if (isFinite(Number(o.cols)) && isFinite(Number(o.full_xn))) {
          gc = {
            cols: num('cols', 1), rows: num('rows', 1), padding_mm: num('padding_mm', 5),
            full_xn: num('full_xn', 0), full_xp: num('full_xp', 0),
            full_yn: num('full_yn', 0), full_yp: num('full_yp', 0),
          };
        }
        if (!gc) { results.push({ idx, raw, error: 'grid_select: need cols/rows/full_xn/xp/yn/yp or outer metadata.grid + metadata.work_area' }); return; }
        const col = num('col', 0), row = num('row', 0);
        try {
          computeCell(gc, col, row);
          results.push({ idx, raw, gridSelect: { col, row, gc } });
        } catch (e) {
          results.push({ idx, raw, error: (e as Error).message });
        }
        return;
      }
      case 'grid_clear': {
        let gc: GridCtx | null = gridCtx;
        if (isFinite(Number(o.full_xn))) {
          gc = { cols: 1, rows: 1, padding_mm: 5, full_xn: num('full_xn', 0), full_xp: num('full_xp', 0), full_yn: num('full_yn', 0), full_yp: num('full_yp', 0) };
        }
        if (!gc) { results.push({ idx, raw, error: 'grid_clear: need full_xn/xp/yn/yp or outer metadata.work_area' }); return; }
        results.push({ idx, raw, gridClear: { gc } });
        return;
      }
      case 'generate': {
        const key = String(o.generator ?? o.key ?? '');
        if (!key) { results.push({ idx, raw, error: 'generate: missing "generator" key' }); return; }
        const params: Record<string, number | string | boolean> = {};
        const rawParams = o.params && typeof o.params === 'object' && !Array.isArray(o.params)
          ? o.params as Record<string, unknown> : {};
        for (const [k, v] of Object.entries(rawParams)) {
          if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') params[k] = v;
        }
        let warp: GeneratorSpec['warp'] | undefined;
        if (o.warp && typeof o.warp === 'object' && !Array.isArray(o.warp)) {
          const w = o.warp as Record<string, unknown>;
          const mode = String(w.mode ?? 'water');
          const wp: Record<string, number> = {};
          if (w.params && typeof w.params === 'object') {
            for (const [k, v] of Object.entries(w.params as Record<string, unknown>)) {
              if (typeof v === 'number') wp[k] = v;
            }
          }
          warp = { mode, params: wp };
        }
        results.push({ idx, raw, generator: { key, params, warp } });
        return;
      }

      default:
        results.push({ idx, raw, error: `unknown type "${type}"` });
    }
  });

  return results;
}

export function boundsToQuery(b: PlotterBounds): string {
  // Firmware params: xn = X−, xp = X+, yn = Y−, yp = Y+, shape 0=rect 1=ellipse
  // up = distance above origin (|yn|), down = distance below origin (yp)
  return `bounds?xn=${-b.left}&xp=${b.right}&yn=${-b.up}&yp=${b.down}&shape=${b.shape === 'ellipse' ? 1 : 0}`;
}

// ---- shared flow-controlled query streamer -----------------------
// The board's draw queue holds 256 jobs and sendRaw returns on ENQUEUE (not on
// draw-completion). To never overflow — even when the machine is already busy
// with an EARLIER stack — gate every burst on the board's REAL pending count.
// Crucially: if the status read fails OR the queue is full, WAIT rather than send
// (a rejection must never look like "room available"). Used by both the JSON
// Script tab and the G-code digester so they share identical back-pressure.
export type SendResult = 'ok' | 'rejected' | 'error';
export interface StreamItem { query: string; raw?: string; }
/** Firmware /api/batch only accepts these ops — everything else must use sendRaw. */
export const BATCH_OPS = new Set(['pen', 'goto', 'line', 'arc']);
export function isBatchableQuery(query: string): boolean {
  return BATCH_OPS.has(query.split('?')[0]);
}
/** Board health snapshot the runner's watchdog reads from one /api/status poll. */
export interface StreamHealth {
  pending: number; done: number; current: number; x: number; y: number;
  drvOk: boolean; drvFlags: string; estop: boolean; aborting: boolean; paused: boolean;
}
export interface StreamHandlers {
  sendRaw: (ep: string, json?: string) => Promise<SendResult>;
  /** Optional: enqueue many ops in one request. When present, streamQueries uses it
   *  (≈80× fewer connections); otherwise it falls back to one request per op. */
  sendBatch?: (queries: string[]) => Promise<{ accepted: number; rejected: number } | 'error'>;
  getPending: () => Promise<number | null>;
  /** Optional richer poll: when present the runner uses it for flow control AND a
   *  progress/health watchdog, so a board that stops draining surfaces a real error
   *  instead of an infinite silent wait. Falls back to getPending when absent. */
  getHealth?: () => Promise<StreamHealth | null>;
  isCancelled: () => boolean;
  onProgress?: (sent: number, errors: number) => void;
  pushLog: (kind: LogEntry['kind'], text: string) => void;
  label?: string;
}
export async function streamQueries(items: StreamItem[], h: StreamHandlers): Promise<{ sent: number; errors: number; stopped: boolean }> {
  const CAP = 256, HIGH = 220, BATCH = 64;
  const MAX_NET_FAILS = 60;          // consecutive transient failures before we give up
  const STALL_MS = 20000;            // board enqueued but no motion for this long → halt w/ reason
  const BEAT_MS = 5000;              // progress heartbeat cadence (so a halt leaves a trail)
  const label = h.label ?? 'stream';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let errors = 0, i = 0, warned = false, netFails = 0, pausedWarned = false;
  // Watchdog: "progress" = the board's done/current/x/y fingerprint changing. A
  // single job (circle/grid cell) can run minutes without `done` advancing, so we
  // also watch x/y — a live plot moves the pen continuously; a true stall freezes
  // all four. lastMoveAt resets whenever the fingerprint changes.
  let fp = '', lastMoveAt = Date.now(), lastBeatAt = Date.now();

  const onTransient = async (): Promise<boolean> => {
    // returns true if we should give up
    if (++netFails >= MAX_NET_FAILS) {
      h.pushLog('err', `[${label}] aborting — ${netFails} straight network failures (connection lost?). ${i}/${items.length} sent.`);
      return true;
    }
    if (netFails === 1) h.pushLog('sys', `[${label}] network busy — backing off & retrying (not dropping jobs)…`);
    await sleep(Math.min(2000, 150 * netFails));
    return false;
  };

  while (i < items.length && !h.isCancelled()) {
    // One poll drives flow control AND the watchdog. getHealth (full status) is
    // preferred; getPending is the legacy fallback (no health/progress data).
    const health = h.getHealth ? await h.getHealth() : null;
    const pend = health ? health.pending : (h.getHealth ? null : await h.getPending());

    if (pend === null) {
      // Status unreadable — the link is stalled/wedged. Route through the backoff
      // so it can't spin here forever; eventually aborts with a real error.
      if (await onTransient()) {
        h.pushLog('err', `[${label}] HALT — lost contact with board (status unreadable). ${i}/${items.length} sent.`);
        return { sent: i, errors, stopped: true };
      }
      continue;
    }
    netFails = 0;                     // a readable status clears the transient counter

    if (health) {
      // Health bail-outs: a board that stopped draining for a known reason should
      // surface the cause immediately instead of waiting at the watermark forever.
      if (health.estop)
        { h.pushLog('err', `[${label}] HALT — board E-STOP latched. ${i}/${items.length} sent; ${pend} still queued.`); return { sent: i, errors, stopped: true }; }
      if (!health.drvOk)
        { h.pushLog('err', `[${label}] HALT — driver fault (${health.drvFlags || '?'}). ${i}/${items.length} sent. Fix cause, clear fault, re-run.`); return { sent: i, errors, stopped: true }; }
      if (health.aborting)
        { h.pushLog('err', `[${label}] HALT — board is flushing its queue (abort). ${i}/${items.length} sent.`); return { sent: i, errors, stopped: true }; }
      if (health.paused) {
        if (!pausedWarned) { h.pushLog('sys', `[${label}] board paused — holding (press Resume on the board/console).`); pausedWarned = true; }
        lastMoveAt = Date.now();      // an intentional pause is not a stall
        await sleep(400);
        continue;
      }
      pausedWarned = false;

      // Progress watchdog + heartbeat.
      const now = Date.now();
      const nfp = `${health.done}|${health.current}|${Math.round(health.x * 10)}|${Math.round(health.y * 10)}`;
      if (nfp !== fp) { fp = nfp; lastMoveAt = now; }
      if (now - lastBeatAt >= BEAT_MS) {
        lastBeatAt = now;
        h.pushLog('sys', `[${label}] streaming ${i}/${items.length} · queue ${pend}/${CAP} · done ${health.done} · pen (${health.x.toFixed(0)},${health.y.toFixed(0)})`);
      }
      if (pend > 0 && now - lastMoveAt >= STALL_MS) {
        h.pushLog('err', `[${label}] HALT — board stopped advancing for ${Math.round((now - lastMoveAt) / 1000)}s `
          + `(done stuck at ${health.done}, ${pend} queued, pen frozen at ${health.x.toFixed(0)},${health.y.toFixed(0)}). `
          + `Likely a blocked move or a wedged link. ${i}/${items.length} sent.`);
        return { sent: i, errors, stopped: true };
      }
    }

    if (pend >= HIGH) {
      if (!warned) {
        h.pushLog('sys', `[${label}] board busy (${pend}/${CAP} queued) — waiting for room…`);
        warned = true;
      }
      await sleep(400);
      continue;                       // do NOT send while full
    }
    warned = false;
    const room = HIGH - pend;         // room reserved → a batch sized ≤ room can't overflow

    if (h.sendBatch && isBatchableQuery(items[i].query)) {
      // Batch only consecutive pen/goto/line/arc ops — circle/home/etc. use sendRaw below.
      const maxN = Math.min(room, BATCH, items.length - i);
      let n = 0;
      while (n < maxN && isBatchableQuery(items[i + n].query)) n++;
      const res = await h.sendBatch(items.slice(i, i + n).map((it) => it.query));
      if (res === 'error') { if (await onTransient()) return { sent: i, errors, stopped: true }; continue; }
      netFails = 0;
      errors += res.rejected;         // sized to fit → rejections are genuine (skip them)
      const actual = res.accepted + res.rejected;
      if (actual < n) {
        // Firmware processed fewer ops than sent (body may have been truncated by a recv
        // timeout). Advance only past the confirmed ops; the rest retry next iteration.
        i += actual;
        h.pushLog('warn', `[${label}] partial batch: sent ${n}, fw confirmed ${actual} — ${n - actual} retrying`);
      } else {
        i += n;                       // all n were processed (accepted or rejected)
      }
      h.onProgress?.(i, errors);
      continue;
    }

    if (h.sendBatch) {
      // Non-batchable op (circle, square, home, …) — individual GET, same as MCP batchSend.
      const res = await h.sendRaw(items[i].query, items[i].raw);
      if (res === 'error') { if (await onTransient()) return { sent: i, errors, stopped: true }; continue; }
      netFails = 0;
      if (res === 'rejected') errors++;
      i++;
      h.onProgress?.(i, errors);
      continue;
    }

    // Per-op fallback (no batch support).
    let budget = room;
    while (budget > 0 && i < items.length && !h.isCancelled()) {
      const res = await h.sendRaw(items[i].query, items[i].raw);
      if (res === 'error') { if (await onTransient()) return { sent: i, errors, stopped: true }; break; }
      netFails = 0;
      if (res === 'rejected') errors++;
      i++;
      budget--;
      h.onProgress?.(i, errors);
    }
  }
  return { sent: i, errors, stopped: h.isCancelled() && i < items.length };
}

export function matrixToQuery(m: MatrixParams): string {
  return `matrix?a=${m.a}&b=${m.b}&c=${m.c}&d=${m.d}&tx=${m.tx}&ty=${m.ty}`;
}

export function motionToQuery(key: keyof MotionParams, val: number, m: MotionParams): string {
  if (key === 'vmax') return `speed?vmax=${val}`;
  if (key === 'amax') return `accel?amax=${val}`;
  if (key === 'run')  return `cur?run=${val}&hold=${m.hold}`;
  if (key === 'hold') return `cur?run=${m.run}&hold=${val}`;
  return '';
}

// ---- Truchet (Carlson 2018 winged motifs) -------------------------
// Mirrors the firmware's tk_* generator in main.c BIT-FOR-BIT (same LCG, same
// row-major motif picks, same geometry), so the preview is exactly what the
// plotter draws. If you change one side, change the other.

export const TRUCHET_MOTIF_NAMES = ['\\', '/', '-', '|', '+.', 'x.', '+',
  'fne', 'fsw', 'fnw', 'fse', 'tn', 'ts', 'te', 'tw'] as const;
export const TRUCHET_DEFAULT_MASK = 0x07a3;  // \ / x. fne fsw fnw fse
const TRUCHET_MIN_CELL = 40;
// Per-motif: bit e set = edge e (0=N,1=E,2=S,3=W) carries a dot, not a strip.
const TM_DOT_EDGES = [0, 0, 5, 10, 15, 0, 0, 12, 3, 6, 9, 4, 1, 8, 2];

type Pt = { x: number; y: number; pen: boolean };

function buildTruchetPath(cmd: TruchetCmd, pts: Pt[]): void {
  const xmin = -cmd.left, xmax = cmd.right, ymin = -cmd.down, ymax = cmd.up;
  const W = xmax - xmin, H = ymax - ymin;
  if (W <= 0 || H <= 0) return;

  let n = Math.max(1, Math.floor(cmd.n));
  let sz = W / n;
  if (sz < TRUCHET_MIN_CELL) {
    n = Math.max(1, Math.floor(W / TRUCHET_MIN_CELL));
    sz = W / n;
  }
  let rows = Math.max(1, Math.floor(H / sz));
  while (n * rows > 1024) rows--;
  const ccx = (xmin + xmax) / 2, ccy = (ymin + ymax) / 2;
  const gx = ccx - n * sz / 2, gy = ccy - rows * sz / 2;
  const erx = W / 2, ery = H / 2;
  const ellipse = cmd.shape === 'ellipse';

  let mask = (cmd.motifs & 0x7fff) || TRUCHET_DEFAULT_MASK;
  const motifs: number[] = [];
  for (let i = 0; i < 15; i++) if (mask & (1 << i)) motifs.push(i);

  // Same LCG as firmware tk_rand(): picks consumed row-major BEFORE drawing.
  let s = cmd.seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 16) & 0x7fff; };
  const picks: number[] = [];
  for (let i = 0; i < n * rows; i++) picks.push(motifs[rnd() % motifs.length]);

  // Pen sink with work-area clipping (mirror of tk_seg/tk_clip_seg).
  let px = NaN, py = NaN, down = false;
  const clipSeg = (x0: number, y0: number, x1: number, y1: number): [number, number] | null => {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const ps = [-dx, dx, -dy, dy];
    const qs = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
    for (let k = 0; k < 4; k++) {
      if (Math.abs(ps[k]) < 1e-9) { if (qs[k] < 0) return null; }
      else {
        const r = qs[k] / ps[k];
        if (ps[k] < 0) { if (r > t0) t0 = r; } else { if (r < t1) t1 = r; }
      }
    }
    if (ellipse) {
      const ex = (x0 - ccx) / erx, ey = (y0 - ccy) / ery;
      const fx = dx / erx, fy = dy / ery;
      const a = fx * fx + fy * fy, b = 2 * (ex * fx + ey * fy), c = ex * ex + ey * ey - 1;
      if (a < 1e-12) { if (c > 0) return null; }
      else {
        const disc = b * b - 4 * a * c;
        if (disc < 0) return null;
        const sq = Math.sqrt(disc);
        const u0 = (-b - sq) / (2 * a), u1 = (-b + sq) / (2 * a);
        if (u0 > t0) t0 = u0;
        if (u1 < t1) t1 = u1;
      }
    }
    return t1 > t0 ? [t0, t1] : null;
  };
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const c = clipSeg(x0, y0, x1, y1);
    if (!c) { down = false; return; }
    const ax = x0 + (x1 - x0) * c[0], ay = y0 + (y1 - y0) * c[0];
    const bx = x0 + (x1 - x0) * c[1], by = y0 + (y1 - y0) * c[1];
    const contig = down && Math.abs(ax - px) < 0.05 && Math.abs(ay - py) < 0.05;
    if (!contig) pts.push({ x: ax, y: ay, pen: false });
    pts.push({ x: bx, y: by, pen: true });
    px = bx; py = by; down = true;
  };
  const arc = (acx: number, acy: number, r: number, a0: number, a1: number) => {
    const nseg = Math.max(4, Math.round(Math.abs(a1 - a0) / 360 * Math.max(12, r * 1.2)));
    let lx = acx + r * Math.cos(a0 * Math.PI / 180), ly = acy + r * Math.sin(a0 * Math.PI / 180);
    for (let k = 1; k <= nseg; k++) {
      const a = (a0 + (a1 - a0) * k / nseg) * Math.PI / 180;
      const nx = acx + r * Math.cos(a), ny = acy + r * Math.sin(a);
      seg(lx, ly, nx, ny);
      lx = nx; ly = ny;
    }
  };

  // Corner angle ranges (Y-down): NW 0..90, NE 90..180, SE 180..270, SW 270..360.
  const strokes = (m: number, x0: number, y0: number) => {
    const A = sz / 3, B = 2 * sz / 3;
    const nwx = x0, nwy = y0, nex = x0 + sz, ney = y0;
    const sex = x0 + sz, sey = y0 + sz, swx = x0, swy = y0 + sz;
    switch (m) {
      case 0:  arc(nex, ney, A, 90, 180); arc(nex, ney, B, 90, 180);
               arc(swx, swy, A, 270, 360); arc(swx, swy, B, 270, 360); break;
      case 1:  arc(nwx, nwy, A, 0, 90); arc(nwx, nwy, B, 0, 90);
               arc(sex, sey, A, 180, 270); arc(sex, sey, B, 180, 270); break;
      case 2:  seg(x0, y0 + A, x0 + sz, y0 + A); seg(x0 + sz, y0 + B, x0, y0 + B); break;
      case 3:  seg(x0 + A, y0, x0 + A, y0 + sz); seg(x0 + B, y0 + sz, x0 + B, y0); break;
      case 4:  break;
      case 5:  arc(nwx, nwy, A, 0, 90); arc(swx, swy, A, 270, 360);
               arc(sex, sey, A, 180, 270); arc(nex, ney, A, 90, 180); break;
      case 6:  seg(x0, y0 + A, x0 + A, y0 + A); seg(x0 + B, y0 + A, x0 + sz, y0 + A);
               seg(x0, y0 + B, x0 + A, y0 + B); seg(x0 + B, y0 + B, x0 + sz, y0 + B);
               seg(x0 + A, y0, x0 + A, y0 + A); seg(x0 + A, y0 + B, x0 + A, y0 + sz);
               seg(x0 + B, y0, x0 + B, y0 + A); seg(x0 + B, y0 + B, x0 + B, y0 + sz); break;
      case 7:  arc(nex, ney, A, 90, 180); arc(nex, ney, B, 90, 180); break;
      case 8:  arc(swx, swy, A, 270, 360); arc(swx, swy, B, 270, 360); break;
      case 9:  arc(nwx, nwy, A, 0, 90); arc(nwx, nwy, B, 0, 90); break;
      case 10: arc(sex, sey, A, 180, 270); arc(sex, sey, B, 180, 270); break;
      case 11: seg(x0, y0 + B, x0 + sz, y0 + B); arc(nwx, nwy, A, 0, 90); arc(nex, ney, A, 90, 180); break;
      case 12: seg(x0, y0 + A, x0 + sz, y0 + A); arc(swx, swy, A, 270, 360); arc(sex, sey, A, 180, 270); break;
      case 13: seg(x0 + A, y0, x0 + A, y0 + sz); arc(nex, ney, A, 90, 180); arc(sex, sey, A, 180, 270); break;
      case 14: seg(x0 + B, y0, x0 + B, y0 + sz); arc(nwx, nwy, A, 0, 90); arc(swx, swy, A, 270, 360); break;
    }
  };
  const MID = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  const DOT_A0 = [0, 90, 180, 270];
  const dotHalf = (e: number, x0: number, y0: number, outer: boolean) => {
    const a0 = DOT_A0[e] + (outer ? 180 : 0);
    arc(x0 + MID[e][0] * sz, y0 + MID[e][1] * sz, sz / 6, a0, a0 + 180);
  };

  const d2 = (u: number, v: number, a: number, b: number) => (u - a) * (u - a) + (v - b) * (v - b);
  const R1 = 1 / 9, R2 = 4 / 9, RD = 1 / 36;
  const ANN = (u: number, v: number, a: number, b: number) => { const d = d2(u, v, a, b); return d >= R1 && d <= R2; };
  const QD = (u: number, v: number, a: number, b: number) => d2(u, v, a, b) < R1;
  const insideMotif = (m: number, u: number, v: number): boolean => {
    switch (m) {
      case 0:  return ANN(u, v, 1, 0) || ANN(u, v, 0, 1);
      case 1:  return ANN(u, v, 0, 0) || ANN(u, v, 1, 1);
      case 2:  return v >= 1 / 3 && v <= 2 / 3;
      case 3:  return u >= 1 / 3 && u <= 2 / 3;
      case 4:  return false;
      case 5:  return !(QD(u, v, 0, 0) || QD(u, v, 1, 0) || QD(u, v, 1, 1) || QD(u, v, 0, 1));
      case 6:  return (v >= 1 / 3 && v <= 2 / 3) || (u >= 1 / 3 && u <= 2 / 3);
      case 7:  return ANN(u, v, 1, 0);
      case 8:  return ANN(u, v, 0, 1);
      case 9:  return ANN(u, v, 0, 0);
      case 10: return ANN(u, v, 1, 1);
      case 11: return v <= 2 / 3 && !QD(u, v, 0, 0) && !QD(u, v, 1, 0);
      case 12: return v >= 1 / 3 && !QD(u, v, 0, 1) && !QD(u, v, 1, 1);
      case 13: return u >= 1 / 3 && !QD(u, v, 1, 0) && !QD(u, v, 1, 1);
      case 14: return u <= 2 / 3 && !QD(u, v, 0, 0) && !QD(u, v, 0, 1);
      default: return false;
    }
  };
  const excluded = (m: number, u: number, v: number): boolean =>
    insideMotif(m, u, v) ||
    d2(u, v, 0.5, 0) <= RD || d2(u, v, 1, 0.5) <= RD ||
    d2(u, v, 0.5, 1) <= RD || d2(u, v, 0, 0.5) <= RD;

  // Per-motif hatch boundary candidates (unit coords): circles + axis lines.
  const CNR = [[0, 0], [1, 0], [1, 1], [0, 1]];  // NW NE SE SW
  const motifCircles = (m: number): number[][] => {
    const c: number[][] = MID.map(p => [p[0], p[1], 1 / 6]);
    const add = (ci: number, r: number) => c.push([CNR[ci][0], CNR[ci][1], r]);
    switch (m) {
      case 0:  add(1, 1 / 3); add(1, 2 / 3); add(3, 1 / 3); add(3, 2 / 3); break;
      case 1:  add(0, 1 / 3); add(0, 2 / 3); add(2, 1 / 3); add(2, 2 / 3); break;
      case 5:  add(0, 1 / 3); add(1, 1 / 3); add(2, 1 / 3); add(3, 1 / 3); break;
      case 7:  add(1, 1 / 3); add(1, 2 / 3); break;
      case 8:  add(3, 1 / 3); add(3, 2 / 3); break;
      case 9:  add(0, 1 / 3); add(0, 2 / 3); break;
      case 10: add(2, 1 / 3); add(2, 2 / 3); break;
      case 11: add(0, 1 / 3); add(1, 1 / 3); break;
      case 12: add(3, 1 / 3); add(2, 1 / 3); break;
      case 13: add(1, 1 / 3); add(2, 1 / 3); break;
      case 14: add(0, 1 / 3); add(3, 1 / 3); break;
    }
    return c;
  };
  const motifLines = (m: number): { u: number[]; v: number[] } => {
    switch (m) {
      case 2:  return { u: [], v: [1 / 3, 2 / 3] };
      case 3:  return { u: [1 / 3, 2 / 3], v: [] };
      case 6:  return { u: [1 / 3, 2 / 3], v: [1 / 3, 2 / 3] };
      case 11: return { u: [], v: [2 / 3] };
      case 12: return { u: [], v: [1 / 3] };
      case 13: return { u: [1 / 3], v: [] };
      case 14: return { u: [2 / 3], v: [] };
      default: return { u: [], v: [] };
    }
  };

  const hatchTile = (m: number, x0: number, y0: number) => {
    const spacing = cmd.spacing;
    const th = cmd.angle * Math.PI / 180;
    const dx = Math.cos(th), dy = Math.sin(th);
    const nx = -Math.sin(th), ny = Math.cos(th);
    const circles = motifCircles(m), lines = motifLines(m);
    const offs = [x0 * nx + y0 * ny, (x0 + sz) * nx + y0 * ny,
                  x0 * nx + (y0 + sz) * ny, (x0 + sz) * nx + (y0 + sz) * ny];
    const k0 = Math.ceil(Math.min(...offs) / spacing), k1 = Math.floor(Math.max(...offs) / spacing);
    for (let k = k0; k <= k1; k++) {
      const lx = k * spacing * nx, ly = k * spacing * ny;
      // clip the infinite hatch line to the tile square
      let s0 = -1e9, s1 = 1e9;
      const ps = [-dx, dx, -dy, dy];
      const qs = [lx - x0, x0 + sz - lx, ly - y0, y0 + sz - ly];
      let miss = false;
      for (let i = 0; i < 4; i++) {
        if (Math.abs(ps[i]) < 1e-7) { if (qs[i] < 0) { miss = true; break; } }
        else {
          const r = qs[i] / ps[i];
          if (ps[i] < 0) { if (r > s0) s0 = r; } else { if (r < s1) s1 = r; }
        }
      }
      if (miss || s1 <= s0) continue;
      const ts: number[] = [s0, s1];
      for (const [cu, cv, cr] of circles) {
        const ccx2 = x0 + cu * sz, ccy2 = y0 + cv * sz, r = cr * sz;
        const ex = lx - ccx2, ey = ly - ccy2;
        const b = 2 * (ex * dx + ey * dy), c = ex * ex + ey * ey - r * r;
        const disc = b * b - 4 * c;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        for (const t of [(-b - sq) / 2, (-b + sq) / 2])
          if (t > s0 && t < s1) ts.push(t);
      }
      for (const c of lines.u)
        if (Math.abs(dx) > 1e-7) { const t = (x0 + c * sz - lx) / dx; if (t > s0 && t < s1) ts.push(t); }
      for (const c of lines.v)
        if (Math.abs(dy) > 1e-7) { const t = (y0 + c * sz - ly) / dy; if (t > s0 && t < s1) ts.push(t); }
      ts.sort((a, b) => a - b);
      const keep: [number, number][] = [];
      for (let i = 0; i + 1 < ts.length; i++) {
        if (ts[i + 1] - ts[i] < 0.05) continue;
        const tm = (ts[i] + ts[i + 1]) / 2;
        const pu = (lx + tm * dx - x0) / sz, pv = (ly + tm * dy - y0) / sz;
        if (!excluded(m, pu, pv)) keep.push([ts[i], ts[i + 1]]);
      }
      for (let i = 0; i < keep.length; i++) {
        const [a, b] = keep[(k & 1) ? keep.length - 1 - i : i];
        if (k & 1) seg(lx + b * dx, ly + b * dy, lx + a * dx, ly + a * dy);
        else       seg(lx + a * dx, ly + a * dy, lx + b * dx, ly + b * dy);
      }
    }
  };

  for (let ri = 0; ri < rows; ri++) {
    for (let c2 = 0; c2 < n; c2++) {
      const ci = (ri & 1) ? (n - 1 - c2) : c2;  // serpentine, like the firmware
      const tx = gx + ci * sz, ty = gy + ri * sz;
      if (tx > xmax || tx + sz < xmin || ty > ymax || ty + sz < ymin) continue;
      const m = picks[ri * n + ci];
      strokes(m, tx, ty);
      for (let e = 0; e < 4; e++) {
        const gridEdge = (e === 0 && ri === 0) || (e === 2 && ri === rows - 1) ||
                         (e === 3 && ci === 0) || (e === 1 && ci === n - 1);
        if (TM_DOT_EDGES[m] & (1 << e)) dotHalf(e, tx, ty, false);
        if (gridEdge) dotHalf(e, tx, ty, true);
      }
      if (cmd.spacing >= 0.5) hatchTile(m, tx, ty);
    }
  }
}

// ---- canvas path simulation (for visual animation) ---------------

export function buildPath(cmd: PlotCmd): { x: number; y: number; pen: boolean }[] {
  const pts: { x: number; y: number; pen: boolean }[] = [];
  if (cmd.type === 'goto') {
    pts.push({ x: cmd.x, y: cmd.y, pen: false });
  } else if (cmd.type === 'line') {
    pts.push({ x: cmd.x0, y: cmd.y0, pen: false });
    pts.push({ x: cmd.x1, y: cmd.y1, pen: true });
  } else if (cmd.type === 'square') {
    const h = cmd.size / 2;
    const a = (cmd.angle || 0) * Math.PI / 180;
    const rot = (px: number, py: number) => ({
      x: cmd.cx + (px * Math.cos(a) - py * Math.sin(a)),
      y: cmd.cy + (px * Math.sin(a) + py * Math.cos(a)),
    });
    if (cmd.fillMode === 2) {
      const start = cmd.outline ? cmd.spacing : 0;
      const ringCount = Math.max(1, Math.floor((h - start) / Math.max(0.5, cmd.spacing)));
      for (let ri = 0; ri < ringCount; ri++) {
        const inset = start + ri * cmd.spacing;
        const hh = h - inset;
        if (hh <= 0) break;
        const corners = [rot(-hh, -hh), rot(hh, -hh), rot(hh, hh), rot(-hh, hh), rot(-hh, -hh)];
        corners.forEach((p, i) => pts.push({ x: p.x, y: p.y, pen: !(ri === 0 && i === 0) }));
      }
    } else if (cmd.outline) {
      const corners = [rot(-h, -h), rot(h, -h), rot(h, h), rot(-h, h), rot(-h, -h)];
      corners.forEach((p, i) => pts.push({ x: p.x, y: p.y, pen: i !== 0 }));
    }
    if (cmd.fillMode === 1) {
      const theta = (cmd.angle || 0) * Math.PI / 180;
      const cos_t = Math.cos(theta + Math.PI / 2), sin_t = Math.sin(theta + Math.PI / 2);
      const extent = h * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)));
      for (let t = -extent + cmd.spacing; t < extent; t += cmd.spacing) {
        pts.push({ x: cmd.cx + t * cos_t - extent * Math.cos(theta), y: cmd.cy + t * sin_t - extent * Math.sin(theta), pen: false });
        pts.push({ x: cmd.cx + t * cos_t + extent * Math.cos(theta), y: cmd.cy + t * sin_t + extent * Math.sin(theta), pen: true });
      }
    }
  } else if (cmd.type === 'circle') {
    if (cmd.fillMode === 2) {
      const startR = cmd.outline ? cmd.r - cmd.spacing : cmd.r;
      const ringCount = Math.max(1, Math.floor(startR / Math.max(0.5, cmd.spacing)));
      for (let ri = 0; ri < ringCount; ri++) {
        const rad = startR - ri * cmd.spacing;
        if (rad <= 0) break;
        const seg = Math.max(24, Math.floor(rad * 1.4));
        for (let k = 0; k <= seg; k++) {
          const th = (k / seg) * Math.PI * 2;
          pts.push({ x: cmd.cx + rad * Math.cos(th), y: cmd.cy + rad * Math.sin(th), pen: !(ri === 0 && k === 0) });
        }
      }
    } else if (cmd.outline) {
      const cycles = cmd.cycles || 1;
      const seg = Math.max(24, Math.floor(cmd.r * 1.4));
      for (let cyc = 0; cyc < cycles; cyc++) {
        for (let k = 0; k <= seg; k++) {
          const th = (k / seg) * Math.PI * 2;
          pts.push({ x: cmd.cx + cmd.r * Math.cos(th), y: cmd.cy + cmd.r * Math.sin(th), pen: !(cyc === 0 && k === 0) });
        }
      }
    }
    if (cmd.fillMode === 1) {
      const theta = (cmd.angle || 0) * Math.PI / 180;
      for (let t = -cmd.r + cmd.spacing; t < cmd.r; t += cmd.spacing) {
        const half = Math.sqrt(Math.max(0, cmd.r * cmd.r - t * t));
        const lx = cmd.cx + t * (-Math.sin(theta)), ly = cmd.cy + t * Math.cos(theta);
        pts.push({ x: lx + half * Math.cos(theta), y: ly + half * Math.sin(theta), pen: false });
        pts.push({ x: lx - half * Math.cos(theta), y: ly - half * Math.sin(theta), pen: true });
      }
    }
  } else if (cmd.type === 'wobbly') {
    // Reproduce the same Fourier algorithm as the firmware using a seeded LCG so
    // the canvas preview matches what the plotter will actually draw.
    const lcg = (() => {
      let s = (cmd.seed >>> 0) || 1;
      return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
    })();
    const h = Math.min(8, Math.max(1, cmd.harmonics));
    const n = Math.min(128, Math.max(24, h * 16));
    const amp: number[] = [], ph: number[] = [];
    for (let i = 0; i < h; i++) {
      amp.push(cmd.wobble * cmd.r / (i + 1) * lcg());
      ph.push(lcg() * Math.PI * 2);
    }
    const minR = cmd.r * 0.05;
    const bound = cmd.boundR > 0 ? cmd.boundR : cmd.r * 1.5;
    const pts2d: {x:number;y:number}[] = [];
    for (let i = 0; i <= n; i++) {
      const theta = (Math.PI * 2 * (i % n)) / n;
      let ri = cmd.r;
      for (let j = 0; j < h; j++) ri += amp[j] * Math.sin((j + 1) * theta + ph[j]);
      ri = Math.min(bound, Math.max(minR, ri));
      pts2d.push({ x: cmd.cx + ri * Math.cos(theta), y: cmd.cy + ri * Math.sin(theta) });
    }
    pts2d.forEach((p, i) => pts.push({ x: p.x, y: p.y, pen: i !== 0 }));
  } else if (cmd.type === 'truchet') {
    buildTruchetPath(cmd, pts);
  } else if (cmd.type === 'bullseye') {
    for (let ri = 0; ri < 4; ri++) {
      const rad = 20 + ri * 20;
      const seg = 48;
      for (let k = 0; k <= seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        pts.push({ x: cmd.cx + rad * Math.cos(th), y: cmd.cy + rad * Math.sin(th), pen: k !== 0 });
      }
    }
  } else if (cmd.type === 'grid') {
    const step = 40, n = 3;
    for (let i = -n; i <= n; i++) {
      pts.push({ x: cmd.cx + i * step, y: cmd.cy - n * step, pen: false });
      pts.push({ x: cmd.cx + i * step, y: cmd.cy + n * step, pen: true });
    }
    for (let j = -n; j <= n; j++) {
      pts.push({ x: cmd.cx - n * step, y: cmd.cy + j * step, pen: false });
      pts.push({ x: cmd.cx + n * step, y: cmd.cy + j * step, pen: true });
    }
  } else if (cmd.type === 'border') {
    // Trace the work-area limit path: rect edges, or the inscribed ellipse perimeter.
    const xmin = -cmd.left, xmax = cmd.right, ymin = -cmd.down, ymax = cmd.up;
    if (cmd.shape === 'ellipse') {
      const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
      const rx = (xmax - xmin) / 2, ry = (ymax - ymin) / 2;
      const seg = 96;
      for (let k = 0; k <= seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        pts.push({ x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th), pen: k !== 0 });
      }
    } else {
      const loop = [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax], [xmin, ymin]];
      loop.forEach(([x, y], i) => pts.push({ x, y, pen: i !== 0 }));
    }
  }
  return pts;
}

// ---- hook --------------------------------------------------------

export function usePlotter() {
  const [ip, setIpState]           = useState<string>(() => getStoredIp());
  const [pen, setPen]              = useState<PenState>({ x: 0, y: 0, down: false });
  const [moving, setMoving]        = useState(false);
  const [connected, setConnected]  = useState(false);
  const [motion, setMotionState]   = useState<MotionParams>({ ...DEFAULTS.motion });
  const [bounds, setBoundsState]   = useState<PlotterBounds>(() => loadBounds());
  const [queue, setQueue]          = useState<string[]>([]);
  const [log, setLog]              = useState<LogEntry[]>([mkLog('sys', 'console ready')]);
  const [status, setStatus]        = useState<PlotterStatus | null>(null);
  const [jobs, setJobs]            = useState<JobEntry[]>([]);
  const [papers, setPapers]        = useState<Paper[]>(() => loadPapers());
  // Affine matrix: `matrix` = the live 6 values being edited; `matrices` = saved
  // presets (localStorage). Firmware default is identity and is NEVER auto-applied
  // on connect — the user explicitly applies a warp.
  const [matrix, setMatrixState]   = useState<MatrixParams>({ ...IDENTITY_PARAMS });
  const [matrices, setMatrices]    = useState<Matrix[]>(() => loadMatrices());

  // Labels captured per job id as `current` advances (firmware only reports the
  // CURRENT job's label, so we remember each one to render the done-job history).
  const jobLabels = useRef<Map<number, string>>(new Map());
  // JSON of each job we submitted (console enqueue + Script-tab items), keyed by
  // job id, so the Position panel can show the running job's exact JSON value.
  const jobJson = useRef<Map<number, string>>(new Map());

  // Tracks whether we've already seeded bounds/motion from the firmware on this IP.
  // Reset when IP changes so a new plotter gets a fresh read.
  const boundsSeeded  = useRef(false);
  const motionSeeded  = useRef(false);
  const matrixSeeded  = useRef(false);
  // Connectivity debounce: SSE uses sseWasOpen to log the drop only once (not on
  // every retry burst). Status poll uses pollFails to require 3 consecutive misses
  // before declaring the link down, so a single slow response doesn't flash the UI.
  const sseWasOpen  = useRef(false);
  const pollFails   = useRef(0);

  // Refs that mirror state — needed for callbacks that close over the initial
  // value and would otherwise see stale data (EventSource handlers, setInterval).
  // The ref is updated every render so the callback always reads the current value.
  const motionRef = useRef(motion);    motionRef.current = motion;
  const boundsRef = useRef(bounds);    boundsRef.current = bounds;
  const papersRef = useRef(papers);    papersRef.current = papers;
  const matrixRef = useRef(matrix);    matrixRef.current = matrix;
  const matricesRef = useRef(matrices); matricesRef.current = matrices;
  const ipRef     = useRef(ip);        ipRef.current     = ip;
  const cancelRef = useRef(false);     // set true by stop()/clearQueue() to cancel client-side work
  const runCancelRef = useRef(false);  // set true by stop()/clearQueue() to halt a running script batch

  // Persist bounds whenever they change — gives a better offline default than the
  // hardcoded fallback. Firmware bounds always win on connect (line ~938).
  useEffect(() => { saveBounds(bounds); }, [bounds]);

  const pushLog = useCallback((kind: LogEntry['kind'], text: string) => {
    setLog((l) => [...l.slice(-199), mkLog(kind, text)]);
  }, []);

  const setIp = useCallback((val: string) => {
    storeIp(val);
    setIpState(val.trim());
  }, []);

  // ---- SSE connection ------------------------------------------
  // Opens GET /events on the plotter. The firmware streams two event types:
  //   • Unnamed ("data: …\n\n")  — log lines from web_log(); caught by es.onmessage
  //   • Named   ("event: pos\n…") — position updates from web_pos_event(); caught by
  //     es.addEventListener('pos', …) so they update the canvas dot without
  //     appearing in the log window.
  // Effect re-runs whenever IP changes (e.g. user edits the IP field in the header).
  useEffect(() => {
    if (!ip) return;
    const url = sseUrl(ip);
    const es = new EventSource(url);

    sseWasOpen.current = false;

    es.onopen = () => {
      sseWasOpen.current = true;
      setConnected(true);
      pushLog('sys', `linked · http://${ip}/`);
    };

    es.onmessage = (e) => {
      // Unnamed events = log messages from web_log()
      const text = e.data as string;
      // Suppress per-sub-segment line/goto chatter — one per segment floods the log
      // and pushes out the higher-level cmd/sys entries. Arc, circle, square, pen,
      // errors etc. are kept because they're coarse-grained and meaningful.
      if (/^(line|goto) (done|\()/.test(text)) return;
      const kind: LogEntry['kind'] = text.startsWith('!! ') ? 'warn' : 'fw';
      pushLog(kind, text);
    };

    // Named position events from web_pos_event() — move the canvas pen dot
    es.addEventListener('pos', (e) => {
      try {
        const { x, y } = JSON.parse((e as MessageEvent).data) as { x: number; y: number };
        setPen((p) => ({ ...p, x, y }));
      } catch { /* ignore malformed */ }
    });

    es.onerror = () => {
      // onerror fires on every browser retry attempt — don't flip the link
      // indicator here (the 1 Hz status poll is the authoritative source).
      // Log the drop only once when the stream actually goes away.
      if (sseWasOpen.current) {
        sseWasOpen.current = false;
        pushLog('sys', '[net] stream dropped — reconnecting…');
      }
    };

    return () => { es.close(); sseWasOpen.current = false; };
  }, [ip, pushLog]);

  // ---- status poll (Autonomous tab) ----------------------------
  // Polls /api/status ~1 Hz to drive the job-progress + driver-health views.
  // The firmware tracks job CURSORS (enqueued/current/done/pending) plus the
  // current job's label and the TMC5072 driver-health latch (drv_ok/drv_flags).
  // We reconstruct a job list from the cursors: ids ≤ done are finished, id ==
  // current is running, ids > current (up to enqueued) are pending. Labels are
  // remembered as `current` advances since the firmware only ever reports the
  // label of the job running right now.
  useEffect(() => {
    if (!ip) { setStatus(null); setJobs([]); return; }
    boundsSeeded.current = false;   // new IP → re-read bounds + motion from that plotter
    motionSeeded.current = false;
    matrixSeeded.current = false;
    pollFails.current = 0;
    let alive = true;

    const poll = async () => {
      let s: RawStatus;
      try { s = await getStatus(ip); } catch {
        pollFails.current += 1;
        // Require 3 consecutive misses before declaring the link down so a single
        // slow response or brief WiFi hiccup doesn't flash the indicator.
        if (pollFails.current === 3) {
          setConnected(false);
          pushLog('sys', '[net] link lost — retrying…');
        }
        return;
      }
      if (!alive) return;
      const wasDown = pollFails.current >= 3;
      pollFails.current = 0;
      setConnected(true);
      if (wasDown) pushLog('sys', `[net] link restored · http://${ip}/`);

      // Pen position + MOVING come straight from the board — no client animation.
      // The dot tracks the real XACTUAL→mm position, and MOVING reflects true
      // execution: on while a job runs, off the instant the board is idle (or paused).
      // Pen down/up mirrors the REAL firmware state (it toggles during scripts /
      // G-code / MCP draws, not just on UI button clicks).
      setPen((p) => ({ ...p, x: s.x, y: s.y, down: s.pen_down ?? p.down }));
      setMoving(!s.idle && !s.paused);

      // On first idle connect, PUSH our stored bounds to the firmware — never adopt the
      // firmware's values. The firmware resets bounds on every reboot; the UI's
      // localStorage value is the durable source of truth. We use apiGet directly (not
      // the job queue) so this is a config write, never a draw job. We gate on s.idle
      // to avoid landing a bounds config mid-plot on a reconnect.
      if (!boundsSeeded.current && s.bounds && s.idle) {
        boundsSeeded.current = true;
        if (ipRef.current) apiGet(ipRef.current, boundsToQuery(boundsRef.current)).catch(() => {});
      }
      if (!motionSeeded.current && s.motion) {
        motionSeeded.current = true;
        setMotionState({
          vmax: s.motion.vmax,
          amax: s.motion.amax,
          run:  s.motion.run_ma,
          hold: s.motion.hold_ma,
        });
      }
      // Reflect the firmware's ACTIVE matrix into the editor (identity at startup) —
      // read-only seeding, never an apply.
      if (!matrixSeeded.current && s.matrix) {
        matrixSeeded.current = true;
        setMatrixState({ ...s.matrix });
      }

      if (s.job && s.current > 0) jobLabels.current.set(s.current, s.job);

      setStatus({
        enqueued: s.enqueued, current: s.current, done: s.done, pending: s.pending,
        idle: s.idle, aborting: s.aborting, paused: s.paused, estop: !!s.estop, job: s.job,
        drvOk: s.drv_ok, drvFlags: s.drv_flags, motion: s.motion, matrix: s.matrix,
      });

      // Build the job rows. Cap to a trailing window so a long session doesn't
      // render hundreds of rows; always include everything from the current job
      // onward plus the most recent finished ones.
      const total = s.enqueued;
      const first = Math.max(1, Math.min(s.current, total) - 7);
      const rows: JobEntry[] = [];
      for (let id = first; id <= total; id++) {
        const state: JobEntry['state'] = id <= s.done ? 'done' : id === s.current && !s.idle ? 'doing' : 'pending';
        rows.push({ id, label: jobLabels.current.get(id) ?? (id === s.current ? s.job : ''), state });
      }
      setJobs(rows);
    };

    poll();
    const timer = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [ip, pushLog]);

  // ---- API send ------------------------------------------------
  const send = useCallback(async (endpoint: string): Promise<import('../lib/api').ApiResult | null> => {
    if (!ipRef.current) { pushLog('warn', `> ${endpoint} → no IP set`); return null; }
    try {
      const d = await apiGet(ipRef.current, endpoint);
      if (d.status === 'ok') pushLog('ok', `[ok] ${d.msg}`);
      else pushLog('err', `[err] ${d.msg}`);
      return d;
    } catch (e) {
      pushLog('err', `[net] ${String(e)}`);
      return null;
    }
  }, [pushLog]);

  // ---- enqueue (send only) -------------------------------------
  // Just submits the command to the firmware. There is NO client-side animation:
  // the canvas pen dot and the MOVING indicator are driven solely by the 1 Hz
  // status poll, so they always reflect the board's true physical state.
  const enqueue = useCallback(async (cmd: PlotCmd) => {
    cancelRef.current = false;
    const ep = cmdToQuery(cmd);
    pushLog('cmd', `> ${cmdToJson(cmd)}`);   // copy-paste-ready JSON (not the raw query)
    // Pen up/down is the one bit of state the firmware doesn't report back, so
    // reflect it locally for the indicator.
    if (cmd.type === 'pen') setPen((p) => ({ ...p, down: cmd.pos === 'down' }));
    // Grid scripts leave aff_tx/aff_ty at a cell centre — home/sethome must reset
    // the matrix or position reads ~cell offset at step 0 (firmware also resets).
    if (cmd.type === 'home' || cmd.type === 'sethome') {
      setMatrixState({ ...IDENTITY_PARAMS });
      if (ipRef.current) apiGet(ipRef.current, matrixToQuery(IDENTITY_PARAMS)).catch(() => {});
      setPen((p) => ({ ...p, x: 0, y: 0 }));
    }
    setQueue((q) => [...q, cmd.type]);
    const d = await send(ep);
    /* Register the job label + JSON at submit time so the job list shows the type
     * and the Position panel can show the running job's exact JSON. */
    if (d?.id) { jobLabels.current.set(d.id, cmdLabel(cmd)); jobJson.current.set(d.id, cmdToJson(cmd)); }
    setQueue((q) => q.slice(1));
  }, [send, pushLog]);

  // Quiet raw send for bulk script execution — no individual log lines, returns
  // true on ok. Pass the item's JSON so the Position panel can show it while it runs.
  // 'ok' = queued; 'rejected' = the firmware refused it (bounds/syntax/queue-full) → skip;
  // 'error' = the request didn't complete (network/connection) → caller should retry, not drop.
  const sendRaw = useCallback(async (endpoint: string, json?: string): Promise<SendResult> => {
    if (!ipRef.current) return 'error';
    try {
      const d = await apiGet(ipRef.current, endpoint);
      if (d.status === 'ok' && d.id != null && json) jobJson.current.set(d.id, json);
      return d.status === 'ok' ? 'ok' : 'rejected';
    } catch {
      return 'error';
    }
  }, []);

  /** Enqueue a job and block until the firmware reports it done (for bounds etc.). */
  const sendAndWait = useCallback(async (endpoint: string, json?: string): Promise<SendResult> => {
    if (!ipRef.current) return 'error';
    try {
      const d = await apiGet(ipRef.current, endpoint);
      if (d.status !== 'ok') return 'rejected';
      if (d.id != null && json) jobJson.current.set(d.id, json);
      if (d.id == null) return 'ok';
      const deadline = Date.now() + 180_000;
      for (;;) {
        const s = await getStatus(ipRef.current);
        if ((s.done ?? 0) >= d.id) return 'ok';
        if (Date.now() > deadline) return 'error';
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch {
      return 'error';
    }
  }, []);

  // Batch many draw ops into one HTTP request (≈80× fewer connections → big streams
  // become practical). Returns enqueue counts, or 'error' on a transient network fail.
  const sendBatch = useCallback(async (queries: string[]): Promise<{ accepted: number; rejected: number } | 'error'> => {
    if (!ipRef.current) return 'error';
    try {
      const d = await apiBatch(ipRef.current, queries.join('\n'));
      // Firmware-side errors (e.g. body too large) must trigger a retry, not a silent
      // {accepted:0,rejected:0} which would advance i past all n ops without queuing them.
      if (d.status !== 'ok') return 'error';
      return { accepted: Number(d.accepted) || 0, rejected: Number(d.rejected) || 0 };
    } catch {
      return 'error';
    }
  }, []);

  const stop = useCallback(() => {
    cancelRef.current = true;
    runCancelRef.current = true;   // also halt any running script batch so it stops feeding jobs
    setPen((p) => ({ ...p, down: false }));
    if (ipRef.current) send('stop');
    // STOP now HOLDS the queue firmware-side (does not flush) — resume to continue.
    pushLog('warn', '!! STOP — motion halted, queue held (press Resume to continue)');
  }, [send, pushLog]);

  // Pause / resume — firmware-side, queue-preserving. Unlike stop() these do NOT
  // flush the queue: the board parks pen-up after the current job and holds the
  // rest until resume. Use for pen swaps / ink fixes mid-run.
  const pause  = useCallback(() => { if (ipRef.current) send('pause'); }, [send]);
  const resume = useCallback(() => { if (ipRef.current) send('resume'); }, [send]);

  // Clear/flush the whole queue (firmware /api/abort → xQueueReset, motion stop,
  // pen up, pending→0). This is the deliberate "throw it all away" action that
  // STOP intentionally does NOT do.
  const clearQueue = useCallback(() => {
    cancelRef.current = true;
    runCancelRef.current = true;   // stop the script runner so it can't refill the queue
    setQueue([]);
    setPen((p) => ({ ...p, down: false }));
    if (ipRef.current) send('abort');
    pushLog('warn', '!! CLEAR — queue flushed, pen up');
  }, [send, pushLog]);

  // Live pending-job count for flow control (the board's draw queue is 256 deep,
  // so a fire-and-forget batch larger than that overflows). Returns null if the
  // status can't be read so callers can decide how to handle it.
  const getPending = useCallback(async (): Promise<number | null> => {
    if (!ipRef.current) return null;
    try { return (await getStatus(ipRef.current)).pending; } catch { return null; }
  }, []);

  // One status read that surfaces everything streamQueries' watchdog needs:
  // queue depth (flow control), the done/current/x/y progress fingerprint, and
  // the board-health flags. Returns null if status can't be read (link stalled).
  const getHealth = useCallback(async (): Promise<StreamHealth | null> => {
    if (!ipRef.current) return null;
    try {
      const s = await getStatus(ipRef.current);
      return {
        pending: s.pending, done: s.done ?? 0, current: s.current ?? 0,
        x: s.x ?? 0, y: s.y ?? 0,
        drvOk: s.drv_ok !== false, drvFlags: s.drv_flags ?? '',
        estop: !!s.estop, aborting: !!s.aborting, paused: !!s.paused,
      };
    } catch { return null; }
  }, []);

  // Motion setters
  const setMotion = useCallback((key: keyof MotionParams, val: number) => {
    setMotionState((m) => ({ ...m, [key]: val }));
  }, []);

  const commitMotion = useCallback((key: keyof MotionParams, val: number) => {
    const ep = motionToQuery(key, val, motionRef.current);
    pushLog('cmd', `> ${ep}`);
    if (ipRef.current) send(ep);
  }, [send, pushLog]);

  // Bounds setters
  const setBounds = useCallback((b: PlotterBounds | ((prev: PlotterBounds) => PlotterBounds)) => {
    setBoundsState(b);
  }, []);

  const commitBounds = useCallback((b: PlotterBounds) => {
    const ep = boundsToQuery(b);
    pushLog('cmd', `> ${ep}`);
    if (ipRef.current) send(ep);
  }, [send, pushLog]);

  // Clear a latched TMC5072 driver fault (re-enables the drivers firmware-side).
  const clearFault = useCallback(() => {
    pushLog('cmd', '> clearfault');
    if (ipRef.current) send('clearfault');
  }, [send, pushLog]);

  // ---- paper presets (persisted, user-managed) -----------------
  const applyPaper = useCallback((p: Paper) => {
    const b: PlotterBounds = { left: p.left, right: p.right, up: p.up, down: p.down, shape: 'rect' };
    setBoundsState(b);
    if (ipRef.current) apiGet(ipRef.current, boundsToQuery(b)).catch(() => {});
    pushLog('ok', `[paper] ${p.name}`);
  }, [pushLog]);

  const savePaper = useCallback((name: string) => {
    const b = boundsRef.current;
    const p: Paper = { name, up: b.up, down: b.down, left: b.left, right: b.right };
    const next = [...papersRef.current.filter((x) => x.name !== name), p];
    setPapers(next); savePapers(next);
    pushLog('ok', `[paper] saved "${name}" (${b.left + b.right}×${b.up + b.down} mm)`);
  }, [pushLog]);

  const renamePaper = useCallback((oldName: string, newName: string) => {
    if (!newName.trim()) return;
    const next = papersRef.current.map((x) => (x.name === oldName ? { ...x, name: newName.trim() } : x));
    setPapers(next); savePapers(next);
  }, []);

  const deletePaper = useCallback((name: string) => {
    const next = papersRef.current.filter((x) => x.name !== name);
    setPapers(next); savePapers(next);
  }, []);

  // ---- affine matrix (live editor + presets) -------------------
  // Edit one of the 6 live values (does NOT push to firmware until applyMatrixVals).
  const setMatrixVal = useCallback((key: keyof MatrixParams, val: number) => {
    setMatrixState((m) => ({ ...m, [key]: val }));
  }, []);

  // Push the current live values to the firmware session.
  const applyMatrixVals = useCallback(() => {
    const ep = matrixToQuery(matrixRef.current);
    pushLog('cmd', `> ${ep}`);
    if (ipRef.current) apiGet(ipRef.current, ep).catch(() => {});
  }, [pushLog]);

  // Reset to identity (passthrough) in both the editor and the firmware.
  const resetMatrix = useCallback(() => {
    setMatrixState({ ...IDENTITY_PARAMS });
    pushLog('cmd', '> matrix identity');
    if (ipRef.current) apiGet(ipRef.current, matrixToQuery(IDENTITY_PARAMS)).catch(() => {});
  }, [pushLog]);

  // Apply a saved preset: load into the editor AND push to the firmware.
  const applyMatrix = useCallback((m: Matrix) => {
    const vals: MatrixParams = { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty };
    setMatrixState(vals);
    if (ipRef.current) apiGet(ipRef.current, matrixToQuery(vals)).catch(() => {});
    pushLog('ok', `[matrix] ${m.name}`);
  }, [pushLog]);

  const saveMatrix = useCallback((name: string) => {
    const v = matrixRef.current;
    const m: Matrix = { name, a: v.a, b: v.b, c: v.c, d: v.d, tx: v.tx, ty: v.ty };
    const next = [...matricesRef.current.filter((x) => x.name !== name), m];
    setMatrices(next); saveMatrices(next);
    pushLog('ok', `[matrix] saved "${name}"`);
  }, [pushLog]);

  const renameMatrix = useCallback((oldName: string, newName: string) => {
    if (!newName.trim()) return;
    const next = matricesRef.current.map((x) => (x.name === oldName ? { ...x, name: newName.trim() } : x));
    setMatrices(next); saveMatrices(next);
  }, []);

  const deleteMatrix = useCallback((name: string) => {
    const next = matricesRef.current.filter((x) => x.name !== name);
    setMatrices(next); saveMatrices(next);
  }, []);

  // Running job for the Position panel: its JSON if we submitted it (console or
  // Script tab), else the firmware's text description; '' when nothing is running.
  const currentJob = (status && !status.idle && status.current > 0)
    ? (jobJson.current.get(status.current) ?? status.job ?? '')
    : '';

  return {
    ip, setIp,
    pen, moving, connected,
    motion, bounds,
    queue, log,
    status, jobs, currentJob,
    papers, applyPaper, savePaper, renamePaper, deletePaper,
    matrix, matrices, setMatrixVal, applyMatrixVals, resetMatrix,
    applyMatrix, saveMatrix, renameMatrix, deleteMatrix,
    setMotion, commitMotion,
    setBounds, commitBounds,
    enqueue, sendRaw, sendAndWait, sendBatch, getPending, getHealth, runCancelRef, stop, pause, resume, clearQueue, clearFault, pushLog,
    DEFAULTS,
  };
}
