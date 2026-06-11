# Polar Plotter — Agent Operating Guide

You drive a **real, physical V‑plotter** (polargraph) through the `polar-plotter` MCP
tools. A pen‑holding gondola hangs from two toothed belts driven by stepper motors
at the top corners; a servo lifts and drops the pen. Every command you send moves
real hardware and lays down real ink. **Plan the whole drawing before you send it,
draw deliberately, and stay inside the work area.**

---

## 1. How the machine thinks

- **Coordinates are millimeters.** Origin `(0,0)` is the **midpoint between the two
  top motor anchors**.
- **Axes:** `X+` is **right**, `Y+` is **DOWN** (toward the floor). This is screen
  convention, not math convention — a larger `y` is *lower* on the wall. A house roof
  is at *smaller* `y` than its floor.
- **The machine is slow and physical.** Moves take real time. There is no undo. Ink
  is permanent. Favor getting it right over getting it fast.
- **One job at a time, in order.** Commands run sequentially; each finishes before the
  next begins. Use `plot_script` to send a whole painting as one ordered list.

## 2. Work area & limits — stay inside

The drawable rectangle is set on the device (console `setbounds` / web UI). Call
`plot_status` to read the **current** limits live (don't assume the defaults). They default to:

| Axis | Min | Max | Span |
|------|-----|-----|------|
| X    | −240 mm | +240 mm | 480 mm wide |
| Y    | −200 mm | +200 mm | 400 mm tall |

Rules:
- **Keep a margin.** Aim to stay ~20 mm inside every edge. Belt geometry is least
  accurate near the very top (small/negative `y`, close to the anchors) — prefer the
  middle band, roughly `y` from `-120` to `+150`.
- A target outside the work area is **rejected** (the firmware returns an error and
  draws nothing). If a command comes back as an error, your shape was too big or
  off‑canvas — shrink it or move its center, don't retry blindly.
- A **shape's full extent** must fit, not just its center: a circle needs
  `cx ± r` and `cy ± r` inside; a square needs `± size/2`.

## 3. Before drawing — setup checklist

1. **Origin must be set.** The machine only knows where `(0,0)` is after a human has
   physically parked the gondola at the midpoint and run `sethome`. If you're unsure
   whether this session is homed, ask the operator rather than assuming. `plot_home`
   only returns to the *current* origin — it does not establish one.
2. **Pen starts up.** Call `plot_pen("up")` if in doubt before any travel.
3. **Sane motion settings** (optional): `plot_set_speed` ~150000–200000 for normal
   work, lower (~80000) for fine detail. `plot_set_current` run ≤ **600 mA** (shared
   12 V/2 A supply — never exceed), hold ~150–200 mA.

## 4. The tools

### Movement & pen
| Tool | Use it to | Key params |
|------|-----------|-----------|
| `plot_goto` | Move the pen to `(x,y)` **without managing the pen** — it does not lift/drop. Use for repositioning. | `x, y` |
| `plot_pen` | Lift or lower the pen. | `position: "up" \| "down"` |
| `plot_home` | Return to origin (lifts pen first). | — |
| `plot_sethome` | Define the current spot as `(0,0)`. Operator/setup only. | — |
| `plot_stop` / `plot_abort` | **Emergency stop / escape**: preempt the running job *mid-stroke*, flush the queue, stop motors, lift the pen. Use the instant anything looks wrong. | — |

### Drawing primitives (these manage the pen for you)
| Tool | Draws | Key params |
|------|-------|-----------|
| `plot_line` | Straight line `(x0,y0)→(x1,y1)`. Auto lifts to start, lowers, draws. | `x0,y0,x1,y1, cycles` |
| `plot_circle` | Circle. `fill_mode` 0=outline, 1=hatch, 2=concentric rings. | `cx,cy,r, cycles, fill_mode, hatch_angle, spacing, outline` |
| `plot_square` | Axis‑aligned square, same fill options as circle. | `cx,cy,size, cycles, fill_mode, hatch_angle, spacing, outline` |
| `plot_wobbly` | Closed organic "blob" via a radial Fourier series — great for clouds, foliage, abstract forms. | `cx,cy,r, bound_r, wobble(0–1), harmonics(1–8), seed, cycles` |
| `plot_truchet` | Multi-scale Truchet tiling (Carlson 2018): quarter-circle arcs over a recursive grid — intricate, fills large areas in one call. | `cx,cy, tile_size(≥20), depth(0–4), seed` |
| `plot_bullseye` | Calibration crosshair + rings at a point. | `cx, cy` |
| `plot_grid` | Calibration grid: 10×10 lines, 8 mm apart, 100 mm long (spans `cx±50, cy±50`). Checks straightness/squareness. | `cx, cy` |
| `plot_border` | Trace the work-area boundary once (pen down). Draws exactly what the firmware thinks is the edge — useful for confirming the canvas limits before a plot. | — |

### Status & settings
- `plot_status` — reports the **work-area bounds**, live pen position, and the job
  queue (enqueued / current / done / pending, idle flag). Call it to confirm the
  dimension limits before planning, or to see how far a batch has progressed.
- `plot_set_speed(vmax)`, `plot_set_accel(amax)`, `plot_set_current(run_ma, hold_ma)`.

> **Every tool waits for completion.** A drawing call does not return until the
> plotter has *physically finished* that move (it polls the job status internally).
> So you never need to add your own delays — when a tool returns `ok`, the ink is
> down. An out-of-bounds target returns an error and draws nothing.

### Batch — your main tool
`plot_script(commands[], stop_on_error=true)` runs an **ordered list** of command
objects, one after another, waiting for each. This is how you paint. `commands` is a
JSON array — each element is `{ "type": "...", ...params }`. Supported `type`s:
`goto, line, circle, square, wobbly, truchet, bullseye, grid, border, pen, home,
sethome, stop, speed, accel, current`. Each step waits until the plotter physically
finishes it before the next begins, and the script halts if any step errors (e.g.
out of bounds) or an escape fires.

```json
[
  { "type": "pen",     "position": "up" },
  { "type": "goto",    "x": -50, "y": 0 },
  { "type": "line",    "x0": -50, "y0": 0, "x1": 50, "y1": 0, "cycles": 2 },
  { "type": "circle",  "cx": 0, "cy": 100, "r": 60, "fill_mode": 2, "spacing": 4 },
  { "type": "wobbly",  "cx": -120, "cy": -80, "r": 50, "wobble": 0.5, "harmonics": 4, "seed": 7 },
  { "type": "truchet", "cx": 0, "cy": 0, "tile_size": 60, "depth": 2, "seed": 42 },
  { "type": "home" }
]
```

> **Console Script tab interop.** The web console has a Script tab that accepts the
> same JSON array pasted directly into a textarea and queues all commands in one go.
> You can generate a script here, copy the array, and paste it there — or vice versa.

## 5. Pen discipline (the #1 source of mistakes)

- **Drawing tools handle their own pen.** `plot_line`, `plot_circle`, `plot_square`,
  `plot_wobbly` lift to the start, lower, draw, and lift again. You don't pen‑manage
  around them.
- **`plot_goto` does NOT.** It moves with whatever pen state is current. To reposition
  without a stray ink trail: `pen up → goto → (pen down if you're about to draw)`.
- When hand‑composing strokes with `goto`, the pattern is always:
  `pen up → goto start → pen down → goto/line through points → pen up`.

## 6. Drawing strategy — make good paintings

- **Compose first.** Decide the full set of strokes and their coordinates before
  sending. Sketch the layout mentally in the Y‑down frame.
- **Prefer `plot_line` and the shape tools over chains of `plot_goto`.** They draw
  true straight/curved paths. (Plain `goto→goto` is for *travel*, not for drawing a
  visible line.)
- **Group by locality** to cut pen‑up travel time: finish everything in one area
  before moving across the canvas.
- **Darken with `cycles`.** A faint pen line becomes solid with `cycles: 2–3`. Use it
  for outlines you want bold.
- **Fills:** `fill_mode 1` (hatch, set `hatch_angle`/`spacing`) for shading;
  `fill_mode 2` (concentric) for solid‑ish disks/rings. Wider `spacing` = faster,
  lighter; tighter = darker, slower.
- **Scale to the canvas.** With ~480×400 mm usable, keep individual features
  ≥ 20–30 mm so they read clearly, and the whole composition within the margins.
- **Use `plot_wobbly`** for anything organic; vary `seed` for different shapes,
  `harmonics` for complexity (1≈soft blob, 8≈jagged), `wobble` for how far from a
  circle.
- **Use `plot_truchet`** to fill large areas with an intricate, self-similar tiling in
  a single call — great for backgrounds, texture fills, or abstract pages. `depth 0` =
  uniform flat grid; `depth 2–3` = Carlson-style multi-scale fractal look. Always
  check that the work area is fully set up before calling it (it covers the whole
  canvas). Change `seed` for a completely different pattern of the same character.

## 7. Caveats & gotchas

- **Lines can bow slightly** on a polargraph. Straight strokes are sub‑segmented to
  stay straight; if you see a curve where you wanted a line, report it — don't try to
  "correct" geometry yourself.
- **Negative/near‑top `y` is risky.** Geometry degrades close to the anchors. Keep
  important detail in the middle band.
- **Respect the current limit.** Never set `run_ma` above 600.
- **Errors mean "didn't draw."** If a tool returns an error (e.g. out of bounds),
  nothing was drawn — fix the coordinates, then resend just that part.
- **If anything is physically wrong** (gondola stuck, belt slip, drawing off‑canvas),
  call `plot_stop` immediately, then reassess.

## 8. Worked example — a simple house

Pass this array as `commands` to `plot_script` (or paste it into the console Script tab):

```json
[
  { "type": "pen",    "position": "up" },
  { "type": "square", "cx": 0,   "cy": 120, "size": 160, "cycles": 2 },
  { "type": "line",   "x0": -80, "y0": 40,  "x1": 0,   "y1": -30, "cycles": 2 },
  { "type": "line",   "x0": 0,   "y0": -30, "x1": 80,  "y1": 40,  "cycles": 2 },
  { "type": "square", "cx": 0,   "cy": 150, "size": 40 },
  { "type": "home" }
]
```

Walls are a square centered at `(0,120)`; the roof is two lines meeting at the apex
`(0,-30)` (remember: smaller `y` = higher on the wall); the door is a small square
near the bottom. `home` parks the gondola when finished.

---

## Appendix A — Every drawing method & variable, in detail

Units are millimeters and degrees throughout. "Default" is what the firmware uses if
you omit the field. Bold params are **required**.

### `plot_goto` — reposition the pen
Moves the gondola to a point. **Does not touch the pen** — whatever state the pen is in
(up or down) is preserved, so a `goto` with the pen down *draws a line* to the target.
Use it for travel (pen up) or to chain hand‑built strokes (pen down).

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| **`x`** | number | within bounds | — | Target X (right +) |
| **`y`** | number | within bounds | — | Target Y (down +) |

### `plot_line` — straight segment
Draws `(x0,y0) → (x1,y1)`. **Self‑manages the pen:** lifts, travels to the start,
lowers, draws the segment, lifts. The path is sub‑segmented internally so it stays
straight on the polargraph.

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| **`x0,y0`** | number | within bounds | — | Start point |
| **`x1,y1`** | number | within bounds | — | End point |
| `cycles` | int | ≥ 1 | 1 | How many times to retrace the segment. Each extra pass reverses direction (no pen‑up between passes) to **darken** a faint line. |

### `plot_circle` — circle, optionally filled
Outline and/or fill centered on `(cx,cy)`. The number of chord segments is chosen
automatically so the curve looks round.

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| **`cx,cy`** | number | center; `cx±r`, `cy±r` must fit | — | Center |
| **`r`** | number | > 0 | — | Radius |
| `cycles` | int | ≥ 1 | 1 | Outline retrace passes (darken). |
| `fill_mode` | int | 0–2 | 0 | **0** = outline only · **1** = hatch (parallel lines) · **2** = concentric (nested shrinking rings). |
| `hatch_angle` | number | any deg | 0 | Direction of the hatch lines, degrees (0 = horizontal). Only affects `fill_mode 1`. |
| `spacing` | number | > 0 | 3 | Gap between hatch lines / concentric rings (mm). Smaller = denser & darker & slower. |
| `outline` | bool | — | true | Draw the perimeter. Set **false** with `fill_mode 1/2` for a fill with no outline. |

### `plot_square` — axis‑aligned square, optionally filled
Same fill model as the circle. `size` is the **full side length**, so the square spans
`cx ± size/2`, `cy ± size/2`.

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| **`cx,cy`** | number | `cx±size/2`, `cy±size/2` must fit | — | Center |
| **`size`** | number | > 0 | — | Side length (full width, not half) |
| `cycles` | int | ≥ 1 | 1 | Outline retrace passes (darken). |
| `fill_mode` | int | 0–2 | 0 | 0 = outline · 1 = hatch · 2 = concentric (nested squares). |
| `hatch_angle` | number | any deg | 0 | Hatch line direction (deg). `fill_mode 1` only. |
| `spacing` | number | > 0 | 3 | Hatch / ring gap (mm). |
| `outline` | bool | — | true | Draw the perimeter; false = fill‑only. |

### `plot_wobbly` — organic closed curve
A closed loop whose radius varies with angle as a random Fourier series:
`r(θ) = r + Σ_{h=1..harmonics} amp_h · sin(h·θ + phase_h)`, with amplitudes falling off
as `1/h` (low harmonics dominate → natural shape). Radius is clamped to `[5% of r,
bound_r]`. Great for clouds, foliage, rocks, abstract blobs.

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| **`cx,cy`** | number | `cx±bound_r`, `cy±bound_r` must fit | — | Center |
| **`r`** | number | > 0 | — | Base radius the shape varies around. |
| `bound_r` | number | ≥ 0 | 0 → `r×1.5` | Hard outer limit — no point exceeds this radius. `0` means "use `r × 1.5`". |
| `wobble` | number | 0.0–1.0 | 0.4 | Distortion amount. **0.0 = perfect circle**, 1.0 = maximum randomness. |
| `harmonics` | int | 1–8 | 3 | Shape complexity. 1 = gentle blob, 8 = complex/jagged. |
| `seed` | int | ≥ 0 | 42 | Random seed. **Same seed + same params = identical shape** every time, so you can reproduce or vary deliberately. |
| `cycles` | int | ≥ 1 | 1 | Retrace passes (darken). |

Quick recipes: `wobble 0.2, harmonics 2` = soft pebble · `0.5, 4` = leaf/cloud ·
`0.9, 7` = spiky burst. Change only `seed` to get a different shape of the same character.

### `plot_truchet` — multi-scale Truchet tiling
Covers the work area with a grid of `tile_size × tile_size` mm cells. Each cell either
draws two quarter-circle arcs connecting edge midpoints (a Truchet tile), or recursively
splits into four half-size cells — controlled by `depth` and a random coin flip (seeded
by `seed`). The two arcs per tile connect opposite edge midpoints: one orientation links
top↔left and bottom↔right; the other links top↔right and bottom↔left. Adjacent tiles
share edge-midpoint endpoints, so arcs from neighbouring cells chain into flowing curves
across the canvas.

`depth 0` = flat uniform grid (50% chance of each orientation, no subdivision). Higher
depth = more recursion → finer detail nested inside coarser cells (Carlson 2018 style).
Minimum drawable tile size is 20 mm (set by firmware; `tile_size` below this is clamped).

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| `cx,cy` | number | any | 0, 0 | Origin of the tiling grid (grid aligns to multiples of `tile_size` from this point). |
| `tile_size` | number | ≥ 20 | 60 | Base cell size in mm. |
| `depth` | int | 0–4 | 2 | Maximum subdivision depth. 0 = flat; 2–3 = visually fractal. |
| `seed` | int | ≥ 0 | 42 | Random seed. Same seed + same params = identical pattern. |

Quick recipes: `tile_size 80, depth 0` = simple uniform Truchet · `tile_size 60, depth 2`
= standard multi-scale · `tile_size 40, depth 3, seed 7` = very dense fractal page-fill.

### `plot_border` — trace the work-area boundary
Draws the work-area limit path exactly once, pen down. Follows whatever the firmware
currently has set as the active shape (rectangle edges, or the inscribed-ellipse
perimeter). Use it to confirm the firmware's idea of the canvas edges before committing
to a full plot — if the border lands where you expect on the paper, the bounds are right.

No parameters.

### `plot_bullseye` — calibration target
Crosshair + concentric rings at a point. Use to check that a commanded coordinate
lands where you expect physically. Not an artistic tool.

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| `cx,cy` | number | within bounds | 0, 0 | Center of the target. |

### `plot_grid` — calibration grid
A 10×10 lattice of lines, 8 mm apart and 100 mm long, centered on `(cx,cy)` (so it
spans `cx±50, cy±50`). Use it to check that lines stay straight, spacing is even, and
the axes are square across the work area. Not an artistic tool.

| Var | Type | Range | Default | Meaning |
|-----|------|-------|---------|---------|
| `cx,cy` | number | `cx±50`, `cy±50` must fit | 0, 0 | Center of the grid. |

### Motion / hardware settings (not drawing, but they shape the result)

| Tool | Var | Range | Default | Meaning |
|------|-----|-------|---------|---------|
| `plot_set_speed` | `vmax` | 10000–400000 | 200000 | Max speed (microsteps/s). Lower for fine detail or if the gondola skips. |
| `plot_set_accel` | `amax` | 50–2000 | 500 | Acceleration (microsteps/s²). Lower = smoother starts/stops, longer ramps. |
| `plot_set_current` | `run_ma` | 100–800 (**keep ≤ 600**) | 600 | Coil current while moving. Too low = skipped steps; too high = heat. |
| `plot_set_current` | `hold_ma` | 0–400 | 200 | Coil current at standstill. |

### Cross‑cutting variable notes
- **`cycles`** exists on every stroke/shape: it retraces *in place* to darken. It does
  **not** scale or offset anything — purely ink density. 2–3 makes an outline bold.
- **`fill_mode` + `outline`** combine: `outline:true, fill_mode:0` = just the edge;
  `outline:true, fill_mode:2` = edge plus inner rings; `outline:false, fill_mode:1` =
  shaded interior with no border.
- **`spacing`** trades speed for darkness: every halving roughly doubles draw time and
  ink coverage.
- **Coordinates are always the shape's geometry**, never pen state — pen handling is
  automatic for `line/circle/square/wobbly/bullseye` and manual for `goto`.

---

> **Requires the matching firmware** (flash the build that adds `/api/status`,
> `/api/abort`, job IDs, and bounds rejection). With it, `plot_status` /
> `plot_abort` / `plot_grid` work, every tool waits for true completion, and
> out-of-bounds targets are rejected. On older firmware those three tools and the
> wait-till-done behavior won't respond — reflash first.
