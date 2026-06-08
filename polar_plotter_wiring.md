# Polar Plotter Wiring Guide

**ESP32-S3 Nano + TMC5072-BOB + SG90 Servo — direct 3.3 V SPI**

> **Revision note:** an earlier build routed the SPI bus through a PC817 8-channel
> optocoupler. PC817s have an ~80 kHz cutoff and invert each line, so they cannot
> carry SPI (every register read came back `0x00`). The bus is now wired
> **direct**, ESP32 ↔ TMC, sharing ground, with **VCCIO at 3.3 V** so both sides
> share the same logic level. The optocoupler has been removed.

## Power Summary
- **Motor Supply**: 12V to TMC **VS**
- **TMC VCCIO**: **3.3V** from the ESP32 **3V3** pin (matches ESP32 logic — no level shifting)
- **Servo**: **5V**
- **Ground**: single common ground — ESP32 GND, TMC GND, and servo GND all tied together

## 1. Power Connections

| ESP32-S3 Nano | TMC5072-BOB | Notes |
|---------------|-------------|-------|
| **3V3**       | **VCCIO**   | 3.3V IO reference — sets SPI logic level |
| **GND**       | **GND**     | Common ground (shared, not isolated) |
| —             | **VS** ← 12V| Motor supply (powers the chip's internal regulator too) |

## 2. SPI + Control Signals (with Wire Colors)

All lines go **straight** from the ESP32 to the TMC — no optocoupler.

Board is a **Waveshare ESP32-S3-Nano** (Arduino Nano ESP32 pin map). Wire to the
**silkscreen labels** below — the SPI pins are labeled `SCK`/`MOSI`/`MISO`, not
D13/D11/D12. GPIO numbers (from the Waveshare schematic) are what the firmware uses.

| Function         | ESP32 header label | GPIO | Wire Color | TMC5072-BOB Pin | Notes |
|------------------|--------------------|------|------------|-----------------|-------|
| **SCK**          | **SCK** (D13)      | 48   | **Orange** | **SCK**         | SPI clock |
| **MOSI / SDI**   | **MOSI** (D11)     | 38   | **Red**    | **SDI**         | ESP32 → TMC |
| **MISO / SDO**   | **MISO** (D12)     | 47   | **Brown**  | **SDO**         | TMC → ESP32 (4.7kΩ pull-up to VCCIO) |
| **CS / CSN**     | **D10**            | 21   | **Yellow** | **CSN**         | Chip select (active LOW) |
| **ENN**          | **D5**             | 8    | **Green**  | **ENN**         | Active LOW (LOW = motors enabled) |
| **Servo Signal** | **D6**             | 9    | **Orange** | —               | PWM to SG90 |

## 3. TMC5072-BOB Fixed Connections

| TMC5072-BOB Pin | Connect To | Notes |
|-----------------|------------|-------|
| **CLK16**       | **GND**    | Use internal oscillator |
| **SWSEL**       | **GND**    | Select SPI mode |
| **SDO**         | **4.7kΩ pull-up to VCCIO (3.3V)** | **Critical** for reliable MISO |

## 4. SG90 Servo Connections

| SG90 Wire  | Connect To       | Notes |
|------------|------------------|-------|
| **Red**    | **5V**           | Use a stable 5V source (not the 3V3 rail) |
| **Brown**  | **GND** (common) | Shared ground with ESP32 + TMC |
| **Orange** | **D6** (ESP32)   | PWM signal (3.3V logic OK) |

## 5. Wiring Diagram

```
ESP32-S3-Nano (Waveshare)             TMC5072-BOB
  header label (GPIO)                 ─────────────────

3V3   ──────────────────────────────► VCCIO (3.3V)
GND   ──────────────────────────────► GND          ◄── common ground (shared)
                                       VS  ◄──────────── 12V motor supply

SCK  (GPIO48) ──Orange──────────────► SCK
MOSI (GPIO38) ──Red─────────────────► SDI
MISO (GPIO47) ◄─Brown───────────────── SDO   (4.7k pull-up to VCCIO)
D10  (GPIO21) ──Yellow──────────────► CSN
D5   (GPIO8)  ──Green───────────────► ENN   (active LOW = enabled)

D6   (GPIO9)  ──Orange──────────────► SG90 signal   (5V power, common GND)

                                       CLK16 ──► GND  (internal oscillator)
                                       SWSEL ──► GND  (SPI mode)
```

## Important Notes

- **VCCIO = 3.3V**: keeps ESP32 and TMC at the same logic level so SPI works
  directly with no level shifting.
- **Common ground**: the ESP32 and TMC share ground (no isolation). On a single
  12V tabletop machine this is normal. If galvanic isolation is ever required,
  use a **fast digital isolator** (e.g. ADuM1401/ADuM1411 or Si8642) — **not** a
  PC817 optocoupler, which is far too slow for SPI.
- **SDO pull-up**: 4.7kΩ from TMC **SDO** to **VCCIO** is required for reliable MISO.
- **ENN behavior**: drive **LOW** to enable motors, **HIGH** to disable. The
  firmware leaves it HIGH (disabled) until the drivers are configured.
- **SPI speed**: with direct wiring the bus easily runs 1–4 MHz (`TMC_SPI_HZ` in
  `main/board_config.h`).
- Motors are already wired to the TMC outputs.
