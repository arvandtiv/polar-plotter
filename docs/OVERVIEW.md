# Polar Plotter — The Whole Thing, in One Read

A friendly tour of the entire product: what the machine is, how it draws, the three
ways you drive it, and the generative "Studio" engine that turns ideas into ink. Read
top to bottom and you'll understand how every part fits together.

> Want the gritty hardware/bring-up lessons? See [`CLAUDE.md`](../CLAUDE.md).
> Want the per-stage Studio build history? See [`docs/v1.3/`](v1.3/README.md).

---

## 1. What it is (the 30-second version)

A **hanging V-plotter** (a "polargraph"): two motors sit at the top corners of a wall
and suspend a **pen gondola** from two GT2 belts. Shortening one belt and lengthening
the other moves the pen anywhere in the triangle between them. A little servo lifts and
drops the pen.

The clever part: **all the geometry runs on the microcontroller.** You say "draw a line
to (x, y) in millimetres" and the board itself works out how long each belt must be,
moves both motors so they arrive *at the same instant*, and streams smooth curves. There
is **no PC in the loop while it's drawing.**

```
   motor A  ●───────span───────●  motor B      origin (0,0) = midpoint, near the top
            \                 /                 +x = right,  +y = DOWN (screen-style)
             \ beltA   beltB /
              \             /
               \           /
                ●  gondola + pen
```

---

## 2. The mental model: one queue, three doorways

Everything that draws goes through **one job queue** owned by **one task** (`web_draw_task`).
Three "doorways" can push jobs onto that queue, but only that one task ever touches the
motors — so commands never collide mid-move.

```
 ┌─ USB serial console ─┐
 ├─ WiFi web console ────┤──▶  draw queue  ──▶  web_draw_task  ──▶  motors + pen
 └─ MCP server (Claude) ─┘        (256 deep)     (the only motor owner)
```

| Doorway | What it's for |
|---------|---------------|
| 🖥️ **USB-serial console** | Bring-up, calibration, single commands. Only needed for flashing + first setup. |
| 🌐 **WiFi HTTP API + web console** | The everyday surface — an Astro/React app talking HTTP + live SSE. |
| 🤖 **MCP server** | Lets **Claude** paint autonomously, using the same generators as the console. |

> ⚠️ The console and WiFi/MCP share the motors with **no lock** — don't drive from the
> serial console *and* over WiFi at the same time.

---

## 3. How a drawing actually happens

### Step A — Geometry (the firmware's job)
`kinematics.h` is pure, host-testable math that converts **(x, y) millimetres ↔ belt
lengths ↔ motor microsteps**. Key numbers for this build:

- **steps/mm = 1280** (200 full steps × 256 microsteps ÷ 40 mm-per-rev).
- **Motor span** ≈ 985 mm; **home belt length** = 700 mm (measured with the gondola
  parked at the midpoint — one tape measurement defines "home").
- Origin `(0,0)` is the **midpoint between the motors**, near the top. **+y points down.**

### Step B — Coordinated, streamed motion
- **Coordinated moves:** both motors are told to finish *simultaneously* by scaling the
  shorter move's ramp — so the belts never desync and lines stay straight-ish.
- **Streaming with look-ahead:** straight edges are chopped into small sub-segments and
  fed to the driver continuously, so the pen *flows* through a path and only truly stops
  at corners (instead of stuttering at every sub-point).
- The TMC5072 driver has a built-in **sixPoint ramp generator**: the firmware just writes
  a target position and the chip accelerates/cruises/decelerates there itself.

### Step C — The work area
The drawable region is a **rectangle** *or* the **ellipse inscribed in it** (handy for
machines whose reachable height tapers at the left/right extremes). Targets outside the
area are rejected; strays are clipped back onto the boundary. `border` traces the active
edge so you can see exactly where the machine thinks the limit is.

The work area boots from a compiled default (`board_config.h`), but a deliberate set
(`plot_set_bounds`, the console Work Area tab, or serial `setbounds`) is **saved to a flash
sector and restored on boot** — so a calibrated area survives reboots/power-cycles. (Grid
cell bounds are transient and never persisted.)

---

## 4. The firmware primitives

The lowest-level vocabulary every doorway shares:

`goto` · `line` · `arc` · `circle` · `square` · `wobbly` (random closed blob) ·
`truchet` (winged-tile tiling) · `bullseye` / `grid` / `border` (calibration aids) ·
`pen` · `home` · `sethome`.

Plus **fills** (none · hatch · concentric), optional **outline**, and a `cycles` count to
re-trace a stroke and darken a faint pen.

---

## 5. The Studio — turning ideas into toolpaths

The Studio is the **generative design engine** (a full-page mode in the web console, and
also available to the MCP). It's built around **one tiny idea** that makes everything
compose cleanly.

### The one idea: a `Frame`
A **Frame** is just a page size plus a list of polylines, in millimetres, in the
plotter's coordinates. That's it. Every feature — shapes, patterns, text, images,
imported G-code — produces a Frame, and everything downstream operates on Frames.

```ts
interface Pt    { x: number; y: number }
interface Path  { points: Pt[]; closed?: boolean; cycles?: number }
interface Frame { widthMm: number; heightMm: number; paths: Path[] }
```

### The pipeline (the single funnel)
```
 generate(params) ─▶ Frame ─▶ simplify + optimise ─▶ compile ─▶ pen/goto/line/arc ─▶ firmware
                      ▲
        modify(params, { lowerFrame })   ← modifiers read the layer beneath them
```

1. **Generate** — a *make* module produces paths (Spirograph, Noise Orbit, Random Walker…).
2. **Modify** — a *modify* module transforms the stack beneath it (Warp ripples it, Mask
   clips it to a shape, Fill hatches its closed areas). Layers stack non-destructively.
3. **Optimise** — `simplifyFrame` (RDP) drops redundant points; `optimizeOrder` reorders
   strokes for the least pen-up travel.
4. **Compile** — turns the Frame into the firmware's own `goto`/`line`/`arc`/`pen`
   queries; circular runs can collapse into native `arc` moves (arc-fitting).
5. **Stream** — `streamQueries` paces the queries against the board's live queue depth,
   **batches** them (≈80× fewer connections) and **retries** transient network hiccups.

### Why it's extensible: the module contract
Every generator/modifier is a **pure, self-describing object** registered on import. Its
parameters are *data* (`{ key, type:'range', min, max, default, … }`), so the UI builds
itself and the MCP can discover every knob automatically — no hardcoding.

```ts
register('spirograph', {
  key: 'spirograph', label: 'Spirograph', kind: 'make',
  sections: [{ title: 'Gears', fields: [
    { key: 'R', type: 'range', min: 10, max: 200, default: 80, unit: 'mm' }, … ] }],
  generate(params, ctx) { /* pure → returns a Frame */ },
});
```

Because `generate` is pure (no DOM, no React), the **same engine runs in the browser and
inside the Node MCP server** — `console/src/lib/mcp-core.ts` bundles it to `core.js`. New
generators added for the console appear in the MCP automatically.

### The Studio file map (all under `console/src/lib/`)
| File | Role |
|------|------|
| `frame.ts` | the `Frame`/`Path`/`Pt` types + helpers |
| `registry.ts` | the module contract + `register`/`listModules`/`defaultsOf` |
| `modules/*.ts` | the generators & modifiers (each registers itself; `index.ts` imports all) |
| `geom.ts` | pure geometry: resample, fit-to-bounds, affine, bezier, seeded RNG, RDP |
| `clip.ts` | `clipPolylineToPolygon` — clip strokes to a region (keeps inside runs) |
| `arcfit.ts` | collapse circular runs into native `arc` primitives |
| `strokefont.ts` | built-in single-stroke vector font for Text (no font file) |
| `pipeline.ts` | `evaluate(layers)` — runs the layer stack bottom→top |
| `toolpath.ts` | `simplifyFrame`, `optimizeOrder` (travel), progress scrubber |
| `compile.ts` | `Frame → firmware query strings` (with optional bounds-clipping + arc-fit) |
| `runPipeline.ts` | the shared compile entry used by **both** the console and the MCP |

### Generator library (today)
Spirograph · Orbital Weave · Noise Orbit · Random Walker · Noised Hatches · Sheets ·
Moiré Curtain · Pattern Maker · Wobbly · Stroke Text · Image → Linework / Halftone /
Squiggle / Surface · basic Box / Circle / Square.
**Modifiers:** Warp (water ripple / radial droplet) · Mask (clip to a shape) · Fill (hatch).

---

## 6. Grids & "fit-in-bounds" (keeping generative art tidy)

**Grid tiling** subdivides the work area into `cols × rows` cells (with padding) and
remaps coordinates so each cell has its own local origin at `(0,0)`. You draw a different
generator into each cell — `grid_select` activates a cell, `grid_clear` restores the full
canvas.

When a generator's art **spills past the cell edge**, two safety nets apply:

1. **Clipping (always):** the spill is drawn **pen-up** outside the cell and **pen-down**
   again when the path re-enters — it never drags ink along the boundary.
2. **Reseeding (opt-in, `fit_in_bounds`):** noise generators wander unpredictably, so you
   can ask the MCP to **retry the generator's random seed** until one fits *entirely*
   inside the cell. The first fitting seed is used; if none of `max_seeds` (default 2000)
   fit, the last attempt is drawn clipped and the run reports **how many cells couldn't
   fit** — your cue to shrink the shape or use fewer cells.

---

## 7. Bringing in outside artwork

| Path | What it does |
|------|--------------|
| 📥 **G-code digester** | Paste or upload `.gcode` / binary `.bgcode`; it translates to `goto`/`line`/`pen` *entirely in the browser*. Z/E/F are dropped (a plotter is just X/Y + pen); G2/G3 arcs are tessellated then re-fit to native `arc` moves. Pen up/down and placement (auto-fit + center + Y-flip) are selectable. |
| 📋 **JSON Script** | Paste a list of commands — every firmware primitive, mid-script config (`bounds`/`matrix`/`speed`/…), `generate` (any Studio generator), and `grid_select`/`grid_clear` for tiled compositions. |
| 🔁 **Affine warp** | An optional 2×3 matrix applied to the logical coords *before* the belt math — for exploring rotation/shear/scale/offset. Session-only, resets to identity on boot. (Linear, so it can't fix the line-bow.) |

---

## 8. Safety, health & "it just keeps going"

- 🛑 **Hardware E-STOP** — a physical button (`GP14`→GND) fires an interrupt that **brakes
  the motors hard** then cuts their power, independent of WiFi/firmware. Latches off until
  you clear the fault; **re-home after.**
- 🩺 **Driver-fault supervision** — the motion task watches the TMC's status for *real*
  faults (over-temp, coil short, undervoltage), halts the job, and surfaces the flags;
  `clear fault` re-enables once you've fixed the cause. Harmless standstill false-positives
  are masked out.
- 🛟 **Self-healing config** — the Pico has *no RESET button*. If the driver is power-cycled
  out from under it, the draw task notices the wiped config and re-applies it before the
  next job.
- 🚦 **Flow-controlled streaming** — big scripts are paced against the live queue depth so a
  400-command stack never overflows the 256-job queue. A **progress watchdog + heartbeat**
  turns a stalled board/link into a *logged, specific error* (E-STOP / driver fault /
  no-motion / lost contact) instead of a silent hang, and every HTTP call now times out so
  a wedged connection can't freeze the run.
- 📊 **Observability** — `/api/status` reports queue health (pending / capacity / rejected /
  peak), driver state, and pause/E-STOP flags; `/events` is a multi-client SSE stream of
  the live log + pen position.

---

## 9. Hardware at a glance

| Part | Role |
|------|------|
| Raspberry Pi **Pico 2 W** (RP2350) | MCU — WiFi, USB, FreeRTOS. **BOOTSEL only, no RESET.** |
| **TMC5072-BOB** | Dual stepper controller/driver with integrated sixPoint ramp generator (SPI) |
| **SG90** servo | Pen lift (up = 50°, down = 70°) |
| GT2 belt + 20-tooth pulley | Drive train — 40 mm / motor-rev |
| 12 V / 2 A supply | Motor power (run current kept low — pen needs little torque, heat is the enemy) |

SPI is wired **direct** (no optocoupler), VCCIO = 3.3 V, shared ground, and `CLK16` tied
to GND. Full wiring → [`polar_plotter_wiring.md`](../polar_plotter_wiring.md);
Pico bring-up notes → [`PICO2W.md`](../PICO2W.md).

---

## 10. Where the code lives

```
main/
  main.c          app_main + bring-up + serial console + draw helpers + web_draw_task
  web_server.c    HTTP API + multi-client SSE (owns the FreeRTOS draw queue)
  kinematics.h    pure (x,y) mm ↔ microstep math (host-testable)
  board_config.h  every pin + tuning constant in one place
components/
  tmc5072/        register-level SPI driver (no Arduino dependency)
  servo/          SG90 via PWM
console/          Astro + React + Tailwind web UI  (npm run dev → :4321)
  src/lib/        the Studio engine (Frame pipeline) + G-code/bgcode digesters
  src/lib/mcp-core.ts   bundles the engine for Node → plotter-mcp/core.js
plotter-mcp/      Node MCP server: the HTTP API + Studio pipeline as tools for Claude
tools/            host-runnable geometry test + pattern generators
```

### Quick builds & tests
```bash
# firmware (Pico)
cmake -B build -DPICO_BOARD=pico2_w && cmake --build build   # → build/main/polar_plotter.uf2
# flash: hold BOOTSEL, plug in USB (mounts as RPI-RP2), drop the .uf2 on it

# geometry dry-run (no hardware)
cc tools/kinematics_test/test_kinematics.c -o /tmp/ktest -lm && /tmp/ktest

# Studio / digester host tests (no hardware)
cd console && npx tsx test/digest.test.ts

# MCP server (rebuilds the shared core, then serves the tools)
cd plotter-mcp && npm start
```

---

## 11. The shortest possible recap

> **One `Frame` data type** flows through **one pipeline** (generate → optimise →
> compile → stream) into **one draw queue** owned by **one motor task** — and **three
> doorways** (serial, WiFi console, MCP) all feed it. The board does its own geometry, so
> drawing needs no PC. The Studio makes the art; grids + fit-in-bounds keep it tidy; the
> watchdog + E-STOP + self-heal keep it running.
