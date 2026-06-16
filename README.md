# Polar Plotter

Firmware + tooling for a **hanging V‑plotter (polargraph)**: two stepper motors
suspend a pen gondola from GT2 belts, and a servo lifts/drops the pen. A
**Raspberry Pi Pico 2 W** drives a **TMC5072** dual stepper controller over SPI
and does *all* the geometry on‑device — belt‑length ↔ (x, y) math, time‑coordinated
moves, look‑ahead path streaming, and fill patterns — so there's **no PC in the
loop at draw time**.

Drive it three ways, all feeding the same draw queue:

- 🖥️ **USB‑serial console** — bring‑up, calibration, single commands
- 🌐 **WiFi HTTP API + web console** (Astro/React) — the everyday surface
- 🤖 **MCP server** — lets Claude paint autonomously

> **Platform note:** this is the **Pico 2 W / Pico SDK** line (current `main`).
> The earlier ESP32‑S3 / ESP‑IDF build is archived on the `ESP32-S3-bendy-line`
> branch. The board has **only a BOOTSEL button — no RESET.**

---

## ✨ What it does

**Drawing**
- Primitives: `goto`, `line`, `circle`, `square`, `wobbly` (random closed curve),
  `truchet` (Carlson winged‑tile tiling), plus `bullseye`/`grid`/`border` calibration aids.
- **Fills:** none · hatch (angled lines) · concentric — with optional outline and multi‑pass darkening (`cycles`).
- **Coordinated moves:** both motors reach target at the same instant (geometrically‑similar ramps), so belts never desync.
- **Streaming interpolation:** straight edges are sub‑segmented and issued with look‑ahead, so the gondola flows through a path and only truly stops at corners.
- **Work area:** rectangle *or* the inscribed **ellipse** (for machines whose reachable Y tapers toward the X extremes); out‑of‑area targets are rejected and strays clamped back onto the boundary.

**Run control**
- ⏸️ **Pause / resume** — parks pen‑up at the next job boundary and **holds the whole queue** for pen swaps / ink fixes, then continues in order.
- ⏹️ **STOP that keeps the queue** — halts motion immediately but *preserves* pending jobs (resume to continue); only an explicit abort flushes.
- 🚦 **Flow‑controlled batches** — the web console paces large scripts against the board's live queue depth so a 400‑command stack never overflows the 256‑job queue.
- 🛟 **Self‑healing drivers** — if the TMC is power‑cycled out from under the MCU (no RESET button!), the draw task detects the wiped config and re‑applies it before the next job (`reinit` also does it on demand).

**Health & observability**
- 🩺 **Driver‑fault supervision** — the motion task scans `DRV_STATUS`/`GSTAT` and latches on real faults (over‑temp, coil short, undervoltage), halting the job and surfacing flags; `clearfault` re‑enables once fixed.
- 📊 **Queue diagnostics** in `/api/status`: `pending` / `qcap` / cumulative `rejected` / `peak` high‑water mark.
- 📡 **Multi‑client SSE** — a live log + pen‑position stream (`/events`) that several browser tabs / clients can hold at once without kicking each other.

---

## 🧰 Hardware

| Part | Role |
|------|------|
| Raspberry Pi **Pico 2 W** (RP2350) | MCU — WiFi (CYW43439), USB, FreeRTOS |
| **TMC5072‑BOB** | Dual stepper controller/driver with integrated sixPoint ramp generator |
| **SG90** servo | Pen lift (up = 180°, down = 120°) |
| GT2 belt + 20‑tooth pulley | Drive train — 40 mm/rev |
| 12 V / 2 A supply | Motor power |

SPI is wired **direct** (no optocoupler), VCCIO = 3.3 V, shared ground. `CLK16`
must be tied to GND. Full wiring table + diagram → [`polar_plotter_wiring.md`](polar_plotter_wiring.md).
Pico‑specific bring‑up notes → [`PICO2W.md`](PICO2W.md).

---

## 🗂️ Repository layout

```
main/
  main.c          — app_main, bring-up, serial console, draw helpers, web_draw_task
  web_server.c    — HTTP API + multi-client SSE stream (FreeRTOS draw queue)
  web_server.h    — shared draw-command types + globals
  kinematics.h    — pure (x,y) mm ↔ microstep math (host-testable)
  board_config.h  — every pin / tuning constant in one place
components/
  tmc5072/        — register-level SPI driver (datasheet §6 map; no Arduino dep)
  servo/          — SG90 via PWM
console/          — Astro 4 + React 18 + Tailwind web UI  (npm run dev → :4321)
plotter-mcp/      — Node MCP server exposing the HTTP API as tools (index.js)
tools/
  kinematics_test/ — host-runnable geometry unit test
  weave/           — pattern generator
lwipopts.h · FreeRTOSConfig.h · pico_sdk_import.cmake · CMakeLists.txt
```

Deep architecture notes & hard‑won bring‑up lessons live in [`CLAUDE.md`](CLAUDE.md).

---

## 🔨 Build & flash

Requires the Pico SDK (set `PICO_SDK_PATH`) and CMake.

```bash
# configure (first time) + build
cmake -B build -DPICO_BOARD=pico2_w
cmake --build build
# → build/main/polar_plotter.uf2

# flash: hold BOOTSEL while plugging in USB → board mounts as RPI-RP2 →
#   drag build/main/polar_plotter.uf2 onto it (it reboots itself)
# or:
picotool load -fx build/main/polar_plotter.uf2
```

The boot log prints a build marker (`[build] <date> <time> …`) so you can confirm
the running firmware is the one you just flashed.

**Geometry dry‑run** (no hardware): `cc tools/kinematics_test/test_kinematics.c -o /tmp/ktest -lm && /tmp/ktest`.

---

## 🌐 Web console

```bash
cd console
npm install
npm run dev          # → http://localhost:4321
```

Set the plotter's IP in the header. The console opens `GET /events` (SSE) for live
log + pen position and sends draw commands to `GET /api/<cmd>?<params>`.

Tabs: **Draw** · **Move** (goto + jog pad) · **Work Area** (bounds + rect/ellipse) ·
**Calibrate** (walk‑limits, bullseye) · **Autonomous** (job progress, driver
health, errors) · **Script** (paste a JSON command list, sent flow‑controlled).
A header **PAUSE/RESUME** (hold), **STOP** (halt, keep queue), and **CLEAR**
(flush the queue) drive the machine regardless of tab; STOP/CLEAR also halt the
in-flight script batch.

---

## 🤖 Autonomous (MCP)

`plotter-mcp/` exposes the HTTP API as MCP tools so Claude can paint on its own.
Set `PLOTTER_IP` / `PLOTTER_PORT` and register it in `.mcp.json`.

- Drawing: `plot_goto/line/circle/square/wobbly/truchet/bullseye/grid/border`
- Control: `plot_pen/home/sethome/stop/abort`, `plot_pause/plot_resume`, `plot_set_speed/accel/current`, `plot_clear_fault`
- Orchestration: **`plot_script`** runs an ordered list, waiting for each job to *physically* finish (and pausing on a driver fault) before the next
- Introspection: **`plot_status`** reports the coordinate frame, work‑area bounds, live position, queue health, and driver state

The server ships with built‑in **coordinate guidance** (origin at top midpoint,
`X+` right, **`Y+` down / `Y-` up**) and a directive to always read live bounds and
stay inside them. Agent playbook → [`plotter-mcp/AGENT_GUIDE.md`](plotter-mcp/AGENT_GUIDE.md).

---

## ⌨️ Serial console commands

| Command | What it does |
|---------|-------------|
| `link` / `status` | SPI link check (`VERSION 0x10`) / full register dump |
| `reinit` | Re‑apply TMC config after a driver power‑cycle |
| `belt <x> <y>` | **Dry run** — print belt lengths + motor targets, no motion |
| `goto <x> <y>` | Move gondola to (x, y) mm |
| `line` / `circle` / `square` / `wobbly` / `truchet` | Draw primitives (see web/MCP for full params) |
| `bullseye` / `grid` / `border` | Calibration aids |
| `where` | Read XACTUAL back as (x, y) mm |
| `jog <1\|2> <vel>` / `stop [1\|2]` | Velocity jog for sign‑checking / decelerate |
| `pen <up\|down\|deg>` · `en <0\|1>` | Servo / driver enable |
| `cur <run> [hold]` · `speed <vmax>` · `accel <amax>` | Motion tuning |
| `setbelt` / `setspan` / `setsteps` / `setbounds` | Runtime geometry & work‑area |
| `sethome` · `home` | Set origin here · return to origin |
| `jobs` · `estop` | Queue snapshot · escape (stop + flush + pen up) |

---

## 📐 Geometry

```
 M_left                              M_right
   |                                   |
   |<--- belt_left --->  <--- belt_right --->|
                     [ gondola ]
                origin (0,0) = midpoint between anchors
                     X+ → right     Y+ → down
```

```
steps/mm = (200 steps/rev × 256 µsteps) / (20 teeth × 2 mm/tooth) = 1280
```

Defaults (`board_config.h`, all runtime‑tunable): `MOTOR_SPAN_MM = 978`,
`HOME_BELT_MM = 715`, run/hold current 600 / 200 mA. The vertical drop is derived
on boot from the home belt length.

### Calibration
1. Measure the motor→gondola belt length with the gondola at the midpoint (both belts equal) → set `HOME_BELT_MM`.
2. Bring the TMC up *before* the MCU configures it (or run `reinit`).
3. `belt 0 0` (dry run) to sanity‑check direction signs.
4. Park the gondola at the midpoint, run `sethome`.
5. `goto 0 100` (Y check) and `goto 100 0` (X stays level).

`square 0 0 100` is the most revealing test — bowed horizontal edges point at
`MOTOR_SPAN_MM`. Tune the geometry constants (not code); see [`CLAUDE.md`](CLAUDE.md)
for the full diagnosis procedure.

---

## 🧠 Design notes

- **Coordinated moves** keep belts in sync by scaling the shorter‑travel motor's ramp so both finish together — no explicit timing math.
- **Streaming line interpolation** issues sub‑segments with look‑ahead so the pen flows through paths and only stops at corners.
- **Multi‑client SSE** hands each `/events` socket to a broadcast task that serves several clients and reaps dead ones — reconnects never kick the live stream.
- **WiFi tuned for responsiveness** — `MEMP_NUM_NETCONN` sized to the socket count and CYW43 power‑save disabled (see the post‑mortem in [`TCP_PCB_EXHAUSTION_BUG.md`](TCP_PCB_EXHAUSTION_BUG.md)).
- **Native motion** uses the TMC5072's on‑chip sixPoint ramp generator (`RAMPMODE=0`) — write `XTARGET`, the chip ramps there; no STEP/DIR. Background → [`docs/motion_native_tmc5072.md`](docs/motion_native_tmc5072.md).

---

## 📚 Docs index

| File | Contents |
|------|----------|
| [`CLAUDE.md`](CLAUDE.md) | Architecture, bring‑up history, gotchas, calibration deep‑dive |
| [`PICO2W.md`](PICO2W.md) | Pico 2 W bring‑up specifics |
| [`polar_plotter_wiring.md`](polar_plotter_wiring.md) | Wiring table + diagram |
| [`plotter-mcp/AGENT_GUIDE.md`](plotter-mcp/AGENT_GUIDE.md) | How an agent should drive the plotter |
| [`docs/motion_native_tmc5072.md`](docs/motion_native_tmc5072.md) | Native ramp‑generator motion |
| [`TCP_PCB_EXHAUSTION_BUG.md`](TCP_PCB_EXHAUSTION_BUG.md) | WiFi/HTTP reliability post‑mortem |
