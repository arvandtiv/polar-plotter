#pragma once

/* ============================================================
 *  Board: Raspberry Pi Pico 2W  (RP2350 + CYW43439 WiFi/BT)
 *
 *  SPI0 pins (top-left block of the Pico header, easy to wire):
 *    Physical Pico pin 4  = GP2  → TMC5072 SCK
 *    Physical Pico pin 5  = GP3  → TMC5072 SDI  (MOSI)
 *    Physical Pico pin 6  = GP4  → TMC5072 SDO  (MISO, with 4.7k pull-up to 3.3V)
 *    Physical Pico pin 7  = GP5  → TMC5072 CSN  (manual GPIO, active-LOW)
 *    Physical Pico pin 9  = GP6  → TMC5072 ENN  (active-LOW enable)
 *    Physical Pico pin 10 = GP7  → SG90 servo PWM
 *    GND from Physical pin 8 (between GP5 and GP6) or any GND pin.
 *
 *  The Pico 2W is a 3.3 V system — direct SPI to the TMC5072-BOB at
 *  VCCIO=3.3 V, shared ground.  No level shifter needed.
 * ============================================================ */

/* SPI0 hardware pins */
#define PIN_SCK    2    /* GP2  SPI0_SCK  */
#define PIN_MOSI   3    /* GP3  SPI0_TX   */
#define PIN_MISO   4    /* GP4  SPI0_RX   */

/* Manual GPIOs */
#define PIN_CSN    5    /* GP5  chip-select (active-LOW)     */
#define PIN_ENN    6    /* GP6  enable (active-LOW to enable)*/
#define PIN_SERVO  7    /* GP7  SG90 PWM                     */
#define PIN_ESTOP  14   /* GP14 hardware E-STOP button → GND (internal pull-up, active-LOW) */

/* ENN is direct-wired, active-LOW: drive LOW to enable the TMC. */
#define ENN_ON_LEVEL  0

/* SPI instance and clock */
#define TMC_SPI_INST  spi0
#define TMC_SPI_HZ    2000000   /* 2 MHz — fast enough for streaming segments, well within TMC5072 spec */

/* Pen lift servo (re-mounted flipped — angles measured on hardware) */
#define PEN_UP_DEG    50
#define PEN_DOWN_DEG  70
#define PEN_DWELL_MS  200

/* TMC5072 dual driver: 0 = driver 1 (left belt), 1 = driver 2 (right belt) */
#define MOTOR_THETA  0
#define MOTOR_RHO    1

/* Current calibration (R_SENSE must match the TMC5072-BOB schematic). */
#define R_SENSE      0.15f
#define VSENSE_HIGH  0

/* Mechanical (same machine as ESP32 build; see CLAUDE.md). */
#define STEPS_PER_REV    200
#define MICROSTEPS       256
#define BELT_MM_PER_REV  40.0f
#define STEPS_PER_MM     ((float)(STEPS_PER_REV * MICROSTEPS) / BELT_MM_PER_REV)
#define MOTOR_SPAN_MM    978.0f
#define HOME_BELT_MM     715.0f
#define LEFT_DIR_SIGN    (+1)
#define RIGHT_DIR_SIGN   (+1)

/* Drawable area limits (mm, origin at centre). */
#define X_MAX_MM   240.0f
#define X_MIN_MM  -240.0f
#define Y_MAX_MM   200.0f
#define Y_MIN_MM  -200.0f

/* Arc / line quality */
#define CIRCLE_CHORD_ERR_MM  0.3f
#define HATCH_SPACING_MM     3.0f
#define LINE_SEG_MM          5.0f
#define LINE_LOOKAHEAD_MM    2.0f
/* Max curvature-aware hand-off release (Phase 2.5): straights/gentle curves release
 * the next streamed target up to this early so the ramp cruises through joints
 * instead of decelerating toward every waypoint. Bounded by the kinematic line-bow
 * over the release window (same budget as LINE_SEG_MM, ~2.5×). */
#define FLOW_LOOKAHEAD_MAX_MM 8.0f

/* WiFi credentials */
#define WIFI_SSID         "BUBSUNNY"
#define WIFI_PASS         "Babijooni123!"

/* UDP ports (same as ESP32 build) */
#define UDP_LISTEN_PORT    8888
#define PATTERN_LISTEN_PORT 8889

/* Motion defaults */
#define TEST_RUN_MA      600.0f   /* raised from 400: gondola load needs more torque than bench test */
#define TEST_HOLD_MA     200.0f
#define TEST_VMAX        200000   /* matches ESP32 default; reduces to drawing speed via 'speed' command */
#define MOVE_TIMEOUT_MS  8000
