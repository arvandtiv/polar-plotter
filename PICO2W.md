# Polar Plotter — Raspberry Pi Pico 2W Deployment

Branch `pico2` is a **complete, standalone port** of the polar plotter firmware from ESP32-S3 / ESP-IDF to **Raspberry Pi Pico 2W (RP2350) / pico-sdk**. All drawing logic, kinematics, HTTP API, web console, and MCP server are identical to `main`; only the platform layer (SPI, PWM, WiFi, USB-serial) changed.

---

## Hardware

| Item | Part |
|------|------|
| MCU board | Raspberry Pi Pico 2W (RP2350, CYW43439 WiFi) |
| Stepper controller/driver | TMC5072-BOB V1.2 (dual driver, SPI) |
| Pen servo | SG90 |
| Supply | 12 V / 2 A for motors; Pico powered via USB or VSYS |

### Pin mapping (SPI0 block, top-left of Pico header)

| Pico physical pin | GPIO | Signal | TMC5072-BOB header |
|---|---|---|---|
| 4 | GP2 | SPI0_SCK | SCK |
| 5 | GP3 | SPI0_TX (MOSI) | SDI |
| 6 | GP4 | SPI0_RX (MISO) | SDO |
| 7 | GP5 | CS (manual GPIO) | CSN |
| 8 | GND | Ground | GND |
| 9 | GP6 | ENN (active-LOW) | ENN |
| 10 | GP7 | PWM servo | SG90 signal |

**CLK16 on the TMC5072-BOB must be tied to GND.** If CLK16 floats high for even one cycle after power-on, the TMC's internal oscillator latches off and it stops answering SPI until the 12 V rail is fully power-cycled (an MCU reset is not enough).

VCCIO on the TMC5072-BOB is set to 3.3 V (Pico logic level). No level shifter is needed.

GP4 (MISO) is pulled up to 3.3 V in firmware so it idles HIGH when the TMC SDO is not actively driving.

---

## pico-sdk toolchain setup

The Pico 2W requires **pico-sdk 2.x** (includes RP2350 support).

```bash
# One-time: install pico-sdk and toolchain
cd ~/pico
git clone --recurse-submodules https://github.com/raspberrypi/pico-sdk.git
export PICO_SDK_PATH=~/pico/pico-sdk

# ARM toolchain (macOS with Homebrew)
brew install cmake
brew install --cask gcc-arm-embedded   # or: arm-none-eabi-gcc from ARM website

# Python (for picotool and build scripts)
pip3 install pyserial
```

---

## Build

```bash
cd ~/Documents/polar_plotter

# First time: configure cmake
cmake -B build -G Ninja \
    -DPICO_BOARD=pico2_w \
    -DPICO_SDK_PATH=~/pico/pico-sdk \
    -DCMAKE_BUILD_TYPE=Release

# Every build
cmake --build build
# Output: build/main/polar_plotter.uf2
```

WiFi credentials live in `main/board_config.h`:
```c
#define WIFI_SSID  "your_ssid"
#define WIFI_PASS  "your_password"
```

---

## Flash

### Method 1 — picotool (recommended)

```bash
picotool load -fx build/main/polar_plotter.uf2
```

If picotool can't find the device, put the Pico in BOOTSEL mode first: hold the BOOTSEL button, tap RESET, release BOOTSEL. The board mounts as a USB mass storage device.

### Method 2 — drag-and-drop

Enter BOOTSEL mode as above. The board appears as `RPI-RP2`. Copy `build/main/polar_plotter.uf2` to the mounted drive. It reboots automatically.

### After flashing

1. **Cycle the 12 V motor supply** (MCU reset alone is not enough if the TMC was unpowered during flash).
2. Open a serial monitor: `tio /dev/cu.usbmodem*` or `minicom -b 115200 -D /dev/cu.usbmodem*`
3. Press RESET on the Pico. The console prints the bring-up log and ends with `plotter>`.

---

## Boot sequence

```
====  Polar Plotter (Pico 2W)  ====
[main] web_server_init...
[main] task creates...
[main] wifi_init_sta...
[wifi] calling cyw43_arch_init...
[wifi] cyw43_arch_init ok
[wifi] connecting to 'BUBSUNNY'...
[wifi] connected: 192.168.x.x
[tmc5072] init ok (SPI 250000 Hz, R_sense=0.150, vsense_hi=0)
================ BRING-UP ================
SPI link: status=0x00 INPUT=0x1000002b VERSION=0x10
=== Motor 1 === ... CHOPCONF 0x000100c3 TOFF=3 (on)
=== Motor 2 === ... CHOPCONF 0x000100c3 TOFF=3 (on)
[pen] servo test: 3 cycles
========== BRING-UP DONE ==========
Calibrate: 'belt 0 0' -> place gondola -> 'sethome' -> 'goto'. 'help' for all.
plotter>
```

**USB CDC is non-blocking**: the firmware polls `stdio_usb_connected()` for up to 30 s so you won't miss the boot log as long as you open the monitor within 30 s of reset.

---

## Console

The USB-serial console uses `getchar_timeout_us(0)` (non-blocking), so it never starves the USB interrupt. Backspace works. Standard 115200 baud.

Key commands:

| Command | Description |
|---------|-------------|
| `status` | Full register dump: VERSION, CHOPCONF, IRUN, DRV_STATUS for both motors |
| `link` | Quick SPI VERSION check |
| `spiraw` | Raw 5-byte SPI dump for INPUT and GSTAT (bring-up diagnostic) |
| `jog <1\|2> <vel>` | Velocity-mode jog a single motor |
| `stop [1\|2]` | Decelerate to stop |
| `belt <x> <y>` | Dry-run: print belt lengths and step targets, no motion |
| `goto <x> <y>` | Coordinated move via kinematics |
| `sethome` | Zero both motor counters at current gondola position |
| `where` | Read XACTUAL back as (x, y) mm |
| `cur <run_mA> [hold_mA]` | Set motor current |
| `speed <vmax>` | Set VMAX |
| `accel <amax>` | Set AMAX (and A1/D1 at the proven ratio) |
| `pen up \| down` | Move servo |
| `en <0\|1>` | Enable / disable TMC output stage |

---

## WiFi and HTTP API

On boot the firmware connects to `WIFI_SSID` and logs the IP. The same HTTP API as the ESP32 build is available at `http://<ip>/api/...`. The web console (`console/`) and MCP server (`plotter-mcp/`) work unchanged — just point them at the Pico's IP instead.

A `wifi_watchdog_task` polls the link every 10 s and reconnects automatically if the association drops.

---

## Normal status flags (not faults)

The TMC5072's `status` output at standstill will show:

- `stst` — at rest, always set when stopped. Normal.
- `openloadA / openloadB` — the open-load comparator only works reliably while the chopper is actively switching. At standstill it fires false positives. Ignore.
- `STALL` — StallGuard2 fires at standstill if VCOOLTHRS=0 (default). Ignore.

The firmware's fault handler only trips on real faults: `OT` (over-temp, bit 25), `s2ga`/`s2gb` (coil shorts, bits 27–28), `GSTAT drv_err / uv_cp`. Everything else is masked.

---

## Hard-won lessons from the porting session

### 1. SPI two-phase read timing — the root cause of VERSION=0x00

The TMC5072 SPI read is two-phase: phase 1 latches the register address, phase 2 returns the data. With back-to-back CS transactions and no inter-frame delay, the RP2350 cycled CS so fast that the TMC couldn't prepare the latched data — all 4 data bytes came back 0x00 on every read. `VERSION` showed `0x00`, `CHOPCONF` showed `0x00000000 TOFF=0 DISABLED`.

**Fix** (`components/tmc5072/tmc5072.c`, `spi_xfer`):
```c
gpio_put(dev->pin_csn, 0);
busy_wait_us_32(1);   /* CS setup time */
spi_write_read_blocking(...);
gpio_put(dev->pin_csn, 1);
busy_wait_us_32(2);   /* inter-frame hold — without this, phase 2 returns 0x00 */
```

Diagnosed using the `spiraw` console command, which added an explicit `sleep_us(10)` between phases and immediately returned correct data.

**Side effect of broken reads**: `position_reached()` reads `RAMP_STAT` which returned 0 → always false → every `wait_reached()` call timed out at 8 s. This made coordinated moves extremely slow before the fix.

### 2. lwIP FreeRTOS sizes default to 0 — causes boot panic

`pico_cyw43_arch_lwip_sys_freertos` uses lwIP's FreeRTOS integration (`NO_SYS=0`). Every mailbox and thread stack size in `lwIP/src/include/lwip/opt.h` defaults to `0`. `sys_mbox_new()` and `sys_thread_new()` assert `size > 0` / `stacksize > 0` — these map to `panic()` in pico-sdk's `arch/cc.h`.

The panic message is invisible over USB CDC because the USB interrupt is disabled when `panic()` halts. Only visible if you have a UART or probe.

**Fix** (`lwipopts.h`): define all sizes explicitly:
```c
#define TCPIP_THREAD_STACKSIZE    4096
#define TCPIP_THREAD_PRIO         4
#define TCPIP_MBOX_SIZE           8
#define DEFAULT_TCP_RECVMBOX_SIZE 8
#define DEFAULT_UDP_RECVMBOX_SIZE 6
#define DEFAULT_RAW_RECVMBOX_SIZE 6
#define DEFAULT_ACCEPTMBOX_SIZE   8
```

### 3. FreeRTOS ARM_CM33_NTZ port requirements

The RP2350's M33 core in non-TrustZone mode requires:
```c
#define configNUMBER_OF_CORES          1   /* explicit; SMP port checks this */
#define configRUN_FREERTOS_SECURE_ONLY 1   /* NTZ: secure-only, no NS/S transitions */
#define configSUPPORT_PICO_TIME_INTEROP 0  /* disable: sleep_ms() before vTaskStartScheduler()
                                              calls vTaskDelay() → NULL deref crash */
```
Heap reduced to 128 KB to leave room for USB + WiFi DMA buffers.

### 4. USB CDC console must be non-blocking

`fgets(stdin)` blocks until a newline. On pico-sdk, this holds the task indefinitely, starving the USB interrupt that delivers characters — so nothing you type ever arrives. Use `getchar_timeout_us(0)` + yield on `PICO_ERROR_TIMEOUT`.

### 5. CLK16 oscillator latch

Datasheet: *"the first HIGH signal on CLK16 disables the internal oscillator until power-down."* If CLK16 floated high before grounding, the TMC won't answer SPI (returns 0xFF) until a **full 12 V power cycle**. An MCU reset or reflash is not enough.

### 6. Servo PWM clock divider

RP2350 runs at 150 MHz. The SG90 needs 50 Hz / 14-bit PWM. Set `SERVO_CLKDIV = 150.0` in `components/servo/` to get the right period. The ESP32 value was different.

### 7. CYW43 WiFi target name in pico-sdk 2.x

The correct cmake library name is `pico_cyw43_arch_lwip_sys_freertos` (not `pico_cyw43_arch_lwip_freertos`). The pico-sdk 2.x renamed it.

---

## Calibration (first run)

1. Power on with gondola roughly in position. Confirm `status` shows `VERSION=0x10 OK` and both `CHOPCONF TOFF=3 (on)`.
2. `belt 0 0` — dry run; prints the belt lengths and step targets for the origin. Verify the numbers match your physical setup.
3. Place the gondola at the midpoint between the two motor anchors (both belts equal length = `HOME_BELT_MM = 715 mm` from `board_config.h`).
4. `sethome` — zeroes both motor counters here.
5. `goto 0 100` — should drop straight down ~100 mm. Confirms steps/mm is correct.
6. `goto 100 0` — should move right and stay level. Sag = `MOTOR_SPAN_MM` too small; rise = too large.
7. `goto 0 0` to return home.

---

## Geometry constants (`main/board_config.h`)

```c
#define MOTOR_SPAN_MM    978.0f   // anchor-to-anchor distance — measure at belt take-off points
#define HOME_BELT_MM     715.0f   // belt length (motor→gondola) at the midpoint origin
#define STEPS_PER_MM     1280.0f  // 200 steps/rev × 256 µsteps / 40 mm/rev
```

`MOTOR_SPAN_MM` is the top suspect for bowed horizontal lines (see CLAUDE.md geometry section).

---

## Differences from `main` (ESP32-S3) branch

| | `main` (ESP32-S3) | `pico2` (Pico 2W) |
|---|---|---|
| SDK | ESP-IDF | pico-sdk 2.x |
| Build | `idf.py build` | `cmake --build build` |
| Flash | `idf.py -p PORT flash` | `picotool load -fx *.uf2` |
| SPI | ESP32 SPI driver | `hardware/spi.h`, `spi_write_read_blocking` |
| WiFi | `esp_wifi` event loop | `cyw43_arch` blocking connect |
| Logging | `ESP_LOGI` / `ESP_LOGE` | `printf` |
| Console | `esp_console` component | hand-rolled `getchar_timeout_us(0)` loop |
| Servo PWM | LEDC peripheral | `hardware/pwm.h`, clkdiv=150.0 |
| FreeRTOS port | `xtensa-idf` | `ARM_CM33_NTZ` |

Drawing logic, kinematics, web server, MCP server, and Astro console UI are identical.
