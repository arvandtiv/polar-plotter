# Polar Plotter

ESP32-S3 firmware for a V-plotter (polargraph): two stepper motors suspend a
gondola from belts, an SG90 servo lifts/drops the pen. The firmware handles all
geometry — belt-length ↔ (x,y) mm math, coordinated moves, and fill patterns —
so no PC processing is needed at draw time.

---

## Hardware

| Part | Role |
|------|------|
| Waveshare ESP32-S3 Nano | MCU — WiFi, USB-Serial-JTAG, console |
| TMC5072-BOB | Dual stepper controller/driver (integrated ramp generator) |
| SG90 servo | Pen lift |
| GT2 belt, 20-tooth pulley | Drive train (40 mm/rev) |
| 12 V / 2 A supply | Motor power |

SPI bus is **direct** (no optocoupler), VCCIO = 3.3 V, shared ground.
Full wiring table and colour-coded diagram: [`polar_plotter_wiring.md`](polar_plotter_wiring.md).

---

## Repository layout

```
main/
  main.c          — app_main, console commands, draw helpers, web_draw_task
  web_server.c    — HTTP API + SSE log stream (async SSE, FreeRTOS queue)
  kinematics.h    — pure (x,y) mm ↔ microstep math, host-testable
  board_config.h  — all pin/tuning constants in one place

components/
  tmc5072/        — register-level SPI driver (no Arduino dependency)
  servo/          — SG90 via LEDC (50 Hz, 14-bit)

console/          — Astro 4 + React 18 + Tailwind web UI (npm run dev → :4321)
plotter-mcp/      — MCP server: exposes the HTTP API as tools for Claude (index.js)

tools/
  kinematics_test/ — host-runnable geometry unit test
  weave/           — pattern generator
```

---

## Build & flash

Requires ESP-IDF (checked out at `~/esp/esp-idf`).

```bash
# one-time toolchain install
~/esp/esp-idf/install.sh esp32s3

# activate the IDF environment (every new shell)
. ~/esp/esp-idf/export.sh

# build
idf.py set-target esp32s3   # first time only
idf.py build

# flash  (manual download mode: hold BOOT, tap RESET, release BOOT)
idf.py -p /dev/cu.usbmodemXXXX -b 115200 flash

# monitor (separate command after RESET)
idf.py -p /dev/cu.usbmodemXXXX monitor
```

> **macOS:** grant the terminal Full Disk Access if the project lives under
> `~/Documents` (otherwise `idf.py` hits a `getcwd EPERM`).

---

## Web console

```bash
cd console
npm install
npm run dev          # → http://localhost:4321
```

Enter the plotter's IP in the header (`192.168.1.53` by default).
The console connects to `GET /events` (SSE) for live log output and pen position,
and sends draw commands to `GET /api/<cmd>?<params>`.

Tabs: **Draw** (circle/square/line/wobbly), **Move** (goto + jog pad), **Work Area**
(bounds + rectangle/ellipse shape toggle), **Calibrate** (walk-limits + bullseye/grid),
and **Autonomous** (live job progress, driver health, and an errors panel).

---

## Autonomous (MCP)

`plotter-mcp/` exposes the HTTP API as MCP tools so Claude can paint on its own.
Configure the plotter address with `PLOTTER_IP` / `PLOTTER_PORT`; register it in
`.mcp.json`. The main tool is `plot_script` (an ordered command list that waits for
each job to physically finish before sending the next). It **pauses on a TMC5072
driver fault** (over-temp, coil short) and reports it; resume with `plot_clear_fault`
once the cause is fixed. See [`plotter-mcp/AGENT_GUIDE.md`](plotter-mcp/AGENT_GUIDE.md).

---

## Console commands (serial)

| Command | What it does |
|---------|-------------|
| `link` | SPI link check — VERSION should be `0x10` |
| `status` | Full register dump (CHOPCONF, currents, DRV_STATUS) |
| `belt <x> <y>` | **Dry run** — prints belt lengths + motor targets without moving |
| `goto <x> <y>` | Move gondola to (x, y) mm |
| `line x0 y0 x1 y1 [cycles]` | Draw a straight line |
| `circle cx cy r [cycles] [fill] [angle] [spacing] [outline]` | Draw a circle |
| `square cx cy size [cycles] [fill] [angle] [spacing] [outline]` | Draw a square |
| `where` | Read XACTUAL back as (x, y) mm |
| `jog <1\|2> <vel>` | Velocity jog for sign-checking |
| `stop [1\|2]` | Decelerate to standstill |
| `pen <up\|down\|deg>` | Servo position |
| `cur <run_mA> [hold_mA]` | Set motor current |
| `speed <vmax>` | Set VMAX |
| `sethome` | Zero both motors here (manual origin calibration) |
| `home` | Return to XTARGET = 0 |

`fill`: `0` = none · `1` = hatch · `2` = concentric. `outline`: `1` = draw perimeter (default) · `0` = fill only.

---

## Calibration

1. Measure the belt length from each motor to the gondola with the gondola at
   the geometric midpoint (both belts equal). Set `HOME_BELT_MM` in `board_config.h`.
2. Power up the TMC before booting the ESP32 (config writes happen at boot).
3. `belt 0 0` — dry run to verify the geometry signs look right.
4. Physically place the gondola at the midpoint and run `sethome`.
5. `goto 0 100` to verify Y movement; `goto 100 0` to verify X level.

The drawn shape that most reliably exposes calibration errors is `square 0 0 100` —
bowed horizontal edges mean `MOTOR_SPAN_MM` is wrong; see `CLAUDE.md` for the
full diagnosis procedure.

---

## Key design notes

**Coordinated moves** — every gondola move writes both motors' `XTARGET` values
scaled so they finish at the same time (geometrically-similar ramps = equal duration).
This keeps the belts synchronised without any explicit timing math.

**Streaming line interpolation** — straight lines are split into ≤ `LINE_SEG_MM`
segments and issued with look-ahead (`LINE_LOOKAHEAD_MM`) so the gondola never
fully decelerates between sub-points. Only the last point of each shape gets a
true stop.

**Async SSE** — the HTTP server has one worker task. The SSE handler immediately
hands off the long-lived connection to a dedicated `sse_task` via an async handler,
so `GET /api/goto` can be served while the stream is open.

**SPI gotchas** — CLK16 must be tied to GND (internal oscillator) and requires a
full 12 V power-cycle if it ever floats high. See `CLAUDE.md` "hard-won lessons"
for the full bring-up history.

---

## Geometry

V-plotter (polargraph) with motors at the top two corners:

```
 M_left                          M_right
   |                               |
   |<-- belt_left -->  <-belt_right-->|
                    [gondola]
                    origin (0,0) = midpoint
                    X+ right   Y+ down
```

`steps/mm = (200 steps/rev × 256 µsteps) / (20 teeth × 2 mm/tooth) = 1280`

Motor span, home belt length and steps/mm are all tunable at runtime via
`setspan`, `setbelt`, and `setsteps` — re-measure and tune these (not code) to
fix calibration drift.

**Work area** can be a rectangle or the inscribed **ellipse** (for a machine whose
reachable Y is tallest at center X and tapers toward the edges) — set via `setbounds`
/ `/api/bounds?shape=` or the console Work Area tab. The `border` command / "Walk
limits" button traces the active boundary once so you can compare it to the real machine.
