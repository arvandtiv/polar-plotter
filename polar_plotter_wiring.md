# Polar Plotter Wiring Guide

**Raspberry Pi Pico 2 W (RP2350) + TMC5072-BOB + SG90 Servo — direct 3.3 V SPI**

> **Revision notes**
> - **No optocoupler on SPI.** An earlier build routed the SPI bus through a PC817
>   8-channel optocoupler; PC817s have an ~80 kHz cutoff and invert each line, so
>   they cannot carry SPI (every register read came back `0x00`). The bus is wired
>   **direct**, Pico ↔ TMC, sharing ground, with **VCCIO at 3.3 V**. If isolation is
>   ever needed use a **fast digital isolator** (ADuM140x / Si86xx), never a PC817.
> - **Platform:** this is the **Pico 2 W** build. (The earlier ESP32-S3 build is on
>   the `ESP32-S3-bendy-line` branch.) Pin numbers below are `GPnn` (the GPIO the
>   firmware uses in `main/board_config.h`) and the Pico's **physical pin** number.

## Power Summary
- **Motor supply:** 12 V → TMC **VS** (also feeds the chip's internal regulator)
- **TMC VCCIO:** **3.3 V** from the Pico **3V3(OUT)** pin (phys 36) — sets SPI logic level, no shifting
- **Servo:** **5 V** (Pico **VBUS**, phys 40, when USB-powered — or an external 5 V)
- **Ground:** single common ground — Pico GND, TMC GND, servo GND, and the 12 V supply GND all tied together

## 1. Power Connections

| Pico 2 W | TMC5072-BOB | Notes |
|----------|-------------|-------|
| **3V3(OUT)** (phys 36) | **VCCIO** | 3.3 V IO reference — sets SPI logic level |
| **GND** (e.g. phys 38) | **GND** | Common ground (shared, not isolated) |
| — | **VS** ← 12 V | Motor supply |

## 2. SPI + Control Signals

All lines go **straight** from the Pico to the TMC — no optocoupler. SPI is **SPI0**.

| Function | Pico GPIO | Phys pin | Wire (suggested) | TMC5072-BOB | Notes |
|----------|-----------|----------|------------------|-------------|-------|
| **SCK**       | GP2  | 4  | Orange | **SCK** | SPI0 clock |
| **MOSI / SDI**| GP3  | 5  | Red    | **SDI** | Pico → TMC (SPI0 TX) |
| **MISO / SDO**| GP4  | 6  | Brown  | **SDO** | TMC → Pico (SPI0 RX); firmware enables an internal pull-up |
| **CS / CSN**  | GP5  | 7  | Yellow | **CSN** | Chip select (active-LOW) |
| **ENN**       | GP6  | 9  | Green  | **ENN** | Active-LOW (LOW = motors enabled) |
| **Servo PWM** | GP7  | 10 | Orange | —       | PWM to SG90 |
| **E-STOP btn**| GP14 | 19 | —      | —       | Momentary button → GND (phys 18); internal pull-up, active-LOW |

## 3. TMC5072-BOB fixed connections

| TMC5072-BOB pin | Connect to | Notes |
|-----------------|------------|-------|
| **CLK16** | **GND** | Use the internal oscillator. **Critical:** if CLK16 floats HIGH at power-up the oscillator latches off until a full 12 V power-cycle (SPI then reads `0xFF`). |
| **SDO** | (optional) 4.7 kΩ → VCCIO | The firmware turns on the Pico's internal pull-up on MISO, so an external pull-up is belt-and-suspenders, not required. |

> `SWSEL` and `TST_MODE` are **hardwired on the BOB PCB** (SPI mode / normal
> operation) — they are *not* on the header, so there is nothing to wire there.

## 4. Hardware E-STOP button (GP14)

A momentary push-button gives a true hardware kill independent of WiFi/firmware:

```
Pico phys 19 (GP14) ──[ button ]── Pico phys 18 (GND)
```

- Internal pull-up is enabled in firmware → **no external resistor needed**.
- Press = GP14 pulled LOW → GPIO interrupt **cuts ENN in hardware** (motors de-energized in ~µs), latches off, and flags the motion loop.
- Clear/re-arm from the console (⛔ banner or `estopclr`), `/api/clearfault`, or MCP `plot_clear_fault` — then **re-home**, since motor power was physically cut.

## 5. SG90 servo

| SG90 wire | Connect to | Notes |
|-----------|------------|-------|
| **Red**   | **5 V** (Pico VBUS phys 40, or external 5 V) | Don't power from the 3V3 rail |
| **Brown** | **GND** (common) | Shared ground |
| **Orange**| **GP7** (phys 10) | PWM signal (3.3 V logic is fine for SG90) |

## 6. Wiring diagram

```
Raspberry Pi Pico 2 W                       TMC5072-BOB
  GPnn (phys)                               ─────────────────

3V3(OUT) (36) ───────────────────────────► VCCIO (3.3 V)
GND      (38) ───────────────────────────► GND          ◄── common ground (shared)
                                            VS  ◄──────────── 12 V motor supply

GP2 (4)  ──Orange───────────────────────► SCK
GP3 (5)  ──Red──────────────────────────► SDI
GP4 (6)  ◄─Brown────────────────────────── SDO   (internal pull-up in firmware)
GP5 (7)  ──Yellow───────────────────────► CSN   (active-LOW)
GP6 (9)  ──Green────────────────────────► ENN   (active-LOW = enabled)

GP7 (10) ──Orange───────────────────────► SG90 signal   (5 V power, common GND)

GP14 (19) ──[ E-STOP button ]── GND (18)   (internal pull-up, active-LOW)

                                            CLK16 ──► GND  (internal oscillator)
```

## Important notes

- **VCCIO = 3.3 V** keeps Pico and TMC at the same logic level — direct SPI, no shifting.
- **Common ground**, no isolation — normal for a single 12 V tabletop machine. For isolation use a fast digital isolator (ADuM140x / Si86xx), never a PC817.
- **CLK16 → GND is mandatory**; a floating-HIGH CLK16 needs a full 12 V power-cycle to recover (an MCU reset is not enough).
- **ENN:** LOW = enabled, HIGH = disabled. Firmware leaves it HIGH until the drivers are configured, and the E-STOP forces it HIGH in hardware.
- **SPI speed:** direct wiring runs comfortably at MHz rates (`TMC_SPI_HZ` in `main/board_config.h`).
- Motor coils are wired to the TMC outputs (OA1/OB1, OA2/OB2).
