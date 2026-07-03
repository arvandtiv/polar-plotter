#!/usr/bin/env node
/**
 * plotter-mcp — MCP server for the polar plotter.
 *
 * Exposes the plotter's HTTP API as named tools so Claude (or any MCP client)
 * can send drawing commands, queue a full painting script, and monitor status
 * without constructing raw URLs.
 *
 * Configuration (environment variables):
 *   PLOTTER_IP      — IP address of the plotter (default: 192.168.1.71)
 *   PLOTTER_PORT    — HTTP port (default: 80)
 *   PLOTTER_ARC_TOL — mm tolerance for collapsing circular runs in compiled art
 *                     into single firmware `arc` jobs (default 0.3 = the firmware's
 *                     own chord error; 0 disables → line-only output, pre-arc behaviour)
 *
 * Start: node index.js
 * Register in .mcp.json (see project root).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compilePaths,
  compilePathsWithWarp,
  expandGenerator,
  expandGeneratorFitted,
  runLayerStack,
  getModule,
  defaultsOf,
  boundsFromFirmware,
  listGenerators,
  gridCtxFromMetadata,
  gridCtxFromPlotterBounds,
  computeCell,
  resolveGridCtx,
  gridClearQueries,
  hydrateGridCommands,
  isIdentityMatrix,
} from './core.js';

const PLOTTER_IP   = process.env.PLOTTER_IP   ?? '192.168.1.71';
const PLOTTER_PORT = process.env.PLOTTER_PORT ?? '80';
const BASE = `http://${PLOTTER_IP}:${PLOTTER_PORT}`;

// Arc-fitting tolerance (mm) for compiled art: circular runs within this tolerance
// collapse into single firmware `arc` jobs (continuous sweep, no per-chord stop/start)
// instead of many `line` jobs. Requires firmware with /api/arc (v1.1+). 0 = off.
const ARC_TOL = Math.max(0, Number(process.env.PLOTTER_ARC_TOL ?? 0.3) || 0);

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function api(endpoint) {
  const url = `${BASE}/api/${endpoint}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`Network error reaching plotter at ${BASE}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const json = await res.json();
  if ((json?.status ?? 'ok') !== 'ok') {
    throw new Error(json?.msg ?? `firmware error from ${endpoint}`);
  }
  return json;
}

function ok(json) {
  // Normalise firmware response { status, msg } into a tool result string.
  const status = json?.status ?? 'unknown';
  const msg    = json?.msg    ?? JSON.stringify(json);
  return `${status}: ${msg}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Enqueue a command and BLOCK until the plotter has actually finished drawing it.
 *
 * The firmware returns a monotonic job `id` from every queued command and exposes
 * the queue cursor at /api/status. We poll `done` until it reaches our id, so the
 * tool only resolves once the physical move is complete — "jobs always wait till
 * the job is accomplished". If an escape (/api/abort) fires mid-job, status reports
 * `aborting` and we return promptly. Out-of-bounds / validation errors come back
 * from the initial call with status !== 'ok' and are surfaced unchanged (no wait).
 */
async function drawAndWait(endpoint, { timeoutMs = 180_000, pollMs = 150 } = {}) {
  const r = await api(endpoint);
  if ((r?.status ?? 'ok') !== 'ok') return r;   // rejected (e.g. outside work area)
  const id = r.id;
  if (id == null) return r;                      // endpoint isn't a tracked job
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    let s = null;
    try { s = await api('status'); } catch { /* transient — retry until deadline */ }
    if (s) {
      // Driver health gate: a TMC5072 fault (over-temp, coil short-to-GND, etc.)
      // is checked BEFORE the done cursor so a job that the firmware aborted mid-
      // stroke is never mistaken for a clean finish. The firmware self-aborts the
      // move; we belt-and-suspenders the escape and surface the latched flags so
      // the caller can pause and report. Recovery is plot_clear_fault.
      if (s.drv_ok === false) {
        try { await api('abort'); } catch { /* best-effort */ }
        return { status: 'driver_fault', msg: `DRIVER FAULT during job ${id}: ${s.drv_flags || 'unknown'}` };
      }
      if (s.aborting) return { status: 'aborted', msg: `job ${id} aborted (escape)` };
      // Don't count the timeout while the operator has paused (pen swap / ink fix):
      // the queue is held, so push the deadline out and keep waiting for resume.
      if (s.paused) deadline = Date.now() + timeoutMs;
      if ((s.done ?? 0) >= id)
        return { status: 'ok', msg: `job ${id} done (at x=${s.x}, y=${s.y})` };
    }
    if (Date.now() > deadline)
      return { status: 'error', msg: `job ${id} timed out after ${Math.round(timeoutMs / 1000)}s` };
    await sleep(pollMs);
  }
}

/**
 * Flow-controlled batch dispatch using the firmware's /api/batch endpoint.
 *
 * /api/batch accepts a POST with newline-separated draw ops and enqueues them
 * all in ONE TCP connection — ~80x fewer round-trips than calling api() per op.
 * Supported ops: pen, goto, line, arc. Others fall back to individual api() calls.
 *
 * The firmware batch body is capped at 8192 bytes; we chunk at BATCH_BODY_MAX
 * and wait for queue headroom before each chunk.
 */
const QUEUE_HEADROOM = 24;
const BATCH_BODY_MAX = 7200;   // conservative under firmware's 8192
const BATCH_LINE_MAX = 200;    // hard cap: keeps chunk.length < 256-QUEUE_HEADROOM, preventing headroom deadlock
const BATCH_OPS = new Set(['pen', 'goto', 'line', 'arc']);

async function postBatch(lines) {
  const body = lines.join('\n');
  const url = `${BASE}/api/batch`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(body)) },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) { throw new Error(`Batch network error: ${err.message}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} from /api/batch`);
  const r = await res.json();
  // Firmware returns status:"error" with HTTP 200 for body-truncated / oversized bodies.
  if (r?.status === 'error') throw new Error(`Firmware batch error: ${r.msg ?? 'unknown'}`);
  // Rejected ops = queue was full despite headroom check (race or oversized chunk).
  if ((r?.rejected ?? 0) > 0) throw new Error(`Batch partial rejection: ${r.rejected} ops dropped (accepted ${r.accepted})`);
  return r;
}

async function batchSend(queries, { timeoutMs = 600_000 } = {}) {
  let lastId = null;
  let deadline = Date.now() + timeoutMs;
  let chunk = [], chunkBytes = 0;

  const flushChunk = async () => {
    if (chunk.length === 0) return;
    // Wait for queue headroom before submitting the chunk.
    for (;;) {
      if (Date.now() > deadline) throw new Error('timeout waiting for queue headroom');
      const s = await api('status');
      if (s.drv_ok === false) throw new Error(`DRIVER FAULT: ${s.drv_flags}`);
      if (s.estop) throw new Error('E-STOP triggered');
      if (s.aborting) throw new Error('abort triggered');
      const free = (s.qcap ?? 256) - (s.pending ?? 0);
      if (free >= chunk.length + QUEUE_HEADROOM) break;
      await sleep(100);
    }
    const r = await postBatch(chunk);
    if (r?.id != null) lastId = r.id;
    chunk = []; chunkBytes = 0;
  };

  for (const q of queries) {
    const op = q.split('?')[0];
    if (!BATCH_OPS.has(op)) {
      // Non-batchable op (speed, accel, home, sethome, etc.) — flush first, then individual call.
      await flushChunk();
      const r = await api(q);
      if (r?.id != null) lastId = r.id;
      continue;
    }
    const lineBytes = Buffer.byteLength(q) + 1;
    if (chunkBytes + lineBytes > BATCH_BODY_MAX || chunk.length >= BATCH_LINE_MAX) await flushChunk();
    chunk.push(q);
    chunkBytes += lineBytes;
  }
  await flushChunk();

  if (lastId == null) return { status: 'ok', msg: 'no queued jobs (all commands were non-draw)' };

  // Wait for the last job to physically complete.
  for (;;) {
    if (Date.now() > deadline) return { status: 'timeout', msg: `timed out waiting for job ${lastId}` };
    await sleep(200);
    let s;
    try { s = await api('status'); } catch { continue; }
    if (s.drv_ok === false) return { status: 'driver_fault', msg: `DRIVER FAULT: ${s.drv_flags}` };
    if (s.aborting) return { status: 'aborted', msg: 'batch aborted (escape)' };
    if (s.paused) { deadline = Date.now() + timeoutMs; continue; } // operator paused — extend
    if ((s.done ?? 0) >= lastId) return { status: 'ok', msg: `${queries.length} commands dispatched; job ${lastId} done` };
  }
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    'polar-plotter',
  version: '1.7.0',
}, {
  instructions: [
    'This server drives a hanging V-plotter (polargraph). Coordinates are in mm.',
    '',
    'COORDINATE SYSTEM:',
    '• Origin (0,0) is the midpoint between the two motor anchors, near the TOP.',
    '• X+ = RIGHT, X- = LEFT.',
    '• Y+ = DOWN (toward the floor), Y- = UP (toward the anchors/ceiling).',
    '  So a SMALLER (more negative) y is HIGHER on the wall; a LARGER (more',
    '  positive) y is LOWER. To move the pen up, DECREASE y; to move down,',
    '  INCREASE y. This is screen-style Y, not math-style.',
    '',
    'WORK AREA / STAYING IN BOUNDS:',
    '• The drawable area is the rectangle x:[xn..xp], y:[yn..yp] reported by',
    '  plot_status. It is configured on the device and is usually NOT symmetric',
    '  (e.g. y often spans far more downward than upward, like -110..+300).',
    '• If bounds.ellipse is true, the usable area is the ELLIPSE inscribed in that',
    '  box, not the full rectangle — keep well inside the corners.',
    '• ALWAYS call plot_status FIRST to read the live bounds before planning any',
    '  coordinates, and keep every point AND every shape extent inside them:',
    '  a circle needs cx±r and cy±r in range; a square needs cx±size/2, cy±size/2.',
    '• The firmware rejects out-of-area targets and clamps strays back onto the',
    '  boundary, which silently distorts art — so plan within bounds yourself.',
    '• plot_border traces the active boundary; useful to confirm the usable area.',
    '',
    'AESTHETICS (human-trained):',
    '• Before COMPOSING any art, call plot_style_guide — it returns the taste',
    '  distilled from 31+ human-ranked training rounds on this exact machine',
    '  (what wins, what gets rejected, per-genre rules, media limits like the',
    '  paper-rip density cap). Designs that ignore it score poorly with the owner.',
  ].join('\n'),
});

// ── Human-trained aesthetic knowledge (ai-training/) ─────────────────────────
// The training loop's distilled outputs live in the repo next to this server.
// Read at call time (not startup) so ongoing training flows through without a
// server restart. Gracefully degrade if the files are absent (e.g. deployed
// standalone without the repo).
const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINING_DIR = join(__dirname, '..', 'ai-training');

function readTrainingFile(name) {
  try {
    return readFileSync(join(TRAINING_DIR, name), 'utf8');
  } catch {
    return null;
  }
}

server.tool(
  'plot_style_guide',
  'The HUMAN-TRAINED aesthetic for this plotter — distilled from 31+ ranked art-training ' +
  'rounds with the machine\'s owner. Call this BEFORE composing/generating any art: it says ' +
  'what wins (organic, irregular, asymmetric, dense-but-open, hand-drawn, multi-mass), what ' +
  'gets rejected (crisp/geometric/symmetric, sparse gestures, mud, over-used engines), the ' +
  'per-genre rules, and hard media limits (paper-rip density cap). ' +
  'section: "learnings" = the ranked-round lessons (default); "klee" = Paul Klee\'s method ' +
  '(how to make a line live); "both" = everything.',
  {
    section: z.enum(['learnings', 'klee', 'both']).default('learnings')
      .describe('Which knowledge file(s) to return'),
  },
  async ({ section }) => {
    const parts = [];
    if (section === 'learnings' || section === 'both') {
      const t = readTrainingFile('LEARNINGS.md');
      parts.push(t ?? '⚠ LEARNINGS.md not found (ai-training/ not present next to this server).');
    }
    if (section === 'klee' || section === 'both') {
      const t = readTrainingFile('klee_principles.md');
      parts.push(t ?? '⚠ klee_principles.md not found (ai-training/ not present next to this server).');
    }
    return { content: [{ type: 'text', text: parts.join('\n\n---\n\n') }] };
  },
);

// Same knowledge as browsable MCP resources, for clients that surface resources.
server.registerResource(
  'style-learnings',
  'polar-plotter://style/learnings',
  { title: 'Plotter style guide — ranked-round learnings',
    description: 'Human-ranked training outcomes: the aesthetic that wins on this machine.',
    mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown',
                 text: readTrainingFile('LEARNINGS.md') ?? 'LEARNINGS.md not found' }],
  }),
);
server.registerResource(
  'style-klee',
  'polar-plotter://style/klee',
  { title: 'Plotter style guide — Klee method',
    description: 'Paul Klee\'s creative method: how to make a plotted line live.',
    mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown',
                 text: readTrainingFile('klee_principles.md') ?? 'klee_principles.md not found' }],
  }),
);

// ── Tools ────────────────────────────────────────────────────────────────────

// plot_goto ──────────────────────────────────────────────────────────────────
server.tool(
  'plot_goto',
  'Move the pen to an (x, y) coordinate in mm. Origin (0,0) is the midpoint ' +
  'between the two motor anchors. X+ is right, Y+ is down.',
  {
    x: z.number().describe('X position in mm'),
    y: z.number().describe('Y position in mm'),
  },
  async ({ x, y }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`goto?x=${x}&y=${y}`)) }],
  }),
);

// plot_line ──────────────────────────────────────────────────────────────────
server.tool(
  'plot_line',
  'Draw a straight line from (x0,y0) to (x1,y1). The pen is auto-lifted to ' +
  'the start point, then lowered. Pass cycles > 1 to retrace and darken.',
  {
    x0:     z.number().describe('Start X in mm'),
    y0:     z.number().describe('Start Y in mm'),
    x1:     z.number().describe('End X in mm'),
    y1:     z.number().describe('End Y in mm'),
    cycles: z.number().int().min(1).default(1).describe('Number of passes (default 1)'),
  },
  async ({ x0, y0, x1, y1, cycles }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`line?x0=${x0}&y0=${y0}&x1=${x1}&y1=${y1}&cycles=${cycles}`)) }],
  }),
);

// plot_circle ────────────────────────────────────────────────────────────────
server.tool(
  'plot_circle',
  'Draw a circle. fill_mode: 0=outline only, 1=hatch lines, 2=concentric rings. ' +
  'outline=false skips the perimeter (use with fill_mode 1 or 2 for fill-only). ' +
  'hatch_angle rotates hatch lines (degrees). spacing controls line gap (mm).',
  {
    cx:          z.number().describe('Center X in mm'),
    cy:          z.number().describe('Center Y in mm'),
    r:           z.number().positive().describe('Radius in mm'),
    cycles:      z.number().int().min(1).default(1).describe('Outline passes (default 1)'),
    fill_mode:   z.number().int().min(0).max(2).default(0).describe('0=none 1=hatch 2=concentric'),
    hatch_angle: z.number().default(0).describe('Hatch angle in degrees (default 0 = horizontal)'),
    spacing:     z.number().positive().default(3).describe('Hatch / ring spacing in mm (default 3)'),
    outline:     z.boolean().default(true).describe('Draw the outer perimeter (default true)'),
  },
  async ({ cx, cy, r, cycles, fill_mode, hatch_angle, spacing, outline }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(
      `circle?cx=${cx}&cy=${cy}&r=${r}&cycles=${cycles}` +
      `&fill=${fill_mode}&angle=${hatch_angle}&spacing=${spacing}&outline=${outline ? 1 : 0}`,
    )) }],
  }),
);

// plot_square ────────────────────────────────────────────────────────────────
server.tool(
  'plot_square',
  'Draw an axis-aligned square. fill_mode: 0=outline only, 1=hatch, 2=concentric. ' +
  'outline=false skips the perimeter. hatch_angle rotates the fill lines.',
  {
    cx:          z.number().describe('Center X in mm'),
    cy:          z.number().describe('Center Y in mm'),
    size:        z.number().positive().describe('Side length in mm'),
    cycles:      z.number().int().min(1).default(1).describe('Outline passes (default 1)'),
    fill_mode:   z.number().int().min(0).max(2).default(0).describe('0=none 1=hatch 2=concentric'),
    hatch_angle: z.number().default(0).describe('Hatch angle in degrees (default 0 = horizontal)'),
    spacing:     z.number().positive().default(3).describe('Hatch / ring spacing in mm (default 3)'),
    outline:     z.boolean().default(true).describe('Draw the outer perimeter (default true)'),
  },
  async ({ cx, cy, size, cycles, fill_mode, hatch_angle, spacing, outline }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(
      `square?cx=${cx}&cy=${cy}&size=${size}&cycles=${cycles}` +
      `&fill=${fill_mode}&angle=${hatch_angle}&spacing=${spacing}&outline=${outline ? 1 : 0}`,
    )) }],
  }),
);

// plot_pen ───────────────────────────────────────────────────────────────────
server.tool(
  'plot_pen',
  'Move the pen servo. Use "up" before travel moves and "down" before drawing.',
  {
    position: z.enum(['up', 'down']).describe('"up" lifts the pen, "down" lowers it'),
  },
  async ({ position }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`pen?pos=${position}`)) }],
  }),
);

// plot_home ──────────────────────────────────────────────────────────────────
server.tool(
  'plot_home',
  'Return the gondola to the origin (0,0). Lifts the pen first. ' +
  'Only meaningful after sethome has been run in this session.',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await drawAndWait('home')) }],
  }),
);

// plot_sethome ───────────────────────────────────────────────────────────────
server.tool(
  'plot_sethome',
  'Zero both motor positions at the current gondola location, defining it as ' +
  'the coordinate origin (0,0). Run this once after physically placing the ' +
  'gondola at the geometric midpoint (both belts = HOME_BELT_MM).',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await drawAndWait('sethome')) }],
  }),
);

// plot_stop ──────────────────────────────────────────────────────────────────
server.tool(
  'plot_stop',
  'Emergency stop — immediately preempt the job in progress (even mid-stroke), ' +
  'FLUSH the pending queue, decelerate both motors, and lift the pen. This ' +
  'DISCARDS all queued work; to halt but KEEP the queue (e.g. for a pen swap) ' +
  'use plot_pause instead. Call this the moment anything looks wrong. Alias of plot_abort.',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await api('abort')) }],
  }),
);

// plot_pause ─────────────────────────────────────────────────────────────────
server.tool(
  'plot_pause',
  'Pause WITHOUT losing the queue. The plotter finishes the current job, then ' +
  'parks with the pen UP and holds — all pending jobs stay queued in order. Use ' +
  'this to swap pens or fix ink mid-run, then plot_resume to continue exactly ' +
  'where it left off. (Unlike plot_stop/plot_abort, which flush the queue.)',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await api('pause')) }],
  }),
);

// plot_resume ────────────────────────────────────────────────────────────────
server.tool(
  'plot_resume',
  'Resume after plot_pause — the held queue continues from the next job.',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await api('resume')) }],
  }),
);

// plot_set_speed ─────────────────────────────────────────────────────────────
server.tool(
  'plot_set_speed',
  'Set the motor speed (VMAX). Higher = faster moves. Default 200000. ' +
  'Reduce for finer detail work or if the gondola skips steps.',
  {
    vmax: z.number().int().min(10000).max(400000).describe('VMAX in microsteps/s (10000–400000, default 200000)'),
  },
  async ({ vmax }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`speed?vmax=${vmax}`)) }],
  }),
);

// plot_set_accel ─────────────────────────────────────────────────────────────
server.tool(
  'plot_set_accel',
  'Set motor acceleration (AMAX = DMAX). Lower values give smoother starts/stops ' +
  'at the cost of longer ramp times.',
  {
    amax: z.number().int().min(50).max(2000).describe('AMAX in microsteps/s² (50–2000, default 500)'),
  },
  async ({ amax }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`accel?amax=${amax}`)) }],
  }),
);

// plot_set_ramp ──────────────────────────────────────────────────────────────
server.tool(
  'plot_set_ramp',
  'Tune the sixPoint ramp SHAPE for line crispness (session-only). a1_ratio/dmax_ratio/' +
  'd1_ratio are multiples of AMAX; v1 is the crossover velocity between the A1 (launch) ' +
  'and AMAX regions. Soft-start recipe (crisper stroke starts, brisker stops): ' +
  'a1_ratio=0.5, v1=12000, dmax_ratio=1.4, d1_ratio=2.0. Defaults restore the stock shape.',
  {
    a1_ratio:   z.number().min(0.05).max(5).default(2.0).describe('A1 = ratio × AMAX (accel below v1 — launch kick; <1 = soft start)'),
    v1:         z.number().int().min(1).max(200000).default(50000).describe('crossover velocity between A1 and AMAX regions (µsteps/s)'),
    dmax_ratio: z.number().min(0.05).max(5).default(1.0).describe('DMAX = ratio × AMAX (main decel; >1 = brisker stops, datasheet-endorsed)'),
    d1_ratio:   z.number().min(0.05).max(5).default(2.8).describe('D1 = ratio × AMAX (decel below v1 — landing)'),
    vstop:      z.number().int().min(1).max(1000).default(10).describe('arrival velocity at the target (never 0)'),
    tzerowait:  z.number().int().min(0).max(65535).default(0).describe('pause at zero crossing on reversals (reduces reversal jerk)'),
  },
  async ({ a1_ratio, v1, dmax_ratio, d1_ratio, vstop, tzerowait }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(
      `ramp?a1r=${a1_ratio}&v1=${v1}&dmaxr=${dmax_ratio}&d1r=${d1_ratio}&vstop=${vstop}&tzw=${tzerowait}`
    )) }],
  }),
);

// plot_set_current ───────────────────────────────────────────────────────────
server.tool(
  'plot_set_current',
  'Set motor run and hold current in milliamps. Keep run ≤ 600 mA per motor ' +
  '(shared 12V/2A supply). Hold current is applied when the motor is stationary.',
  {
    run_ma:  z.number().min(100).max(800).describe('Run current in mA (100–800, default 600)'),
    hold_ma: z.number().min(0).max(400).describe('Hold current in mA (0–400, default 200)'),
  },
  async ({ run_ma, hold_ma }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`cur?run=${run_ma}&hold=${hold_ma}`)) }],
  }),
);

// plot_set_matrix ────────────────────────────────────────────────────────────
server.tool(
  'plot_set_matrix',
  `Apply a 2D affine warp to the logical drawing space (session-only, NOT saved to flash).
Every commanded (x,y) is transformed before the belt math:
  x' = a*x + b*y + tx ;  y' = c*x + d*y + ty
Identity (a=1, b=0, c=0, d=1, tx=0, ty=0) = no warp (the startup default).
This is an EXPLORATION tool for rotation/shear/scale/offset of the whole drawing —
an affine is linear and cannot correct the polargraph line-bow. Pass identity to reset.`,
  {
    a:  z.number().describe('x scale / cos term (identity 1)'),
    b:  z.number().describe('x shear from y (identity 0)'),
    c:  z.number().describe('y shear from x (identity 0)'),
    d:  z.number().describe('y scale / cos term (identity 1)'),
    tx: z.number().describe('x translation in mm (identity 0)'),
    ty: z.number().describe('y translation in mm (identity 0)'),
  },
  async ({ a, b, c, d, tx, ty }) => ({
    content: [{ type: 'text', text: ok(await api(`matrix?a=${a}&b=${b}&c=${c}&d=${d}&tx=${tx}&ty=${ty}`)) }],
  }),
);

// plot_wobbly ────────────────────────────────────────────────────────────────
server.tool(
  'plot_wobbly',
  `Draw a closed random curve using a radial Fourier series.

The radius at each angle is: r(θ) = base_r + Σ amp_h·sin(h·θ + phase_h)

wobble controls distortion: 0.0 = perfect circle, 1.0 = maximum randomness.
harmonics controls shape complexity: 1 = gentle blob, 8 = complex jagged shape.
bound_r is a hard outer limit — no part of the curve will exceed this radius
from the centre (defaults to r * 1.5).
seed makes the shape reproducible: same seed + same params = same curve every time.

Examples:
  wobble=0.0, harmonics=1   → circle
  wobble=0.2, harmonics=2   → soft organic blob
  wobble=0.5, harmonics=4   → moderately wobbly closed shape
  wobble=0.9, harmonics=7   → complex jagged closed form`,
  {
    cx:        z.number().describe('Center X in mm'),
    cy:        z.number().describe('Center Y in mm'),
    r:         z.number().positive().describe('Base radius in mm'),
    bound_r:   z.number().nonnegative().default(0).describe('Outer bounding radius in mm (0 = r×1.5)'),
    wobble:    z.number().min(0).max(1).default(0.4).describe('Distortion amount 0.0–1.0 (default 0.4)'),
    harmonics: z.number().int().min(1).max(8).default(3).describe('Shape complexity 1–8 (default 3)'),
    seed:      z.number().int().min(0).default(42).describe('Random seed — same seed = same shape (default 42)'),
    cycles:    z.number().int().min(1).default(1).describe('Outline passes (default 1)'),
    fill_mode:   z.number().int().min(0).max(2).default(0).describe('0=none 1=hatch 2=concentric (nested wavy rings)'),
    hatch_angle: z.number().default(0).describe('Hatch angle in degrees (default 0 = horizontal)'),
    spacing:     z.number().positive().default(3).describe('Hatch / ring spacing in mm (default 3)'),
    outline:     z.boolean().default(true).describe('Draw the wavy perimeter (default true)'),
  },
  async ({ cx, cy, r, bound_r, wobble, harmonics, seed, cycles, fill_mode, hatch_angle, spacing, outline }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(
      `wobbly?cx=${cx}&cy=${cy}&r=${r}&bound_r=${bound_r}` +
      `&wobble=${wobble}&harmonics=${harmonics}&seed=${seed}&cycles=${cycles}` +
      `&fill=${fill_mode}&angle=${hatch_angle}&spacing=${spacing}&outline=${outline ? 1 : 0}`,
    )) }],
  }),
);

// plot_bullseye ──────────────────────────────────────────────────────────────
server.tool(
  'plot_bullseye',
  'Draw a calibration bullseye (crosshair + concentric circles) at (cx, cy). ' +
  'Use to verify the origin maps to the correct physical location.',
  {
    cx: z.number().default(0).describe('Center X in mm (default 0)'),
    cy: z.number().default(0).describe('Center Y in mm (default 0)'),
  },
  async ({ cx, cy }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`bullseye?cx=${cx}&cy=${cy}`)) }],
  }),
);

// plot_arc ───────────────────────────────────────────────────────────────────
server.tool(
  'plot_arc',
  'Draw a single arc: part of a circle centred at (cx, cy) with the given radius, ' +
  'sweeping from angle a0 to a1 (radians, 0 = right, increases clockwise since Y+ is down). ' +
  'lift=true (default) lets the firmware manage pen position; lift=false continues from the ' +
  'current pen position without raising it (for chaining arcs into composite curves). ' +
  'Full-circle example: a0=0, a1=6.2832. Quarter-circle (top-right): a0=−1.5708, a1=0.',
  {
    cx:     z.number().default(0).describe('Centre X in mm'),
    cy:     z.number().default(0).describe('Centre Y in mm'),
    r:      z.number().positive().default(50).describe('Radius in mm'),
    a0:     z.number().default(0).describe('Start angle in radians (0 = right/east)'),
    a1:     z.number().default(6.2832).describe('End angle in radians (default = full circle)'),
    cw:     z.boolean().default(false).describe('Clockwise sweep (default false = CCW)'),
    cycles: z.number().int().min(1).max(20).default(1).describe('Times to retrace (darken)'),
    lift:   z.boolean().default(true).describe('Manage pen automatically (false = chain with prior arc)'),
  },
  async ({ cx, cy, r, a0, a1, cw, cycles, lift }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(
      `arc?cx=${cx}&cy=${cy}&r=${r}&a0=${a0}&a1=${a1}&cw=${cw ? 1 : 0}&cycles=${cycles}&lift=${lift ? 1 : 0}`
    )) }],
  }),
);

// plot_grid ──────────────────────────────────────────────────────────────────
server.tool(
  'plot_grid',
  'Draw a calibration grid centered at (cx, cy): a 10x10 set of lines, 8 mm ' +
  'apart, 100 mm long (spans cx±50, cy±50). Use to check straightness, spacing, ' +
  'and squareness across the work area.',
  {
    cx: z.number().default(0).describe('Center X in mm (default 0)'),
    cy: z.number().default(0).describe('Center Y in mm (default 0)'),
  },
  async ({ cx, cy }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(`grid?cx=${cx}&cy=${cy}`)) }],
  }),
);

// plot_abort ─────────────────────────────────────────────────────────────────
server.tool(
  'plot_abort',
  'Hard escape: immediately preempt the running job (even mid-stroke), flush ' +
  'the pending queue, stop both motors, and lift the pen. Same as plot_stop.',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await api('abort')) }],
  }),
);

// plot_border ─────────────────────────────────────────────────────────────────
// Calibration: walk the work-area limit path once (pen down). Follows the active
// bounds shape — the four rectangle edges, or the inscribed-ellipse perimeter.
// Draws exactly where the firmware believes the reachable edge is, for comparison
// against the physical machine. Uses the firmware's stored bounds (set the area
// first via the console Work Area tab).
server.tool(
  'plot_border',
  'Walk the work-area limit path once with the pen down (rectangle edges or the ' +
  'inscribed-ellipse perimeter, per the current bounds). A calibration aid: it ' +
  'traces the firmware\'s reachable boundary so you can compare it to the real machine.',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await drawAndWait('border')) }],
  }),
);

// plot_clear_fault ────────────────────────────────────────────────────────────
// Recovery after a driver fault paused a script. Re-enables the TMC5072 drivers
// (the only way to clear a latched coil short-to-GND) and drops the firmware's
// sticky fault latch so jobs can run again. Call this ONLY after the physical
// cause (overheating, short, loose wiring) has actually been addressed — if the
// fault persists, the next move will simply trip it again.
server.tool(
  'plot_clear_fault',
  'Clear a latched TMC5072 driver fault OR the hardware E-STOP latch, and ' +
  're-enable the drivers so work can resume. Use after a driver fault or an ' +
  'E-STOP button press (see plot_status) once the cause is resolved. Note: the ' +
  'hardware E-STOP physically cut motor power, so re-home before relying on position.',
  {},
  async () => ({
    content: [{ type: 'text', text: ok(await api('clearfault')) }],
  }),
);

// plot_status ─────────────────────────────────────────────────────────────────
server.tool(
  'plot_status',
  'Report the plotter state: the work-area bounds (the dimension limits set on ' +
  'the device — ALWAYS check these before planning coordinates and keep every ' +
  'point/shape inside them), the live pen position, and the job queue cursor ' +
  '(enqueued / current / done / pending, idle flag). Remember Y+ is DOWN and ' +
  'Y- is UP, so y=yn is the TOP edge and y=yp is the BOTTOM edge.',
  {},
  async () => {
    const s = await api('status');
    const b = s.bounds ?? {};
    const shape = b.ellipse ? 'ELLIPSE inscribed in this box (stay inside the corners)' : 'rectangle';
    const lines = [
      `idle: ${s.idle}${s.aborting ? '  (ABORTING)' : ''}${s.paused ? '  (PAUSED — queue held; call plot_resume)' : ''}${s.estop ? '  ⛔ HARDWARE E-STOP — motors cut; call plot_clear_fault' : ''}`,
      s.drv_ok === false
        ? `driver: ⛔ FAULT — ${s.drv_flags} (call plot_clear_fault after resolving)`
        : `driver: ok`,
      `position: x=${s.x} y=${s.y} mm`,
      `work area (${shape}):`,
      `  x: ${b.xn} (left) .. ${b.xp} (right) mm`,
      `  y: ${b.yn} (top/up) .. ${b.yp} (bottom/down) mm   [Y+ = DOWN, Y- = UP]`,
      `jobs: enqueued=${s.enqueued} current=${s.current} done=${s.done} pending=${s.pending}`,
      // Queue health — the firmware draw queue is fixed-depth; a full queue REJECTS
      // new jobs. rejected/peak are cumulative since boot (diagnose flooding here).
      s.qcap != null
        ? `queue: ${s.pending}/${s.qcap} used${s.pending >= s.qcap ? '  ⚠ FULL (new jobs rejected)' : ''}` +
          (s.rejected ? `  · rejected(total)=${s.rejected}` : '') +
          (s.peak != null ? `  · peak=${s.peak}` : '')
        : null,
      s.job ? `current job: ${s.job}` : null,
    ].filter(Boolean);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// plot_script ────────────────────────────────────────────────────────────────
// The main tool for autonomous painting: send an ordered list of commands and
// they execute sequentially. Each step waits for the plotter to FINISH drawing it
// (via job-id status polling) before the next is sent, so the queue never
// overflows and the result is deterministic.
server.tool(
  'plot_script',
  `Execute an ordered list of drawing commands sequentially. Each command waits
until the plotter has physically finished it before the next begins, so this is
safe for full paintings. Returns a summary of each step's result.

Each command object must have a "type" field plus the parameters for that type:

  { "type": "goto",    "x": 0, "y": 0 }
  { "type": "line",    "x0": -100, "y0": 0, "x1": 100, "y1": 0, "cycles": 1 }
  { "type": "circle",  "cx": 0, "cy": 0, "r": 50, "fill_mode": 2, "spacing": 4, "outline": true }
  { "type": "square",  "cx": 0, "cy": 100, "size": 80, "fill_mode": 1, "hatch_angle": 45 }
  { "type": "pen",     "position": "up" }
  { "type": "pen",     "position": "down" }
  { "type": "home" }
  { "type": "sethome" }
  { "type": "stop" }
  { "type": "speed",   "vmax": 150000 }
  { "type": "accel",   "amax": 300 }
  { "type": "current", "run_ma": 500, "hold_ma": 150 }
  { "type": "wobbly",  "cx": 0, "cy": 0, "r": 60, "wobble": 0.5, "harmonics": 4, "seed": 7 }
  { "type": "bullseye","cx": 0, "cy": 0 }
  { "type": "grid",    "cx": 0, "cy": 0 }

Configuration commands (take effect instantly, do not queue a draw job):
  { "type": "bounds",       "xn": -200, "xp": 200, "yn": -150, "yp": 150, "ellipse": false }
  { "type": "matrix",       "a": 1, "b": 0, "c": 0, "d": 1, "tx": 50, "ty": 30 }
  { "type": "grid_select",  "cols": 2, "rows": 2, "padding_mm": 5, "col": 0, "row": 0,
                             "full_xn": -200, "full_xp": 200, "full_yn": -150, "full_yp": 150 }
  { "type": "grid_clear",   "full_xn": -200, "full_xp": 200, "full_yn": -150, "full_yp": 150 }

Studio generators (same unified pipeline as the console Script tab):
  { "type": "generate", "generator": "randomWalker", "params": { "count": 5, "seed": 42 } }

Fit-in-bounds (reseed): set metadata.fit_in_bounds=true to make every "generate" reseed
until its art fits ENTIRELY inside the active cell/work-area; the first fitting seed is
used. Misses (no seed fit within metadata.max_seeds, default 2000) are drawn CLIPPED with
pen-up gaps — never an edge-walk — and the run ends with a summary of how many cells could
not fit. Override per command with "fit": true/false (and optional "max_seeds","fit_tol_mm").
Off by default: spills are still clipped to pen-up gaps, just not reseeded.

Wrapped document (grid tests — metadata supplies work_area + grid for grid_select):
  { "metadata": { "work_area": { "x_min": -276, "x_max": 263, "y_min": -115, "y_max": 273 },
                  "grid": { "cols": 10, "rows": 10, "padding_mm": 10 },
                  "fit_in_bounds": true, "max_seeds": 2000 },
    "commands": [ … ] }`,
  {
    commands: z.union([
      z.array(z.object({ type: z.string().optional() }).passthrough()).min(1),
      z.object({
        metadata: z.record(z.string(), z.unknown()).optional(),
        commands: z.array(z.object({ type: z.string().optional() }).passthrough()).min(1),
      }),
    ]).describe('Command array, or { metadata, commands } document (console Script tab format)'),

    stop_on_error: z.boolean().default(true).describe(
      'Abort the script if any command returns an error (default true)',
    ),
  },
  async ({ commands: raw, stop_on_error }) => {
    let { commands: all, gridCtx, metadata } = unwrapScriptCommands(raw);
    // If the script does any grid work, make the LIVE firmware work area authoritative:
    // re-derive gridCtx from the machine's real bounds so a script carrying stale or
    // wrong-convention inline full_* (e.g. a Y-flipped work area) can't place cells off
    // the canvas. Grid shape (cols/rows/padding) still comes from metadata/the command.
    //
    // ⚠ EXCEPT when a grid cell is still ACTIVE on the machine (a previous run halted
    // before grid_clear): then the live bounds are that CELL's bounds, not the full
    // area — deriving the grid from them tiles the inside of the stale cell (draws land
    // squished/offset) and grid_clear "restores" the wrong area. The firmware reports
    // the affine matrix in /api/status: non-identity matrix = a cell is active → fall
    // back to the document's metadata/inline full_* instead of live bounds.
    const hasGrid = all.some((c) => c?.type === 'grid_select' || c?.type === 'grid_clear');
    const results = [];
    if (hasGrid) {
      const s = await api('status');
      const fb = boundsFromFirmware(s.bounds ?? {});
      const liveOk = [fb.left, fb.right, fb.up, fb.down].every((v) => isFinite(v) && v !== 0);
      const ident = isIdentityMatrix(s.matrix);   // null = firmware without the field
      if (liveOk && ident !== false) {
        gridCtx = gridCtxFromPlotterBounds(fb, gridCtx ?? { cols: 1, rows: 1, padding_mm: 5 });
      } else if (ident === false) {
        if (gridCtx) {
          results.push(`⚠ A grid cell was still active on the machine (leftover matrix tx=${s.matrix?.tx} ty=${s.matrix?.ty}) — ` +
                       `using the document's work_area as the full area instead of the live (cell) bounds.`);
        } else {
          throw new Error(
            'A grid cell is still active on the machine (non-identity matrix) and this script has no ' +
            'metadata.work_area to define the FULL area. Run plot_grid_clear first (with the full bounds), ' +
            'or add metadata.work_area to the script.');
        }
      }
      if (gridCtx) all = hydrateGridCommands(all, gridCtx);
    }
    const commands = all.filter((c) => c?.type && c.type !== 'status');

    // Reseed-until-fits feature (toggle): script-wide via metadata.fit_in_bounds,
    // per-generate override via cmd.fit. When on, each cell's generator is reseeded
    // until its art fits inside the cell; misses are drawn clipped (pen-up gaps) and
    // counted. See expandGeneratorFitted.
    const fitOn      = metadata?.fit_in_bounds ?? metadata?.fit ?? false;
    const fitMaxSeed = Number(metadata?.max_seeds ?? 2000);
    const fitTolMm   = Number(metadata?.fit_tol_mm ?? 0);
    let activeCell = null;                 // "(col,row)" of the current grid cell
    const fitMisses = [];                  // cells/generators that never fit
    let fitContained = 0, fitSkipped = 0;  // counters for the summary

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const isDirect = DIRECT_CMD_TYPES.has(cmd.type);
      if (cmd.type === 'grid_select') activeCell = `(${cmd.col ?? 0},${cmd.row ?? 0})`;
      else if (cmd.type === 'grid_clear') activeCell = null;

      let json;
      try {
        if (cmd.type === 'generate') {
          const s = await api('status');
          const bounds = boundsFromFirmware(s.bounds ?? {});
          const spec = {
            key: cmd.generator ?? cmd.key,
            params: cmd.params ?? {},
            warp: cmd.warp
              ? { mode: cmd.warp.mode ?? 'water', params: cmd.warp.params ?? {} }
              : undefined,
          };
          // Per-command cmd.fit overrides the script-wide toggle.
          const wantFit = cmd.fit ?? fitOn;
          const ex = expandGeneratorFitted(spec, bounds, {
            fit: wantFit,
            maxSeeds: Number(cmd.max_seeds ?? fitMaxSeed),
            fitTolMm: Number(cmd.fit_tol_mm ?? fitTolMm),
            ellipse: !!s.bounds?.ellipse,
            arcTol: ARC_TOL,
          });
          if (wantFit) {
            const where = activeCell ? `cell ${activeCell}` : `${spec.key}`;
            if (!ex.hasSeed) { fitSkipped++; results.push(`   ↳ fit skipped (${where}): "${spec.key}" has no seed param.`); }
            else if (ex.fit) { fitContained++; }
            else { fitMisses.push(where); results.push(`   ↳ ⚠ fit MISS (${where}): no seed in ${ex.attempts} fit — drawn clipped.`); }
          }
          json = await batchSend(ex.queries);
        } else if (cmd.type === 'studio') {
          // Full Studio layer-stack step (same doc shape as plot_studio / the console's
          // "Export" JSON). Bounds are read live, so inside a grid_select the stack is
          // evaluated + clipped for the ACTIVE CELL — a studio design per cell.
          const s = await api('status');
          const bounds = boundsFromFirmware(s.bounds ?? {});
          const { layers, groups } = buildStudioStack(cmd.layers, cmd.groups);
          const queries = runLayerStack(layers, bounds, groups, undefined, { arcTol: ARC_TOL });
          results.push(`   ↳ studio stack: ${layers.length} layer(s) → ${queries.length} ops` +
                       (activeCell ? ` (cell ${activeCell})` : ''));
          json = await batchSend(queries);
        } else if (isDirect) {
          // Configuration commands bypass the draw queue and execute immediately.
          json = await executeDirectCmd(cmd, gridCtx);
        } else {
          if (cmd.type === 'home' || cmd.type === 'sethome') {
            await api('matrix?a=1&b=0&c=0&d=1&tx=0&ty=0');
          }
          const endpoint = buildEndpoint(cmd);
          json = await drawAndWait(endpoint);   // wait until this step physically finishes
        }
      } catch (err) {
        const msg = `[${i + 1}/${commands.length}] ${cmd.type}: ${err.message}`;
        results.push(msg);
        if (stop_on_error) {
          results.push('Script aborted.');
          break;
        }
        continue;
      }

      const status = json?.status ?? 'unknown';
      results.push(`[${i + 1}/${commands.length}] ${cmd.type} → ${status}: ${json?.msg ?? ''}`);

      // A driver fault ALWAYS pauses the script, regardless of stop_on_error: the
      // hardware is unhappy, so it is never safe to push the next job. Report the
      // fault and how to resume.
      if (status === 'driver_fault') {
        results.push(`⛔ PAUSED on a driver fault at step ${i + 1}/${commands.length} (${cmd.type}).`);
        results.push(`   ${json?.msg ?? ''}`);
        results.push(`   ${commands.length - (i + 1)} command(s) NOT sent. Resolve the hardware issue, ` +
                     `then call plot_clear_fault and re-run the remaining steps.`);
        break;
      }

      // Stop on a firmware error (e.g. out of bounds) or an escape/abort.
      if (stop_on_error && status !== 'ok') {
        results.push(status === 'aborted'
          ? 'Script halted (escape/abort triggered).'
          : 'Script aborted (firmware returned error).');
        break;
      }
    }

    // Auto-cleanup (parity with the console Script tab's finally-block): if the script
    // activated a grid cell and ended — or HALTED mid-run — without a grid_clear,
    // restore the full work area + identity matrix now. A cell left active is exactly
    // what poisons the next run's "live bounds = full area" derivation above.
    if (activeCell && gridCtx) {
      try {
        const q = gridClearQueries(gridCtx);
        await drawAndWait(q.boundsQuery);
        await api(q.matrixQuery);
        results.push(`Grid auto-cleared (cell ${activeCell} was still active) — full work area restored.`);
      } catch (err) {
        results.push(`⚠ Grid auto-clear failed: ${err.message} — run plot_grid_clear manually.`);
      }
    }

    // Fit summary — the headline the user wants: how many cells could not be made
    // to fit inside their bound even after exhausting every seed.
    if (fitOn) {
      const tried = fitContained + fitSkipped + fitMisses.length;
      results.push('');
      if (fitMisses.length === 0) {
        results.push(`Fit: ✓ all ${fitContained} generated cell(s) fit inside their bounds.`);
      } else {
        results.push(`Fit: ✗ ${fitMisses.length}/${tried} cell(s) could NOT fit after ${fitMaxSeed} seeds ` +
                     `(drawn clipped with pen-up gaps): ${fitMisses.join(', ')}`);
      }
      if (fitSkipped > 0) results.push(`     (${fitSkipped} generator(s) had no seed param to vary — fit not applicable.)`);
    }

    return { content: [{ type: 'text', text: results.join('\n') }] };
  },
);

// ── Raw-path & generative tools ──────────────────────────────────────────────

// Build Studio Layer[]/LayerGroup[] from a document (the console Studio tab's
// "⤓ Export" JSON, or a bare { layers, groups }). Layers accept module|moduleKey;
// params merge over the module's defaults so partial params are fine. Image-based
// modules need an uploaded image, which only exists in the web console.
function buildStudioStack(rawLayers, rawGroups) {
  if (!Array.isArray(rawLayers) || rawLayers.length === 0)
    throw new Error('studio: "layers" must be a non-empty array');
  const layers = rawLayers.map((l, i) => {
    const key = String(l?.moduleKey ?? l?.module ?? '');
    const mod = getModule(key);
    if (!mod) throw new Error(`studio: unknown module "${key}" (layer ${i + 1}) — see plot_list_generators`);
    if (key.startsWith('image'))
      throw new Error(`studio: "${key}" needs an uploaded image — image layers only work in the web console`);
    return {
      id: `l${i}`,
      moduleKey: key,
      params: { ...defaultsOf(mod), ...(l.params ?? {}) },
      groupId: l.groupId != null ? String(l.groupId) : undefined,
    };
  });
  const groups = Array.isArray(rawGroups) ? rawGroups.map((g, i) => ({
    id: String(g?.id ?? `g${i}`),
    name: String(g?.name ?? `group ${i + 1}`),
    tx: Number(g?.tx ?? 0),
    ty: Number(g?.ty ?? 0),
    rotateDeg: Number(g?.rotateDeg ?? 0),
  })) : [];
  return { layers, groups };
}

server.tool(
  'plot_list_generators',
  'List all built-in generative algorithms available to plot_generate. ' +
  'Returns each generator key, label, and description so you can choose what to use. ' +
  'Call this first to browse options before calling plot_generate.',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(listGenerators(), null, 2) }],
  }),
);

server.tool(
  'plot_studio',
  `Plot a FULL Studio layer-stack document — the same JSON the web console's Studio tab
exports ("⤓ Export"), so a saved design can be handed to this tool unchanged.
Runs the complete Studio pipeline: evaluate every layer (all generators PLUS the
mask / fill / warp modifier layers and text, with group transforms) → clip to the live
work area (or the ACTIVE GRID CELL) → simplify → travel-optimize → arc-fit →
flow-controlled send, waiting until drawing physically finishes.

Accepts { layers, groups? } or the full export file { format, name, layers, groups,
metadata }. Layer shape: { module: "<key>", params?: {...}, groupId?: "g1" } — params
merge over the module's defaults, so only overrides are needed. Modifier layers
(mask/fill/warp) apply to the composition below them, exactly like in the Studio.
Limitation: image* modules need an uploaded image and only work in the web console.`,
  {
    doc: z.object({
      name:   z.string().optional(),
      layers: z.array(z.record(z.string(), z.unknown())).min(1)
        .describe('Layer stack, bottom-first: [{ module, params?, groupId? }, …]'),
      groups: z.array(z.record(z.string(), z.unknown())).optional()
        .describe('Optional layer groups: [{ id, name, tx, ty, rotateDeg }]'),
    }).passthrough().describe("Studio document (the console's ⤓ Export JSON works as-is)"),
  },
  async ({ doc }) => {
    const { layers, groups } = buildStudioStack(doc.layers, doc.groups);
    const s = await api('status');
    const bounds = boundsFromFirmware(s.bounds ?? {});
    if (![bounds.left, bounds.right, bounds.up, bounds.down].every((v) => isFinite(v) && v !== 0))
      throw new Error('could not read live work-area bounds from the plotter (is it online?)');
    const queries = runLayerStack(layers, bounds, groups, undefined, { arcTol: ARC_TOL });
    const draws = queries.filter((q) => q.startsWith('line?') || q.startsWith('arc?')).length;
    const result = await batchSend(queries);
    return { content: [{ type: 'text', text: [
      `Studio stack "${doc.name ?? 'untitled'}": ${layers.length} layer(s), ${groups.length} group(s) → ` +
      `${queries.length} ops (${draws} drawn segments) inside x:[${-bounds.left}..${bounds.right}] y:[${-bounds.up}..${bounds.down}].`,
      ok(result),
    ].join('\n') }] };
  },
);

server.tool(
  'plot_polylines',
  `Draw one or more arbitrary polyline paths directly on the plotter.
This is the lowest-level drawing tool — pass arrays of (x,y) points and the MCP
compiles them to goto/pen/line firmware sequences and sends them with flow control.

Use this when the firmware's fixed primitives (circle, square, wobbly)
can't express the shape you want. You compute the points; this tool sends them.

The tool handles pen management for each path:
  goto start (pen up) → pen down → line segments → pen up

If clip_to_bounds is true (default), paths that stray outside the current work
area are trimmed at the boundary — the surviving inside segments are drawn, the
out-of-bounds parts are silently dropped.

SAMPLING DENSITY — rule of thumb:
  For smooth curves: sample every ≤ 2 mm along the curve.
  Full circle radius R → at least ceil(2·π·R / 2) points.
  Example: R=60 mm → ceil(188/2) = 94 points minimum (200 is safer).

COMMON PATTERNS Claude can compute:

  Archimedean spiral (R grows linearly with angle):
    for i in 0..N: θ = i*(2π*turns/N), r = rMin + (rMax-rMin)*(i/N)
    x = r*cos(θ), y = r*sin(θ)

  Lissajous figure (two sine waves):
    x = A*sin(a*t + δ), y = B*sin(b*t)   for t in [0, 2π]
    a/b ratio determines knot complexity; δ is the phase offset.

  Rose curve (polar):
    r = cos(k*θ), x = r*cos(θ), y = r*sin(θ)   for θ in [0, 2π] (k even)
    or [0, π] (k odd). k=2 → 4 petals, k=3 → 3 petals.

  Sine wave band:
    x = xStart + t*(xEnd-xStart), y = cy + A*sin(ω*t + φ)

  Concentric rings (separate paths per ring):
    for each R: points = [ (R*cos(θ), R*sin(θ)) for θ in 0..2π+ε ]

All coordinates in mm, Y+ = DOWN. Check plot_status for current bounds.`,
  {
    paths: z.array(z.object({
      points: z.array(z.object({
        x: z.number(),
        y: z.number(),
      })).min(2).describe('Ordered list of (x,y) waypoints in mm'),
      closed:  z.boolean().default(false).describe('Connect last point back to first'),
      cycles:  z.number().int().min(1).max(10).default(1).describe('Retrace count (darken)'),
    })).min(1),
    clip_to_bounds: z.boolean().default(true).describe(
      'Trim paths at the work-area boundary so out-of-range segments are clipped (default true)',
    ),
    warp_mode: z.enum(['none', 'water', 'droplet']).default('none').describe(
      'Apply a warp displacement to the paths before sending. ' +
      '"water" = sinusoidal X/Y ripple; "droplet" = radial rings from a centre.',
    ),
    warp_params: z.object({
      amplitude:  z.number().default(8).describe('Warp displacement magnitude (mm)'),
      wavelength: z.number().default(60).describe('Warp spatial period (mm)'),
      falloff:    z.number().default(0.01).describe('Droplet radial decay (0 = uniform)'),
      cx:         z.number().default(0).describe('Warp centre X (mm)'),
      cy:         z.number().default(0).describe('Warp centre Y (mm)'),
    }).default({}).describe('Warp parameters — only used when warp_mode != "none"'),
  },
  async ({ paths, clip_to_bounds, warp_mode, warp_params }) => {
    // Read current bounds for clipping.
    let clipBounds = null;
    let fwBounds = null;
    if (clip_to_bounds) {
      try {
        const s = await api('status');
        fwBounds = boundsFromFirmware(s.bounds ?? {});
        if (![fwBounds.left, fwBounds.right, fwBounds.up, fwBounds.down].every(v => isFinite(v) && v > 0)) {
          fwBounds = null;
        }
      } catch { /* skip clipping if status fails */ }
    }

    if (!fwBounds) fwBounds = { left: 300, right: 300, up: 300, down: 300 };
    const queries = compilePathsWithWarp(
      paths,
      fwBounds,
      warp_mode !== 'none' ? { mode: warp_mode, params: warp_params ?? {} } : null,
      { arcTol: ARC_TOL },
    );
    const result = await batchSend(queries);

    return {
      content: [{ type: 'text', text: [
        `Sent ${paths.length} path(s) — ${queries.length} firmware commands.`,
        warp_mode !== 'none' ? `Warp: ${warp_mode} (amplitude ${(warp_params ?? {}).amplitude ?? 8} mm)` : null,
        clip_to_bounds && fwBounds
          ? `Clipped to x:${-fwBounds.left}..${fwBounds.right}, y:${-fwBounds.up}..${fwBounds.down}`
          : 'No bounds clipping (status unavailable or skipped).',
        `Result: ${result.status}${result.msg ? ` — ${result.msg}` : ''}`,
      ].filter(Boolean).join('\n') }],
    };
  },
);

server.tool(
  'plot_generate',
  `Run a named generative algorithm, compile its output to firmware commands, and
send everything to the plotter — in one call. This gives you access to all the
studio generators from the MCP, without needing the browser console.

Use plot_list_generators first to browse what is available and read each one's
parameter description. Then call plot_generate with the generator key and your
chosen params.

All generators respect the current work area bounds (read via plot_status before
calling). Out-of-bounds paths are clipped automatically.

After generation, you can also apply a warp displacement to the paths by setting
warp_mode to "water" (sinusoidal) or "droplet" (radial ripples) with warp_params.

Available generators (call plot_list_generators for the full, live list with
descriptions — it includes every module below plus basic shapes):
  HUMAN-TRAINED favourites (see plot_style_guide for the taste they serve):
  branching    — organic dendritic growth: tree/coral/delta/splat (coreR/flow/edgeAvoid)
  flowWhirls   — full-field streamlines through a vortex field (the winning swirl engine)
  ruledLines   — parallel lines in the 4 LeWitt directions; jitter bends them as SMOOTH
                 ARC bows (jitterStyle=arc, default) or waves; densityStops multi-point
                 density profile ("1,0.15,1" = valley); minGap paper-rip clamp
  connectDots / strokeField / arcs / locatedFigures / scribble / curvyDivide /
  whirls / growthField — the rest of the trained set
  STOCK:
  spirograph   — hypotrochoid / epitrochoid roulette curves (gear toy)
  orbitalWeave — continuous orbiting trace that folds into woven knots
  noiseOrbit   — concentric rings distorted by 3D noise + Chaikin smoothing
  randomWalker — agents drifting with accumulating velocity; mode="pipe" draws growing
                 circles (rMin→rMax) along the invisible walk instead of the line
  noisedHatches — grid of hatch cells shaped by a noise blob
  moireCurtain — two line gratings at slightly different angles (moiré interference)
  patternMaker — base shape tiled across a grid with per-cell rotation
  text         — box text with built-in stroke fonts
  (image* modules need an uploaded image — web console only; sheets is BANNED by the
  style guide.)`,
  {
    generator: z.string().describe(
      'Generator module key — use plot_list_generators to see all options with descriptions',
    ),

    params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}).describe(
      'Generator-specific parameters. Omit any to use the generator\'s defaults. ' +
      'Use plot_list_generators to see what each generator accepts.',
    ),

    warp_mode: z.enum(['none', 'water', 'droplet']).default('none').describe(
      'Apply a warp displacement after generation. "water" = sinusoidal X/Y ripple; ' +
      '"droplet" = radial rings from a centre (like a stone in water). "none" = no warp.',
    ),

    warp_params: z.object({
      amplitude:  z.number().default(8).describe('Warp displacement magnitude (mm)'),
      wavelength: z.number().default(60).describe('Warp spatial period (mm)'),
      falloff:    z.number().default(0.01).describe('Droplet mode: radial decay rate. 0 = no decay.'),
      cx:         z.number().default(0).describe('Warp centre X (mm, droplet mode)'),
      cy:         z.number().default(0).describe('Warp centre Y (mm, droplet mode)'),
    }).default({}).describe('Parameters for the warp modifier (only used when warp_mode != "none")'),

    fit_in_bounds: z.boolean().default(false).describe(
      'Reseed until the art fits ENTIRELY inside the work area. Sweeps the generator\'s ' +
      'seed (only generators with a seed param) and uses the first that fits. If none of ' +
      'max_seeds fit, the last attempt is drawn clipped (pen-up gaps, never an edge-walk) ' +
      'and the miss is reported. Off (default) = single shot, still clipped.',
    ),
    max_seeds: z.number().int().min(1).max(10000).default(2000).describe(
      'When fit_in_bounds is on, how many seeds to try before giving up (default 2000).',
    ),
    fit_tol_mm: z.number().min(0).default(0).describe(
      'Overshoot tolerance for the fit test (mm). 0 = strictly inside the edge.',
    ),
  },
  async ({ generator, params, warp_mode, warp_params, fit_in_bounds, max_seeds, fit_tol_mm }) => {
    const s = await api('status');
    const bounds = boundsFromFirmware(s.bounds ?? {});
    if (![bounds.left, bounds.right, bounds.up, bounds.down].every(v => isFinite(v) && v > 0)) {
      const b = s.bounds ?? {};
      throw new Error(`Could not read valid work area bounds from firmware (got: xn=${b.xn}, xp=${b.xp}, yn=${b.yn}, yp=${b.yp}). Is the plotter connected?`);
    }

    const spec = {
      key: generator,
      params: params ?? {},
      warp: warp_mode !== 'none'
        ? { mode: warp_mode, params: warp_params ?? {} }
        : undefined,
    };
    const ex = expandGeneratorFitted(spec, bounds, {
      fit: fit_in_bounds,
      maxSeeds: max_seeds,
      fitTolMm: fit_tol_mm,
      ellipse: !!s.bounds?.ellipse,
      arcTol: ARC_TOL,
    });
    const result = await batchSend(ex.queries);

    const gens = listGenerators();
    const label = gens.find((g) => g.key === generator)?.label ?? generator;

    let fitLine = null;
    if (fit_in_bounds) {
      if (!ex.hasSeed)        fitLine = `Fit: SKIPPED — "${generator}" has no seed param to vary; drawn clipped.`;
      else if (ex.fit)        fitLine = `Fit: ✓ fits inside bounds at seed ${ex.seed} (after ${ex.attempts} tr${ex.attempts === 1 ? 'y' : 'ies'}).`;
      else                    fitLine = `Fit: ✗ NO seed in ${ex.attempts} fit — drawn clipped (pen-up gaps). Retune params or raise max_seeds.`;
    } else if (!ex.fit) {
      fitLine = `Note: art spills outside the bounds — drawn clipped (pen-up gaps). Set fit_in_bounds to reseed for a contained result.`;
    }

    return {
      content: [{ type: 'text', text: [
        `Generator: ${label}`,
        `Firmware commands: ${ex.queries.length}`,
        warp_mode !== 'none' ? `Warp applied: ${warp_mode} (amplitude ${warp_params?.amplitude ?? 8} mm)` : null,
        fitLine,
        `Result: ${result.status}${result.msg ? ` — ${result.msg}` : ''}`,
      ].filter(Boolean).join('\n') }],
    };
  },
);

// ── Bounds & grid tools ──────────────────────────────────────────────────────

server.tool(
  'plot_set_bounds',
  'Set the firmware work area bounds. All drawing commands are clipped to this ' +
  'rectangle (or the inscribed ellipse when ellipse=true). Coordinates in mm; ' +
  'Y+ is DOWN. xn/yn are usually negative (left/top), xp/yp positive (right/bottom). ' +
  'Use plot_status to read current bounds. Use plot_grid_clear (not this tool) to ' +
  'restore bounds after grid cell work.',
  {
    xn:      z.number().describe('Left boundary (X−, usually negative)'),
    xp:      z.number().describe('Right boundary (X+, usually positive)'),
    yn:      z.number().describe('Top boundary (Y−, usually negative since Y+ is down)'),
    yp:      z.number().describe('Bottom boundary (Y+, usually positive since Y+ is down)'),
    ellipse: z.boolean().default(false).describe(
      'Clip to the ellipse inscribed in the box instead of the rectangle (default false)',
    ),
  },
  async ({ xn, xp, yn, yp, ellipse }) => ({
    // persist=1 — a deliberate work-area set is saved to flash so it survives a reboot.
    content: [{ type: 'text', text: ok(await api(
      `bounds?xn=${xn}&xp=${xp}&yn=${yn}&yp=${yp}&shape=${ellipse ? 1 : 0}&persist=1`,
    )) }],
  }),
);

// plot_grid_plan ──────────────────────────────────────────────────────────────
server.tool(
  'plot_grid_plan',
  `Compute and return the full grid layout for a given work area and grid params —
no firmware call, no state change. Use this BEFORE starting cell iteration to:
  • Confirm cell sizes and padding look right
  • Get every cell's global centre coordinates
  • Build a loop plan (col 0..cols-1, row 0..rows-1)

Returns a JSON object:
  { cols, rows, padding_mm, cellW, cellH,
    cells: [ { col, row, cx, cy, xn, xp, yn, yp }, ... ] }
where cx/cy are the cell centre in global (full-area) coordinates, and
xn/xp/yn/yp are the cell edges in global coordinates.`,
  {
    cols:       z.number().int().min(1).max(12).describe('Number of columns'),
    rows:       z.number().int().min(1).max(12).describe('Number of rows'),
    padding_mm: z.number().min(0).default(5).describe('Gap between adjacent cells in mm (default 5)'),
    full_xn:    z.number().describe('Full work area left bound (xn from plot_status)'),
    full_xp:    z.number().describe('Full work area right bound (xp from plot_status)'),
    full_yn:    z.number().describe('Full work area top bound (yn from plot_status)'),
    full_yp:    z.number().describe('Full work area bottom bound (yp from plot_status)'),
  },
  ({ cols, rows, padding_mm, full_xn, full_xp, full_yn, full_yp }) => {
    const cellW = ((full_xp - full_xn) - (cols - 1) * padding_mm) / cols;
    const cellH = ((full_yp - full_yn) - (rows - 1) * padding_mm) / rows;
    if (cellW <= 0 || cellH <= 0) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: `padding_mm=${padding_mm} too large — cells have zero or negative size`,
        cellW, cellH,
      }) }] };
    }
    const rnd = (n) => Math.round(n * 10) / 10;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lx = full_xn + c * (cellW + padding_mm);
        const ty = full_yn + r * (cellH + padding_mm);
        const cx = lx + cellW / 2;
        const cy = ty + cellH / 2;
        cells.push({
          col: c, row: r,
          cx: rnd(cx), cy: rnd(cy),
          xn: rnd(lx), xp: rnd(lx + cellW),
          yn: rnd(ty), yp: rnd(ty + cellH),
        });
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        cols, rows, padding_mm,
        cellW: rnd(cellW), cellH: rnd(cellH),
        total: cols * rows,
        cells,
      }, null, 2) }],
    };
  },
);

server.tool(
  'plot_grid_select',
  `Activate a grid cell: divide the full work area into cols×rows equal cells
(with padding_mm gap between adjacent cells), then configure the firmware so
that (0,0) maps to the selected cell's centre and all drawing is clipped to that
cell's bounds.

IMPORTANT — pass the FULL work area bounds every call (not the cell bounds the
firmware reports once a cell is active). Call plot_status ONCE at session start,
save xn/xp/yn/yp, and reuse those same values for every plot_grid_select and
plot_grid_clear call.

The tool pushes two things to firmware:
  1. bounds = ±cellW/2, ±cellH/2   → clips drawing to this cell
  2. matrix tx=cellCentreX, ty=Y   → (0,0) draws at the cell's global centre

After activation, all draw tools (plot_line, plot_circle, plot_generate, etc.)
work in cell-local coordinates — (0,0) is the cell centre, (±cellW/2, ±cellH/2)
are the edges. plot_generate reads the cell bounds automatically.

Typical single-session workflow:
  1. plot_status                         → save full xn, xp, yn, yp
  2. plot_grid_plan cols rows padding ... → (optional) preview layout
  3. plot_grid_select col=0 row=0 ...    → top-left cell
  4. plot_circle / plot_generate / ...   → draw (cell-local coords)
  5. plot_grid_select col=1 row=0 ...    → next cell (same full bounds!)
  6. ...repeat for all cells...
  7. plot_grid_clear                     → restore full work area`,
  {
    cols:       z.number().int().min(1).max(12).describe('Number of columns'),
    rows:       z.number().int().min(1).max(12).describe('Number of rows'),
    padding_mm: z.number().min(0).default(5).describe('Gap between adjacent cells in mm (default 5)'),
    col:        z.number().int().min(0).describe('Column to activate (0 = leftmost)'),
    row:        z.number().int().min(0).describe('Row to activate (0 = topmost)'),
    full_xn:    z.number().describe('Full work area left bound (xn from plot_status)'),
    full_xp:    z.number().describe('Full work area right bound (xp from plot_status)'),
    full_yn:    z.number().describe('Full work area top bound (yn from plot_status)'),
    full_yp:    z.number().describe('Full work area bottom bound (yp from plot_status)'),
  },
  async ({ cols, rows, padding_mm, col, row, full_xn, full_xp, full_yn, full_yp }) => {
    if (col >= cols) throw new Error(`col ${col} out of range (0..${cols - 1})`);
    if (row >= rows) throw new Error(`row ${row} out of range (0..${rows - 1})`);
    const cellW = ((full_xp - full_xn) - (cols - 1) * padding_mm) / cols;
    const cellH = ((full_yp - full_yn) - (rows - 1) * padding_mm) / rows;
    if (cellW <= 0 || cellH <= 0) throw new Error('padding_mm too large — cells have zero or negative size');
    const lx = full_xn + col * (cellW + padding_mm);
    const ty = full_yn + row * (cellH + padding_mm);
    const cx = lx + cellW / 2;
    const cy = ty + cellH / 2;
    const cell = computeCell(
      { cols, rows, padding_mm, full_xn, full_xp, full_yn, full_yp },
      col, row,
    );
    await drawAndWait(cell.boundsQuery);
    await api(cell.matrixQuery);
    const rnd = (n) => Math.round(n * 10) / 10;
    return {
      content: [{ type: 'text', text: [
        `Grid cell (col ${col}, row ${row}) activated.`,
        `Cell size: ${rnd(cell.cellW)} × ${rnd(cell.cellH)} mm`,
        `Cell centre in global coords: (${rnd(cell.cx)}, ${rnd(cell.cy)})`,
        `Work area now clipped to x: ${rnd(-cell.cellW/2)}..${rnd(cell.cellW/2)}, y: ${rnd(-cell.cellH/2)}..${rnd(cell.cellH/2)}`,
        `(0,0) = cell centre. All draw commands use cell-local coordinates.`,
      ].join('\n') }],
    };
  },
);

server.tool(
  'plot_grid_clear',
  'Deactivate grid cell mode: restore the full work area bounds and reset the ' +
  'coordinate matrix to identity (goto 0 0 returns to the original origin). ' +
  'Pass the same full_xn/xp/yn/yp values you used for plot_grid_select.',
  {
    full_xn: z.number().describe('Full work area left bound (same as plot_grid_select)'),
    full_xp: z.number().describe('Full work area right bound'),
    full_yn: z.number().describe('Full work area top bound'),
    full_yp: z.number().describe('Full work area bottom bound'),
    ellipse: z.boolean().default(false).describe('Restore as ellipse clip (default false = rectangle)'),
  },
  async ({ full_xn, full_xp, full_yn, full_yp, ellipse }) => {
    const boundsEp = `bounds?xn=${full_xn}&xp=${full_xp}&yn=${full_yn}&yp=${full_yp}&shape=${ellipse ? 1 : 0}`;
    await drawAndWait(boundsEp);
    await api(`matrix?a=1&b=0&c=0&d=1&tx=0&ty=0`);
    return {
      content: [{ type: 'text', text: [
        'Grid cell cleared. Full work area restored.',
        `Bounds: x: ${full_xn}..${full_xp}, y: ${full_yn}..${full_yp}`,
        '(0,0) is the original plotter origin again.',
      ].join('\n') }],
    };
  },
);

// ── Script document helpers (console Script tab parity) ─────────────────────

/** Accept a bare command array or { metadata, commands } — same as the console Script tab. */
function unwrapScriptCommands(raw) {
  if (Array.isArray(raw)) return { commands: raw, gridCtx: null, metadata: null };
  if (raw && typeof raw === 'object' && Array.isArray(raw.commands)) {
    const gridCtx = gridCtxFromMetadata(raw);
    return { commands: hydrateGridCommands(raw.commands, gridCtx), gridCtx, metadata: raw.metadata ?? null };
  }
  throw new Error('Expected a JSON command array or { metadata, commands } document');
}

// ── Endpoint builder (shared by plot_script) ─────────────────────────────────

/** Handle configuration commands that need direct api() calls (no draw queue). */
async function executeDirectCmd(cmd, gridCtx = null) {
  const p = cmd;
  switch (p.type) {
    case 'bounds':
      // Explicit work-area command (not grid tiling) → persist across reboot.
      return api(`bounds?xn=${p.xn}&xp=${p.xp}&yn=${p.yn}&yp=${p.yp}&shape=${p.ellipse ? 1 : 0}&persist=1`);

    case 'matrix':
      return api(`matrix?a=${p.a ?? 1}&b=${p.b ?? 0}&c=${p.c ?? 0}&d=${p.d ?? 1}&tx=${p.tx ?? 0}&ty=${p.ty ?? 0}`);

    case 'grid_select': {
      // gridCtx (live firmware bounds) is authoritative; shape comes from the command.
      const gc = resolveGridCtx(p, gridCtx);
      if (!gc) throw new Error('grid_select: need metadata.work_area+grid on the document, or cols/rows/full_xn…yp on the command');
      const col = Number(p.col ?? 0);
      const row = Number(p.row ?? 0);
      const cell = computeCell(gc, col, row);
      // Bounds is a queued job — wait until it lands before matrix (immediate).
      await drawAndWait(cell.boundsQuery);
      await api(cell.matrixQuery);
      return { status: 'ok', msg: `cell (${col},${row}) active — ${cell.cellW}×${cell.cellH} mm` };
    }

    case 'grid_clear': {
      const ellipse = p.ellipse ?? false;
      const gc = resolveGridCtx(p, gridCtx);
      if (!gc) throw new Error('grid_clear: need metadata.work_area on the document, or full_xn…yp on the command');
      const q = gridClearQueries(gc);
      const shape = ellipse ? 1 : 0;
      const boundsEp = q.boundsQuery.replace('shape=0', `shape=${shape}`);
      await drawAndWait(boundsEp);
      await api(q.matrixQuery);
      return { status: 'ok', msg: 'grid cleared, full area restored' };
    }

    default:
      throw new Error(`Not a direct command: ${p.type}`);
  }
}

const DIRECT_CMD_TYPES = new Set(['bounds', 'matrix', 'grid_select', 'grid_clear']);

function buildEndpoint(cmd) {
  const p = cmd;
  switch (p.type) {
    case 'goto':
      return `goto?x=${p.x ?? 0}&y=${p.y ?? 0}`;

    case 'line':
      return `line?x0=${p.x0 ?? 0}&y0=${p.y0 ?? 0}&x1=${p.x1 ?? 0}&y1=${p.y1 ?? 0}&cycles=${p.cycles ?? 1}`;

    case 'arc':
      return (
        `arc?cx=${p.cx ?? 0}&cy=${p.cy ?? 0}&r=${p.r ?? 50}` +
        `&a0=${p.a0 ?? 0}&a1=${p.a1 ?? 6.2832}` +
        `&cw=${(p.cw ?? false) ? 1 : 0}&cycles=${p.cycles ?? 1}&lift=${(p.lift ?? true) ? 1 : 0}`
      );

    case 'circle':
      return (
        `circle?cx=${p.cx ?? 0}&cy=${p.cy ?? 0}&r=${p.r ?? 50}` +
        `&cycles=${p.cycles ?? 1}&fill=${p.fill_mode ?? 0}` +
        `&angle=${p.hatch_angle ?? 0}&spacing=${p.spacing ?? 3}` +
        `&outline=${(p.outline ?? true) ? 1 : 0}`
      );

    case 'square':
      return (
        `square?cx=${p.cx ?? 0}&cy=${p.cy ?? 0}&size=${p.size ?? 100}` +
        `&cycles=${p.cycles ?? 1}&fill=${p.fill_mode ?? 0}` +
        `&angle=${p.hatch_angle ?? 0}&spacing=${p.spacing ?? 3}` +
        `&outline=${(p.outline ?? true) ? 1 : 0}`
      );

    case 'wobbly':
      return (
        `wobbly?cx=${p.cx ?? 0}&cy=${p.cy ?? 0}&r=${p.r ?? 50}` +
        `&bound_r=${p.bound_r ?? 0}&wobble=${p.wobble ?? 0.4}` +
        `&harmonics=${p.harmonics ?? 3}&seed=${p.seed ?? 42}&cycles=${p.cycles ?? 1}`
      );

    case 'bullseye':
      return `bullseye?cx=${p.cx ?? 0}&cy=${p.cy ?? 0}`;

    case 'grid':
      return `grid?cx=${p.cx ?? 0}&cy=${p.cy ?? 0}`;

    case 'border':  return 'border';   // walk the work-area limit path (uses stored bounds)

    case 'pen':
      if (p.position !== 'up' && p.position !== 'down')
        throw new Error('pen position must be "up" or "down"');
      return `pen?pos=${p.position}`;

    case 'home':    return 'home';
    case 'sethome': return 'sethome';
    case 'stop':    return 'stop';

    case 'speed':
      return `speed?vmax=${p.vmax ?? 200000}`;

    case 'accel':
      return `accel?amax=${p.amax ?? 500}`;

    case 'current':
      // Accept run_ma/hold_ma (MCP style) and run/hold (console script style).
      return `cur?run=${p.run_ma ?? p.run ?? 300}&hold=${p.hold_ma ?? p.hold ?? 100}`;

    default:
      throw new Error(`Unknown command type: ${p.type}`);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
