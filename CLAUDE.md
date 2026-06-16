# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Firmware for a **polar plotter**: an **ESP32-S3 Nano** drives a **TMC5072** dual stepper controller/driver over a **direct 3.3 V SPI bus** (VCCIO = 3.3 V, shared ground), plus an **SG90 servo** for pen lift. Hardware wiring is documented in `polar_plotter_wiring.md`; vendor datasheets are in `docs/` (`3119171.pdf` = TMC5072, `product_808.pdf` = ESP32-S3 Nano / NanoS3).

Built with **ESP-IDF** (target `esp32s3`). Three control surfaces, all driving the same draw queue: the **USB-serial console** (bring-up/calibration), a **WiFi HTTP API + web console** (`console/`, Astro/React), and an **MCP server** (`plotter-mcp/`) that lets Claude paint autonomously. USB is only needed for flashing — normal operation is over WiFi.

## Build / flash / monitor

ESP-IDF is checked out at `~/esp/esp-idf`. Every shell needs it activated first:

```bash
. ~/esp/esp-idf/export.sh
```

> One-time setup: the toolchain/Python env is **not installed yet**. Run `~/esp/esp-idf/install.sh esp32s3` once (large download) before the first build.

```bash
idf.py set-target esp32s3   # first time only
idf.py build
idf.py -p <PORT> flash monitor   # PORT e.g. /dev/cu.usbmodemXXXX (native USB-Serial-JTAG)
idf.py menuconfig
```

"Running" means flashing to the board and watching the serial log: `app_main` in `main/main.c` does a safe bring-up (no motor motion) then opens the console. The one host-runnable test is the kinematics dry run: `cc tools/kinematics_test/test_kinematics.c -o /tmp/ktest -lm && /tmp/ktest` — keep it passing before flashing geometry changes.

## Architecture

- **`components/tmc5072/`** — self-contained register-level driver (no Arduino/TMCStepper dependency, which doesn't cover the 5072). `tmc5072.h` holds the full datasheet §6 register map. Key design points:
  - The 5072 is **dual** — almost every register exists per-motor. Per-motor macros take `m = 0` (driver 1) or `m = 1` (driver 2); **the address stride differs per register group**, so each group encodes its own offset. Don't assume a single uniform offset.
  - SPI is **40-bit, mode 3, MSB-first**. Writes OR the address with `0x80`. **Reads are two-phase**: the first transfer latches the address, the data returns on the *second*. The first reply byte is the SPI status.
  - Uses the **integrated sixPoint motion controller** (`RAMPMODE=0`): you write `XTARGET` and the chip ramps there. No STEP/DIR — consistent with the wiring (SPI + ENN only).
  - **Coordinated moves** (`tmc5072_move_coordinated`): writes both motors' targets so they finish at the **same time** by scaling the shorter-travel motor's ramp by its distance ratio (geometrically-similar ramps take equal time — no explicit T math). Every gondola move goes through this; single-motor positioning helpers were deliberately removed because they desync the belts / clobber the origin.
  - `position_reached` uses `RAMP_STAT` bit 9 (the chip's own flag). Velocity mode (`tmc5072_move_velocity`/`_stop`) + an experimental stallGuard2 sensorless-home (`tmc5072_home_stallguard`) also exist.
  - **`tmc5072_set_accel`** scales the WHOLE ramp, not just `AMAX`/`DMAX`: it also sets `A1`/`D1` (the sub-`V1` ramp legs) at the proven default ratio (`A1=2×`, `D1=2.8×`). The chip's 6-point ramp uses `A1` below `V1` (50000) and only `AMAX` above it — and streamed `goto`/`line` sub-segments live below `V1`, so without this the accel setting had no effect on them.
- **`components/servo/`** — SG90 via the LEDC peripheral (50 Hz, 14-bit). `servo_write_deg()` / `servo_write_us()`.
- **`main/`** — `board_config.h` (all pin/tuning constants), `main.c` (`app_main` bring-up + console + `web_draw_task`), **`web_server.c/.h`** (HTTP API + SSE), and **`kinematics.h`** (pure, dependency-free polargraph (x,y)↔microstep math, also host-tested by `tools/kinematics_test/`).
- **`main/web_server.c`** — WiFi HTTP API + SSE log/position stream. All draw endpoints push a `wcmd_t` onto `g_draw_queue` (consumed by `web_draw_task` in main.c — the single task that owns the motors) and return a monotonic job id; clients poll `/api/status` until `done >= id`. SSE is handed to a dedicated `sse_task` so the one httpd worker is never blocked. **Console and web/MCP share the motors with no mutex — don't drive from the serial console and WiFi simultaneously.**
- **`console/`** — Astro 4 + React 18 + Tailwind web UI (`npm run dev` → :4321). Talks only to the firmware over HTTP + SSE; IP is set in the header. Tabs: Draw / Move / Work Area / Calibrate / **Autonomous** (job progress + driver health + an errors panel).
- **`plotter-mcp/`** — Node MCP server (`index.js`) exposing the HTTP API as tools for Claude. `plot_script` runs an ordered list, waiting for each job to physically finish (job-id polling) before the next. See `AGENT_GUIDE.md`.

### Drawing & calibration console
The firmware does the (x,y) mm ↔ belt-length ↔ microstep geometry itself (no PC needed). Key commands: `belt <x> <y>` (DRY RUN — prints targets, no motion; use first), `goto <x> <y>`, `line`/`circle`/`square` (each takes an optional trailing `[cycles]` to retrace and darken a faint pen), `where` (XACTUAL→mm), `jog`/`stop` (velocity jog for sign-checking), `sethome` (the ONLY origin-setter: bare = manual zero-both-here; `sethome sg <m> <vel> [sgt]` = experimental stallGuard home). Straight edges are sub-segmented (`LINE_SEG_MM`) and **streamed with look-ahead** (`LINE_LOOKAHEAD_MM`) so motion flows instead of stopping at every sub-point, with a true stop only at corners.

### Work-area shape & the limit path
The drawable area is the rectangle `[x_min,x_max]×[y_min,y_max]` (set via `setbounds` or `/api/bounds`). It can instead be the **ellipse inscribed in that box** (`shape=1` / the console's Work Area "Ellipse" toggle) — for a machine whose reachable Y is tallest at the centre X and tapers toward the X extremes. `plotter_in_bounds()` rejects out-of-area targets; `clamp_xy()` projects strays back onto the boundary (radially, for the ellipse). The **`border` command** (`/api/border`, `plot_border`, console "Walk limits") traces the active boundary once pen-down — a calibration aid that draws exactly where the firmware thinks the edge is.

### Driver-fault supervision (over WiFi)
`/api/status` reports `drv_ok` + `drv_flags`. The motion task scans `DRV_STATUS`/`GSTAT` (`driver_fault_scan`, throttled, motion-task-only to avoid SPI contention) and on a **real** fault — `OT` (over-temp), `s2ga`/`s2gb` (coil short), `GSTAT drv_err`/`uv_cp` — latches `g_drv_fault`, logs once, and trips the escape path. The masked-out `stst`/`STALL`/`openload` bits are documented standstill false-positives. The MCP halts the current job and pauses a `plot_script` on a fault; `/api/clearfault` (`plot_clear_fault`) re-enables the drivers (clears latched shorts) and resets the latch so a script can resume after the cause is fixed.

## Things that will bite you (verify before powering motors)

- **Pin map (verified):** the board is a **Waveshare ESP32-S3-Nano** (Arduino Nano ESP32 map) — silkscreen labels are NOT 1:1 with GPIOs. Verified from its schematic: `SCK`→GPIO48, `MOSI`→GPIO38, `MISO`→GPIO47, `D10`→GPIO21, `D5`→GPIO8, `D6`→GPIO9. The SPI header pins are labeled `SCK`/`MOSI`/`MISO` (= D13/D11/D12), so wire to those, not to pins labeled D11/D12/D13 (which don't exist). `board_config.h` uses the GPIO numbers.
- **SPI is wired direct (no optocoupler).** An earlier build put a PC817 8-channel opto on the bus; PC817s cut off at ~80 kHz and invert, so SPI returned all `0x00`. The bus is now ESP32↔TMC direct with **VCCIO = 3.3 V** and **shared ground**. `TMC_SPI_HZ` defaults to 1 MHz and can go to several MHz. If isolation is ever needed, use a fast digital isolator (ADuM140x/Si86xx), never a PC817.
- **ENN is direct, active-LOW.** The ESP32 drives D5 LOW to enable the drivers (`ENN_ON_LEVEL = 0`).
- **`R_SENSE` is unverified (`0.15 Ω` in `board_config.h`) — the prime suspect for motors overheating.** The firmware computes coil current *assuming* this value; if the real resistor is smaller, it silently over-drives the coils (e.g. real 0.075 Ω → ~1 A for a commanded 600 mA). Fix: set a known current, read actual coil current with a meter, adjust `R_SENSE` until the console's "estimated mA" matches. Until verified, keep run current low (see Power/current). The old TMC2226 board used 0.11 Ω.
- **Ramp registers `D1` and `VSTOP` must never be 0** in positioning mode (datasheet §6.2.1).

## Bring-up status & hard-won lessons (as of 2026-06-08)

**🎉 BRING-UP COMPLETE — first motion confirmed (2026-06-08).** Full chain proven on real hardware via the console:
- `status` → both drivers report `CHOPCONF=0x000100c3`, `GSTAT=0`, no fault flags
- `cur 300` → current control (IRUN/IHOLD) confirmed correct
- both motors physically rotate via the integrated ramp generator (originally proven with a `wig` command, since removed — use `goto`/`jog` now)
- `pen up` / `pen down` → SG90 pen servo moves to configured angles

Note: `status` shows `openloadA`/`openloadB` set **at standstill** (`stst` also set) — this is a **known false positive** in Trinamic open-load detection (the comparator only works meaningfully while the chopper is actively switching during motion, not at hold). Not a wiring fault. Only worth investigating if the flag persists *while the motor is actively turning*.

**Since bring-up:** the WiFi HTTP API, the Astro web console, the MCP server, driver-fault supervision, elliptical work-area + limit-path tracing, and the full-ramp accel fix are all in. The remaining open item is **geometry calibration** (the bowed-square issue below).

**SPI comms to the TMC5072 are confirmed working**: `link` returns `VERSION=0x10`, status byte `0x19`, and `status` shows no driver fault flags. The debugging journey, so it isn't repeated:

- **No optocoupler on SPI.** The PC817 8-channel board can't carry SPI (~80 kHz cutoff + inverting → every read came back `0x00`). Bus is now direct, `VCCIO=3.3 V`, shared ground. See the wiring guide.
- **Pin map** — Waveshare = Arduino-Nano-ESP32 map; the SPI pins are silkscreened `SCK`/`MOSI`/`MISO` (= D13/D11/D12). GPIOs 48/38/47/21/8/9. See "Things that will bite you".
- **TMC5072-BOB V1.2 layout.** Left header (top→bottom): `VCCIO, GND, ENC1A, ENC1B, ENC1N, CSN, SCK, SDI, SDO, CLK16, ENN, ENC2A, ENC2B, ENC2N`. **`SWSEL` and `TST_MODE` are hardwired on the PCB** (SPI mode / normal operation) — they are *not* on the header, so don't go hunting for them. **`CLK16` must be tied to GND.**
- **CLK16 oscillator latch — the final fix.** Datasheet: *"the first HIGH signal on CLK disables the internal oscillator until power down."* If CLK16 floated high before you grounded it, the TMC won't answer SPI (reads `0xFF`) until a **full power-cycle of the 12 V supply** — an ESP reset/reflash is NOT enough. This is what finally brought the link up.
- **Config only runs at boot.** `tmc5072_config_motor()` writes `CHOPCONF=0x000100C3` etc. in the boot bring-up. If the ESP boots while the TMC is dead/unpowered, those writes go nowhere and registers stay at reset defaults (`CHOPCONF=0x00`, output disabled). Reboot the ESP *after* the TMC is live so config actually lands.

### Toolchain / flashing gotchas
- **macOS TCC:** the project under `~/Documents` (a protected folder) made `idf.py`/`esptool` fail with `os.getcwd() … PermissionError: EPERM`. Fix: grant the terminal app **Full Disk Access** (then fully quit + reopen it), or move the project out of `~/Documents`. Build works once granted.
- **USB-Serial-JTAG re-enumerates** after resets — `/dev/cu.usbmodemNNN` can change or vanish. Close any open monitor first (it holds the port). Avoid spamming RTS resets — they drop the USB device.
- **✅ FLASHING BLOCKER RESOLVED (2026-06-08).** Was: *"Could not open /dev/cu.usbmodemNNN, the port is busy or doesn't exist"* / "No serial data received" — the ESP32-S3 **native-USB auto-reset race** (`--before=default_reset` toggles DTR/RTS → USB re-enumerates, port number changes e.g. `101`→`1101` → esptool loses the port before completing the handshake). **Working fix:** put the board in **manual download mode** (hold `BOOT`/B0, tap `RESET`, release `BOOT`), recheck `ls /dev/cu.usbmodem*` for the current port name, then **`idf.py -p <port> -b 115200 flash`** (flash only, no monitor). Press `RESET` to boot normally, then `idf.py -p <port> monitor` as a separate command (monitor's baud is fixed by firmware console config — it doesn't take `-b`).
  - **Use `-b 115200` by default for all `idf.py ... flash` commands on this project** — the default 460800 baud was part of what triggered the race.
- **The agent's shell cannot see `/dev/cu.usbmodem*`** (sandbox doesn't expose the device node), so flashing/monitoring must be done by the user from their own terminal.

### Bring-up command sequence (for reference / re-flashing)
With the TMC live: `status` (expect `CHOPCONF 0x000100C3`) → `cur 300` → `jog 1 20000` / `stop 1` (confirm a motor turns) → `pen up` / `pen down`. Then calibrate: `belt 0 0` (dry run) → place gondola at the midpoint origin → `sethome` → `goto`/`line`/`circle`/`square`.

## Mechanical setup & calibration

**Same physical machine as the sibling `../wall-plotter`** — only the MCU + driver changed (Uno R4 + TMC2226/UART → ESP32-S3 + TMC5072/SPI). The geometry, drive train, and pen mechanism are unchanged. Values below come from that project's print firmware (`firmware/plotter/plotter.ino`) and `docs/belt_pully_info.jpg`.

**Drive train**
- Belt **GT2, 2 mm pitch**; pulley **Flomore GT2, 20 teeth**, 5 mm bore, 6 mm width.
- Belt travel per motor revolution = 20 × 2 mm = **40 mm/rev**.
- Steppers are 1.8° → **200 full steps/rev**.
- **steps/mm = (200 × microsteps) / 40 = 5 × microsteps**
  - 16 µsteps (old TMC2226 firmware) → **80 steps/mm**
  - **256 µsteps (TMC5072 native, this firmware's default) → 1280 steps/mm**
- Equivalent "spool radius" in the cord-length math = 40/(2π) = **6.366 mm**.

**Geometry (V-plotter / polargraph)** — implemented firmware-side in `main/kinematics.h` (pure, host-testable; see `tools/kinematics_test/`). Constants live in `board_config.h`.
- Two motors anchored at the top corners; gondola hangs from two belts.
- Motor span (anchor-to-anchor): **985 mm** (`MOTOR_SPAN_MM`). The older calibration.ino used 895 mm — the print firmware's 985 is authoritative, but re-measure for this build.
- Origin (0,0) = **midpoint between the anchors**. X+ = right, Y+ = down. **Defined by the measured belt length, not the drop:** set `HOME_BELT_MM` = the belt length (motor→gondola) with the gondola parked at the midpoint — both belts are equal there, so one tape measurement defines home. Current build: **`HOME_BELT_MM = 700 mm`**. The firmware derives the vertical drop at startup: `drop = √(HOME_BELT_MM² − (span/2)²)` = √(700² − 492.5²) ≈ **497.44 mm** (logged on boot). (The earlier convention specified a 400 mm drop directly → 634.5 mm belts; superseded because the belt is far easier to measure than the drop.)
- Motor A = right anchor (`MOTOR_RHO`), Motor B = left anchor (`MOTOR_THETA`); **B is mirror-mounted** (unwind direction is opposite A). The per-motor step-direction signs `LEFT_DIR_SIGN`/`RIGHT_DIR_SIGN` (both `+1` by default) capture this and **must be confirmed on hardware** — verify with the `belt` dry-run + `jog` before trusting `goto`.

**Console (Python-free calibration):** `belt <x> <y>` (dry run — prints belt lengths + motor targets, no motion), `goto <x> <y>` (coordinated move via kinematics), `line`/`circle`/`square` (with optional `[cycles]`), `where` (read XACTUAL back as mm), `jog`/`stop` (velocity-mode jog), `sethome` (set origin).

**Homing** — no endstops / no sensorless homing yet. It is **manual**: physically place the gondola at the midpoint origin (both belts = `HOME_BELT_MM`), then run **`sethome`** to zero XACTUAL there. From then on XTARGET=0 = true origin. `sethome` is the ONLY origin-setter (the old `setorigin`/`shome` were merged into it; bare `sethome` = manual zero-both, `sethome sg <m> <vel> [sgt]` = experimental stallGuard2 home). stallGuard2 (datasheet §12) is scaffolded in `tmc5072_home_stallguard()` but **experimental** — SGT needs per-machine tuning.

**⚠️ Open calibration issue (drawn square bows):** a commanded square comes out with bowed horizontal edges and non-90° corners (2 obtuse / 2 acute), **mirror-symmetric about the Y axis, straight down the vertical centerline.** With the Cartesian interpolation in place, that signature = a wrong **shared, symmetric** geometry constant, not a code bug. Prime suspect is **`MOTOR_SPAN_MM`** (the carried-over 985 guess — measure between the two belt *take-off* points, not shaft centers). `STEPS_PER_MM` is derived (200·256/40=1280; only wrong if pulley teeth/belt pitch differ); `HOME_BELT_MM` was measured. Diagnose: `goto 0 100` should drop ~100 mm (immune to span error → isolates steps/mm); `goto ±100 0` should stay level (sag/rise ⇒ span too small/large). Second-order residual after span: pen-tip offset from the belt convergence point, and finite belt wrap on the pulley.

**Pen servo** — up = **180°**, down = **120°**, ~200 ms dwell (in `board_config.h`).

**Power / current** — shared **12 V / 2 A** supply across both motors. Defaults: **RUN = 400 mA, HOLD = 200 mA** (`board_config.h`). RUN was de-rated from 600 mA because a pen gondola needs little torque and run current is the heat source during a multi-hour plot — and because `R_SENSE` is unverified (see above), so the *true* current may exceed the setpoint. HOLD is kept at 200 mA on purpose: a hanging V-plotter needs holding torque or the gondola slips when idle. Don't crank RUN back up without verifying `R_SENSE` against measured coil current. Driver over-temp is now caught (see "Driver-fault supervision"), but a motor can overheat well before the driver's ~150 °C OT trips — current is the lever.

## Hardware reference

- Wiring, wire colors, and the ASCII diagram: `polar_plotter_wiring.md`.
- TMC5072 register details: `docs/3119171.pdf` §6 (p.27 general/ramp, p.41 motor-driver, p.88 quick-config). **stallGuard2** (§12) enables sensorless homing — a possible alternative to endstops.

## MCP servers (`.mcp.json`)

- **polar-plotter** (`plotter-mcp/index.js`) — the plotter's own HTTP API as tools: `plot_goto/line/circle/square/wobbly/truchet/bullseye/grid/border`, `plot_pen/home/sethome/stop/abort`, `plot_pause/resume` (queue-preserving hold vs the flush of stop/abort), `plot_set_speed/accel/current`, `plot_clear_fault`, `plot_status` (bounds + position + queue health: pending/qcap/rejected/peak + paused), and `plot_script` (ordered, wait-till-done, flow-controlled batch). Talks over WiFi (`PLOTTER_IP`/`PLOTTER_PORT` env, default `192.168.1.71`). See `plotter-mcp/AGENT_GUIDE.md`.
- **context7** — pull current docs for ESP-IDF / Trinamic APIs (the 5072 has thin third-party library coverage).
- **playwright** — for testing the WiFi web console.
