# Polar Plotter — Agent Operating Guide

You drive a **real, physical V-plotter** (polargraph) through the `polar-plotter` MCP
tools. A pen-holding gondola hangs from two toothed belts driven by stepper motors at
the top corners; a servo lifts and drops the pen. Every command you send moves real
hardware and lays down real ink. **Plan before you send. Draw deliberately. Stay inside
the work area.**

---

## 1. How the machine thinks

- **Coordinates are millimeters.** Origin `(0,0)` is the **midpoint between the two
  top motor anchors**.
- **Axes:** `X+` = right, `X-` = left. `Y+` = **DOWN** (toward the floor), `Y-` = **UP**
  (toward the anchors). This is screen convention, not math: larger `y` is **lower** on
  the wall, smaller/more-negative `y` is **higher**.
  - To move the pen **up**, DECREASE `y`.
  - To move the pen **down**, INCREASE `y`.
  - A house roof sits at *smaller* `y` than its floor.
- **One job at a time, in order.** Each command waits until the plotter physically
  finishes before the next begins. Use `plot_script` or `plot_generate` to send whole
  paintings in one call.
- **Ink is permanent. There is no undo.** Plan the full drawing before sending.

---

## 2. Work area — know your bounds before every session

The drawable area is set on the device. **Always call `plot_status` first** to read the
live bounds — do not assume defaults.

```
plot_status → returns, e.g.:
  work area (rectangle):
    x: -240 (left) .. 240 (right) mm
    y: -110 (top/up) .. 300 (bottom/down) mm   [Y+ = DOWN]
```

Rules:
- **Keep a ~20 mm margin** inside every edge. Belt geometry is least accurate near the
  very top (small/negative `y`, close to the anchors) — prefer the middle band.
- A target **outside the work area is rejected** (firmware returns error, nothing drawn).
  Fix coordinates and resend — don't retry blindly.
- A **shape's full extent** must fit, not just its centre:
  - circle: `cx ± r` and `cy ± r` inside
  - square: `cx ± size/2` and `cy ± size/2` inside
- If `bounds.ellipse` is true, the usable area is the **ellipse inscribed** in the box,
  not the full rectangle — stay well away from the corners.
- `plot_border` traces the active boundary pen-down — use it to confirm the canvas
  before starting a large plot.

---

## 3. Setup checklist

1. **Origin must be set.** The machine only knows where `(0,0)` is after a human has
   physically parked the gondola at the midpoint and run `sethome`. Ask the operator
   before assuming. `plot_home` returns to the *current* origin — it doesn't establish one.
2. **Pen starts up.** Call `plot_pen("up")` before any travel if in doubt.
3. **Sane motion** (optional): speed ~150000–200000 for normal; ~80000 for fine detail.
   Current ≤ 600 mA run (shared 12 V/2 A supply — hard cap).

---

## 4. Tool reference

### 4.1 Movement & pen control

| Tool | What it does | Key params |
|------|-------------|-----------|
| `plot_goto` | Move to `(x,y)` **without touching the pen state**. Use for travel. | `x, y` |
| `plot_pen` | Lift or lower the pen. | `position: "up" \| "down"` |
| `plot_home` | Return to origin (lifts pen first). | — |
| `plot_sethome` | Define current spot as `(0,0)`. Operator/setup only. | — |
| `plot_stop` | **Preempt and flush** the running job + queue. Use when anything looks wrong. Discards pending work. | — |
| `plot_abort` | Same as stop — alias. | — |
| `plot_pause` | **Hold without losing queue**: finishes the current job, parks pen-up, keeps all pending. | — |
| `plot_resume` | Continue after a pause. | — |

**Pen discipline:**
- Drawing tools (`plot_line`, `plot_circle`, etc.) **manage the pen themselves** — they lift to start, drop, draw, lift. Don't add extra pen calls around them.
- `plot_goto` does **not** touch the pen. Travel pattern: `pen up → goto → (pen down if drawing)`.
- When building strokes manually: `pen up → goto start → pen down → goto/line through points → pen up`.

### 4.2 Firmware drawing primitives (pen managed automatically)

| Tool | Draws | Key params |
|------|-------|-----------|
| `plot_line` | Straight segment `(x0,y0)→(x1,y1)`. Sub-segmented internally to stay straight on the polargraph. | `x0,y0,x1,y1, cycles` |
| `plot_arc` | Single arc — part of a circle. Sweep from `a0` to `a1` (radians, 0=east, CW since Y+↓). `lift=false` chains arcs without raising the pen. | `cx,cy,r, a0,a1, cw, cycles, lift` |
| `plot_circle` | Circle, optionally filled. | `cx,cy,r, cycles, fill_mode(0-2), hatch_angle, spacing, outline` |
| `plot_square` | Axis-aligned square, same fill options. `size` = full side length. | `cx,cy,size, cycles, fill_mode, hatch_angle, spacing, outline` |
| `plot_wobbly` | Organic blob via radial Fourier series — great for clouds, foliage, rocks. | `cx,cy,r, bound_r, wobble(0-1), harmonics(1-8), seed, cycles` |
| `plot_truchet` | Full-canvas Truchet tiling (Carlson 2018). White ribbon motifs through a hatched field. | `n, spacing, angle, seed, motifs[]` |
| `plot_bullseye` | Calibration crosshair + rings at a point. | `cx, cy` |
| `plot_grid` | Calibration grid — 10×10 lines, 8 mm spacing, centred on `(cx,cy)`. | `cx, cy` |
| `plot_border` | Trace the work-area boundary once pen-down. | — |

**Fill mode** (circle / square): `0` = outline only, `1` = hatch lines, `2` = concentric rings.
**cycles** darkens by retracing in place — 2–3 makes a bold line. It does not scale or offset.

### 4.3 Generative tools (high-level, compute & send in one call)

These are the most powerful tools for autonomous painting.

#### `plot_list_generators`
Returns a JSON list of all built-in generators with key, label, description, and param names.
**Call this first** before `plot_generate` to browse what's available.

#### `plot_generate`
Run a named generator, compile its output to firmware commands, and dispatch everything.
The generator uses the current work area bounds (read automatically from firmware).
Out-of-bounds paths are **clipped** at the boundary: the inside parts draw, and where the
path leaves the area the pen lifts and drops again when it re-enters — it never drags ink
along the edge (no boundary-walk).

```json
{
  "generator": "spirograph",
  "params": { "R": 80, "r": 30, "d": 50 },
  "warp_mode": "none"
}
```

Optionally apply a warp modifier after generation:
- `warp_mode: "water"` — sinusoidal X/Y ripple (wavy distortion over the whole frame)
- `warp_mode: "droplet"` — radial rings from a centre (like a stone dropped in water)

```json
{
  "generator": "randomWalker",
  "params": { "count": 30, "flowAngle": 90 },
  "warp_mode": "water",
  "warp_params": { "amplitude": 12, "wavelength": 80 }
}
```

##### Fit-in-bounds (auto-reseed) — `fit_in_bounds`
Some generators (especially the noise-driven ones: `noiseOrbit`, `noisedHatches`,
`randomWalker`, `sheets`) wander and **spill outside the area** for some seeds. Set
`fit_in_bounds: true` to make `plot_generate` **retry the generator's `seed`** until its
art fits *entirely* inside the current bounds, and draw the first seed that fits.

```json
{
  "generator": "noiseOrbit",
  "params": { "seed": 1, "rings": 6, "maxRadius": 70 },
  "fit_in_bounds": true,
  "max_seeds": 2000,
  "fit_tol_mm": 0
}
```

- `fit_in_bounds` (default **false**) — off = single pass (still clipped to pen-up gaps).
- `max_seeds` (default **2000**) — how many seeds to sweep before giving up.
- `fit_tol_mm` (default **0**) — allow this much overshoot before counting it a spill;
  raise it (e.g. `1`–`2`) to tolerate a tiny edge nick instead of rejecting the seed.
- The result text reports the outcome: `Fit: ✓ fits … at seed N (after K tries)`, or
  `Fit: ✗ NO seed in 2000 fit — drawn clipped` when nothing fits (then shrink the
  generator's radius/size params, raise `max_seeds`, or raise `fit_tol_mm`).
- Only generators that expose a `seed` param can be reseeded; others report `Fit: SKIPPED`.

#### `plot_polylines`
Send raw point arrays as firmware strokes — the lowest-level drawing primitive.
Use this when you compute shapes mathematically (see §5 Recipes).

```json
{
  "paths": [
    {
      "points": [{"x": 0, "y": 0}, {"x": 50, "y": 30}, {"x": -20, "y": 80}],
      "closed": false,
      "cycles": 1
    }
  ],
  "clip_to_bounds": true
}
```

With `clip_to_bounds: true` (default), segments that stray outside the work area are
trimmed — the surviving inside parts are drawn, the out-of-bounds parts silently dropped.
This makes `plot_polylines` safe even for spirals that naturally overshoot.

### 4.4 Status & settings

| Tool | What it returns / does |
|------|----------------------|
| `plot_status` | Work-area bounds, live pen position, job queue (enqueued/current/done/pending/idle), queue health (qcap, rejected, peak), driver state, paused/estop flags. **Read this first every session.** |
| `plot_set_speed(vmax)` | Max speed in microsteps/s. ~150000 normal, ~80000 fine detail. |
| `plot_set_accel(amax)` | Acceleration. Lower = smoother starts. |
| `plot_set_current(run_ma, hold_ma)` | Coil current. run ≤ 600 mA (hard limit). |
| `plot_set_matrix(a,b,c,d,tx,ty)` | Affine warp of the logical space. Session-only. Identity = (1,0,0,1,0,0). |
| `plot_set_bounds(xn,xp,yn,yp,ellipse)` | Set the work area on the firmware **and save it to flash** — it now survives reboots/power-cycles. (Grid cell bounds set by `plot_grid_select` are transient and are NOT persisted.) Set this once per machine; if `plot_status` ever shows the symmetric default (≈ ±240 × ±200), the saved area was never written or the layout magic changed — just call this again. |
| `plot_clear_fault` | Clear a latched driver fault or E-STOP latch. Re-home after E-STOP. |

### 4.5 Grid tiling — multiple cells in one session (§9 for full workflow)

| Tool | What it does |
|------|-------------|
| `plot_grid_plan(cols,rows,padding_mm,full_xn…yp)` | **Pure preview** — returns full cell layout (sizes, centres, all indices). No firmware call. Call this first. |
| `plot_grid_select(cols,rows,padding_mm,col,row,full_xn…yp)` | Activate a cell: sets bounds to ±cellW/2,±cellH/2 + matrix to cell centre. |
| `plot_grid_clear(full_xn,full_xp,full_yn,full_yp)` | Restore full work area + identity matrix. |

### 4.6 Batch script

`plot_script(commands[], stop_on_error=true)` — run an ordered list of commands sequentially.
Each draw command waits until physically done; configuration commands (`bounds`, `matrix`,
`grid_select`, `grid_clear`) execute immediately.

**Draw types:** `goto, line, arc, circle, square, wobbly, truchet, bullseye, grid, border, pen, home, sethome, stop, speed, accel, current`

**Config types (immediate, no queue):** `bounds, matrix, grid_select, grid_clear`

**Fit-in-bounds for `generate` steps:** put `"fit_in_bounds": true` in the document's
`metadata` to make **every** `generate` step reseed until its art fits inside the active
cell (same behaviour as `plot_generate`'s `fit_in_bounds`; tune with `metadata.max_seeds`
and `metadata.fit_tol_mm`). Override per step with `"fit": true/false`. At the end of the
run, `plot_script` prints a **summary of how many cells could not fit** even after all
seeds — e.g. `Fit: ✗ 7/100 cell(s) could NOT fit after 2000 seeds: (3,1), (4,4), …`. See §9.

---

## 5. Raw path recipes — `plot_polylines`

All formulas assume N points indexed `i = 0..N`, t = i/N or i/(N-1). Coordinates in mm.

### Archimedean spiral
Radius grows linearly from `rMin` to `rMax` over `turns` revolutions.
```
N = Math.ceil(2*π*rMax*turns / 2)   // ~2 mm per point
for i in 0..N:
  θ = 2π * turns * (i/N)
  r = rMin + (rMax - rMin) * (i/N)
  x = r * cos(θ),  y = r * sin(θ)
```
Example: `rMin=5, rMax=80, turns=8` → tight inward spiral, 80 mm outer radius.

### Lissajous figure
```
N = 500
for i in 0..N:
  t = 2π * (i/N)
  x = A * sin(a*t + δ)
  y = B * sin(b*t)
```
`a=3, b=2, δ=π/2` → classic 3:2 knot. `A=B=60` for a 60 mm half-width.
`a=5, b=4` → more complex knot. `δ=0` makes it symmetric; `δ=π/2` adds a 90° phase.

### Rose curve (polar)
```
k=3 → 3 petals (odd k); k=4 → 8 petals (even k → 2k petals)
N = 500
for i in 0..N:
  θ = 2π * (i/N)        // for even k; use π for odd k
  r = R * cos(k*θ)
  x = r * cos(θ),  y = r * sin(θ)
```

### Sine wave / banner line
```
N = 200
for i in 0..N:
  t = i/N
  x = xStart + t*(xEnd-xStart)
  y = cy + A * sin(2π * freq * t + phase)
```
`A=20 mm, freq=3` → 3 full waves across the banner. Stack several with different `cy`
and `phase` offsets for a layered wave pattern.

### Superellipse (Lamé curve)
```
for i in 0..N:
  θ = 2π * (i/N)
  x = a * sign(cos(θ)) * |cos(θ)|^(2/n)
  y = b * sign(sin(θ)) * |sin(θ)|^(2/n)
```
`n=2` → ellipse; `n=4` → rounded square; `n=∞` → rectangle; `n=0.5` → star.
`a, b` = half-widths. `sign(v) = v < 0 ? -1 : 1`.

### Epitrochoid / hypotrochoid (manual, if you need precise control)
Spirograph formula, outer gear:
```
base = R + r   (epi) or R - r (hypo)
k = base / r
for i in 0..N:
  t = 2π * turns * (i/N)
  x = base*cos(t) - d*cos(k*t)   (epi sign)
  y = base*sin(t) - d*sin(k*t)
```
(Use `plot_generate spirograph` instead — it computes turns automatically via gcd.)

### Concentric rings
```
for each R in [r1, r2, r3, ...]:
  N = Math.max(64, Math.ceil(2*π*R / 2))   // 2 mm per point
  points = [ {x: R*cos(2π*i/N), y: R*sin(2π*i/N)} for i in 0..N ]
  // close the ring: repeat first point at end
  send as one closed path
```

### Harmonograph / Lissajous decay
```
for i in 0..N:
  t = i * dt
  x = A*exp(-d1*t)*sin(f1*t + p1) + B*exp(-d2*t)*sin(f2*t + p2)
  y = C*exp(-d3*t)*sin(f3*t + p3) + D*exp(-d4*t)*sin(f4*t + p4)
```
Start with `d1=d2=d3=d4=0.001`, `f1≈f2≈f3≈f4≈1`, small prime offsets, `N=3000`.

---

## 6. Generator reference — `plot_generate`

### `spirograph`
A hypotrochoid (inner rolling gear) or epitrochoid (outer rolling gear) roulette curve —
the classic gear toy. Fully deterministic, no randomness.

The curve closes after `r / gcd(R,r)` full rotations of the rolling gear.
`R/r` ratio determines petal count; `d` (pen offset from gear centre) controls how
open or tight the loops are. `d = r` → the pen is at the gear rim (cusped petals).
`d > r` → loops overshoot and overlap.

| Param | Default | Meaning |
|-------|---------|---------|
| `R`   | 80      | Fixed gear radius (mm). |
| `r`   | 30      | Rolling gear radius (mm). Controls petal count via `gcd(R,r)`. |
| `d`   | 50      | Pen offset from the rolling gear centre. 0 = plain circle. |
| `type` | `"hypo"` | `"hypo"` (inner rolling) or `"epi"` (outer rolling). |
| `cx, cy` | 0, 0 | Centre position (mm). |
| `cycles` | 1    | Retrace passes (darken). |

Examples:
```
{ R:80, r:30, d:50 }              → 8-petal classic
{ R:80, r:50, d:50 }              → tight lobed star (gcd=10)
{ R:60, r:25, d:40 }              → 12-petal
{ R:80, r:3,  d:50 }              → fine star, many petals (gcd=1 → 3 turns)
{ R:80, r:40, d:80, type:"epi" }  → epitrochoid loops outside
```

### `orbitalWeave`
A single continuous trace: a small ellipse (the "loop") whose centre orbits in a big
circle, weaving harmonograph-style knots. Fully deterministic.

The curve closes when both `orbitTurns` and `traceTurns` are integers. The ratio
`orbitTurns / traceTurns` determines knot topology — large prime ratios produce airy
open weaves; small ratios close quickly. Making `majorRadius ≠ minorRadius` elongates
the inner loop into an ellipse.

| Param | Default | Meaning |
|-------|---------|---------|
| `orbitRadius` | 50 | Radius of the outer orbit (mm). |
| `orbitTurns`  | 1  | Full orbits the centre completes. |
| `majorRadius` | 24 | Inner loop major axis (mm). |
| `minorRadius` | 24 | Inner loop minor axis (mm). Equal → circle. |
| `traceTurns`  | 13 | Inner loop revolutions. Prime ratio with `orbitTurns` → complex. |
| `cx, cy`      | 0, 0 | Centre. |
| `cycles`      | 1  | Retrace. |

Examples:
```
{ orbitRadius:60, traceTurns:13 }                               → default 13-petal
{ orbitRadius:70, traceTurns:7 }                                → simpler 7-petal
{ orbitRadius:60, orbitTurns:2, traceTurns:17 }                 → double-orbit star
{ orbitRadius:50, majorRadius:35, minorRadius:10, traceTurns:9 }→ elongated loops
```

### `noiseOrbit`
Concentric N-sided polygons whose vertices are nudged outward by a 3D noise field,
then smoothed with Chaikin's algorithm. Multiple "layers" (different noise z-slices)
are stacked into a rich orbital texture. Great for atmospheric halos.

`nudge` = max noise displacement; higher = more distortion. Each `seed` gives a
completely different noise field. More `layers` = more strands at each ring radius.

| Param | Default | Meaning |
|-------|---------|---------|
| `numCircles` | 30  | Number of concentric rings per layer. |
| `minRadius`  | 10  | Innermost ring radius (mm). |
| `maxRadius`  | 100 | Outermost ring radius (mm). |
| `numSides`   | 20  | Polygon sides before Chaikin smoothing. |
| `chaikin`    | 4   | Smoothing iterations. 0 = polygon; 4 = smooth blob. |
| `nudge`      | 15  | Max noise displacement (mm). |
| `layers`     | 5   | Noise z-slices stacked. |
| `layerStep`  | 1.5 | Z-step between layers. Larger = more varied. |
| `seed`       | 42  | Noise seed. |
| `cx, cy`     | 0, 0 | Centre. |

Examples:
```
{ numCircles:30, maxRadius:100, nudge:15, layers:5 }  → default
{ numCircles:50, maxRadius:80,  nudge:5,  layers:1 }  → fine rings, subtle
{ numCircles:20, maxRadius:120, nudge:40, layers:8 }  → wild, heavily distorted
{ numCircles:30, maxRadius:100, seed:99 }              → different noise field
```

### `randomWalker`
Agents start along a line `(x1,y1)→(x2,y2)` and walk with a shared initial velocity
(`flowAngle`). Each step randomly perturbs the velocity by `±velStep`, clamped to
`±maxVel`. Paths stop when they leave the work area.

`flowAngle` drives the general drift: 0° = right, 90° = down, 180° = left, 270° = up.
Set `x1=x2, y1=y2` for a single origin point; a long start line creates sparser starts.

| Param | Default | Meaning |
|-------|---------|---------|
| `count`     | 20   | Number of walker agents. |
| `steps`     | 2000 | Max steps per walker. |
| `flowAngle` | 90   | Initial shared velocity direction (degrees). |
| `velStep`   | 0.5  | Random perturbation per step (mm). Higher = faster divergence. |
| `maxVel`    | 4    | Speed cap per step (mm). |
| `x1,y1`     | 0,0  | Start line endpoint 1. |
| `x2,y2`     | 0,0  | Start line endpoint 2. |
| `cycles`    | 1    | Retrace. |
| `seed`      | 42   | Random seed. |

Examples:
```
{ count:20, flowAngle:90, x1:-100, y1:-150, x2:100, y2:-150 }  → top-edge fan, downward
{ count:50, flowAngle:0,  x1:-200, y1:-80,  x2:-200, y2:80  }  → left-edge curtain, rightward
{ count:30, flowAngle:45 }                                      → origin, diagonal spread
{ count:10, maxVel:2, velStep:0.1 }                            → slow, tightly correlated
```

### `noisedHatches`
Divides a rectangle into a `gridN×gridN` grid. Each cell gets a short hatch line.
A noise-driven blob determines direction: cells inside hatch at `angleDeg`; cells outside
hatch at `angleDeg+90°`. Produces a two-tone texture with an organic boundary.

| Param | Default | Meaning |
|-------|---------|---------|
| `gridN`      | 30   | Grid density (cells per side). Higher = finer texture. |
| `angleDeg`   | 45   | Hatch angle inside the blob (degrees). |
| `blobRadius` | 80   | Base blob radius (mm). |
| `noiseScale` | 0.15 | Noise spatial frequency. Higher = bumpier boundary. |
| `w, h`       | 200, 200 | Canvas size (mm). |
| `cx, cy`     | 0, 0    | Centre. |
| `seed`       | 42   | Blob shape and position. |

Examples:
```
{ gridN:30, angleDeg:45, blobRadius:80, w:200, h:200 }  → default
{ gridN:50, angleDeg:0,  blobRadius:60, noiseScale:0.3 } → fine, bumpy blob
{ gridN:20, blobRadius:120 }                             → coarse, large blob
```

### `sheets`
Builds a `cols×rows` grid of randomly displaced points, groups them into columns, then
linearly interpolates `interpSteps` additional columns between each pair. Result: flowing
near-vertical curtain lines. The work area bounds determine the spread.

| Param | Default | Meaning |
|-------|---------|---------|
| `cols`        | 25 | Source column count. |
| `rows`        | 20 | Points per column. |
| `xJitter`     | 8  | Max horizontal displacement per grid point (mm). |
| `yJitter`     | 5  | Max vertical displacement per grid point (mm). |
| `interpSteps` | 9  | Interpolated columns between each source pair. More = denser. |
| `cx, cy`      | 0,0 | Offset of the whole field. |
| `seed`        | 42 | Random seed. |

### `moireCurtain`
Two parallel-line gratings at slightly different angles. Their overlap creates moiré
interference — a shimmering beat pattern. Fully deterministic.

Narrow `spacing` (2–4 mm) and small `offsetAngle` (2–8°) produce dramatic interference.
Larger `offsetAngle` → finer fringes.

| Param | Default | Meaning |
|-------|---------|---------|
| `w, h`        | 200, 200 | Pattern size (mm). |
| `spacing`     | 4  | Line spacing within each grating (mm). |
| `angle`       | 90 | Base grating angle (degrees). |
| `offsetAngle` | 6  | Angle difference between the two gratings (degrees). |
| `cx, cy`      | 0,0 | Centre. |

### `patternMaker`
Tiles a base shape (square, circle, or triangle) across a `cols×rows` grid. Each cell
rotates the shape by `rotateStep` more than the previous, creating cascading patterns.
`rotateStep = 360/cols` → aligned rows; prime-ish steps → cascades.

| Param | Default | Meaning |
|-------|---------|---------|
| `shape`      | `"square"` | `"square"`, `"circle"`, or `"triangle"`. |
| `fillRatio`  | 0.8    | Shape size as fraction of cell. 1.0 = cells touching. |
| `rotateStep` | 7      | Additional rotation per cell (degrees). Negative = other way. |
| `cols`       | 8      | Grid columns. |
| `rows`       | 8      | Grid rows. |
| `cell`       | 24     | Cell size (mm). |
| `cx, cy`     | 0,0    | Centre. |

---

## 7. Warp modifier

Applies a displacement field to paths after generation (or to any raw paths).

**Water warp** — sinusoidal X/Y ripple:
```
x' = x + amplitude * sin(2π/wavelength * (y - cy))
y' = y + amplitude * sin(2π/wavelength * (x - cx))
```
Use for gently undulating everything — turns straight sheets into waves, distorts
spirographs into organic forms.

**Droplet warp** — radial rings from a centre point, decaying with distance:
```
d = amplitude * sin(2π/wavelength * r) * exp(-falloff * r)
x' = x + (dx/r) * d,  y' = y + (dy/r) * d   where r = hypot(x-cx, y-cy)
```
Use for a "stone dropped in water" effect — rings of distortion radiating outward.

`warp_params`:
- `amplitude` — displacement magnitude (mm). 5–20 for subtle; 30+ for strong.
- `wavelength` — ripple period (mm). Match to shape scale (circle radius, etc.).
- `falloff` — droplet radial decay (0 = uniform rings; 0.01–0.03 = localised).
- `cx, cy` — warp origin (droplet mode).

---

## 8. Drawing strategy

- **Compose first.** Decide coordinates before sending. Sketch in Y-down frame.
- **Prefer shape tools over goto chains.** `plot_line`, `plot_circle`, etc. draw true curves.
  Plain `goto→goto` chains are for travel, not visible marks.
- **Use `plot_generate` for complex generative work.** It reads bounds, runs the generator,
  clips paths, and sends everything in one call.
- **Use `plot_polylines` for precise custom math.** You compute exact point arrays; the
  tool handles flow control and clipping.
- **Group by locality.** Finish everything in one area before moving across the canvas.
  This cuts pen-up travel time significantly.
- **Darken with `cycles`.** 2–3 passes makes an outline bold. Same path, no movement offset.
- **Scale to the canvas.** With ~480×400 mm usable, keep individual features ≥ 20–30 mm
  so they read clearly. Keep the composition within margins.
- **Lines bow slightly** on a polargraph (geometry effect). Straight strokes are
  sub-segmented to stay straight; if you see a curve where you wanted a line, report it.

---

## 9. Grid tiling — filling multiple cells

Grid tiling subdivides the work area into cols×rows equal cells (with `padding_mm` gaps
between adjacent cells) and remaps the coordinate system so each cell has its own local
origin. All drawing tools work in **cell-local coordinates** while a cell is active.

### Coordinate rule while a cell is active
- `(0, 0)` = the cell's **centre** in physical space.
- `±cellW/2` reaches the cell edges horizontally (cellW from `plot_grid_plan`).
- `±cellH/2` reaches the cell edges vertically.
- A circle with `r = cellW/4` fills half the cell width, symmetrically centred.

### ⚠️ MANDATORY: verify shapes fit inside the cell BEFORE drawing

**The firmware rejects any draw command whose extent exceeds the active cell bounds.
Rejected jobs are silently counted as failed — nothing is drawn and no error is surfaced
beyond the job-failure counter. A wrong radius in a 24×24 grid can produce 576 silent
failures with a blank plot.**

After `plot_grid_plan` returns `cellW` and `cellH`, compute the safe limits and check
every shape you plan to send:

```
maxR    = min(cellW, cellH) / 2        ← maximum safe radius / half-size for centred shapes
maxSide = min(cellW, cellH)            ← maximum safe full side length (squares/rects)
```

Per shape:
| Shape | Constraint |
|-------|-----------|
| `circle r` | `r ≤ maxR` |
| `square size` | `size/2 ≤ maxR` (i.e. `size ≤ min(cellW,cellH)`) |
| `arc`, `line`, `goto` | all points must be within `±cellW/2` (X) and `±cellH/2` (Y) |
| `plot_generate` | generator params (radius, maxRadius, etc.) must respect `maxR` |

**Real example of what goes wrong:** a 24×24 grid over a 539×388 mm work area with
`padding_mm=10` → `cellW≈12.9 mm`, `cellH≈6.6 mm`, `maxR≈3.3 mm`. Sending `circle r=12`
produces 576 firmware rejections. The solution is either fewer cells (e.g. 6×4) or a
smaller radius (`r ≤ 3`).

**Workflow rule:** call `plot_grid_plan` first, read `cellW`/`cellH` from the response,
compute `maxR`, and do not proceed until every planned draw command is confirmed to fit.

### Step 0: preview the layout with `plot_grid_plan`

Call this first — no firmware state change, just returns the full cell table.

```
plot_grid_plan cols=3 rows=2 padding_mm=5
  full_xn=-240 full_xp=240 full_yn=-110 full_yp=300
```

Returns:
```json
{
  "cols": 3, "rows": 2, "padding_mm": 5,
  "cellW": 146.7, "cellH": 202.5, "total": 6,
  "cells": [
    { "col": 0, "row": 0, "cx": -166.7, "cy": 91.3, "xn": -240, "xp": -93.3, "yn": -110, "yp": 92.5 },
    { "col": 1, "row": 0, "cx":    0.0, "cy": 91.3, ... },
    ...
  ]
}
```

Use this to read `cellW` and `cellH`, compute `maxR = min(cellW,cellH)/2`, and verify
every planned draw fits before sending a single command (see ⚠️ constraint above).

### Step 1: activate a cell with `plot_grid_select`

```
plot_grid_select cols=3 rows=2 padding_mm=5 col=0 row=0
  full_xn=-240 full_xp=240 full_yn=-110 full_yp=300
```

This pushes two things to firmware:
1. `bounds = ±cellW/2, ±cellH/2` — clips drawing to this cell
2. `matrix tx=cx ty=cy` — (0,0) draws at the cell's global centre

### Critical: carry the original bounds
Once a cell is active, the firmware reports **cell-sized bounds**. You must store the
full bounds from your first `plot_status` call and pass the same `full_xn/xp/yn/yp` to
**every** `plot_grid_select` and `plot_grid_clear` call. Never re-read bounds mid-session.

### Full iteration workflow

```
1. plot_status                        → save full_xn, full_xp, full_yn, full_yp
2. plot_grid_plan cols=3 rows=2 ...   → read cellW, cellH; compute maxR = min(cellW,cellH)/2
                                        STOP HERE if any planned shape exceeds maxR — adjust
                                        cols/rows or shape sizes before continuing
3. plot_grid_select col=0 row=0 ...   → top-left cell active
   plot_circle / plot_generate / ...  → draw in cell-local coords (shapes ≤ maxR!)
4. plot_grid_select col=1 row=0 ...   → middle-top cell (SAME full bounds!)
   ...
5. plot_grid_select col=2 row=0 ...
   ...
6. ... continue for all rows/cols ...
7. plot_grid_clear full_xn=... ...    → restore full work area + identity matrix
8. plot_home
```

### `plot_generate` inside a cell
`plot_generate` reads the firmware bounds after `plot_grid_select`, so it automatically
gets the cell dimensions as its canvas. No extra steps — just call `plot_grid_select`
then `plot_generate` directly.

### Keeping generative art inside the cell — `fit_in_bounds`
The MANDATORY fit check above is about **fixed-size primitives** (circle/square radius).
**Generative** modules are different: noise-driven generators (`noiseOrbit`, `noisedHatches`,
`randomWalker`, `sheets`) wander and often **poke outside the cell for some seeds** — you
cannot predict it from the params alone. Two safety nets, both automatic:

1. **Clipping (always on).** Any spill is drawn with the pen **up** outside the cell and
   **down** again when the path re-enters — it never walks the cell edge. So a spill never
   ruins neighbouring cells; it just loses the outside portion.
2. **Reseeding (opt-in).** Set `fit_in_bounds: true` so the generator's `seed` is swept
   (up to `max_seeds`, default 2000) until a seed lands **entirely inside the cell**. The
   first fitting seed is used; if none fit, the last attempt is drawn clipped and counted.

In a `plot_script` grid run, switch it on once via `metadata` — it applies to every cell:

```json
{
  "metadata": {
    "work_area": { "x_min": -240, "x_max": 240, "y_min": -110, "y_max": 300 },
    "grid": { "cols": 4, "rows": 4, "padding_mm": 8 },
    "fit_in_bounds": true,
    "max_seeds": 2000
  },
  "commands": [
    { "type": "grid_select", "col": 0, "row": 0 },
    { "type": "generate", "generator": "noiseOrbit", "params": { "seed": 1, "maxRadius": 40 } },
    { "type": "grid_select", "col": 1, "row": 0 },
    { "type": "generate", "generator": "randomWalker", "params": { "count": 6, "seed": 1 } },
    { "type": "grid_clear" },
    { "type": "home" }
  ]
}
```

At the end the run reports how many cells couldn't be contained, e.g.
`Fit: ✗ 3/16 cell(s) could NOT fit after 2000 seeds: (1,2), (3,0), (3,3)`. When that
happens, the generator is simply too large for the cell — **shrink its size params**
(radius / maxRadius / blobRadius), use fewer cells, or raise `fit_tol_mm` to allow a small
nick. A generator with **no `seed` param** can't be reseeded and is reported as skipped.

### Using `plot_script` for grid work

```json
[
  { "type": "grid_select", "cols": 2, "rows": 2, "padding_mm": 5,
    "col": 0, "row": 0,
    "full_xn": -240, "full_xp": 240, "full_yn": -110, "full_yp": 300 },
  { "type": "circle", "cx": 0, "cy": 0, "r": 40 },

  { "type": "grid_select", "cols": 2, "rows": 2, "padding_mm": 5,
    "col": 1, "row": 0,
    "full_xn": -240, "full_xp": 240, "full_yn": -110, "full_yp": 300 },
  { "type": "square", "cx": 0, "cy": 0, "size": 60 },

  { "type": "grid_clear",
    "full_xn": -240, "full_xp": 240, "full_yn": -110, "full_yp": 300 },
  { "type": "home" }
]
```

---

## 10. Autonomous painting workflow

### Simple generative piece
```
1. plot_status           → read bounds; check idle; pen position
2. plot_pen "up"
3. plot_generate generator="spirograph" params={R:80, r:30, d:50}
4. plot_home
```

### Grid composition with different designs per cell
```
1. plot_status                 → note full bounds (xn xp yn yp)
2. plot_grid_plan cols=2 rows=2 padding_mm=5 full_xn=...
                               → read cellW/cellH; compute maxR = min(cellW,cellH)/2
                                  VERIFY all params (R, orbitRadius, maxRadius…) ≤ maxR
3. plot_set_speed 120000
4. plot_grid_select col=0 row=0 (full bounds)
   plot_generate generator="spirograph" params={R:40, r:15, d:30}   ← R ≤ maxR!
5. plot_grid_select col=1 row=0 (same full bounds)
   plot_generate generator="orbitalWeave" params={orbitRadius:40, traceTurns:9}
6. plot_grid_select col=0 row=1 (same full bounds)
   plot_generate generator="noiseOrbit" params={maxRadius:50, nudge:20, seed:7}
7. plot_grid_select col=1 row=1 (same full bounds)
   plot_polylines paths=[...archimedean spiral points...]
8. plot_grid_clear (full bounds)
9. plot_home
```

### Layered full-canvas painting
```
1. plot_status
2. plot_generate generator="sheets" params={cols:20, interpSteps:8}
3. plot_generate generator="noiseOrbit" params={numCircles:20, maxRadius:120, nudge:30}
   warp_mode="water" warp_params={amplitude:15, wavelength:100}
4. plot_home
```

---

## 11. Caveats & gotchas

- **Negative/near-top `y` is risky.** Geometry degrades close to the anchors. Keep
  important detail in the middle band.
- **Never exceed 600 mA run current.** Shared 12 V / 2 A supply.
- **Errors mean "didn't draw."** An error response (out-of-bounds, etc.) means nothing
  was drawn. Fix coordinates, then resend just that part.
- **Driver faults** (over-temp, coil short) pause the script and require `plot_clear_fault`
  after resolving the hardware issue.
- **E-STOP** (physical button or `/api/clearfault`) cuts motor power. Re-home after.
- **If anything is physically wrong**, call `plot_stop` immediately, then reassess.
- **`plot_generate` + `plot_polylines` both clip paths.** No need to pre-filter your
  math — paths that stray outside are trimmed at the boundary, not silently distorted.

---

## 12. JSON script format — full reference

The JSON script format is the **shared language** between two surfaces:

- **Console → Autonomous → Script panel** — paste a JSON array and click Run. The
  browser expands `"generate"` items locally (using the same studio pipeline), then
  streams everything to the firmware via the batched flow-controlled sender.
- **MCP `plot_script` tool** — send the same array from Claude Desktop. Each draw
  command waits until physically done before the next begins; config commands execute
  immediately without queuing.

Both surfaces accept the exact same JSON, so a script written for one drops straight
into the other.

### Wrapper formats

All three of the following are valid:

```json
[ { "type": "circle", "cx": 0, "cy": 0, "r": 80 } ]
```
```json
{ "commands": [ { "type": "circle", "cx": 0, "cy": 0, "r": 80 } ] }
```
```json
{ "script": [ { "type": "circle", "cx": 0, "cy": 0, "r": 80 } ] }
```

---

### 12.1 Movement & pen commands

#### `goto` — travel to a point (pen state unchanged)
```json
{ "type": "goto", "x": 50, "y": -30 }
```
| Field | Type | Required | Range | Notes |
|-------|------|----------|-------|-------|
| `x` | float | ✓ | within work area X (`xn`..`xp`) | mm from origin; X+ = right |
| `y` | float | ✓ | within work area Y (`yn`..`yp`) | mm from origin; Y+ = **DOWN** |

The firmware rejects coordinates outside the current work-area bounds with a 400 error — no
partial move. Keep both x and y inside bounds.

#### `pen` — lift or lower the pen
```json
{ "type": "pen", "position": "up" }
{ "type": "pen", "position": "down" }
```
| Field | Type | Values |
|-------|------|--------|
| `position` (or `pos`) | string | `"up"` or `"down"` only |

SG90 servo: up = 50°, down = 70°, 200 ms dwell (hardware constants — not
configurable in firmware without recompile).

#### `home` — return to origin (0,0), pen lifted
```json
{ "type": "home" }
```
No parameters. Returns gondola to mechanical zero set by the last `sethome`.

#### `sethome` — mark current gondola position as (0,0)
```json
{ "type": "sethome" }
```
No parameters. Operator/setup only — do not call mid-plot; resets kinematics
origin and all subsequent coordinates are relative to this new zero.

#### `stop` — abort running job, flush queue, lift pen
```json
{ "type": "stop" }
```
No parameters. Equivalent to pressing the physical E-STOP then clearing it. Re-home
after if position is uncertain.

---

### 12.2 Firmware drawing primitives

All drawing tools manage the pen automatically (lift → travel → drop → draw → lift).
All coordinates must be within the active work-area bounds or the job is rejected.

#### `line` — straight segment
```json
{ "type": "line", "x0": -80, "y0": 0, "x1": 80, "y1": 0 }
{ "type": "line", "x0": -80, "y0": 0, "x1": 80, "y1": 0, "cycles": 3 }
```
| Field | Type | Required | Default | Range | Notes |
|-------|------|----------|---------|-------|-------|
| `x0, y0` | float | ✓ | — | within bounds | Start point (mm) |
| `x1, y1` | float | ✓ | — | within bounds | End point (mm) |
| `cycles` | int | — | 1 | 1–20 | Retrace passes to darken; >5 rarely adds visible ink |

Sub-segmented internally (`LINE_SEG_MM` ≈ 2 mm) to keep the path straight on the
polargraph belt geometry. Long lines are streamed with look-ahead so motion flows
without stopping.

#### `arc` — circular arc segment
```json
{ "type": "arc", "cx": 0, "cy": 0, "r": 60, "a0": 0, "a1": 3.1416 }
{ "type": "arc", "cx": 0, "cy": 0, "r": 60, "a0": -1.5708, "a1": 1.5708, "cw": true }
```
| Field | Type | Required | Default | Range | Notes |
|-------|------|----------|---------|-------|-------|
| `cx, cy` | float | ✓ | — | any mm (centre may be outside bounds; arc is clipped) | Centre of arc |
| `r` | float | ✓ | — | > 0; practical 5–400 mm | Radius. Huge radii slow things down (many sub-segments). |
| `a0` | float | ✓ | — | any float (radians) | Start angle. 0 = east, π/2 ≈ 1.5708 = south (Y+↓), π ≈ 3.1416 = west, 3π/2 ≈ 4.7124 = north |
| `a1` | float | ✓ | — | any float (radians) | End angle. Full circle: a1 = a0 ± 6.2832 |
| `cw` | bool | — | `false` | `true` / `false` | Clockwise sweep. Y+ is DOWN so `cw=true` is the "natural" screen direction |
| `cycles` | int | — | 1 | 1–20 | Retrace passes |
| `lift` | int | — | 1 | `0` or `1` | `0` = no pen lift at start/end — use to chain arcs into composite curves |

**Angle quick-reference:**

| Direction | Degrees | Radians (approx) |
|-----------|---------|-----------------|
| East (right) | 0° | 0 |
| South (down, Y+) | 90° | 1.5708 |
| West (left) | 180° | 3.1416 |
| North (up, Y−) | 270° | 4.7124 |
| Full circle | 360° | 6.2832 |

**Chaining two arcs into an S-curve without lifting the pen:**
```json
{ "type": "arc", "cx": -40, "cy": 0, "r": 40, "a0": 0, "a1": 3.1416, "lift": 0 },
{ "type": "arc", "cx":  40, "cy": 0, "r": 40, "a0": 3.1416, "a1": 0, "cw": true, "lift": 0 }
```

#### `circle` — full circle with optional fill
```json
{ "type": "circle", "cx": 0, "cy": 0, "r": 80 }
{ "type": "circle", "cx": 0, "cy": 0, "r": 80, "cycles": 2, "fill_mode": 1, "hatch_angle": 45, "spacing": 4 }
```
| Field | Type | Required | Default | Range | Notes |
|-------|------|----------|---------|-------|-------|
| `cx, cy` | float | ✓ | — | within bounds | Centre (mm) |
| `r` | float | ✓ | — | > 0; practical 5–200 mm | Radius. Ensure cx±r stays within bounds or the firmware rejects the job. |
| `cycles` | int | — | 1 | 1–20 | Retrace passes |
| `fill_mode` | int | — | 0 | `0`, `1`, `2` | `0`=outline only, `1`=parallel hatch lines, `2`=concentric rings |
| `hatch_angle` | float | — | 0 | 0–360 (degrees) | Hatch line direction when `fill_mode=1`; 0=horizontal, 90=vertical, 45=diagonal |
| `spacing` | float | — | 3 | 0.5–20 mm | Spacing between hatch/ring lines; < 1 mm creates very dense fills and long draw times |
| `outline` | int | — | 1 | `0` or `1` | `0` suppresses the outer circle; fill lines only |

#### `square` — axis-aligned square with optional fill
```json
{ "type": "square", "cx": 0, "cy": 0, "size": 160 }
{ "type": "square", "cx": 0, "cy": 0, "size": 160, "fill_mode": 2, "spacing": 5 }
```
| Field | Type | Required | Default | Range | Notes |
|-------|------|----------|---------|-------|-------|
| `cx, cy` | float | ✓ | — | within bounds | Centre (mm) |
| `size` | float | ✓ | — | > 0; practical 10–400 mm | Full side length; extends `size/2` in each direction from centre |
| `cycles` | int | — | 1 | 1–20 | Retrace passes |
| `fill_mode` | int | — | 0 | `0`, `1`, `2` | Same as `circle`: 0=outline, 1=hatch, 2=concentric |
| `hatch_angle` | float | — | 0 | 0–360° | Hatch direction (fill_mode 1) |
| `spacing` | float | — | 3 | 0.5–20 mm | Hatch/ring spacing |
| `outline` | int | — | 1 | `0` or `1` | Suppress the outer border |

#### `wobbly` — organic blob via radial Fourier harmonics
```json
{ "type": "wobbly", "cx": 0, "cy": 50, "r": 60, "wobble": 0.4, "harmonics": 3, "seed": 42 }
```
| Field | Type | Required | Default | Range | Notes |
|-------|------|----------|---------|-------|-------|
| `cx, cy` | float | ✓ | — | within bounds | Centre (mm) |
| `r` | float | ✓ | — | > 0; practical 10–150 mm | Mean radius. Actual extremes = r × (1 ± wobble). |
| `bound_r` | float | — | 0 | ≥ 0 | If > 0, hard radial clamp — no point of the blob exceeds this distance from centre |
| `wobble` | float | — | 0.4 | 0.0–1.0 | Deformation amplitude as fraction of r. 0 = plain circle; 1.0 = max distortion |
| `harmonics` | int | — | 3 | 1–8 | Number of Fourier modes. 1 = single-lobe bulge; 8 = spiky/irregular |
| `seed` | int | — | 42 | any int | Integer seed for harmonic phases — change for a different shape |
| `cycles` | int | — | 1 | 1–20 | Retrace passes |
| `fill_mode` | int | — | 0 | `0`, `1`, `2` | Same fill options as circle |
| `hatch_angle` | float | — | 0 | 0–360° | Hatch direction (fill_mode 1) |
| `spacing` | float | — | 3 | 0.5–20 mm | Fill line spacing |
| `outline` | int | — | 1 | `0` or `1` | Suppress the outer blob outline |

#### `truchet` — full-canvas Carlson Truchet tiling
```json
{ "type": "truchet", "n": 4, "spacing": 3, "angle": 45, "seed": 42 }
{ "type": "truchet", "n": 6, "spacing": 2, "angle": 30, "seed": 7, "motifs": 1955 }
```
| Field | Type | Required | Default | Range | Notes |
|-------|------|----------|---------|-------|-------|
| `n` | int | — | 4 | 1–13 (auto-clamped) | Cells per axis. Firmware enforces a minimum cell size of **40 mm** — n is silently reduced until cells are ≥ 40 mm. For a ~520 mm canvas width the hard max is ~13. |
| `spacing` | float | — | 3 | 0.5–10 mm | Hatch line spacing within each ribbon motif |
| `angle` | float | — | 45 | 0–360° | Global hatch field angle |
| `seed` | int | — | 42 | any int | Random layout seed — selects which motif each cell gets |
| `motifs` | int | — | 1955 | 1–32767 (15-bit) | Bitmask of enabled ribbon types. `0` is treated as the firmware default (= 1955 = `0x7A3`). |

**Truchet motif bitmask reference** — `motifs` field is a bitfield; OR the bits you want:

| Bit | Value | Symbol | Description |
|-----|-------|--------|-------------|
| 0 | 1 | `\` | Diagonal slash (top-left → bottom-right) |
| 1 | 2 | `/` | Diagonal backslash (top-right → bottom-left) |
| 2 | 4 | `-` | Horizontal bar |
| 3 | 8 | `\|` | Vertical bar |
| 4 | 16 | `+.` | Plus with rounded dots |
| 5 | 32 | `x.` | X-cross with rounded dots |
| 6 | 64 | `+` | Plain plus cross |
| 7 | 128 | `fne` | Fan arc — north-east quadrant |
| 8 | 256 | `fsw` | Fan arc — south-west quadrant |
| 9 | 512 | `fnw` | Fan arc — north-west quadrant |
| 10 | 1024 | `fse` | Fan arc — south-east quadrant |
| 11 | 2048 | `tn` | Diagonal tile, north bias |
| 12 | 4096 | `ts` | Diagonal tile, south bias |
| 13 | 8192 | `te` | Diagonal tile, east bias |
| 14 | 16384 | `tw` | Diagonal tile, west bias |

Default `0x7A3` = 1955 = bits 0+1+5+7+8+9+10 = `\`, `/`, `x.`, `fne`, `fsw`, `fnw`, `fse`.

**Example presets:**
- Diagonal only: `motifs: 3` (bits 0+1 = `\` + `/`)
- Fans only: `motifs: 1920` (bits 7–10)
- All straight: `motifs: 92` (bits 2+3+4+6 = `-`, `|`, `+.`, `+`)
- All motifs: `motifs: 32767`

#### `bullseye` — calibration crosshair + concentric rings
```json
{ "type": "bullseye", "cx": 0, "cy": 0 }
```
| Field | Type | Required | Default | Range |
|-------|------|----------|---------|-------|
| `cx, cy` | float | — | 0, 0 | within bounds | Centre of the crosshair pattern |

#### `grid` — calibration line grid
```json
{ "type": "grid", "cx": 0, "cy": 0 }
```
| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `cx, cy` | float | — | 0, 0 | Centre of a 10×10 grid, 8 mm spacing, 100 mm span |

#### `border` — trace the active work-area boundary once, pen-down
```json
{ "type": "border" }
```
No parameters. Traces exactly the rectangle or ellipse that the firmware enforces as the
clip boundary — use after `bounds` to confirm the work area before plotting.

---

### 12.3 Studio generators — `"type": "generate"`

> **Console only (not in `plot_script`).** The `"generate"` type is expanded in the
> browser by the console Script panel. `plot_script` does not support it — use the
> `plot_generate` MCP tool instead for Claude Desktop.

Runs any studio generator, compiles its paths, and streams the result to the firmware.
Uses the current work-area bounds automatically. Paths are clipped at the boundary.

```json
{ "type": "generate", "generator": "<key>", "params": { ... } }
```

Optional warp modifier:
```json
{
  "type": "generate",
  "generator": "noiseOrbit",
  "params": { "numCircles": 20, "maxRadius": 100, "nudge": 15 },
  "warp": { "mode": "water", "params": { "amplitude": 10, "wavelength": 80 } }
}
```

**`warp.mode` options and their parameters:**

| Mode | params | Range | Effect |
|------|--------|-------|--------|
| `"water"` | `amplitude` | 0–50 mm (practical 3–20) | Sinusoidal displacement magnitude |
| `"water"` | `wavelength` | 10–500 mm (practical 30–150) | Period of the ripple |
| `"droplet"` | `amplitude` | 0–50 mm (practical 3–20) | Ring displacement magnitude |
| `"droplet"` | `wavelength` | 10–500 mm (practical 30–150) | Spacing between emanating rings |
| `"droplet"` | `falloff` | 0–0.1 (0 = no decay) | Amplitude decay per ring outward |
| `"droplet"` | `cx, cy` | any mm | Centre point of the emanating rings |

---

#### Generator: `spirograph`

Draws hypotrochoid/epitrochoid roulette curves — the classic "gear toy" pattern.
The number of petals/lobes is determined by the `R/r` ratio.

```json
{ "type": "generate", "generator": "spirograph",
  "params": { "R": 80, "r": 30, "d": 50 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `R` | float | 80 | ≥ 1 mm | Fixed (outer) gear radius. Should be < half the smaller canvas dimension. |
| `r` | float | 30 | 1 – R | Rolling gear radius. R/r must be rational for a closed curve. |
| `d` | float | 50 | 0 – R+r | Pen-tip offset from the rolling gear centre. 0 = circle; ≈R+r = outer cusp tip. |

The number of loop turns is computed automatically as `lcm(R,r)/r` (clamped 1–200).
Try near-integer ratios for clean closed forms: R=80, r=30 → 8-petal; R=70, r=20 → 7-petal.

---

#### Generator: `orbitalWeave`

An orbiting tracer that winds around a central ellipse — produces woven knot patterns
when `traceTurns` and `orbitTurns` share no common factor.

```json
{ "type": "generate", "generator": "orbitalWeave",
  "params": { "orbitRadius": 70, "orbitTurns": 5, "majorRadius": 50, "traceTurns": 17 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `orbitRadius` | float | 60 | 1–200 mm | Distance from origin to the orbiting point |
| `orbitTurns` | int | 6 | 1–20 | How many times the point orbits the origin |
| `majorRadius` | float | 40 | 1–100 mm | Ellipse major semi-axis (X direction) |
| `minorRadius` | float | 20 | 1 – majorRadius | Ellipse minor semi-axis (Y direction) |
| `traceTurns` | int | 17 | 1–100 | Winding turns of the tracer. **Use a prime number** coprime with `orbitTurns` for complex knots. |

---

#### Generator: `noiseOrbit`

Concentric rings that are distorted by layered 3D value noise — natural, organic-looking.

```json
{ "type": "generate", "generator": "noiseOrbit",
  "params": { "numCircles": 25, "maxRadius": 120, "nudge": 20, "seed": 7 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `numCircles` | int | 20 | 2–200 (practical 10–60) | Number of concentric rings |
| `minRadius` | float | 20 | 1 – (maxRadius−1) | Innermost ring radius (mm) |
| `maxRadius` | float | 100 | > minRadius; practical 30–250 mm | Outermost ring radius |
| `numSides` | int | 20 | 6–80 | Polygon approximation facets per ring (more = smoother) |
| `chaikin` | int | 2 | 0–6 | Chaikin smoothing passes after distortion (0 = raw polygon) |
| `nudge` | float | 15 | 0–100 mm | Noise displacement magnitude — the "wobbliness" amount |
| `layers` | int | 1 | 1–10 | Number of stacked noise layers (more = finer detail) |
| `layerStep` | float | 0 | 0–20 mm | Radial offset between layers |
| `seed` | int | 42 | any int | Noise seed — change for a different organic shape |

---

#### Generator: `randomWalker`

Multiple agents drift across the canvas with accumulated velocity following a
flow-field angle — produces flowing, calligraphic line traces.

```json
{ "type": "generate", "generator": "randomWalker",
  "params": { "count": 40, "steps": 3000, "flowAngle": 60, "seed": 13 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `count` | int | 20 | 1–500 (practical 10–100) | Number of independent walking agents |
| `steps` | int | 2000 | 100–20000 | Steps per agent. More = longer, more tangled paths. |
| `flowAngle` | float | 0 | 0–360° | Global drift direction in degrees (0 = right, 90 = down) |
| `velStep` | float | 0.5 | 0.01–5.0 | Velocity increment per step (mm/step change) |
| `maxVel` | float | 5 | velStep–30 | Velocity cap — limits how fast an agent can move |
| `seed` | int | 42 | any int | Seed for starting positions and velocity noise |
| `x1, y1` | float | (left bound, top bound) | any mm within canvas | Walker bounding box top-left |
| `x2, y2` | float | (right bound, bottom bound) | any mm within canvas | Walker bounding box bottom-right |

---

#### Generator: `noisedHatches`

A grid of hatch-line cells where a noise blob controls which cells are filled — creates
textured, ink-wash-like regions.

```json
{ "type": "generate", "generator": "noisedHatches",
  "params": { "gridN": 30, "angleDeg": 45, "blobRadius": 90, "seed": 5 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `gridN` | int | 25 | 5–200 (practical 10–80) | Number of hatch cells per axis |
| `angleDeg` | float | 45 | 0–360° | Hatch line angle within each cell |
| `blobRadius` | float | 80 | 10–500 mm | Radius of the noise blob that controls coverage |
| `noiseScale` | float | 0.05 | 0.005–0.5 | Spatial frequency of the noise; smaller = smoother blobs |
| `seed` | int | 42 | any int | Seed for the noise field |

Canvas size is taken automatically from the work-area bounds — no `w`/`h` needed.

---

#### Generator: `sheets`

Draws a grid of vertical column points that are randomly displaced, then interpolates
smooth curves through each row — produces soft curtain / fabric-fold aesthetics.

```json
{ "type": "generate", "generator": "sheets",
  "params": { "cols": 20, "interpSteps": 8 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `cols` | int | 20 | 2–100 | Number of column points across the width |
| `rows` | int | 10 | 2–50 | Number of row samples down the height |
| `xJitter` | float | 30 | 0–100 mm | Horizontal random displacement per grid point |
| `yJitter` | float | 10 | 0–100 mm | Vertical random displacement per grid point |
| `interpSteps` | int | 8 | 0–30 | Chaikin interpolation passes for curve smoothing; 0 = raw grid lines |
| `seed` | int | 42 | any int | Layout seed |

---

#### Generator: `moireCurtain`

Two overlapping line gratings at slightly different angles — interference between them
creates moiré fringes.

```json
{ "type": "generate", "generator": "moireCurtain",
  "params": { "spacing": 3, "angle": 20, "offsetAngle": 5 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `spacing` | float | 3 | ≥ 0.5 mm (practical 1–15) | Line spacing within each grating. Smaller spacing = finer fringes. |
| `angle` | float | 20 | 0–90° | Angle of the first grating |
| `offsetAngle` | float | 5 | 0.1–45° | Angular offset between the two gratings. Smaller offset = wider fringes, more visual depth. |

Canvas extents are taken automatically from the work-area bounds.

---

#### Generator: `patternMaker`

Tiles a base shape (square, circle, or triangle) across a grid with per-column rotation —
produces op-art geometric compositions.

```json
{ "type": "generate", "generator": "patternMaker",
  "params": { "cols": 6, "rows": 5, "shape": "circle", "fillRatio": 0.85, "cell": 60 } }
```
| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `shape` | string | `"square"` | `"square"` / `"circle"` / `"triangle"` | Base shape drawn in each cell |
| `cols` | int | 5 | 1–30 | Number of columns |
| `rows` | int | 5 | 1–30 | Number of rows |
| `cell` | float | 60 | 5–200 mm | Cell size in mm (both width and height) |
| `fillRatio` | float | 0.8 | 0.1–2.0 | Shape size as a fraction of the cell; > 1.0 = shapes overlap neighbours |
| `rotateStep` | float | 15 | −180–180° | Rotation added per column; each column is rotated by `col × rotateStep` |

---

### 12.4 Work area & affine matrix configuration

These commands reconfigure the firmware's drawing canvas mid-script.
In `plot_script` they execute immediately (no draw queue). In the console Script panel
they are sent as direct API calls between the batched draw commands.

#### `bounds` — set the work area
```json
{ "type": "bounds", "xn": -260, "xp": 260, "yn": -115, "yp": 273 }
{ "type": "bounds", "xn": -260, "xp": 260, "yn": -115, "yp": 273, "shape": 1 }
```
| Field | Type | Required | Range | Notes |
|-------|------|----------|-------|-------|
| `xn` | float | ✓ | < 0 (e.g. `-276`) | Left boundary — **must be negative** |
| `xp` | float | ✓ | > 0 (e.g. `263`) | Right boundary — **must be positive** |
| `yn` | float | ✓ | < 0 (e.g. `-115`) | Top boundary — **must be negative** (Y+ is DOWN, so top = negative) |
| `yp` | float | ✓ | > 0 (e.g. `273`) | Bottom boundary — **must be positive** |
| `shape` | int | — | `0` or `1` | `0` = rectangle (default), `1` = ellipse inscribed in the box |

All subsequent draw commands are clipped to these bounds until changed.
Firmware resets bounds on reboot — the console re-pushes them on every connect.

**Current default work area (as of v1.3):** `xn=-276, xp=263, yn=-115, yp=273`

#### `matrix` — affine warp of the logical drawing space
```json
{ "type": "matrix", "a": 1, "b": 0, "c": 0, "d": 1, "tx": 0, "ty": 0 }
```
The firmware applies `x' = a·x + b·y + tx, y' = c·x + d·y + ty` to every coordinate
before belt/kinematics math. **Session-only — resets to identity on reboot.**

| Field | Type | Identity | Practical range | Effect |
|-------|------|----------|----------------|--------|
| `a` | float | 1 | 0.25–2.0 | X scale (1 = no change, 0.5 = half width, 2.0 = double) |
| `b` | float | 0 | −1.0–1.0 | X shear from Y (skews the X axis with Y movement) |
| `c` | float | 0 | −1.0–1.0 | Y shear from X (skews the Y axis with X movement) |
| `d` | float | 1 | 0.25–2.0 | Y scale |
| `tx` | float | 0 | within canvas (mm) | X offset — shifts the entire drawing right (+) or left (−) |
| `ty` | float | 0 | within canvas (mm) | Y offset — shifts entire drawing down (+) or up (−); Y+ is down |

**Common recipes:**

| Goal | Values |
|------|--------|
| Identity (reset) | `a=1, b=0, c=0, d=1, tx=0, ty=0` |
| Shift right 60 mm | `a=1, b=0, c=0, d=1, tx=60, ty=0` |
| Scale to 75% | `a=0.75, b=0, c=0, d=0.75, tx=0, ty=0` |
| Mirror horizontally | `a=-1, b=0, c=0, d=1, tx=0, ty=0` |
| Rotate 15° CW | `a=0.9659, b=-0.2588, c=0.2588, d=0.9659, tx=0, ty=0` |
| Rotate 30° CW | `a=0.8660, b=-0.5, c=0.5, d=0.8660, tx=0, ty=0` |

Use `plot_border` after setting a matrix to confirm the transformed work area before plotting.
`plot_set_matrix` in the MCP does the same interactively.

---

### 12.5 Motion settings

#### `speed` — set maximum velocity
```json
{ "type": "speed", "vmax": 200000 }
```
| Field | Type | Default | Hard range | Notes |
|-------|------|---------|-----------|-------|
| `vmax` | int | 200000 | 10000–600000 (µsteps/s) | TMC5072 VMAX register. Changes apply to the next draw command. |

**Practical speed tiers:**

| vmax | Use case |
|------|----------|
| 50 000 | Ultra slow — calibration / wet ink |
| 80 000 | Fine detail or hatching |
| 150 000 | Careful plotting |
| 200 000 | **Default** — general plotting |
| 300 000 | Fast fills |
| 500 000 | Travel moves only — may show vibration in pen-down lines |

At 256 µsteps and 1280 steps/mm, 200 000 µsteps/s ≈ 156 mm/s.

#### `accel` — set acceleration
```json
{ "type": "accel", "amax": 500 }
```
| Field | Type | Default | Hard range | Notes |
|-------|------|---------|-----------|-------|
| `amax` | int | 500 | 100–5000 (µsteps/s²) | Scales the whole TMC5072 ramp (AMAX + A1/D1 sub-legs). Lower = smoother start/stop, fewer vibration artefacts on long lines. Higher = faster acceleration but more likely to overshoot corners. |

**Practical accel tiers:**

| amax | Character |
|------|-----------|
| 100–200 | Very gentle — almost no corner overshoot |
| 300–500 | **Default range** — good balance |
| 800–1500 | Snappy — suitable only for fast travel at high vmax |
| 2000+ | Aggressive — may skip steps if current is too low |

#### `current` — set stepper coil current
```json
{ "type": "current", "run_ma": 400, "hold_ma": 200 }
{ "type": "current", "run": 400, "hold": 200 }
```
`run_ma`/`run` and `hold_ma`/`hold` are accepted interchangeably.

| Field | Type | Default | Hard limit | Notes |
|-------|------|---------|-----------|-------|
| `run_ma` (or `run`) | int | 400 | **≤ 600 mA** | Active drawing current. 600 mA is the shared 12 V / 2 A supply limit for **both** motors combined — real per-motor safe max is ~400–500 mA for long sessions. |
| `hold_ma` (or `hold`) | int | 200 | ≥ 50 mA | Hold current when motors are idle. **Do not set to 0** — a hanging V-plotter needs holding torque or the gondola will slip. |

**Recommended operating points:**

| Scenario | run_ma | hold_ma |
|----------|--------|---------|
| Short session, high detail | 400 | 200 |
| Multi-hour plot (thermal safety) | 300 | 150 |
| Power-on default (firmware) | 400 | 200 |
| Maximum safe (verify R_SENSE first) | 500 | 250 |

The firmware's `R_SENSE = 0.15 Ω` is currently unverified — if the real resistor is
smaller, the true current exceeds the setpoint. Confirm with a clamp meter before
raising run current above 400 mA.

---

### 12.6 Grid tiling in a script

`grid_select` and `grid_clear` are supported in `plot_script` (MCP) as immediate config
commands. They are **not** supported in the console Script panel (use the standalone
`plot_grid_select` / `plot_grid_clear` tools there instead).

**`grid_select` fields:**

| Field | Type | Required | Range | Notes |
|-------|------|----------|-------|-------|
| `cols` | int | ✓ | 1–20 | Total columns in the grid |
| `rows` | int | ✓ | 1–20 | Total rows in the grid |
| `padding_mm` | float | ✓ | 0–50 mm | Gap between cells |
| `col` | int | ✓ | 0 – (cols−1) | Column index of the cell to activate (0 = leftmost) |
| `row` | int | ✓ | 0 – (rows−1) | Row index of the cell to activate (0 = topmost / most negative Y) |
| `full_xn` | float | ✓ | negative mm | Full canvas left boundary (same value as your `bounds` xn) |
| `full_xp` | float | ✓ | positive mm | Full canvas right boundary |
| `full_yn` | float | ✓ | negative mm | Full canvas top boundary |
| `full_yp` | float | ✓ | positive mm | Full canvas bottom boundary |

**`grid_clear` fields:** same four `full_*` boundary fields as `grid_select` — pass the
same values you used for the grid. Restores bounds to the full canvas.

Draw commands inside an active cell use **cell-local coordinates**: `(0,0)` = cell centre.

**2×2 example:**
```json
[
  { "type": "grid_select",
    "cols": 2, "rows": 2, "padding_mm": 5, "col": 0, "row": 0,
    "full_xn": -260, "full_xp": 260, "full_yn": -115, "full_yp": 273 },
  { "type": "circle", "cx": 0, "cy": 0, "r": 40 },

  { "type": "grid_select",
    "cols": 2, "rows": 2, "padding_mm": 5, "col": 1, "row": 0,
    "full_xn": -260, "full_xp": 260, "full_yn": -115, "full_yp": 273 },
  { "type": "wobbly", "cx": 0, "cy": 0, "r": 50, "wobble": 0.5, "seed": 7 },

  { "type": "grid_select",
    "cols": 2, "rows": 2, "padding_mm": 5, "col": 0, "row": 1,
    "full_xn": -260, "full_xp": 260, "full_yn": -115, "full_yp": 273 },
  { "type": "truchet", "n": 3, "spacing": 3, "seed": 42 },

  { "type": "grid_select",
    "cols": 2, "rows": 2, "padding_mm": 5, "col": 1, "row": 1,
    "full_xn": -260, "full_xp": 260, "full_yn": -115, "full_yp": 273 },
  { "type": "square", "cx": 0, "cy": 0, "size": 80, "fill_mode": 2, "spacing": 6 },

  { "type": "grid_clear",
    "full_xn": -260, "full_xp": 260, "full_yn": -115, "full_yp": 273 },
  { "type": "home" }
]
```

**Rules:**
- Pass the same `full_xn/xp/yn/yp` to every `grid_select` and `grid_clear` call — the
  firmware reports cell-sized bounds once a cell is active, not the original full bounds.
- Draw commands inside a cell use **cell-local coordinates**: `(0,0)` = cell centre,
  `±cellW/2` and `±cellH/2` reach the cell edges.
- `plot_generate` (MCP) reads the cell bounds automatically after `grid_select` — just
  call it directly after activating the cell.

---

### 12.7 Complete multi-technique script example

This example uses bounds, motion settings, generators with warp, primitives, arcs,
matrix offset, and grid tiling — demonstrating the full v1.3 feature set:

```json
[
  { "type": "speed", "vmax": 180000 },
  { "type": "accel", "amax": 400 },
  { "type": "current", "run_ma": 400, "hold_ma": 200 },

  { "type": "bounds", "xn": -276, "xp": 263, "yn": -115, "yp": 273 },

  { "type": "generate", "generator": "sheets",
    "params": { "cols": 20, "rows": 12, "interpSteps": 8, "xJitter": 25, "seed": 1 } },

  { "type": "generate", "generator": "noiseOrbit",
    "params": { "numCircles": 18, "maxRadius": 110, "nudge": 22, "seed": 3 },
    "warp": { "mode": "water", "params": { "amplitude": 14, "wavelength": 100 } } },

  { "type": "circle", "cx": 0, "cy": 80, "r": 50, "cycles": 2 },

  { "type": "arc", "cx": 0, "cy": 0, "r": 90, "a0": -1.5708, "a1": 1.5708 },

  { "type": "wobbly", "cx": -80, "cy": 40, "r": 40, "wobble": 0.45, "harmonics": 4, "seed": 9 },
  { "type": "wobbly", "cx":  80, "cy": 40, "r": 40, "wobble": 0.45, "harmonics": 4, "seed": 17 },

  { "type": "matrix", "a": 1, "b": 0, "c": 0, "d": 1, "tx": 60, "ty": 0 },
  { "type": "circle", "cx": 0, "cy": -60, "r": 30 },
  { "type": "matrix", "a": 1, "b": 0, "c": 0, "d": 1, "tx": 0, "ty": 0 },

  { "type": "home" }
]
```

---

### 12.8 Copy-paste compatibility — console ↔ Claude Desktop

The JSON format is identical in both surfaces. The only difference:

| Feature | Console Script panel | MCP `plot_script` |
|---------|---------------------|-------------------|
| `"type": "generate"` | ✓ Expanded in-browser | ✗ Not supported — use `plot_generate` tool instead |
| `grid_select / grid_clear` | ✗ Not supported as JSON | ✓ Immediate config command |
| All other types | ✓ | ✓ |

To convert a console script for Claude Desktop:
1. Replace each `{ "type": "generate", ... }` with a separate `plot_generate` call.
2. Add `grid_select` / `grid_clear` objects directly into the `commands` array.

To convert a `plot_script` for the console:
1. Replace `plot_generate` calls with `{ "type": "generate", "generator": "...", "params": {...} }` items.
2. Remove `grid_select` / `grid_clear` items and use the grid tools manually.

---

## Appendix — All tools at a glance

| Tool | Category | One-liner |
|------|---------|-----------|
| `plot_goto` | Move | Travel to (x,y) without touching pen state |
| `plot_pen` | Move | Lift or lower pen |
| `plot_home` | Move | Return to (0,0) |
| `plot_sethome` | Setup | Set current position as (0,0) |
| `plot_stop` | Control | Emergency stop + flush queue |
| `plot_abort` | Control | Alias for stop |
| `plot_pause` | Control | Hold queue, park pen-up |
| `plot_resume` | Control | Continue after pause |
| `plot_line` | Draw | Straight segment, pen managed |
| `plot_arc` | Draw | Arc segment, chainable with `lift=false` |
| `plot_circle` | Draw | Circle, optional fill |
| `plot_square` | Draw | Square, optional fill |
| `plot_wobbly` | Draw | Organic blob via Fourier series |
| `plot_truchet` | Draw | Full-canvas Carlson Truchet tiling |
| `plot_bullseye` | Calibration | Crosshair + rings at a point |
| `plot_grid` | Calibration | 10×10 line grid at a point |
| `plot_border` | Calibration | Trace work-area boundary |
| `plot_list_generators` | **Generative** | List all built-in generators |
| `plot_generate` | **Generative** | Run generator → compile → dispatch |
| `plot_polylines` | **Generative** | Send raw point arrays as strokes |
| `plot_status` | Status | Bounds, position, queue, driver |
| `plot_set_speed` | Settings | vmax microsteps/s |
| `plot_set_accel` | Settings | amax microsteps/s² |
| `plot_set_current` | Settings | run_ma / hold_ma |
| `plot_set_matrix` | Settings | Affine warp (session-only) |
| `plot_set_bounds` | Settings | Set work area bounds on firmware |
| `plot_clear_fault` | Recovery | Clear driver fault / E-STOP latch |
| `plot_grid_plan` | Grid | Preview cell layout (sizes/centres, no firmware call) |
| `plot_grid_select` | Grid | Activate a grid cell |
| `plot_grid_clear` | Grid | Restore full work area |
| `plot_script` | Batch | Run ordered command list |

> **Requires matching firmware** — flash the build that adds `/api/status`, `/api/abort`,
> job IDs, and bounds rejection. `plot_generate` and `plot_polylines` compile their own
> paths and send via flow-controlled batch dispatch, so they never flood the queue.
