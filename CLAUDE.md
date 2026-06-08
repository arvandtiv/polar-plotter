# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Firmware for a **polar plotter**: an **ESP32-S3 Nano** drives a **TMC5072** dual stepper controller/driver over a **direct 3.3 V SPI bus** (VCCIO = 3.3 V, shared ground), plus an **SG90 servo** for pen lift. Hardware wiring is documented in `polar_plotter_wiring.md`; vendor datasheets are in `docs/` (`3119171.pdf` = TMC5072, `product_808.pdf` = ESP32-S3 Nano / NanoS3).

Built with **ESP-IDF** (target `esp32s3`). Control plan: USB-serial bring-up first, a WiFi web UI later.

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

There are no unit tests yet; "running" means flashing to the board and watching the serial log (`app_main` in `main/main.c` does a bring-up self-test).

## Architecture

- **`components/tmc5072/`** — self-contained register-level driver (no Arduino/TMCStepper dependency, which doesn't cover the 5072). `tmc5072.h` holds the full datasheet §6 register map. Key design points:
  - The 5072 is **dual** — almost every register exists per-motor. Per-motor macros take `m = 0` (driver 1) or `m = 1` (driver 2); **the address stride differs per register group**, so each group encodes its own offset. Don't assume a single uniform offset.
  - SPI is **40-bit, mode 3, MSB-first**. Writes OR the address with `0x80`. **Reads are two-phase**: the first transfer latches the address, the data returns on the *second*. The first reply byte is the SPI status.
  - Uses the **integrated sixPoint motion controller** (`RAMPMODE=0`): you write `XTARGET` and the chip ramps there. No STEP/DIR — consistent with the wiring (SPI + ENN only).
- **`components/servo/`** — SG90 via the LEDC peripheral (50 Hz, 14-bit). `servo_write_deg()` / `servo_write_us()`.
- **`main/`** — `board_config.h` (all pin/tuning constants) + `main.c` (`app_main` bring-up).

## Things that will bite you (verify before powering motors)

- **Pin map (verified):** the board is a **Waveshare ESP32-S3-Nano** (Arduino Nano ESP32 map) — silkscreen labels are NOT 1:1 with GPIOs. Verified from its schematic: `SCK`→GPIO48, `MOSI`→GPIO38, `MISO`→GPIO47, `D10`→GPIO21, `D5`→GPIO8, `D6`→GPIO9. The SPI header pins are labeled `SCK`/`MOSI`/`MISO` (= D13/D11/D12), so wire to those, not to pins labeled D11/D12/D13 (which don't exist). `board_config.h` uses the GPIO numbers.
- **SPI is wired direct (no optocoupler).** An earlier build put a PC817 8-channel opto on the bus; PC817s cut off at ~80 kHz and invert, so SPI returned all `0x00`. The bus is now ESP32↔TMC direct with **VCCIO = 3.3 V** and **shared ground**. `TMC_SPI_HZ` defaults to 1 MHz and can go to several MHz. If isolation is ever needed, use a fast digital isolator (ADuM140x/Si86xx), never a PC817.
- **ENN is direct, active-LOW.** The ESP32 drives D5 LOW to enable the drivers (`ENN_ON_LEVEL = 0`).
- **`IHOLD_IRUN` current must be tuned** to the TMC5072-BOB's sense resistors — the default is a placeholder.
- **Ramp registers `D1` and `VSTOP` must never be 0** in positioning mode (datasheet §6.2.1).

## Bring-up status & hard-won lessons (as of 2026-06-08)

**🎉 BRING-UP COMPLETE — first motion confirmed (2026-06-08).** Full chain proven on real hardware via the console:
- `status` → both drivers report `CHOPCONF=0x000100c3`, `GSTAT=0`, no fault flags
- `cur 300` → current control (IRUN/IHOLD) confirmed correct
- `wig 1 6400 1` / `wig 2 6400 1` → **both motors physically rotate** back-and-forth via the integrated ramp generator
- `pen up` / `pen down` → SG90 pen servo moves to configured angles

Note: `status` shows `openloadA`/`openloadB` set **at standstill** (`stst` also set) — this is a **known false positive** in Trinamic open-load detection (the comparator only works meaningfully while the chopper is actively switching during motion, not at hold). Not a wiring fault. Only worth investigating if the flag persists *while the motor is actively turning*.

**Next phase:** geometry/calibration work (see "Mechanical setup & calibration" below) and the WiFi web UI.

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
With the TMC live: `status` (expect `CHOPCONF 0x000100C3`) → `cur 300` → `wig 1 6400 1` / `wig 2 6400 1` → `pen up` / `pen down`. All confirmed working 2026-06-08.

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

**Console (Python-free calibration):** `belt <x> <y>` (dry run — prints belt lengths + motor targets, no motion), `goto <x> <y>` (coordinated move via kinematics), `where` (read XACTUAL back as mm), `jog`/`stop` (velocity-mode jog), `shome` (experimental stallGuard2 home).

**Homing** — no endstops / no sensorless homing yet. It is **manual**: physically place the gondola at the midpoint origin (both belts = `HOME_BELT_MM`), then run `setorigin` to zero XACTUAL there. From then on XTARGET=0 = true origin. stallGuard2 sensorless homing (TMC5072 datasheet §12) is scaffolded in `tmc5072_home_stallguard()` / the `shome` command but **experimental** — SGT needs per-machine tuning.

**Pen servo** — up = **180°**, down = **120°**, ~200 ms dwell (in `board_config.h`).

**Power / current** — shared **12 V / 2 A** supply across both motors → keep **≤ 600 mA RMS per motor** (≈848 mA peak; ≈1.7 A total, leaving headroom). The old TMC2226 board used a 0.11 Ω sense resistor; the **TMC5072-BOB differs — verify `R_SENSE`** before trusting the mA figures.

## Hardware reference

- Wiring, wire colors, and the ASCII diagram: `polar_plotter_wiring.md`.
- TMC5072 register details: `docs/3119171.pdf` §6 (p.27 general/ramp, p.41 motor-driver, p.88 quick-config). **stallGuard2** (§12) enables sensorless homing — a possible alternative to endstops.

## MCP servers (`.mcp.json`)

- **context7** — pull current docs for ESP-IDF / Trinamic APIs (the 5072 has thin third-party library coverage).
- **playwright** — for testing the WiFi UI once it exists.
