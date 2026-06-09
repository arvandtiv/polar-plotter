# DESIGN — Polar Plotter Console

> Build-ready design specification for an AI coding agent (Claude Code).
> A developer who was **not** in the design conversation should be able to implement
> the whole console from this file alone. Read it top to bottom before writing code.

---

## 1. Overview

A web control console for a **polar / wall-mounted pen plotter** driven by a
microcontroller (ESP32-class) that exposes an HTTP query API and a log stream.

The console must:
- Show **live machine state** (pen position on the work area, pen up/down, motion status, queue).
- Send **one-shot drawing commands** (goto, line, circle, square, calibration targets).
- Set **persistent motion config** (speed, acceleration, run/hold current).
- Set the **work-area boundaries** (4 directional extents from origin).
- Stream a readable **command/response log**.
- Work **desktop-first but fully responsive** so the machine can be driven remotely from a phone.

This replaces an earlier dense terminal-style page. The redesign's guiding moves:
machine state is visualized (not just commanded), labels are spelled out with units,
connection state is a real status chip with reconnect, errors are humanized, and
**persistent config (motion/bounds) is visually separated from one-shot actions (draw)**.

---

## 2. About the design files & fidelity

The files in `reference/` are a **high-fidelity design reference built in HTML + React (Babel in-browser) + Tailwind (CDN)**.
They are a **prototype of look & behavior — not production code to ship.**

**Your task:** recreate this UI in the target environment using its established patterns.
- If the plotter already serves a web UI (e.g. a single static `index.html` from flash/LittleFS on the MCU), implement there with vanilla JS or a light framework — **no CDN/build step if it must be flashed offline** (inline Tailwind output or hand-written CSS).
- If a frontend framework already exists, use it and its component conventions.
- The prototype **simulates** the firmware (see §9). All command dispatch, drawing animation,
  and the queue are faked client-side. In production these become **real HTTP calls** to the API in §8.

This is **hi-fi**: match the colors, type, spacing, and interactions precisely.

---

## 3. Coordinate system (read first — easy to get wrong)

- **Origin `(0,0)` is the center** of the work area. The plotter is polar/centered, so coordinates are signed.
- **+X = right, −X = left, +Y = up, −Y = down.** (SVG Y is flipped: screenY = −machineY.)
- All distances are in **mm**.
- The work area is a rectangle defined by **four independent extents from the origin**:
  `left`, `right`, `up`, `down` (each ≥ 0). Total width = left + right; total height = up + down.
  The origin need not be centered in the rectangle.

---

## 4. Layout

Top-level: sticky header + a two-column responsive grid inside a `max-width: 1400px` container
(horizontal padding 16px mobile / 24px ≥640px; vertical padding 16px / 24px).

### Header (sticky, z-20, `bg-ink-950/90` + backdrop-blur, bottom border `ink-800`)
- **Left:** 36×36 rounded-lg bordered tile (`ink-850`, `ink-700` border) holding a target/crosshair
  SVG icon in `cyanx`; then title **"Polar Plotter"** (15px bold, `ink-100`) with sub-line
  `console · v2.4` (mono 11px `ink-500`, hidden < 640px).
- **Right:** Connection chip + STOP button.

### Main grid
- `grid-cols-1` on mobile; at `lg` (≥1024px): `grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]`, gap 16px.
- **Left column (machine state):** Position card, then Motion card.
- **Right column (controls):** Tab bar, the active tab's card(s), then the Log card.
- On mobile everything stacks into one column in this DOM order: Position → Motion → Tabs → tab content → Log.

---

## 5. Screens / cards

### 5.1 Position card  (left column, top)
- Header: title "POSITION" with a `◎` icon in `cyanx`. Header right side shows two mono 12px status flags:
  - Motion: `● MOVING` (`warn`) when moving, else `○ idle` (`ink-500`).
  - Pen: `▼ pen down` (`go`) or `△ pen up` (`ink-500`).
- Body:
  - **Live canvas** (see §6), full width, aspect ratio = work-area aspect.
  - **Readout strip:** 4 tiles (`grid-cols-2` mobile / `grid-cols-4` ≥640px), each = uppercase label + mono value + unit:
    `X` (mm, 1 decimal), `Y` (mm, 1 decimal), `Queue` (cmd count), `Strokes` (drawn polyline count).
  - **Button row** (flex-wrap, gap 8px):
    `⌂ Home` (primary), `Set Home` (default), `Pen Up` (go when pen is up else default),
    `Pen Down` (go when pen is down else default), and right-aligned `Clear canvas` (ghost; clears drawn strokes only — local view reset, not a machine command).

### 5.2 Motion card  (left column, bottom)
- Header: "MOTION", `⚡` icon in `warn`.
- Four **ParamSlider** rows (see §7.3), vertical spacing 20px, with a divider (`h-px bg-ink-800`) between Accel and Run current:
  | Param | Unit label | min | max | step | default | accent |
  |---|---|---|---|---|---|---|
  | Speed | `µstep/t` | 10000 | 400000 | 5000 | **200000** | `#38bdf8` |
  | Acceleration | `AMAX=DMAX` | 50 | 2000 | 10 | **500** | `#34d399` |
  | Run current | `mA` | 100 | 1200 | 20 | **600** | `#fbbf24` |
  | Hold current | `mA` | 0 | 800 | 20 | **200** | `#fb923c` |
- Each row: dragging the slider updates the number live (`onInput`); **releasing** the slider OR
  blurring the number input **commits** (fires the API call + logs it). A `⟲ <default>` button resets.

### 5.3 Tab bar  (right column, top)
- Segmented control in a bordered pill (`ink-750` border, `ink-900/70` bg, 4px padding).
- Four equal tabs: **Draw**, **Move**, **Work Area**, **Calibrate**. Active = `bg-ink-800 text-cyanx`; inactive = `text-ink-500` → hover `ink-300`. Default tab: **Draw**.

### 5.4 Draw tab → three cards (Circle, Square, Line)
Each card header has a glyph icon and a right-aligned **go**-variant Draw button.
Fields use the **FieldInline** control (§7.5): uppercase label, mono number input, optional unit suffix.

- **Circle** (`○`, accent `cyanx`, button "Draw ○"): grid `cols-2` mobile / `cols-3` ≥640px:
  Center X (mm), Center Y (mm), Radius (mm, min 1), Cycles (min 1), Angle (°), Fill spacing (mm, min 0.5, step 0.5).
  Below grid: a **Toggle** "Fill (spiral inward)".
  Defaults: cx −120, cy −80, r 75, cycles 2, fill **on**, angle 135, spacing 2.
- **Square** (`□`, accent `go`, "Draw □"): same grid: Center X, Center Y, Size (min 1), Cycles (min 1), Angle (°), Fill spacing (min 0.5, step 0.5). Toggle "Fill (concentric)".
  Defaults: cx 0, cy 0, sz 100, cycles 1, fill **off**, angle 0, spacing 3.
- **Line** (`／`, accent `warn`, "Draw ／"): grid `cols-2` / `cols-4`: X0, Y0, X1, Y1 (all mm). Then a 112px-wide Cycles field (min 1).
  Defaults: x0 0, y0 0, x1 100, y1 0, cycles 1.

### 5.5 Move tab → "Move to point" card (`↗`, accent `cyanx`)
- Row: X (mm), Y (mm) FieldInlines + a `Go →` primary button (full-width on mobile).
- **Jog pad** below: a 3×3 grid of arrow buttons (↑ ← → ↓, 44px tall — respect 44px min hit target),
  center cell shows current step (`{step}mm`), arrows move the pen by ±step in X/Y from current position
  (they enqueue a `goto` to `current ± step`). Step selector: segmented `1 / 10 / 50` mm (default 10),
  active = `cyanx` filled.

### 5.6 Work Area tab → boundary card (`⛶`, accent `#a78bfa`)
- Intro line (12px `ink-400`): "Distance from origin (0,0) to each edge. The canvas updates live."
- **BoundsControl** (§7.6): a 3×3 cross. Top-center = Up (+Y), left = Left (−X), right = Right (+X),
  bottom-center = Down (−Y). Center cell = dashed-border tile showing mono `{W}×{H}` and "work area" caption.
  Each edge is a number field (mm, min 0). Editing live-updates the canvas; **blur commits** the `bounds` API call.
- A `Reset to default` ghost button (left 300, right 300, up 200, down 200).

### 5.7 Calibrate tab → calibration card (`✛`, accent `#f472b6`)
- Center X / Center Y FieldInlines.
- Buttons: `◎ Bullseye` and `▦ Grid` (both primary) — enqueue calibration draws centered at the entered point.
- Helper text (12px `ink-500`): use targets to verify the work area maps to physical space, then adjust under Work Area.

### 5.8 Log card  (right column, bottom; `min-height: 280px`)
- Header "LOG", `❯` icon in `go`, right-aligned `clear` text button.
- Body: a 260px-tall scroll region (`LogView`, §7.7). Auto-scrolls to bottom on new entries.
  Each line: dim mono timestamp (`HH:MM:SS`, 24h) + message, colored by kind (see §7.7).
- Messages must be **human-readable**: echo the **spelled-out query** (`> circle?cx=-120&cy=-80&r=75&cycles=2&fill=1&angle=135&spacing=2`),
  then the response (`[ok] circle drawn`). Never surface raw stack traces — see §10.

---

## 6. Live position canvas (SVG)

- One responsive `<svg>` with `viewBox = "{-left-pad} {-up-pad} {left+right+2·pad} {up+down+2·pad}"`,
  `preserveAspectRatio="xMidYMid meet"`, CSS `aspect-ratio` matching the viewBox. `pad = max(20, (left+right)·0.06)`.
- Project machine→screen as `(x, −y)`. `strokeWidth` scales with view: `sw = viewBoxWidth / 400`.
- Layers, back to front:
  1. **Work-area rect** fill `#0e1318`, stroke `ink-700` (`#2a3845`), `rx = sw`.
  2. **Grid** lines every 50mm (100mm if viewBox width > 800), stroke `#172029`, `0.6·sw`.
  3. **Axes** (X & Y through origin) stroke `#2f4150`, `1·sw`.
  4. **Committed paths** — each drawn stroke is a `<polyline>` in its assigned color (palette below), `1.4·sw`, opacity 0.92.
  5. **Active path** (currently drawing) — polyline at `1.8·sw`.
  6. **Origin marker** — hollow circle r `3·sw`, stroke `ink-600`.
  7. **Pen head** — when moving, a soft halo (r `9·sw`, 18% opacity) in green (down) / cyan (up);
     a ring (r `4.5·sw`, filled green when pen down, else hollow cyan); a center dot (r `1.2·sw`).
- **Corner labels** (absolutely positioned, mono 10px `ink-600`): `+Y {up}`, `−Y {down}`, `+X {right}`, `−X {left}`.
- **Stroke color palette** (assigned round-robin per drawn command):
  `['#38bdf8','#34d399','#fbbf24','#f472b6','#a78bfa','#fb923c']`.

---

## 7. Components & exact styling

> Build these as reusable components. The reference implements them in `reference/console-components.jsx`
> and `reference/console-canvas.jsx`.

### 7.1 Card
Rounded-xl, border `ink-750`, bg `ink-900/70`. Header: flex space-between, 16px/10px padding,
bottom border `ink-800`; title is 11px semibold, uppercase, letter-spacing 0.14em, `ink-400`, with an
accent-colored icon. Body padding 16px. Optional header-right slot.

### 7.2 Buttons (`Btn`)
Padding 12px×6px, rounded-lg, 13px medium, `active:scale-[.97]`, disabled 40% + not-allowed. Variants:
- `default`: `bg-ink-800` hover `ink-750`, border `ink-700`, text `ink-300`.
- `primary`: `cyanx/15` hover `/25`, border `cyanx/40`, text `cyanx`.
- `go`: `go/15` hover `/25`, border `go/40`, text `go`.
- `ghost`: transparent hover `ink-800`, border `ink-750`, text `ink-400`.
- `danger`: `stop/15` hover `/25`, border `stop/40`, text `stop`.

### 7.3 ParamSlider  (the motion control)
A label row + slider row.
- **Label row:** param name (12px medium `ink-300`) on the left; on the right a **numeric `<input type=number>`**
  (96px, right-aligned mono 13px `ink-100`, `ink-700` border → focus `cyanx/50`) followed by a 56px unit label (mono 10px `ink-500`).
- **Slider row:** `<input type=range>` (flex-1) + a `⟲ {default}` reset button (mono 10px; `ink-600` when at default, else `ink-400` hover `cyanx`).
- **Range track** is a CSS custom gradient showing fill: `linear-gradient(90deg, {accent} {pct}%, #2a3845 {pct}%)`; **thumb** is a 16px circle in `{accent}` with a 2px `ink-900` border + accent ring; scales 1.15 on hover.
- **Events:** range `onChange` → live update; range `onMouseUp`/`onTouchEnd` → commit. Number `onChange` → live update (clamped to min/max); number `onBlur` → commit. Reset button → set to default + commit.

### 7.4 Toggle (checkbox replacement)
A pill switch: 36×20px track, `cyanx/70` when on / `ink-700` off, 16px white knob sliding left↔right (0.5 ↔ 18px). Label 12px `ink-300` to the right. Whole thing is one clickable button.

### 7.5 FieldInline (shape-form field)
Vertical: uppercase 10px label (`ink-500`) + a bordered input group (`ink-700` border → focus `cyanx/50`, bg `ink-850`, rounded-lg) containing a `type=number` (mono 13px `ink-200`) and an optional mono 10px unit suffix. Clamps to min/max on blur.

### 7.6 NumField (stepper variant, optional)
Same as FieldInline but with `−` / `+` stepper buttons on each side (used where tap-stepping is nicer than typing). 15px stepper glyphs, `ink-500` → hover `cyanx`.

### 7.7 LogView
Scroll container (`overflow-y-auto`, rounded-lg, border `ink-800`, bg `ink-950`, padding 12px, mono 12.5px, relaxed leading). Auto-scroll to bottom via effect on log change. Each line: flex gap 10px = `ink-700` tabular timestamp + wrapped message (`whitespace-pre-wrap break-all`). Color by kind:
`cmd → cyanx`, `ok → go`, `err → stop`, `warn → warn`, `sys → ink-500`.
Entrance animation `logIn` (0.18s): translateY 3px→0, opacity 0.55→1. **Do not start opacity at 0** (keeps lines visible if a render snapshot catches frame 0).

### 7.8 StatusChip (connection)
Bordered pill (`ink-750`, bg `ink-850`). A status dot (2.5px) — `go` with an expanding `pulse-ring` halo when up, `stop` when down — then a `whitespace-nowrap` mono 12px label `LINK UP`/`LINK DOWN` (colored go/stop), then a small text button `drop` (when up) / `reconnect` (when down).

### 7.9 StopButton
Large, always visible in the header. 2px `stop/60` border, `stop/15` hover `/25`, bold tracking, `stop` text. Shows a small square glyph; when moving, a blinking dot replaces it. `active:scale-95`.

---

## 8. API / firmware contract

The plotter exposes an HTTP query API. Confirmed/known endpoints (GET):

### Motion config (persistent)
| Control | Endpoint | Default |
|---|---|---|
| Speed | `GET /api/speed?vmax=200000` | 200000 µstep/t |
| Accel | `GET /api/accel?amax=500` | 500 (AMAX = DMAX) |
| Current | `GET /api/cur?run=600&hold=200` | 600 mA run / 200 mA hold |

### Actions (one-shot) — query-string style as seen in the live log
| Action | Query |
|---|---|
| Move | `goto?x={x}&y={y}` |
| Line | `line?x0=&y0=&x1=&y1=&cycles=` |
| Square | `square?cx=&cy=&sz=&cycles=&fill={0\|1}&angle=&spacing=` |
| Circle | `circle?cx=&cy=&r=&cycles=&fill={0\|1}&angle=&spacing=` |
| Bullseye | `bullseye?cx=&cy=` |
| Grid | `grid?cx=&cy=` |
| Pen | `pen?pos={up\|down}` |
| Home | `home` |
| Set home | `sethome` |

### Proposed new endpoint (for the Work Area feature)
| Control | Endpoint |
|---|---|
| Bounds | `GET /api/bounds?l={left}&r={right}&u={up}&d={down}` |

> ⚠️ **Confirm with the firmware author:**
> 1. Whether action commands are also under `/api/` (the log shows bare `circle?…`; the motion table shows `/api/…`). Normalize the base path.
> 2. The exact `bounds` endpoint name/params (the above is a proposal).
> 3. Whether `fill` means *spiral inward* (circle) and *concentric rings* (square) — the prototype assumes so.
> 4. Response format: the prototype expects `ok`/queued text. The original UI crashed trying to `JSON.parse` a plain-text reply — **do not assume JSON** (see §10).

### Log stream
There is a separate **log/event stream** (the original showed "Log stream disconnected (reconnecting…)").
Implement as **SSE (`EventSource`) or WebSocket** with auto-reconnect. The StatusChip reflects this stream's
connection state and offers a manual reconnect. Commands dispatched while the link is down should be
**rejected client-side** with a clear `→ dropped (link down)` log line (don't silently queue against a dead link).

---

## 9. State & behavior

State the app owns (names from the reference's `usePlotter` hook):
- `pen: {x, y, down}` — current pen position + pen state.
- `moving: bool`, `connected: bool`.
- `motion: {vmax, amax, run, hold}` — config; defaults in §5.2.
- `bounds: {left, right, up, down}` — defaults 300/300/200/200.
- `paths: Stroke[]` — committed drawn polylines `{color, points:[{x,y}]}`.
- `activePath: Stroke | null` — the stroke being drawn right now.
- `queue: string[]` — pending command labels (for the count badge).
- `log: {id, kind, text, t}[]` — capped (~180 lines).
- Per-tab local form state for goto/circle/square/line/calib + jog step.

Behavior:
- **Dispatch:** build the query string, append a `cmd` log line (`> …`), call the endpoint. On success append an `ok` line; on link-down append an `err` `→ dropped (link down)` line and don't send.
- **Motion/bounds commit** fires on slider-release / number-blur / reset, not on every keystroke.
- **STOP** aborts the active motion, flushes the queue, releases the pen, and logs `!! STOP — queue flushed, motors released` (`warn`). Must be reachable at all times (header).
- **Pen-position rendering:** in production the page should reflect the machine's *reported* position from the log/telemetry stream, not a client-side guess. The prototype animates locally because it has no real machine — replace that with real telemetry/echo.

### What is simulated in the prototype (replace for production)
- The whole `animatePath` routine (interpolating the pen along computed points with a `setInterval` ticker) — this only exists to visualize without hardware. Production draws strokes from **real position telemetry**.
- The vmax→mm/s mapping used for animation speed.
- The connect/disconnect toggle (real = actual stream state).
- `buildPath()` geometry for circle/square/line/bullseye/grid is a **reasonable preview** of what the firmware will draw; the firmware is the source of truth for actual motion. Keep it only if you want a client-side path preview.

---

## 10. Error handling (explicit requirement — this was a defect in the original)
- The firmware may reply with **plain text, not JSON** (e.g. `Nothing matched`). **Never blindly `JSON.parse`.**
  Read as text first; parse as JSON only if the content-type/shape warrants it.
- Surface failures as a friendly `warn`/`err` log line, e.g. `sethome → "Nothing matched"`, not a raw
  `SyntaxError: Unexpected token 'N'… is not valid JSON`. Keep any raw detail behind a hover/expand if needed.

---

## 11. Design tokens

### Color (Tailwind `theme.extend.colors`)
```
ink.950 #0a0d11   ink.900 #0e1318   ink.850 #131a21   ink.800 #19222b
ink.750 #202b36   ink.700 #2a3845   ink.600 #3a4c5c   ink.500 #5b7186
ink.400 #7e95aa   ink.300 #a7bccd
go      #34d399  (dim #0f3a2c, soft #6ee7b7)   // success / pen-down / "go"
warn    #fbbf24  (dim #3d2f0a)                 // moving / caution
stop    #f87171  (dim #3a1414)                 // stop / errors / disconnected
cyanx   #38bdf8  (dim #0b2f44)                 // primary accent / pen-up
extra accents: #a78bfa (work area), #f472b6 (calibration), #fb923c (hold current)
```
Page background: `#0a0d11`.

### Typography
- **Sans:** "IBM Plex Sans" (UI labels, headings). Weights 400/500/600/700.
- **Mono:** "IBM Plex Mono" (all data, values, log, coordinates). Weights 400/500/600.
- Section titles: 11px, uppercase, letter-spacing 0.14em.
- Field labels: 10px uppercase, letter-spacing wider, `ink-500`.
- Readout values: 16px mono `ink-100`; log: 12.5px mono.

### Spacing / radius / motion
- Container max-width 1400px. Card radius `xl` (12px); inputs/buttons `lg` (8px).
- Grid/stack gaps mostly 12–16px; motion-slider rows 20px apart.
- Min hit target 44px (jog pad, primary buttons on mobile).
- Animations: `logIn` 0.18s (translate+fade, never to opacity 0); `pulse-ring` 1.8s on the connected dot; `blink` 1.1s on the STOP dot while moving. Respect `prefers-reduced-motion` for decorative loops.
- Custom scrollbars: track `ink-900`, thumb `ink-700` → hover `ink-600`.

---

## 12. Responsive
- **≥1024px:** two columns (state ~1.05fr / controls 1fr).
- **640–1024px:** single column; shape-form grids go to 3 columns where noted.
- **<640px:** single column; shape grids 2 columns; sub-line in header hidden; STOP + chip stay in the header.
  Consider a **sticky bottom STOP bar** for thumb reach on phones (recommended, not yet in prototype).

---

## 13. Files in this bundle (`reference/`)
- `Plotter Console.html` — entry: Tailwind config, fonts, global CSS (slider/scrollbar/animation), script load order.
- `console-sim.jsx` — `usePlotter` state machine, command→query serialization, path geometry, **simulated** drawing/animation. Replace the simulated parts with real API + telemetry.
- `console-components.jsx` — `Card, Btn, StopButton, StatusChip, NumField, ParamSlider, Toggle, FieldInline`.
- `console-canvas.jsx` — `PlotterCanvas` (live SVG), `BoundsControl` (4-direction cross), `LogView`.
- `console-app.jsx` — composition: header, columns, tabs, all cards, `Readout`, `JogPad`.

Open `Plotter Console.html` in a browser to interact with the reference.

---

## 14. Build checklist
- [ ] Confirm API base path + the `bounds` endpoint + `fill` semantics with firmware author (§8).
- [ ] Wire real GET calls for every command; **read responses as text, parse defensively** (§10).
- [ ] Implement log stream (SSE/WebSocket) + auto-reconnect; drive StatusChip + reject commands when down.
- [ ] Drive the canvas pen + drawn strokes from **real telemetry**, not the simulated animator.
- [ ] Keep STOP reachable everywhere; flush queue + release motors on press.
- [ ] Match tokens in §11 exactly (hi-fi).
- [ ] Verify on a phone; add sticky bottom STOP if building for remote mobile control.
- [ ] If flashed to the MCU offline: ship compiled Tailwind/CSS + bundled JS — no CDN, no in-browser Babel.
