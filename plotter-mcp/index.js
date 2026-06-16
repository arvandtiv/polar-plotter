#!/usr/bin/env node
/**
 * plotter-mcp — MCP server for the polar plotter.
 *
 * Exposes the plotter's HTTP API as named tools so Claude (or any MCP client)
 * can send drawing commands, queue a full painting script, and monitor status
 * without constructing raw URLs.
 *
 * Configuration (environment variables):
 *   PLOTTER_IP   — IP address of the plotter (default: 192.168.1.71)
 *   PLOTTER_PORT — HTTP port (default: 80)
 *
 * Start: node index.js
 * Register in .mcp.json (see project root).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PLOTTER_IP   = process.env.PLOTTER_IP   ?? '192.168.1.71';
const PLOTTER_PORT = process.env.PLOTTER_PORT ?? '80';
const BASE = `http://${PLOTTER_IP}:${PLOTTER_PORT}`;

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
  return res.json();
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
  const deadline = Date.now() + timeoutMs;
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

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    'polar-plotter',
  version: '1.0.0',
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
  ].join('\n'),
});

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
  'Emergency stop / escape — immediately preempt the job in progress (even ' +
  'mid-stroke), flush the pending queue, decelerate both motors, and lift the ' +
  'pen. Call this the moment anything looks wrong. Alias of plot_abort.',
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
    cycles:    z.number().int().min(1).default(1).describe('Number of passes (default 1)'),
  },
  async ({ cx, cy, r, bound_r, wobble, harmonics, seed, cycles }) => ({
    content: [{ type: 'text', text: ok(await drawAndWait(
      `wobbly?cx=${cx}&cy=${cy}&r=${r}&bound_r=${bound_r}` +
      `&wobble=${wobble}&harmonics=${harmonics}&seed=${seed}&cycles=${cycles}`,
    )) }],
  }),
);

// plot_truchet ────────────────────────────────────────────────────────────────
// Motif names (Carlson, Bridges 2018) → firmware bitmask bits.
const TRUCHET_MOTIFS = {
  '\\': 0, '/': 1, '-': 2, '|': 3, '+.': 4, 'x.': 5, '+': 6,
  fne: 7, fsw: 8, fnw: 9, fse: 10, tn: 11, ts: 12, te: 13, tw: 14,
};
const TRUCHET_DEFAULT = ['\\', '/', 'x.', 'fne', 'fsw', 'fnw', 'fse'];

server.tool(
  'plot_truchet',
  `Draw a Truchet tiling over the whole work area using Carlson's winged tile
motifs (Bridges 2018): strips of width cell/3 meeting the cell edges at the 1/3
and 2/3 points, so ribbons connect seamlessly cell-to-cell. The motif ribbons
are left as white paper; the background (negative space) is hatched with
globally aligned lines, so white channels wind through a continuous hatched
field. This is a long-running job: hatching a full work area takes serious pen
time — coarser spacing (3–4 mm) plots much faster.

n = number of grid columns (cell size = work-area width / n, clamped to
>= 40 mm). Rows are derived from the height. seed makes the pattern
reproducible. motifs picks which tile shapes appear — mixing 2–3 shapes gives
the richest emergent forms. Available motifs:
  \\\\ /        diagonal arc ribbons
  - |         straight bars (with dots)
  +           crossing bars
  x.          centre blob
  +.          four dots
  fne fsw fnw fse   "frowns": one corner arc + two dots
  tn ts te tw       "tees": bar + stem + one dot

In ellipse work-area mode the pattern is clipped to the ellipse boundary.`,
  {
    n:        z.number().int().min(1).max(64).default(4).describe('Grid columns — cell size = width/n, clamped to >= 40 mm (default 4)'),
    spacing:  z.number().min(0).default(3).describe('Hatch line spacing in mm; 0 = outlines only, no hatching (default 3)'),
    angle:    z.number().default(45).describe('Hatch angle in degrees (default 45)'),
    seed:     z.number().int().min(0).default(42).describe('Random seed — same seed = same pattern (default 42)'),
    motifs:   z.array(z.enum(Object.keys(TRUCHET_MOTIFS))).default(TRUCHET_DEFAULT)
                .describe('Motif names to draw from (default: arcs + frowns + blob)'),
  },
  async ({ n, spacing, angle, seed, motifs }) => {
    const mask = motifs.reduce((m, name) => m | (1 << TRUCHET_MOTIFS[name]), 0);
    return {
      content: [{ type: 'text', text: ok(await drawAndWait(
        `truchet?n=${n}&spacing=${spacing}&angle=${angle}&seed=${seed}&motifs=${mask}`,
      )) }],
    };
  },
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
  'Clear a latched TMC5072 driver fault and re-enable the drivers so a paused ' +
  'script can resume. Use after a driver fault (see plot_status) once the ' +
  'hardware cause is resolved. Then re-run the remaining commands.',
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
      `idle: ${s.idle}${s.aborting ? '  (ABORTING)' : ''}${s.paused ? '  (PAUSED — queue held; call plot_resume)' : ''}`,
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
  { "type": "truchet", "n": 4, "spacing": 3, "angle": 45, "seed": 42, "motifs": 1955 }
  { "type": "bullseye","cx": 0, "cy": 0 }
  { "type": "grid",    "cx": 0, "cy": 0 }`,
  {
    commands: z.array(z.object({
      type: z.enum([
        'goto', 'line', 'circle', 'square', 'wobbly', 'truchet',
        'bullseye', 'grid', 'border',
        'pen', 'home', 'sethome', 'stop',
        'speed', 'accel', 'current',
      ]).describe('Command type'),
    }).passthrough()).min(1).describe('Ordered list of commands to execute'),

    stop_on_error: z.boolean().default(true).describe(
      'Abort the script if any command returns an error (default true)',
    ),
  },
  async ({ commands, stop_on_error }) => {
    const results = [];

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let endpoint;

      try {
        endpoint = buildEndpoint(cmd);
      } catch (err) {
        const msg = `[${i + 1}/${commands.length}] build error: ${err.message}`;
        results.push(msg);
        if (stop_on_error) {
          results.push('Script aborted.');
          break;
        }
        continue;
      }

      let json;
      try {
        json = await drawAndWait(endpoint);   // wait until this step physically finishes
      } catch (err) {
        const msg = `[${i + 1}/${commands.length}] ${cmd.type} → network error: ${err.message}`;
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

    return { content: [{ type: 'text', text: results.join('\n') }] };
  },
);

// ── Endpoint builder (shared by plot_script) ─────────────────────────────────

function buildEndpoint(cmd) {
  const p = cmd;
  switch (p.type) {
    case 'goto':
      return `goto?x=${p.x ?? 0}&y=${p.y ?? 0}`;

    case 'line':
      return `line?x0=${p.x0 ?? 0}&y0=${p.y0 ?? 0}&x1=${p.x1 ?? 0}&y1=${p.y1 ?? 0}&cycles=${p.cycles ?? 1}`;

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

    case 'truchet': {
      // motifs: either a numeric firmware bitmask or an array of motif names.
      const mask = Array.isArray(p.motifs)
        ? p.motifs.reduce((m, name) => m | (1 << (TRUCHET_MOTIFS[name] ?? 0)), 0)
        : (p.motifs ?? 0);
      return (
        `truchet?n=${p.n ?? 4}&spacing=${p.spacing ?? 3}` +
        `&angle=${p.angle ?? 45}&seed=${p.seed ?? 42}&motifs=${mask}`
      );
    }

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
      return `cur?run=${p.run_ma ?? 300}&hold=${p.hold_ma ?? 100}`;

    default:
      throw new Error(`Unknown command type: ${p.type}`);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
