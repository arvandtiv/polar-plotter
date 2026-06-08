#pragma once
#include "driver/spi_master.h"
#include "driver/ledc.h"

/* ============================================================
 *  Board: Waveshare ESP32-S3-Nano (WS-26745).
 *  It follows the Arduino Nano ESP32 pin map, so the silkscreen
 *  labels are NOT 1:1 with GPIO numbers. The SPI header pins are
 *  labeled SCK / MOSI / MISO (these are D13 / D11 / D12); CS is
 *  the pin labeled D10. GPIO numbers below are verified from the
 *  Waveshare ESP32-S3-Nano schematic (docs/).
 * ============================================================ */
#define PIN_SCK    48   /* hdr "SCK"  (D13)  orange  SPI clock                */
#define PIN_MOSI   38   /* hdr "MOSI" (D11)  red     SDI (ESP32 -> TMC)       */
#define PIN_MISO   47   /* hdr "MISO" (D12)  brown   SDO (4.7k pull-up VCCIO) */
#define PIN_CSN    21   /* hdr "D10"         yellow  chip select             */
#define PIN_ENN     8   /* hdr "D5"          green   active-LOW enable        */
#define PIN_SERVO   9   /* hdr "D6"          orange  SG90 PWM                 */

/* Direct-wired ENN (no optocoupler): the TMC enables when its ENN pin is LOW,
 * so the ESP32 drives D5 LOW to enable. 0 = drive low to enable. */
#define ENN_ON_LEVEL  0

/* SPI clock. Bus is wired direct ESP32<->TMC (VCCIO=3.3V, shared ground), so it
 * runs fast. 1 MHz is a safe start on jumper wires; the TMC5072 handles several
 * MHz, so raise this once comms are confirmed. */
#define TMC_SPI_HOST  SPI2_HOST
#define TMC_SPI_HZ    1000000   /* 1 MHz (direct-wired) */

/* Pen lift servo — angles carried over from the wall-plotter (same mechanism). */
#define SERVO_LEDC_CHANNEL  LEDC_CHANNEL_0
#define PEN_UP_DEG          180
#define PEN_DOWN_DEG        120
#define PEN_DWELL_MS        200

/* TMC5072 is a dual driver — one chip, two motors. 0 = driver 1, 1 = driver 2. */
#define MOTOR_THETA  0   /* "motor 1 / left"  */
#define MOTOR_RHO    1   /* "motor 2 / right" */

/* ---- Driver current calibration ----
 * Current in mA is derived from the BOB's sense resistor. R_SENSE MUST match
 * your TMC5072-BOB (check its schematic/silkscreen) or the mA figures are wrong.
 * The console prints the resulting CS + estimated mA so you can calibrate by
 * measuring actual coil current. */
#define R_SENSE      0.15f   /* OHMS — VERIFY on your board! */
#define VSENSE_HIGH  0       /* 0: Vfs=0.325V (more range), 1: Vfs=0.180V (low-mA resolution) */

/* ---- Mechanical setup (same machine as ../wall-plotter; see CLAUDE.md) ----
 * GT2 belt, 20-tooth pulley -> 40 mm of belt per motor revolution.
 * 1.8deg motor -> 200 full steps/rev.
 * steps/mm = STEPS_PER_REV * microsteps / BELT_MM_PER_REV = 5 * microsteps
 *   -> 1280 steps/mm at the TMC5072's native 256 microsteps. */
#define STEPS_PER_REV    200
#define MICROSTEPS       256      /* TMC5072 native (MRES=0); matches CHOPCONF */
#define BELT_MM_PER_REV  40.0f    /* GT2 2mm pitch * 20 teeth */
/* microsteps per mm of belt = 200 * 256 / 40 = 1280 */
#define STEPS_PER_MM     ((float)(STEPS_PER_REV * MICROSTEPS) / BELT_MM_PER_REV)
#define MOTOR_SPAN_MM    985.0f   /* anchor-to-anchor; re-measure for this build */

/* Origin definition, the easy-to-measure way: instead of the vertical drop, give
 * the MEASURED belt length (motor -> gondola) with the gondola parked at the
 * midpoint origin. Both belts are equal there by symmetry, so one number defines
 * the home. The firmware derives the vertical drop from this and the span
 * (drop = sqrt(HOME_BELT_MM^2 - (MOTOR_SPAN_MM/2)^2)) at startup.
 * Measured for this build: 700 mm each. */
#define HOME_BELT_MM     700.0f   /* belt length at the origin (both belts equal) */

/* Belt-lengthening -> step-sign per motor. The left motor is mirror-mounted
 * (CLAUDE.md), so the two often differ. THESE ARE GUESSES — confirm on the real
 * machine with the `belt` dry-run + `jog` before trusting `goto`. This is the
 * axis/sign knob that caused the earlier calibration grief; flip a value here
 * (and rebuild) if a motor drives the wrong way. */
#define LEFT_DIR_SIGN    (+1)
#define RIGHT_DIR_SIGN   (+1)

/* ---- WiFi + UDP boundary-hit listener ----
 * Joins the same network the camera-tracking Python script (gondola_boundary_keeper.py,
 * sibling ../wall-plotter project) runs on. That script sends single-byte UDP edge
 * codes ('1'/'2'/'3'/'4' = side hit, 'o' = drifted far past the arena); on receiving
 * any of them this firmware homes the gondola (see home_gondola() in main.c).
 * NOTE: station mode gets a DHCP IP -- read it off the serial log after boot and
 * point the Python script's target IP at it (or set a DHCP reservation on your router). */
#define WIFI_SSID         "BUBSUNNY"
#define WIFI_PASS         "Babijooni123!"
#define UDP_LISTEN_PORT   8888

/* ---- WiFi + UDP drawing-pattern stream (separate port/task from the boundary
 * listener above, on purpose: keeping them independent means a boundary-hit
 * code can always preempt an in-flight pattern with the hard stop in
 * home_gondola(), instead of queuing up behind whatever point is mid-move).
 * Wire format: one point per datagram, ASCII "<m1_target> <m2_target> <pen 0|1>"
 * -- raw absolute XTARGET microstep positions, NOT (x,y) plotter coordinates.
 * The Python side (cv2 pattern generator) owns the x,y -> belt-length -> step
 * conversion; firmware just walks the resulting points. See pattern_stream_task(). */
#define PATTERN_LISTEN_PORT 8889

/* ---- Self-test defaults (all changeable live over the serial console) ---- */
#define TEST_RUN_MA      600.0f   /* run current */
#define TEST_HOLD_MA     200.0f   /* standstill current */
#define TEST_VMAX        200000   /* speed (microsteps/t) */
#define TEST_AMPLITUDE   51200    /* travel (microsteps; 200 full-steps * 256 ustep = 1 rev) */
#define TEST_CYCLES      4        /* back-and-forth repetitions */
#define MOVE_TIMEOUT_MS  8000
