/* Polar plotter firmware: bring-up + interactive drawing console.
 *
 * On boot it runs a safe bring-up (SPI link check -> driver config -> register
 * dump -> servo sweep; NO motor motion), derives the machine geometry from
 * board_config.h, then drops into an interactive serial console for calibration
 * and drawing. All gondola motion goes through the coordinated (same-execution-
 * time) move path so the two belts always finish together.
 *
 * Console (type `help`):
 *   link                 re-read the TMC over SPI (VERSION should be 0x10)
 *   cur <run_mA> [hold]  set run/hold current on both motors
 *   speed <vmax>         set VMAX (speed) on both motors
 *   belt <x> <y>         DRY RUN: print belt lengths + motor targets for (x,y)
 *                        mm without moving -- use this first when calibrating
 *   goto <x> <y>         move gondola to (x,y) mm via firmware kinematics
 *   line <x0> <y0> <x1> <y1> [cycles]
 *                        draw a straight line (pen auto up/down)
 *   circle <cx> <cy> <r> [cycles]
 *                        draw a circle (pen auto up/down); segment count auto
 *                        from radius + CIRCLE_CHORD_ERR_MM
 *   square <cx> <cy> <z> [cycles]
 *                        draw an axis-aligned square, side length z mm (pen
 *                        auto up/down); edges Cartesian-interpolated (LINE_SEG_MM)
 *   [cycles]             optional repeat count: retrace the shape N times with the
 *                        pen DOWN to darken a faint line (default 1)
 *   where                read XACTUAL back as an (x,y) mm coordinate
 *   jog  <m> <vel>       velocity-mode jog (RAMPMODE 1/2); `stop` to halt
 *   stop [m]             decelerate a jog to standstill (both if no motor given)
 *   pen  <up|down|deg>   servo position
 *   en   <0|1>           disable / enable the drivers (ENN)
 *   stat                 dump DRV_STATUS + positions for both motors
 *   home                 return both motors to XTARGET=0 (also triggered by UDP boundary hits)
 *   sethome              set the origin (0,0). Two forms:
 *                          sethome                      manual: place gondola at the
 *                                                       midpoint (both belts = HOME_BELT_MM)
 *                                                       and zero BOTH motors here
 *                          sethome sg <m> <vel> [sgt]   EXPERIMENTAL stallGuard2
 *                                                       sensorless home of one motor
 *                        The kinematics assume this has been done; it is the ONLY
 *                        command that (re)defines the origin.
 *
 * WiFi / UDP boundary-hit listener (port UDP_LISTEN_PORT):
 *   Joins WIFI_SSID and listens for the single-byte edge codes that
 *   gondola_boundary_keeper.py (sibling ../wall-plotter project) sends from its
 *   camera tracker. On '1'/'2'/'3'/'4' (side hit) or 'o' (drifted far past the
 *   arena) this firmware hard-stops and homes the gondola -- see
 *   home_gondola() / udp_listener_task().
 *
 * WiFi / UDP drawing-pattern stream (port PATTERN_LISTEN_PORT, separate socket
 * + task on purpose -- see pattern_stream_task()):
 *   Receives one drawing point per datagram as ASCII "<m1_target> <m2_target>
 *   <pen 0|1>" -- raw absolute XTARGET microstep positions computed Python-side
 *   (cv2 pattern generator owns the x,y -> belt-length -> step geometry) -- and
 *   walks them in order, lifting/lowering the pen as instructed. Kept on its own
 *   socket/task so a boundary-hit code can always preempt it immediately.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_console.h"

#include "nvs_flash.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "lwip/sockets.h"

#include "board_config.h"
#include "tmc5072.h"
#include "servo.h"
#include "kinematics.h"
#include "web_server.h"

static const char *TAG = "plotter-test";
static tmc5072_t   tmc;
static esp_console_repl_t *s_repl = NULL;

/* WiFi connection state, updated by wifi_event_handler() and surfaced in
 * print_global_status()/`status` so you can check connectivity + IP without
 * scrolling back through the boot log for the one-shot "got IP" line. */
static volatile bool      s_wifi_connected = false;
static esp_netif_ip_info_t s_wifi_ip;

/* Live-adjustable test parameters (seeded from board_config.h). */
static float    g_run_ma       = TEST_RUN_MA;
static float    g_hold_ma      = TEST_HOLD_MA;
static uint32_t g_vmax         = TEST_VMAX;
static uint32_t g_accel        = 500;          /* AMAX/DMAX */
static float    g_home_belt_mm  = HOME_BELT_MM;  /* tunable at runtime via `setbelt` */
static float    g_motor_span_mm  = MOTOR_SPAN_MM;  /* tunable at runtime via `setspan` */
static float    g_steps_per_mm = 1265.0f;   /* tunable via `setsteps` */
static float    g_x_scale      = 1.0300f;   /* tunable via `setxscale` */
static float    g_y_scale      = 1.0f;      /* tunable via `setyscale` */
static float    g_x_min        = X_MIN_MM;  /* tunable via `setbounds` or /api/bounds */
static float    g_x_max        = X_MAX_MM;
static float    g_y_min        = Y_MIN_MM;
static float    g_y_max        = Y_MAX_MM;

/* Machine geometry for the firmware-side kinematics (see kinematics.h). Built
 * from board_config.h so calibration is a matter of editing constants there.
 * `drop_mm` is derived at startup from the measured HOME_BELT_MM (sqrtf can't run
 * in a static initializer), so it's filled in app_main via init_geometry(). */
static plotter_geom_t g_geom = {
    .span_mm      = MOTOR_SPAN_MM,
    .drop_mm      = 0.0f,   /* set in init_geometry() from HOME_BELT_MM */
    .steps_per_mm = 1265.0f,
    .x_scale      = 1.0300f,
    .y_scale      = 1.0f,
    .left_sign    = LEFT_DIR_SIGN,
    .right_sign   = RIGHT_DIR_SIGN,
};

/* Forward declarations for draw helpers (defined after the lower-level primitives,
 * used by both console cmd_* wrappers and web_draw_task).
 * fill_mode: 0=none  1=hatch (angled lines)  2=concentric (rings/circles)
 * outline:   true = draw the perimeter; false = fill only (skip outer shape) */
static void do_draw_goto(float x, float y);
static void do_draw_line(float x0, float y0, float x1, float y1, int cycles);
static void do_draw_square(float cx, float cy, float size, int cycles, int fill_mode, float hatch_angle, float hatch_spacing, bool outline);
static void do_draw_circle(float cx, float cy, float r, int cycles, int fill_mode, float hatch_angle, float hatch_spacing, bool outline);
static void do_draw_bullseye(float cx, float cy);
static void do_draw_grid(float cx, float cy);
/* wobble: 0.0 = perfect circle … 1.0 = very distorted; harmonics controls shape complexity */
static void do_draw_wobbly(float cx, float cy, float r, float bound_r,
                            float wobble, int harmonics, int seed, int cycles);

static void init_geometry(void)
{
    g_geom.span_mm      = g_motor_span_mm;
    g_geom.drop_mm      = plt_drop_from_home_belt(g_motor_span_mm, g_home_belt_mm);
    g_geom.steps_per_mm = g_steps_per_mm;
    g_geom.x_scale      = g_x_scale;
    g_geom.y_scale      = g_y_scale;
    ESP_LOGI(TAG, "geometry: span=%.1f mm  home_belt=%.1f mm  -> drop=%.2f mm  (%.1f steps/mm  xs=%.4f ys=%.4f)",
             (double)g_motor_span_mm, (double)g_home_belt_mm, (double)g_geom.drop_mm,
             (double)g_geom.steps_per_mm, (double)g_geom.x_scale, (double)g_geom.y_scale);
}

static uint16_t mres_to_microsteps(uint8_t mres)
{
    static const uint16_t tbl[9] = {256, 128, 64, 32, 16, 8, 4, 2, 1};
    return (mres <= 8) ? tbl[mres] : 0;
}

/* --------------------------------------------------------------------------- */

static void apply_current(float run_ma, float hold_ma)
{
    uint8_t irun  = tmc5072_ma_to_cs(run_ma,  R_SENSE, VSENSE_HIGH);
    uint8_t ihold = tmc5072_ma_to_cs(hold_ma, R_SENSE, VSENSE_HIGH);
    tmc5072_set_current_ma(&tmc, MOTOR_THETA, run_ma, hold_ma);
    tmc5072_set_current_ma(&tmc, MOTOR_RHO,   run_ma, hold_ma);
    ESP_LOGI(TAG, "current: run=%.0f mA (IRUN CS=%u ~%.0f mA), hold=%.0f mA (CS=%u)  [R_SENSE=%.3f vsense_hi=%d]",
             (double)run_ma, irun, (double)tmc5072_cs_to_ma(irun, R_SENSE, VSENSE_HIGH),
             (double)hold_ma, ihold, (double)R_SENSE, VSENSE_HIGH);
}

static void apply_speed(uint32_t vmax)
{
    tmc5072_set_vmax(&tmc, MOTOR_THETA, vmax);
    tmc5072_set_vmax(&tmc, MOTOR_RHO,   vmax);
    ESP_LOGI(TAG, "speed: VMAX=%lu", (unsigned long)vmax);
}

/* DRV_STATUS bit layout (datasheet §6.4, "DRV_STATUS – Driver status flags"):
 *   bits  0-9  SG_RESULT  stallGuard2 load measurement (0=high load/near-stall .. 1023=low load)
 *              -- only meaningful while moving inside a tuned VCOOLTHRS/SGT window;
 *                 noisy/garbage at standstill or low speed (see [[STALL false-positive]] below)
 *   bits 16-20 CS_ACTUAL  actual current scale the chopper is applying right now
 *   bit  24    STALL      SG_RESULT crossed the COOLCONF.SGT threshold
 *              -- false-positive here: firmware never writes COOLCONF/VCOOLTHRS, so they sit at
 *                 reset 0x0 and the comparator runs unconditionally (even at v=0, hence "stst STALL"
 *                 together, which is physically impossible for a real stall). Cosmetic only --
 *                 wait_reached()/move_to() never check this bit.
 *   bit  25    OT         over-temperature shutdown (driver disabled, real fault)
 *   bit  26    otpw       over-temperature pre-warning
 *   bits 27-28 s2ga/s2gb  short-to-GND on coil A / B (real fault, latched until re-enable)
 *   bits 29-30 openload A/B  open-load detection per coil
 *              -- also a known false positive at standstill: the comparator only works while
 *                 the chopper is actively switching during motion
 *   bit  31    stst       standstill (no step pulses for ~2^20 clock cycles)
 */
static void print_status(int m)
{
    uint32_t s = tmc5072_drv_status(&tmc, m);
    ESP_LOGI(TAG, "M%d pos=%ld DRV_STATUS=0x%08lx  %s%s%s%s%s%s%s SG_RESULT=%lu CS_ACT=%lu",
             m + 1, (long)tmc5072_position(&tmc, m), (unsigned long)s,
             (s & (1u << 31)) ? "stst "   : "",
             (s & (1u << 24)) ? "STALL "  : "",
             (s & (1u << 25)) ? "OT! "    : "",
             (s & (1u << 26)) ? "otpw "   : "",
             (s & (1u << 27)) ? "s2ga! "  : "",
             (s & (1u << 28)) ? "s2gb! "  : "",
             ((s & (3u << 29))) ? "openload " : "",
             (unsigned long)(s & 0x3FF),            /* SG_RESULT = low 10 bits */
             (unsigned long)((s >> 16) & 0x1F));    /* CS_ACTUAL = bits 16-20 (5-bit current scale, 0-31) */
}

static void apply_accel(uint32_t accel)
{
    tmc5072_set_accel(&tmc, MOTOR_THETA, accel);
    tmc5072_set_accel(&tmc, MOTOR_RHO,   accel);
    ESP_LOGI(TAG, "accel: AMAX=DMAX=%lu", (unsigned long)accel);
}

/* --- Full register readback (modeled on the wall-plotter printFullStatus,
 *     re-mapped to TMC5072 bit layouts) --------------------------------- */

static void print_global_status(void)
{
    uint8_t  st = 0;
    uint32_t in = tmc5072_read(&tmc, TMC5072_INPUT, &st);
    uint8_t  ver = (in >> 24) & 0xFF;
    uint32_t gconf = tmc5072_read(&tmc, TMC5072_GCONF, NULL);
    uint32_t gstat = tmc5072_read(&tmc, TMC5072_GSTAT, NULL);

    printf("\n=== TMC5072 global ===\n");
    printf("  SPI status byte : 0x%02x\n", st);
    printf("  VERSION (INPUT) : 0x%02x %s\n", ver,
           (ver == 0x10) ? "OK" : "<-- expected 0x10! check SPI/opto/SDO pull-up");
    printf("  GCONF  0x%08lx : single_driver=%lu shaft1=%lu shaft2=%lu\n",
           (unsigned long)gconf, (unsigned long)(gconf & 1),
           (unsigned long)((gconf >> 8) & 1), (unsigned long)((gconf >> 9) & 1));
    printf("  GSTAT  0x%08lx : reset=%lu drv_err1=%lu drv_err2=%lu uv_cp=%lu\n",
           (unsigned long)gstat, (unsigned long)(gstat & 1),
           (unsigned long)((gstat >> 1) & 1), (unsigned long)((gstat >> 2) & 1),
           (unsigned long)((gstat >> 3) & 1));

    if (s_wifi_connected) {
        printf("  WiFi   SSID=%-16s IP=" IPSTR "  UDP boundary listener on :%d\n",
               WIFI_SSID, IP2STR(&s_wifi_ip.ip), UDP_LISTEN_PORT);
    } else {
        printf("  WiFi   SSID=%-16s <-- not connected (check credentials / AP in range)\n",
               WIFI_SSID);
    }
}

static void print_full_status(int m)
{
    /* CHOPCONF field layout (datasheet §6.4 "CHOPCONF – chopper configuration"):
     *   bits  0-3  TOFF    off-time / driver-enable (0 = output stage disabled entirely)
     *   bits  4-6  HSTRT   hysteresis start value (chopper comparator tuning)
     *   bits  7-10 HEND    hysteresis end value (signed, offset by -3)
     *   bits 15-16 TBL     comparator blank time (filters switching noise)
     *   bit  17    vsense  sense-resistor voltage range select (low/high sensitivity)
     *   bits 24-27 MRES    microstep resolution, 0=256 .. 8=fullstep (see mres_to_microsteps)
     */
    uint32_t chop = tmc5072_read(&tmc, TMC5072_CHOPCONF(m), NULL);
    uint8_t  toff   = (chop >> 0)  & 0x0F;
    uint8_t  hstrt  = (chop >> 4)  & 0x07;
    uint8_t  hend   = (chop >> 7)  & 0x0F;
    uint8_t  tbl    = (chop >> 15) & 0x03;
    uint8_t  vsense = (chop >> 17) & 0x01;
    uint8_t  mres   = (chop >> 24) & 0x0F;

    /* IHOLD_IRUN is write-only on the chip (no readback path), so tmc5072_get_ihold_irun()
     * returns the driver's local shadow copy of the last value written -- it reflects what
     * we *configured*, not a live register read. Layout: bits 0-4 IHOLD, 8-12 IRUN, 16-19 IHOLDDELAY. */
    uint32_t ihr   = tmc5072_get_ihold_irun(&tmc, m);
    uint8_t  ihold = (ihr >> 0)  & 0x1F;
    uint8_t  irun  = (ihr >> 8)  & 0x1F;
    uint8_t  ihd   = (ihr >> 16) & 0x0F;

    uint32_t ds    = tmc5072_drv_status(&tmc, m);
    uint8_t  csact = (ds >> 16) & 0x1F;

    printf("\n=== Motor %d (driver %d) ===\n", m + 1, m + 1);
    printf("  XACTUAL=%ld  VACTUAL=%ld\n",
           (long)tmc5072_position(&tmc, m),
           (long)(int32_t)tmc5072_read(&tmc, TMC5072_VACTUAL(m), NULL));

    printf("  CHOPCONF 0x%08lx : TOFF=%u %s HSTRT=%u HEND=%u TBL=%u vsense=%u MRES=%u (%u usteps)\n",
           (unsigned long)chop, toff, toff ? "(driver on)" : "<-- TOFF=0, OUTPUT DISABLED",
           hstrt, hend, tbl, vsense, mres, mres_to_microsteps(mres));

    printf("  IHOLD_IRUN(cfg)  : IRUN=%u (~%.0f mA) IHOLD=%u (~%.0f mA) IHOLDDELAY=%u\n",
           irun, (double)tmc5072_cs_to_ma(irun, R_SENSE, VSENSE_HIGH),
           ihold, (double)tmc5072_cs_to_ma(ihold, R_SENSE, VSENSE_HIGH), ihd);

    printf("  DRV_STATUS 0x%08lx : CS_ACTUAL=%u (~%.0f mA) SG_RESULT=%lu\n",
           (unsigned long)ds, csact, (double)tmc5072_cs_to_ma(csact, R_SENSE, VSENSE_HIGH),
           (unsigned long)(ds & 0x3FF));
    printf("    flags: %s%s%s%s%s%s%s%s%s\n",
           (ds & (1u << 31)) ? "stst "     : "",
           (ds & (1u << 24)) ? "STALL "    : "",
           (ds & (1u << 25)) ? "OT! "      : "",
           (ds & (1u << 26)) ? "otpw "     : "",
           (ds & (1u << 27)) ? "s2ga! "    : "",
           (ds & (1u << 28)) ? "s2gb! "    : "",
           (ds & (1u << 29)) ? "openloadA ": "",
           (ds & (1u << 30)) ? "openloadB ": "",
           (ds & (1u << 15)) ? "fullstep " : "");
}

/* Polls POSITION_REACHED (set by the chip's ramp generator once XACTUAL==XTARGET)
 * rather than blocking on a fixed delay -- the ramp duration depends on distance,
 * VMAX and acceleration, so a fixed wait would either be too short (truncating the
 * move) or too long (wasting time). 20 ms poll is coarse enough not to flood SPI. */
static bool wait_reached(int m, int timeout_ms)
{
    int waited = 0;
    while (!tmc5072_position_reached(&tmc, m)) {
        vTaskDelay(pdMS_TO_TICKS(20));
        waited += 20;
        if (waited >= timeout_ms) {
            ESP_LOGW(TAG, "M%d move timeout (not reaching target — check current/wiring)", m + 1);
            return false;
        }
    }
    return true;
}

/* "Home" the gondola: lift the pen, then return both motors to XTARGET=0.
 *
 * NOTE on what "home" means here: per CLAUDE.md this machine has no endstops
 * and no sensorless homing -- (0,0) only means something once the gondola has
 * been physically placed at the true origin and XACTUAL zeroed there (the
 * manual homing procedure). This routine does NOT perform that procedure; it
 * just returns to wherever position 0 currently is for each motor. That is
 * the true origin only if it was established that way earlier in the session
 * (i.e. via `sethome` after manual placement; only `sethome` sets the origin).
 *
 * Triggered by: the `home` console command, and by udp_listener_task() on any
 * boundary-hit code from the camera tracker. */
static void home_gondola(void)
{
    /* HARD STOP, first thing: redirect each motor's XTARGET to its current
     * XACTUAL. The sixPoint ramp generator (RAMPMODE=0) recomputes its ramp
     * the instant XTARGET changes, so this makes it decelerate to a stop
     * right where the gondola already is -- as fast as DMAX/D1/VSTOP allow --
     * instead of finishing whatever distant move (e.g. an in-flight `goto`)
     * was running and THEN turning back to home. That "finish first, home
     * after" behaviour is exactly what this avoids: the redirect is a single
     * register write per motor, so it lands within the current SPI mutex's
     * microsecond-scale hold time regardless of what `wait_reached` elsewhere
     * is doing -- no shared abort flag or extra polling loop needed, so the
     * normal move path (move_coordinated/wait_reached) is untouched and free
     * motion keeps its full performance. */
    int32_t stop_t = tmc5072_position(&tmc, MOTOR_THETA);
    int32_t stop_r = tmc5072_position(&tmc, MOTOR_RHO);
    tmc5072_move_to(&tmc, MOTOR_THETA, stop_t);
    tmc5072_move_to(&tmc, MOTOR_RHO,   stop_r);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    ESP_LOGW(TAG, "HARD STOP at M1=%ld M2=%ld -- now homing (pen up, XTARGET=0)",
             (long)stop_t, (long)stop_r);

    servo_write_deg(PEN_UP_DEG);
    vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS));

    tmc5072_enable(&tmc, true);
    /* Coordinated so the gondola travels straight back to the origin. */
    tmc5072_move_coordinated(&tmc, 0, 0);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);

    ESP_LOGI(TAG, "HOMING done: M1 pos=%ld  M2 pos=%ld",
             (long)tmc5072_position(&tmc, MOTOR_THETA),
             (long)tmc5072_position(&tmc, MOTOR_RHO));
}

/* Defines "wherever the gondola physically is right now" as the coordinate
 * origin (0,0): hard-stops both motors in place, then writes XTARGET=XACTUAL=0
 * for each. This is the manual-homing calibration step CLAUDE.md describes
 * ("place the gondola at the true origin, then zero XACTUAL there"). It is the
 * default action of `sethome`, the ONLY origin-setter: the old single-motor test
 * commands that zeroed XACTUAL as a side effect (wig/verify/test) were removed
 * precisely because they silently redefined "0" out from under calibration.
 *
 * Use: physically place the gondola at the true geometric origin (midpoint
 * between the anchors, where both belts measure HOME_BELT_MM -- see CLAUDE.md
 * "Mechanical setup & calibration"), then run `sethome`. From that point on
 * XTARGET=0 means "true origin" -- and the firmware kinematics (goto/circle/
 * square/where) convert (x, y) mm to absolute XTARGET microsteps from it. */
static void set_origin_here(void)
{
    int32_t stop_t = tmc5072_position(&tmc, MOTOR_THETA);
    int32_t stop_r = tmc5072_position(&tmc, MOTOR_RHO);
    tmc5072_move_to(&tmc, MOTOR_THETA, stop_t);
    tmc5072_move_to(&tmc, MOTOR_RHO,   stop_r);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);

    tmc5072_write(&tmc, TMC5072_XTARGET(MOTOR_THETA), 0);
    tmc5072_write(&tmc, TMC5072_XACTUAL(MOTOR_THETA), 0);
    tmc5072_write(&tmc, TMC5072_XTARGET(MOTOR_RHO),   0);
    tmc5072_write(&tmc, TMC5072_XACTUAL(MOTOR_RHO),   0);

    ESP_LOGW(TAG, "ORIGIN SET HERE: M1 pos=%ld  M2 pos=%ld (XTARGET=XACTUAL=0 for both)",
             (long)tmc5072_position(&tmc, MOTOR_THETA),
             (long)tmc5072_position(&tmc, MOTOR_RHO));
}

static bool link_check(void)
{
    uint8_t st = 0;
    uint32_t in = tmc5072_read(&tmc, TMC5072_INPUT, &st);
    uint8_t ver = (in >> 24) & 0xFF;
    ESP_LOGI(TAG, "SPI link: status=0x%02x INPUT=0x%08lx VERSION=0x%02x (expect 0x10)",
             st, (unsigned long)in, ver);
    if (ver == 0x00 || ver == 0xFF) {
        /* 0xFF and 0x00 are the two classic "nothing is actually replying" signatures:
         * 0xFF = MISO stuck high (chip dead/CLK16 oscillator latch -- needs full 12V
         *        power-cycle, an ESP reset alone won't clear it -- or floating bus);
         * 0x00 = MISO stuck low (no SDO drive at all -- wrong pins, opto in the path, etc).
         * Both were hit during this board's bring-up; see CLAUDE.md "hard-won lessons". */
        ESP_LOGE(TAG, "  -> BAD VERSION (0xFF = MISO high / no reply; 0x00 = no MISO). Check:"
                      " CLK16->GND (internal osc), SWSEL->GND (SPI mode), CSN/SCK/SDI/SDO"
                      " wiring, and the 4.7k SDO->VCCIO pull-up.");
        return false;
    }
    ESP_LOGI(TAG, "  -> SPI link looks good");
    return true;
}

/* Safe boot diagnostics — checks the SPI link, configures both drivers, dumps
 * the registers and exercises the servo, but does NOT move the motors. */
static void run_bringup(void)
{
    ESP_LOGI(TAG, "================ BRING-UP ================");
    bool link_ok = link_check();

    tmc5072_config_motor(&tmc, MOTOR_THETA);
    tmc5072_config_motor(&tmc, MOTOR_RHO);
    apply_current(g_run_ma, g_hold_ma);
    apply_speed(g_vmax);
    apply_accel(g_accel);

    /* Verify config landed before any motion (like the wall-plotter's [3/3]). */
    print_global_status();
    print_full_status(MOTOR_THETA);
    print_full_status(MOTOR_RHO);

    ESP_LOGI(TAG, "Servo test: pen up/down x3");
    for (int i = 0; i < 3; i++) {
        servo_write_deg(PEN_DOWN_DEG); vTaskDelay(pdMS_TO_TICKS(600));
        servo_write_deg(PEN_UP_DEG);   vTaskDelay(pdMS_TO_TICKS(600));
    }

    tmc5072_enable(&tmc, false);   /* leave motors de-energized until commanded */
    ESP_LOGI(TAG, "========== BRING-UP DONE ==========");
    if (!link_ok) {
        ESP_LOGE(TAG, "SPI link FAILED — fix wiring before moving motors.");
    }
    ESP_LOGI(TAG, "Motors NOT moved. Calibrate: 'belt 0 0' (dry run) -> place gondola");
    ESP_LOGI(TAG, "at origin -> 'sethome' -> 'goto'/'line'/'circle'/'square'. 'help' for all.");
}

/* ---------------------------- console commands ----------------------------- */

static int motor_arg(const char *s) /* "1"/"2" -> 0/1, else -1 */
{
    int v = atoi(s);
    return (v == 1 || v == 2) ? v - 1 : -1;
}

static int cmd_link(int argc, char **argv) { (void)argc; (void)argv; link_check(); return 0; }

static int cmd_cur(int argc, char **argv)
{
    if (argc < 2) { printf("usage: cur <run_mA> [hold_mA]\n"); return 0; }
    g_run_ma = atof(argv[1]);
    if (argc >= 3) g_hold_ma = atof(argv[2]);
    apply_current(g_run_ma, g_hold_ma);
    return 0;
}

static int cmd_speed(int argc, char **argv)
{
    if (argc < 2) { printf("usage: speed <vmax>\n"); return 0; }
    g_vmax = strtoul(argv[1], NULL, 0);
    apply_speed(g_vmax);
    return 0;
}

static int cmd_accel(int argc, char **argv)
{
    if (argc < 2) { printf("usage: accel <amax>\n"); return 0; }
    g_accel = strtoul(argv[1], NULL, 0);
    apply_accel(g_accel);
    return 0;
}

static int cmd_exit(int argc, char **argv)
{
    (void)argc; (void)argv;
    printf("Closing REPL. Press Ctrl+] to exit idf.py monitor.\n");
    s_repl->del(s_repl);
    return 0;
}

static void print_geom_vars(void)
{
    printf("  home_belt  = %.1f mm  (default %.1f)\n",  (double)g_home_belt_mm,  (double)HOME_BELT_MM);
    printf("  motor_span = %.1f mm  (default %.1f)\n",  (double)g_motor_span_mm, (double)MOTOR_SPAN_MM);
    printf("  steps/mm   = %.3f\n",   (double)g_steps_per_mm);
    printf("  x_scale    = %.4f\n",   (double)g_x_scale);
    printf("  y_scale    = %.4f\n",   (double)g_y_scale);
    printf("  -> drop    = %.2f mm\n", (double)g_geom.drop_mm);
}

static int cmd_setsteps(int argc, char **argv)
{
    if (argc < 2) {
        print_geom_vars();
        printf("usage: setsteps <steps_per_mm>\n");
        return 0;
    }
    g_steps_per_mm = atof(argv[1]);
    init_geometry();
    print_geom_vars();
    return 0;
}

static int cmd_setxscale(int argc, char **argv)
{
    if (argc < 2) {
        print_geom_vars();
        printf("usage: setxscale <scale>   (1.0 = no correction)\n");
        return 0;
    }
    g_x_scale = atof(argv[1]);
    init_geometry();
    print_geom_vars();
    return 0;
}

static int cmd_setyscale(int argc, char **argv)
{
    if (argc < 2) {
        print_geom_vars();
        printf("usage: setyscale <scale>   (1.0 = no correction)\n");
        return 0;
    }
    g_y_scale = atof(argv[1]);
    init_geometry();
    print_geom_vars();
    return 0;
}

static int cmd_setspan(int argc, char **argv)
{
    if (argc < 2) {
        print_geom_vars();
        printf("usage: setspan <mm>\n");
        return 0;
    }
    g_motor_span_mm = atof(argv[1]);
    init_geometry();
    print_geom_vars();
    return 0;
}

static int cmd_setbounds(int argc, char **argv)
{
    if (argc < 5) {
        printf("  bounds: x=[%.1f, %.1f]  y=[%.1f, %.1f] mm\n",
               (double)g_x_min, (double)g_x_max, (double)g_y_min, (double)g_y_max);
        printf("usage: setbounds <xmin> <xmax> <ymin> <ymax>\n");
        return 0;
    }
    g_x_min = atof(argv[1]);
    g_x_max = atof(argv[2]);
    g_y_min = atof(argv[3]);
    g_y_max = atof(argv[4]);
    printf("bounds set: x=[%.1f, %.1f]  y=[%.1f, %.1f] mm\n",
           (double)g_x_min, (double)g_x_max, (double)g_y_min, (double)g_y_max);
    return 0;
}

static int cmd_setbelt(int argc, char **argv)
{
    if (argc < 2) {
        print_geom_vars();
        printf("usage: setbelt <mm>\n");
        return 0;
    }
    g_home_belt_mm = atof(argv[1]);
    init_geometry();
    print_geom_vars();
    return 0;
}

/* Clamp (x,y) to the drawable area. Returns true and logs a warning if clamped. */
static bool clamp_xy(float *x, float *y)
{
    bool clamped = false;
    if (*x > g_x_max) { *x = g_x_max; clamped = true; }
    if (*x < g_x_min) { *x = g_x_min; clamped = true; }
    if (*y > g_y_max) { *y = g_y_max; clamped = true; }
    if (*y < g_y_min) { *y = g_y_min; clamped = true; }
    if (clamped)
        ESP_LOGW(TAG, "point clamped to drawable area (x=%.1f y=%.1f)",
                 (double)*x, (double)*y);
    return clamped;
}

/* DRY RUN: compute belt lengths + motor targets for (x,y) mm WITHOUT moving.
 * The first thing to use when calibrating -- check the geometry, sign, and
 * magnitude of the targets against hand calculations / a tape measure before
 * letting `goto` actually drive the gondola. */
static int cmd_belt(int argc, char **argv)
{
    if (argc < 3) { printf("usage: belt <x_mm> <y_mm>   (dry run: prints targets, no motion)\n"); return 0; }
    float x = atof(argv[1]);
    float y = atof(argv[2]);

    float bl = plt_belt_left(&g_geom, x, y);
    float br = plt_belt_right(&g_geom, x, y);
    float l0 = plt_home_belt(&g_geom);
    int32_t sl, sr;
    plt_xy_to_steps(&g_geom, x, y, &sl, &sr);

    /* round-trip back to (x,y) to prove the forward/inverse math agrees */
    float rx, ry;
    plt_steps_to_xy(&g_geom, sl, sr, &rx, &ry);

    printf("\n-- belt dry run for (x=%.1f, y=%.1f) mm --\n", (double)x, (double)y);
    printf("  geom: span=%.1f drop=%.1f steps/mm=%.3f xs=%.4f ys=%.4f  home_belt=%.2f mm\n",
           (double)g_geom.span_mm, (double)g_geom.drop_mm, (double)g_geom.steps_per_mm,
           (double)g_geom.x_scale, (double)g_geom.y_scale, (double)l0);
    printf("  belt length : left=%.2f mm (%+.2f from home)  right=%.2f mm (%+.2f from home)\n",
           (double)bl, (double)(bl - l0), (double)br, (double)(br - l0));
    printf("  motor target: LEFT(M1)=%ld steps  RIGHT(M2)=%ld steps  [signs L=%+d R=%+d]\n",
           (long)sl, (long)sr, g_geom.left_sign, g_geom.right_sign);
    printf("  round-trip  : (%.2f, %.2f) mm  (err %.3f, %.3f)\n",
           (double)rx, (double)ry, (double)(rx - x), (double)(ry - y));
    return 0;
}

/* Move the gondola to an (x,y) mm coordinate using the firmware kinematics and a
 * coordinated (time-synced) move so the segment is straight. Requires the origin
 * to have been set (manual placement + `sethome`) for the coordinates to be true. */
static int cmd_goto(int argc, char **argv)
{
    if (argc < 3) { printf("usage: goto <x_mm> <y_mm>\n"); return 0; }
    float x = atof(argv[1]);
    float y = atof(argv[2]);
    int32_t sl, sr;
    plt_xy_to_steps(&g_geom, x, y, &sl, &sr);
    printf("goto (%.1f, %.1f) mm -> LEFT(M1)=%ld RIGHT(M2)=%ld steps\n",
           (double)x, (double)y, (long)sl, (long)sr);
    do_draw_goto(x, y);
    return 0;
}

/* Read both motors' XACTUAL back and convert to an (x,y) mm coordinate, so you
 * can see where the firmware thinks the gondola is (inverse kinematics). */
static int cmd_where(int argc, char **argv)
{
    (void)argc; (void)argv;
    int32_t sl = tmc5072_position(&tmc, MOTOR_RHO);    /* RHO is physically left */
    int32_t sr = tmc5072_position(&tmc, MOTOR_THETA);  /* THETA is physically right */
    float x, y;
    plt_steps_to_xy(&g_geom, sl, sr, &x, &y);
    printf("where: LEFT(M2)=%ld RIGHT(M1)=%ld steps -> (x=%.2f, y=%.2f) mm\n",
           (long)sl, (long)sr, (double)x, (double)y);
    return 0;
}

/* Pen lift/drop with the configured settle dwell. */
static void pen_lift(void) { servo_write_deg(PEN_UP_DEG);   vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS)); }
static void pen_drop(void) { servo_write_deg(PEN_DOWN_DEG); vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS)); }

/* Clamp (x,y) to the drawable area. Returns true and prints a warning if
 * the point was outside the limits defined in board_config.h. */
/* Coordinated move to an (x,y) mm point (does not touch the pen). */
static void move_to_xy(float x, float y)
{
    clamp_xy(&x, &y);
    int32_t sl, sr;
    plt_xy_to_steps(&g_geom, x, y, &sl, &sr);
    tmc5072_move_coordinated(&tmc, sr, sl);   /* THETA=right, RHO=left */
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
}

/* Block until BOTH motors are within `lookahead` microsteps of their targets
 * (tl, tr) -- "near", not necessarily "reached". Used to issue the next line
 * sub-segment early so the ramp generator never decelerates to a full stop. */
static void wait_both_near(int32_t tl, int32_t tr, int32_t lookahead, int timeout_ms)
{
    int waited = 0;
    while (waited < timeout_ms) {
        int32_t al = tmc5072_position(&tmc, MOTOR_RHO);    /* RHO is physically left */
        int32_t ar = tmc5072_position(&tmc, MOTOR_THETA);  /* THETA is physically right */
        if (labs(tl - al) <= lookahead && labs(tr - ar) <= lookahead) return;
        vTaskDelay(pdMS_TO_TICKS(2));
        waited += 2;
    }
}

/* Draw a straight Cartesian line from (x0,y0) to (x1,y1) mm, assuming the pen is
 * already at (x0,y0). Splits the line into <= LINE_SEG_MM pieces (so the path
 * stays straight -- a single coordinated move would be straight only in step
 * space and would bow), and STREAMS them: each sub-segment's target is issued as
 * soon as the gondola comes within LINE_LOOKAHEAD_MM of the previous one, so the
 * motion flows continuously instead of dead-stopping at every 2 mm. The final
 * sub-segment waits for a true stop, so the endpoint/corner is hit exactly. Pen
 * state is the caller's responsibility. */
static void draw_line_mm(float x0, float y0, float x1, float y1)
{
    float dx = x1 - x0, dy = y1 - y0;
    float len = sqrtf(dx * dx + dy * dy);
    int n = plt_line_segments(len, LINE_SEG_MM);
    int32_t lookahead = (int32_t)(LINE_LOOKAHEAD_MM * g_geom.steps_per_mm);
    int32_t sl, sr;
    for (int i = 1; i <= n; i++) {
        float t = (float)i / (float)n;
        float px = x0 + dx * t, py = y0 + dy * t;
        clamp_xy(&px, &py);
        plt_xy_to_steps(&g_geom, px, py, &sl, &sr);
        tmc5072_move_coordinated(&tmc, sr, sl);   /* THETA=right, RHO=left */
        if (i < n) {
            wait_both_near(sl, sr, lookahead, MOVE_TIMEOUT_MS);   /* keep flowing */
        } else {
            wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);           /* exact at corner */
            wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
        }
    }
}

/* The optional trailing [cycles] arg on line/circle/square repeats the shape
 * that many times WITHOUT lifting the pen, retracing the same path to darken a
 * faint line. Defaults to 1. */
static int parse_cycles(const char *s)
{
    int c = atoi(s);
    return (c < 1) ? 1 : c;
}

/* Draw a straight line from (x0,y0) to (x1,y1) mm. Repeats [cycles] times by
 * retracing back-and-forth with the pen down (each extra pass reverses
 * direction, so no pen-up travel between passes). */
static int cmd_line(int argc, char **argv)
{
    if (argc < 5) { printf("usage: line <x0> <y0> <x1> <y1> [cycles]\n"); return 0; }
    float x0 = atof(argv[1]), y0 = atof(argv[2]);
    float x1 = atof(argv[3]), y1 = atof(argv[4]);
    int cycles = (argc >= 6) ? parse_cycles(argv[5]) : 1;
    printf("line (%.1f,%.1f)->(%.1f,%.1f) x%d pass%s\n",
           (double)x0, (double)y0, (double)x1, (double)y1, cycles, cycles == 1 ? "" : "es");
    do_draw_line(x0, y0, x1, y1, cycles);
    printf("line done\n");
    return 0;
}

/* Liang-Barsky clip of infinite line through (lx,ly) in direction (dx,dy) to the
 * axis-aligned box [cx-h, cx+h] x [cy-h, cy+h]. Returns the valid parameter range
 * [*s0, *s1] and false if the line misses the box entirely. */
static bool clip_to_rect(float cx, float cy, float h,
                          float lx, float ly, float dx, float dy,
                          float *s0, float *s1)
{
    *s0 = -1e9f; *s1 = 1e9f;
    float ps[4] = { -dx,  dx,  -dy,  dy  };
    float qs[4] = { lx - (cx - h), (cx + h) - lx,
                    ly - (cy - h), (cy + h) - ly };
    for (int k = 0; k < 4; k++) {
        if (fabsf(ps[k]) < 1e-7f) {
            if (qs[k] < 0.0f) return false;
        } else {
            float r = qs[k] / ps[k];
            if (ps[k] < 0.0f) { if (r > *s0) *s0 = r; }
            else               { if (r < *s1) *s1 = r; }
        }
    }
    return *s1 > *s0;
}

/* Clip infinite line through (lx,ly) in direction (dx,dy) to a circle of radius r
 * centred at (cx,cy). Returns the valid parameter range [*s0, *s1]. */
static bool clip_to_circle(float cx, float cy, float r,
                            float lx, float ly, float dx, float dy,
                            float *s0, float *s1)
{
    float ex = lx - cx, ey = ly - cy;
    float a = dx * dx + dy * dy;
    float b = 2.0f * (ex * dx + ey * dy);
    float c = ex * ex + ey * ey - r * r;
    float disc = b * b - 4.0f * a * c;
    if (disc < 0.0f) return false;
    float sq = sqrtf(disc);
    *s0 = (-b - sq) / (2.0f * a);
    *s1 = (-b + sq) / (2.0f * a);
    return true;
}

/* General angled hatch fill. Lines run at `angle_deg` (0 = horizontal), spaced
 * `spacing_mm` apart in the perpendicular direction. `is_circle` selects the
 * clipping shape; `shape_param` is radius (circle) or half-side (rectangle). */
static void hatch_lines(float cx, float cy, bool is_circle, float shape_param,
                         float angle_deg, float spacing_mm)
{
    if (spacing_mm < 0.1f) spacing_mm = 0.1f;
    float theta = angle_deg * (PLT_PI / 180.0f);
    float cos_t = cosf(theta), sin_t = sinf(theta);
    /* Perpendicular direction: (-sin_t, cos_t).  Extent of shape in that direction. */
    float extent = is_circle ? shape_param
                              : shape_param * (fabsf(cos_t) + fabsf(sin_t));
    float t = -extent + spacing_mm;
    while (t < extent) {
        float lx = cx + t * (-sin_t);
        float ly = cy + t *   cos_t;
        float s0, s1;
        bool ok = is_circle
            ? clip_to_circle(cx, cy, shape_param, lx, ly, cos_t, sin_t, &s0, &s1)
            : clip_to_rect  (cx, cy, shape_param, lx, ly, cos_t, sin_t, &s0, &s1);
        if (ok && s1 > s0 + 0.5f) {
            float x0 = lx + s0 * cos_t, y0 = ly + s0 * sin_t;
            float x1 = lx + s1 * cos_t, y1 = ly + s1 * sin_t;
            pen_lift();
            move_to_xy(x0, y0);
            pen_drop();
            draw_line_mm(x0, y0, x1, y1);
        }
        t += spacing_mm;
    }
}

/* ---- do_draw_* helpers: called by both console cmd_* and web_draw_task ---- */

/* Read both motors' actual position and push a structured SSE pos event.
 * No-op if the web server is not running (s_log_stream check inside web_pos_event). */
static void emit_pos_event(void)
{
    int32_t sl = tmc5072_position(&tmc, MOTOR_RHO);
    int32_t sr = tmc5072_position(&tmc, MOTOR_THETA);
    float x, y;
    plt_steps_to_xy(&g_geom, sl, sr, &x, &y);
    web_pos_event(x, y);
}

static void do_draw_goto(float x, float y)
{
    clamp_xy(&x, &y);
    int32_t sl, sr;
    plt_xy_to_steps(&g_geom, x, y, &sl, &sr);
    tmc5072_enable(&tmc, true);
    tmc5072_move_coordinated(&tmc, sr, sl);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    emit_pos_event();
}

static void do_draw_line(float x0, float y0, float x1, float y1, int cycles)
{
    tmc5072_enable(&tmc, true);
    pen_lift();
    move_to_xy(x0, y0);
    pen_drop();
    for (int c = 0; c < cycles; c++) {
        if (c & 1) draw_line_mm(x1, y1, x0, y0);
        else       draw_line_mm(x0, y0, x1, y1);
    }
    pen_lift();
}

static void do_draw_square(float cx, float cy, float size, int cycles, int fill_mode,
                            float hatch_angle, float hatch_spacing, bool outline)
{
    float h = size * 0.5f;
    tmc5072_enable(&tmc, true);
    if (outline) {
        float xs[4] = { cx - h, cx + h, cx + h, cx - h };
        float ys[4] = { cy - h, cy - h, cy + h, cy + h };
        pen_lift();
        move_to_xy(xs[0], ys[0]);
        pen_drop();
        for (int c = 0; c < cycles; c++)
            for (int e = 0; e < 4; e++)
                draw_line_mm(xs[e], ys[e], xs[(e + 1) & 3], ys[(e + 1) & 3]);
    }
    if (fill_mode == 1) {
        hatch_lines(cx, cy, false, h, hatch_angle, hatch_spacing);
    } else if (fill_mode == 2) {
        /* Concentric rings: start at outer edge (include it if no outline), step inward. */
        float s_start = outline ? size - 2.0f * hatch_spacing : size;
        for (float s = s_start; s > 2.0f * hatch_spacing; s -= 2.0f * hatch_spacing) {
            float hi = s * 0.5f;
            float xi[4] = { cx - hi, cx + hi, cx + hi, cx - hi };
            float yi[4] = { cy - hi, cy - hi, cy + hi, cy + hi };
            pen_lift();
            move_to_xy(xi[0], yi[0]);
            pen_drop();
            for (int e = 0; e < 4; e++)
                draw_line_mm(xi[e], yi[e], xi[(e + 1) & 3], yi[(e + 1) & 3]);
        }
    }
    pen_lift();
}

static void do_draw_circle(float cx, float cy, float r, int cycles, int fill_mode,
                            float hatch_angle, float hatch_spacing, bool outline)
{
    int n = plt_arc_segments(r, CIRCLE_CHORD_ERR_MM);
    if (n < 3) n = 3;
    float dth = PLT_TWO_PI / (float)n;
    float dc = cosf(dth), ds = sinf(dth);
    tmc5072_enable(&tmc, true);
    if (outline) {
        pen_lift();
        move_to_xy(cx + r, cy);
        pen_drop();
        for (int cyc = 0; cyc < cycles; cyc++) {
            float vx = r, vy = 0.0f;
            for (int k = 1; k <= n; k++) {
                float nvx = vx * dc - vy * ds;
                float nvy = vx * ds + vy * dc;
                vx = nvx; vy = nvy;
                float px = (k == n) ? cx + r : cx + vx;
                float py = (k == n) ? cy     : cy + vy;
                move_to_xy(px, py);
            }
        }
    }
    if (fill_mode == 1) {
        hatch_lines(cx, cy, true, r, hatch_angle, hatch_spacing);
    } else if (fill_mode == 2) {
        /* Concentric inward circles; start at r when no outline so the edge ring is drawn. */
        float r_start = outline ? r - hatch_spacing : r;
        for (float ri = r_start; ri > hatch_spacing * 0.5f; ri -= hatch_spacing) {
            int ni = plt_arc_segments(ri, CIRCLE_CHORD_ERR_MM);
            if (ni < 3) ni = 3;
            float dth_i = PLT_TWO_PI / (float)ni;
            float dc_i = cosf(dth_i), ds_i = sinf(dth_i);
            pen_lift();
            move_to_xy(cx + ri, cy);
            pen_drop();
            float vx_i = ri, vy_i = 0.0f;
            for (int k = 1; k <= ni; k++) {
                float nvx = vx_i * dc_i - vy_i * ds_i;
                float nvy = vx_i * ds_i + vy_i * dc_i;
                vx_i = nvx; vy_i = nvy;
                float px = (k == ni) ? cx + ri : cx + vx_i;
                float py = (k == ni) ? cy      : cy + vy_i;
                move_to_xy(px, py);
            }
        }
    }
    pen_lift();
}

static void do_draw_bullseye(float cx, float cy)
{
    const float arm = 10.0f;
    tmc5072_enable(&tmc, true);
    for (int c = 0; c < 5; c++) {
        pen_lift();  move_to_xy(cx - arm, cy);
        pen_drop();  draw_line_mm(cx - arm, cy, cx + arm, cy);
        pen_lift();  move_to_xy(cx, cy - arm);
        pen_drop();  draw_line_mm(cx, cy - arm, cx, cy + arm);
    }
    pen_lift();
}

static void do_draw_grid(float cx, float cy)
{
    const int   n    = 10;
    const float gap  = 8.0f;
    const float hlen = 50.0f;
    tmc5072_enable(&tmc, true);
    for (int i = 0; i < n; i++) {
        float y = cy + (i - (n - 1) * 0.5f) * gap;
        pen_lift();  move_to_xy(cx - hlen, y);
        pen_drop();  draw_line_mm(cx - hlen, y, cx + hlen, y);
    }
    for (int i = 0; i < n; i++) {
        float x = cx + (i - (n - 1) * 0.5f) * gap;
        pen_lift();  move_to_xy(x, cy - hlen);
        pen_drop();  draw_line_mm(x, cy - hlen, x, cy + hlen);
    }
    pen_lift();
}

/* Closed random curve using a radial Fourier series.
 *
 * The radius at angle θ is:
 *   r(θ) = r + Σ(h=1..harmonics) amp_h * sin(h*θ + phase_h)
 *
 * Amplitude of each harmonic falls off as 1/h so low harmonics dominate
 * (natural, smooth shape). wobble=0 → perfect circle; wobble=1 → maximum
 * distortion. bound_r clamps every sample so the curve never leaves that
 * radius from the centre.
 *
 * n sample points are drawn as connected straight segments (draw_line_mm
 * sub-divides each segment for Cartesian accuracy). The curve is closed by
 * connecting the last point back to the first. */
static void do_draw_wobbly(float cx, float cy, float r, float bound_r,
                            float wobble, int harmonics, int seed, int cycles)
{
#define WOBBLY_MAX_PTS 128
    float px[WOBBLY_MAX_PTS], py[WOBBLY_MAX_PTS];

    if (harmonics < 1) harmonics = 1;
    if (harmonics > 8) harmonics = 8;
    int n = harmonics * 16;
    if (n < 24)  n = 24;
    if (n > WOBBLY_MAX_PTS) n = WOBBLY_MAX_PTS;

    /* Generate per-harmonic random amplitudes and phases. */
    srand((unsigned)seed);
    float amp[8], ph[8];
    for (int h = 0; h < harmonics; h++) {
        float rand_scale = (float)(rand() % 1000) / 1000.0f;
        amp[h] = wobble * r / (float)(h + 1) * rand_scale;
        ph[h]  = (float)(rand() % 1000) / 1000.0f * PLT_TWO_PI;
    }

    float min_r = r * 0.05f;   /* don't collapse to a point */

    for (int i = 0; i < n; i++) {
        float theta = PLT_TWO_PI * (float)i / (float)n;
        float ri = r;
        for (int h = 0; h < harmonics; h++)
            ri += amp[h] * sinf((float)(h + 1) * theta + ph[h]);
        if (bound_r > 0.0f && ri > bound_r) ri = bound_r;
        if (ri < min_r) ri = min_r;
        px[i] = cx + ri * cosf(theta);
        py[i] = cy + ri * sinf(theta);
    }

    tmc5072_enable(&tmc, true);
    pen_lift();
    move_to_xy(px[0], py[0]);
    pen_drop();
    for (int c = 0; c < cycles; c++) {
        for (int i = 1; i <= n; i++)
            draw_line_mm(px[(i - 1) % n], py[(i - 1) % n],
                         px[i % n],       py[i % n]);
    }
    pen_lift();
#undef WOBBLY_MAX_PTS
}

/* ---- console command wrappers (thin: parse + print, then call do_draw_*) ---- */

static int cmd_square(int argc, char **argv)
{
    if (argc < 4) { printf("usage: square <cx> <cy> <size> [cycles] [fill 0|1|2] [angle_deg] [spacing_mm] [outline 0|1]\n"); return 0; }
    float cx = atof(argv[1]), cy = atof(argv[2]), z = atof(argv[3]);
    if (z <= 0.0f) { printf("size must be > 0\n"); return 0; }
    int   cycles    = (argc >= 5) ? parse_cycles(argv[4]) : 1;
    int   fill_mode = (argc >= 6) ? atoi(argv[5]) : 0;
    float hangle    = (argc >= 7) ? atof(argv[6]) : 0.0f;
    float hspac     = (argc >= 8) ? atof(argv[7]) : HATCH_SPACING_MM;
    bool  outline   = (argc >= 9) ? (atoi(argv[8]) != 0) : true;
    static const char *fill_names[] = { "", " [hatch]", " [concentric]" };
    int fi = (fill_mode >= 0 && fill_mode <= 2) ? fill_mode : 0;
    printf("square (%.1f, %.1f) side=%.1f mm x%d%s%s\n",
           (double)cx, (double)cy, (double)z, cycles, fill_names[fi], outline ? "" : " [no outline]");
    if (fill_mode > 0) printf("  fill: angle=%.1f deg  spacing=%.1f mm\n",
                              (double)hangle, (double)hspac);
    do_draw_square(cx, cy, z, cycles, fill_mode, hangle, hspac, outline);
    printf("square done\n");
    return 0;
}

static int cmd_bullseye(int argc, char **argv)
{
    float cx = (argc >= 3) ? atof(argv[1]) : 0.0f;
    float cy = (argc >= 3) ? atof(argv[2]) : 0.0f;
    printf("bullseye (%.1f, %.1f) arm=10 mm x5\n", (double)cx, (double)cy);
    do_draw_bullseye(cx, cy);
    printf("bullseye done\n");
    return 0;
}

static int cmd_grid(int argc, char **argv)
{
    float cx = (argc >= 3) ? atof(argv[1]) : 0.0f;
    float cy = (argc >= 3) ? atof(argv[2]) : 0.0f;
    printf("grid center=(%.1f, %.1f) 10x10 lines 8mm spacing 100mm long\n",
           (double)cx, (double)cy);
    do_draw_grid(cx, cy);
    printf("grid done\n");
    return 0;
}

static int cmd_circle(int argc, char **argv)
{
    if (argc < 4) { printf("usage: circle <cx> <cy> <r> [cycles] [fill 0|1|2] [angle_deg] [spacing_mm] [outline 0|1]\n"); return 0; }
    float cx = atof(argv[1]), cy = atof(argv[2]), r = atof(argv[3]);
    if (r <= 0.0f) { printf("radius must be > 0\n"); return 0; }
    int   cycles    = (argc >= 5) ? parse_cycles(argv[4]) : 1;
    int   fill_mode = (argc >= 6) ? atoi(argv[5]) : 0;
    float hangle    = (argc >= 7) ? atof(argv[6]) : 0.0f;
    float hspac     = (argc >= 8) ? atof(argv[7]) : HATCH_SPACING_MM;
    bool  outline   = (argc >= 9) ? (atoi(argv[8]) != 0) : true;
    int n = plt_arc_segments(r, CIRCLE_CHORD_ERR_MM);
    static const char *fill_names[] = { "", " [hatch]", " [concentric]" };
    int fi = (fill_mode >= 0 && fill_mode <= 2) ? fill_mode : 0;
    printf("circle (%.1f, %.1f) r=%.1f mm %d segs x%d%s%s\n",
           (double)cx, (double)cy, (double)r, n, cycles, fill_names[fi], outline ? "" : " [no outline]");
    if (fill_mode > 0) printf("  fill: angle=%.1f deg  spacing=%.1f mm\n",
                              (double)hangle, (double)hspac);
    do_draw_circle(cx, cy, r, cycles, fill_mode, hangle, hspac, outline);
    printf("circle done\n");
    return 0;
}

/* web_draw_task: dequeues web commands and executes them sequentially.
 *
 * This is the only task that drives the motors from the web UI. All the HTTP
 * handlers (handle_circle, handle_goto, …) just push a wcmd_t onto g_draw_queue
 * and return immediately. This task is where the actual motor moves happen —
 * keeping all blocking motor waits out of the httpd worker.
 *
 * Command data is packed into wcmd_t.p[8] by convention:
 *   p[0..3]  shape/position parameters (cx, cy, r/size, cycles)
 *   p[4]     fill_mode (0=none 1=hatch 2=concentric)
 *   p[5]     hatch_angle (degrees)
 *   p[6]     hatch_spacing (mm)
 *   p[7]     outline (1.0 = draw perimeter, 0.0 = fill only)
 *
 * After each draw command, emit_pos_event() fires an SSE "pos" event so the
 * browser canvas dot snaps to the gondola's final position. */
static void web_draw_task(void *arg)
{
    (void)arg;
    wcmd_t cmd;
    for (;;) {
        if (xQueueReceive(g_draw_queue, &cmd, portMAX_DELAY) != pdTRUE) continue;
        static const char *fill_label[] = { "", " [hatch]", " [concentric]" };
        switch (cmd.type) {
            case WCMD_CIRCLE: {
                int fm = (int)cmd.p[4];
                web_log("circle (%.1f,%.1f) r=%.1f x%d%s",
                        (double)cmd.p[0], (double)cmd.p[1], (double)cmd.p[2],
                        (int)cmd.p[3], (fm >= 0 && fm <= 2) ? fill_label[fm] : "");
                do_draw_circle(cmd.p[0], cmd.p[1], cmd.p[2], (int)cmd.p[3], fm, cmd.p[5], cmd.p[6], cmd.p[7] != 0.0f);
                emit_pos_event();
                web_log("circle done");
                break;
            }
            case WCMD_SQUARE: {
                int fm = (int)cmd.p[4];
                web_log("square (%.1f,%.1f) side=%.1f x%d%s",
                        (double)cmd.p[0], (double)cmd.p[1], (double)cmd.p[2],
                        (int)cmd.p[3], (fm >= 0 && fm <= 2) ? fill_label[fm] : "");
                do_draw_square(cmd.p[0], cmd.p[1], cmd.p[2], (int)cmd.p[3], fm, cmd.p[5], cmd.p[6], cmd.p[7] != 0.0f);
                emit_pos_event();
                web_log("square done");
                break;
            }
            case WCMD_LINE:
                web_log("line (%.1f,%.1f)->(%.1f,%.1f) x%d",
                        (double)cmd.p[0], (double)cmd.p[1],
                        (double)cmd.p[2], (double)cmd.p[3], (int)cmd.p[4]);
                do_draw_line(cmd.p[0], cmd.p[1], cmd.p[2], cmd.p[3], (int)cmd.p[4]);
                emit_pos_event();
                web_log("line done");
                break;
            case WCMD_GOTO:
                web_log("goto (%.1f, %.1f)", (double)cmd.p[0], (double)cmd.p[1]);
                do_draw_goto(cmd.p[0], cmd.p[1]);   /* do_draw_goto calls emit_pos_event */
                web_log("goto done");
                break;
            case WCMD_HOME:
                web_log("home");
                home_gondola();
                emit_pos_event();
                web_log("home done");
                break;
            case WCMD_STOP:
                web_log("stop");
                tmc5072_stop(&tmc, MOTOR_THETA);
                tmc5072_stop(&tmc, MOTOR_RHO);
                break;
            case WCMD_PEN_UP:
                web_log("pen up");
                pen_lift();
                break;
            case WCMD_PEN_DOWN:
                web_log("pen down");
                pen_drop();
                break;
            case WCMD_PEN_DEG:
                web_log("pen %.0f deg", (double)cmd.p[0]);
                servo_write_deg((int)cmd.p[0]);
                break;
            case WCMD_BULLSEYE:
                web_log("bullseye (%.1f, %.1f)", (double)cmd.p[0], (double)cmd.p[1]);
                do_draw_bullseye(cmd.p[0], cmd.p[1]);
                web_log("bullseye done");
                break;
            case WCMD_GRID:
                web_log("grid (%.1f, %.1f)", (double)cmd.p[0], (double)cmd.p[1]);
                do_draw_grid(cmd.p[0], cmd.p[1]);
                web_log("grid done");
                break;
            case WCMD_WOBBLY:
                web_log("wobbly (%.1f,%.1f) r=%.1f bound=%.1f wobble=%.2f h=%d seed=%d x%d",
                        (double)cmd.p[0], (double)cmd.p[1], (double)cmd.p[2], (double)cmd.p[3],
                        (double)cmd.p[4], (int)cmd.p[5], (int)cmd.p[6], (int)cmd.p[7]);
                do_draw_wobbly(cmd.p[0], cmd.p[1], cmd.p[2], cmd.p[3],
                               cmd.p[4], (int)cmd.p[5], (int)cmd.p[6], (int)cmd.p[7]);
                emit_pos_event();
                web_log("wobbly done");
                break;
            case WCMD_SETHOME:
                web_log("sethome");
                set_origin_here();
                web_log("sethome done");
                break;
            case WCMD_BOUNDS:
                g_x_min = cmd.p[0]; g_x_max = cmd.p[1];
                g_y_min = cmd.p[2]; g_y_max = cmd.p[3];
                web_log("bounds: x=[%.1f,%.1f] y=[%.1f,%.1f] mm",
                        (double)g_x_min, (double)g_x_max,
                        (double)g_y_min, (double)g_y_max);
                break;
            case WCMD_SPEED:
                g_vmax = (uint32_t)cmd.p[0];
                apply_speed(g_vmax);
                web_log("speed vmax=%lu", (unsigned long)g_vmax);
                break;
            case WCMD_ACCEL:
                g_accel = (uint32_t)cmd.p[0];
                apply_accel(g_accel);
                web_log("accel amax=%lu", (unsigned long)g_accel);
                break;
            case WCMD_CURRENT:
                g_run_ma = cmd.p[0];
                if (cmd.p[1] >= 0.0f) g_hold_ma = cmd.p[1];
                apply_current(g_run_ma, g_hold_ma);
                web_log("current run=%.0f hold=%.0f mA",
                        (double)g_run_ma, (double)g_hold_ma);
                break;
            default:
                break;
        }
    }
}

/* Jog a motor at a constant velocity (RAMPMODE 1/2) until `stop`. Handy during
 * calibration to confirm a motor's direction sign and to position the gondola
 * by hand-eye. vel sign sets direction. */
static int cmd_jog(int argc, char **argv)
{
    if (argc < 3) { printf("usage: jog <1|2> <velocity>   (use 'stop <1|2>' to halt)\n"); return 0; }
    int m = motor_arg(argv[1]);
    if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
    int32_t v = (int32_t)strtol(argv[2], NULL, 0);
    tmc5072_enable(&tmc, true);
    tmc5072_move_velocity(&tmc, m, v, g_accel);
    printf("M%d jogging at v=%ld (RAMPMODE %d). 'stop %d' to halt.\n",
           m + 1, (long)v, (v < 0) ? 2 : 1, m + 1);
    return 0;
}

static int cmd_stop(int argc, char **argv)
{
    if (argc < 2) {   /* stop both by default */
        tmc5072_stop(&tmc, MOTOR_THETA);
        tmc5072_stop(&tmc, MOTOR_RHO);
        printf("both motors decelerating to stop\n");
        return 0;
    }
    int m = motor_arg(argv[1]);
    if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
    tmc5072_stop(&tmc, m);
    printf("M%d decelerating to stop\n", m + 1);
    return 0;
}

/* Establish the coordinate origin (0,0). The single home-setting command:
 *   sethome                       manual: zero BOTH motors at the current spot
 *                                 (place the gondola at the midpoint origin,
 *                                 both belts = HOME_BELT_MM, then run this)
 *   sethome sg <1|2> <vel> [sgt]  EXPERIMENTAL stallGuard2 sensorless home of
 *                                 one motor: drive toward a hard stop until the
 *                                 belt stalls, then zero that motor. SGT needs
 *                                 tuning -- start coarse.
 * These are the ONLY deliberate origin-setters in the firmware. */
static int cmd_sethome(int argc, char **argv)
{
    if (argc >= 2 && !strcmp(argv[1], "sg")) {
        if (argc < 4) {
            printf("usage: sethome sg <1|2> <velocity> [sgt]   (EXPERIMENTAL — tune sgt!)\n");
            return 0;
        }
        int m = motor_arg(argv[2]);
        if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
        int32_t v = (int32_t)strtol(argv[3], NULL, 0);
        int sgt   = (argc >= 5) ? atoi(argv[4]) : 4;
        tmc5072_enable(&tmc, true);
        printf("M%d stallGuard home at v=%ld sgt=%d ...\n", m + 1, (long)v, sgt);
        esp_err_t r = tmc5072_home_stallguard(&tmc, m, v, g_accel, sgt, MOVE_TIMEOUT_MS);
        printf("  -> %s (XACTUAL now %ld)\n",
               (r == ESP_OK) ? "STALL detected, zeroed" : "NO stall (timeout) — adjust sgt/velocity",
               (long)tmc5072_position(&tmc, m));
        return 0;
    }

    /* Default: manual in-place origin set for both motors. */
    set_origin_here();
    return 0;
}

static int cmd_wobbly(int argc, char **argv)
{
    if (argc < 4) {
        printf("usage: wobbly <cx> <cy> <r> [bound_r] [wobble 0-1] [harmonics 1-8] [seed] [cycles]\n");
        printf("  wobble=0 -> circle, wobble=1 -> max distortion\n");
        printf("  harmonics: 1=gentle blob  8=complex jagged\n");
        return 0;
    }
    float cx       = atof(argv[1]);
    float cy       = atof(argv[2]);
    float r        = atof(argv[3]);
    float bound_r  = (argc >= 5) ? atof(argv[4]) : r * 1.5f;
    float wobble   = (argc >= 6) ? atof(argv[5]) : 0.4f;
    int   harmonics= (argc >= 7) ? atoi(argv[6]) : 3;
    int   seed     = (argc >= 8) ? atoi(argv[7]) : 42;
    int   cycles   = (argc >= 9) ? parse_cycles(argv[8]) : 1;
    if (r <= 0.0f) { printf("r must be > 0\n"); return 0; }
    printf("wobbly (%.1f, %.1f) r=%.1f bound=%.1f wobble=%.2f h=%d seed=%d x%d\n",
           (double)cx, (double)cy, (double)r, (double)bound_r,
           (double)wobble, harmonics, seed, cycles);
    do_draw_wobbly(cx, cy, r, bound_r, wobble, harmonics, seed, cycles);
    printf("wobbly done\n");
    return 0;
}

static int cmd_pen(int argc, char **argv)
{
    if (argc < 2) { printf("usage: pen <up|down|degrees>\n"); return 0; }
    if      (!strcmp(argv[1], "up"))   servo_write_deg(PEN_UP_DEG);
    else if (!strcmp(argv[1], "down")) servo_write_deg(PEN_DOWN_DEG);
    else                               servo_write_deg(atof(argv[1]));
    printf("pen -> %s\n", argv[1]);
    return 0;
}

static int cmd_en(int argc, char **argv)
{
    if (argc < 2) { printf("usage: en <0|1>\n"); return 0; }
    bool on = atoi(argv[1]) != 0;
    tmc5072_enable(&tmc, on);
    printf("drivers %s\n", on ? "ENABLED" : "disabled");
    return 0;
}

static int cmd_stat(int argc, char **argv)
{
    (void)argc; (void)argv;
    print_status(MOTOR_THETA);
    print_status(MOTOR_RHO);
    return 0;
}

static int cmd_status(int argc, char **argv)
{
    (void)argc; (void)argv;
    print_global_status();
    print_full_status(MOTOR_THETA);
    print_full_status(MOTOR_RHO);
    return 0;
}

static int cmd_home(int argc, char **argv) { (void)argc; (void)argv; home_gondola(); return 0; }

static void register_commands(void)
{
    const esp_console_cmd_t cmds[] = {
        { .command = "link",   .help = "Re-read the TMC over SPI (VERSION check)",  .func = cmd_link },
        { .command = "cur",    .help = "Set current: cur <run_mA> [hold_mA]",       .func = cmd_cur },
        { .command = "speed",  .help = "Set speed: speed <vmax>",                   .func = cmd_speed },
        { .command = "accel",   .help = "Set acceleration: accel <amax>",                             .func = cmd_accel },
        { .command = "setbelt", .help = "Set home belt length (mm): setbelt <mm> (recalcs geometry)", .func = cmd_setbelt },
        { .command = "setspan",  .help = "Set motor span (mm): setspan <mm> (recalcs geometry)",          .func = cmd_setspan },
        { .command = "setsteps",   .help = "Set steps/mm: setsteps <val> (recalcs geometry)",   .func = cmd_setsteps  },
        { .command = "setxscale",  .help = "Set X axis scale: setxscale <val> (default 1.0)",  .func = cmd_setxscale },
        { .command = "setyscale",  .help = "Set Y axis scale: setyscale <val> (default 1.0)",  .func = cmd_setyscale },
        { .command = "setbounds",  .help = "Set drawable bounds (mm): setbounds <xmin> <xmax> <ymin> <ymax>", .func = cmd_setbounds },
        { .command = "exit",    .help = "Close the REPL console (press Ctrl+] to exit monitor)",      .func = cmd_exit },
        { .command = "belt",   .help = "DRY RUN: print belt lengths + targets for goto <x> <y> (no motion)", .func = cmd_belt },
        { .command = "goto",   .help = "Move gondola to (x,y) mm via kinematics: goto <x_mm> <y_mm>", .func = cmd_goto },
        { .command = "line",   .help = "Draw a line: line <x0> <y0> <x1> <y1> [cycles]", .func = cmd_line },
        { .command = "circle", .help = "Draw a circle: circle <cx> <cy> <r_mm> [cycles] [fill 0|1]", .func = cmd_circle },
        { .command = "square",   .help = "Draw a square: square <cx> <cy> <size_mm> [cycles] [fill 0|1]", .func = cmd_square },
        { .command = "wobbly",   .help = "Random closed curve: wobbly <cx> <cy> <r> [bound_r] [wobble 0-1] [harmonics 1-8] [seed] [cycles]", .func = cmd_wobbly },
        { .command = "bullseye", .help = "Draw calibration crosshair: bullseye [cx cy] (10mm arms, 5 passes)",        .func = cmd_bullseye },
        { .command = "grid",     .help = "Draw calibration grid: grid [cx cy] (10x10 lines, 8mm spacing, 100mm long)", .func = cmd_grid },
        { .command = "where",  .help = "Read XACTUAL back as an (x,y) mm coordinate", .func = cmd_where },
        { .command = "jog",    .help = "Velocity-mode jog: jog <1|2> <velocity> (stop to halt)", .func = cmd_jog },
        { .command = "stop",   .help = "Stop velocity jog: stop [1|2]",             .func = cmd_stop },
        { .command = "pen",    .help = "Servo: pen <up|down|degrees>",              .func = cmd_pen },
        { .command = "en",     .help = "Enable/disable drivers: en <0|1>",          .func = cmd_en },
        { .command = "home",   .help = "Home: return both motors to XTARGET=0",     .func = cmd_home },
        { .command = "sethome", .help = "Set origin: sethome (manual, both) | sethome sg <1|2> <vel> [sgt]", .func = cmd_sethome },
        { .command = "stat",   .help = "Brief DRV_STATUS + positions",              .func = cmd_stat },
        { .command = "status", .help = "Full register readback (both motors)",      .func = cmd_status },
    };
    for (size_t i = 0; i < sizeof(cmds) / sizeof(cmds[0]); i++) {
        ESP_ERROR_CHECK(esp_console_cmd_register(&cmds[i]));
    }
}

/* ------------------------------- WiFi (station) ----------------------------- */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_wifi_connected = false;
        ESP_LOGW(TAG, "WiFi: disconnected, retrying...");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *evt = (ip_event_got_ip_t *)data;
        s_wifi_ip = evt->ip_info;
        s_wifi_connected = true;
        ESP_LOGI(TAG, "WiFi: got IP " IPSTR
                      "  <-- open http://" IPSTR "/ in a browser",
                 IP2STR(&evt->ip_info.ip), IP2STR(&evt->ip_info.ip));
        web_log("WiFi up: http://" IPSTR "/", IP2STR(&evt->ip_info.ip));
    }
}

/* Joins WIFI_SSID/WIFI_PASS in station mode. WiFi requires NVS (it stores
 * calibration data there); the erase-and-retry handles a fresh/incompatible
 * partition, which is the standard ESP-IDF nvs_flash_init() boilerplate. */
static void wifi_init_sta(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wcfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

    wifi_config_t sta_cfg = {
        .sta = {
            .ssid     = WIFI_SSID,
            .password = WIFI_PASS,
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "WiFi: connecting to '%s'... (watch for the got-IP log line)", WIFI_SSID);
}

/* ------------------------- UDP boundary-hit listener ------------------------ */

/* Listens for the single-byte edge codes gondola_boundary_keeper.py sends:
 *   '1'/'2'/'3'/'4' = LEFT/TOP/RIGHT/BOTTOM side hit, 'o' = drifted far past the
 * arena (panic). Any of them triggers home_gondola(). 'h'/'s'/'x' (heartbeat /
 * start / stop) are also sent by that script but ignored here -- this firmware
 * doesn't implement the bouncing behavior those codes were designed to drive. */
static void udp_listener_task(void *arg)
{
    struct sockaddr_in addr = {
        .sin_family      = AF_INET,
        .sin_port        = htons(UDP_LISTEN_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };

    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "UDP: socket() failed, errno=%d", errno);
        vTaskDelete(NULL);
    }
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "UDP: bind() to port %d failed, errno=%d", UDP_LISTEN_PORT, errno);
        close(sock);
        vTaskDelete(NULL);
    }
    ESP_LOGI(TAG, "UDP: listening on port %d for boundary-hit codes (1-4, 'o' -> home)",
             UDP_LISTEN_PORT);

    char buf[8];
    while (1) {
        struct sockaddr_in src;
        socklen_t src_len = sizeof(src);
        int len = recvfrom(sock, buf, sizeof(buf) - 1, 0, (struct sockaddr *)&src, &src_len);
        if (len < 0) {
            ESP_LOGE(TAG, "UDP: recvfrom failed, errno=%d", errno);
            continue;
        }
        buf[len] = '\0';
        char code = buf[0];
        if (code == '1' || code == '2' || code == '3' || code == '4' || code == 'o') {
            ESP_LOGW(TAG, "UDP: boundary-hit code '%c' from %s -> homing",
                     code, inet_ntoa(src.sin_addr));
            home_gondola();
        }
    }
}

/* Streams a dense drawing pattern from the Python/cv2 side, point by point, over
 * its OWN UDP socket and task -- deliberately separate from udp_listener_task()
 * so a boundary-hit code can always preempt it instantly via home_gondola()'s
 * hard stop, rather than queuing up behind whatever point is currently mid-move
 * (the same "finish current move first" problem that motivated the hard stop).
 *
 * Wire format: one point per UDP datagram, ASCII "<m1_target> <m2_target> <pen 0|1>"
 * -- RAW absolute XTARGET microstep positions, not (x,y) plotter coordinates.
 * The x,y -> belt-length -> microstep conversion (CLAUDE.md "Mechanical setup &
 * calibration") deliberately stays on the Python side for now: that geometry math
 * is far easier to write, tune and visualize there than in C, and keeping the
 * firmware "dumb" (just walk the points it's given) means recalibrating later
 * only touches the Python side. */
static void pattern_stream_task(void *arg)
{
    struct sockaddr_in addr = {
        .sin_family      = AF_INET,
        .sin_port        = htons(PATTERN_LISTEN_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };

    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "PATTERN: socket() failed, errno=%d", errno);
        vTaskDelete(NULL);
    }
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "PATTERN: bind() to port %d failed, errno=%d", PATTERN_LISTEN_PORT, errno);
        close(sock);
        vTaskDelete(NULL);
    }
    ESP_LOGI(TAG, "PATTERN: listening on port %d for points \"<m1> <m2> <pen 0|1>\"",
             PATTERN_LISTEN_PORT);

    bool pen_down = false;   /* track state so we don't re-write/dwell on every point */
    servo_write_deg(PEN_UP_DEG);

    char buf[32];
    while (1) {
        struct sockaddr_in src;
        socklen_t src_len = sizeof(src);
        int len = recvfrom(sock, buf, sizeof(buf) - 1, 0, (struct sockaddr *)&src, &src_len);
        if (len < 0) {
            ESP_LOGE(TAG, "PATTERN: recvfrom failed, errno=%d", errno);
            continue;
        }
        buf[len] = '\0';

        int m1, m2, pen;
        if (sscanf(buf, "%d %d %d", &m1, &m2, &pen) != 3) {
            ESP_LOGW(TAG, "PATTERN: malformed point \"%s\" from %s, skipping",
                     buf, inet_ntoa(src.sin_addr));
            continue;
        }

        /* Always re-assert the commanded angle -- home_gondola()/cmd_pen()/
         * run_bringup() all write the servo directly, bypassing this task's
         * `pen_down` belief, so that belief can silently desync from the
         * physical position (symptom: gondola draws fine but the pen never
         * visibly moves -- it "transitions" to the angle it's already at, or
         * skips a transition it wrongly believes already happened). A bare
         * servo_write_deg() is just a PWM duty-cycle register write -- cheap
         * even when redundant -- so only the PEN_DWELL_MS settle delay needs
         * gating on an actual believed change, to keep free-motion pacing. */
        bool want_down = (pen != 0);
        servo_write_deg(want_down ? PEN_DOWN_DEG : PEN_UP_DEG);
        if (want_down != pen_down) {
            pen_down = want_down;
            vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS));
        }

        ESP_LOGI(TAG, "PATTERN: -> M1=%d M2=%d pen=%s", m1, m2, pen_down ? "down" : "up");

        tmc5072_enable(&tmc, true);
        /* Coordinated move: both belts reach their targets simultaneously, so the
         * gondola tracks the segment in a straight line instead of dog-legging
         * (the faster belt finishing early then the slower one catching up). The
         * chip's two ramp generators run this in parallel; we just wait for both. */
        tmc5072_move_coordinated(&tmc, (int32_t)m1, (int32_t)m2);
        wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
        wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    }
}

/* --------------------------------------------------------------------------- */

void app_main(void)
{
    ESP_LOGI(TAG, "Polar plotter bring-up test");

    init_geometry();   /* derive origin drop from the measured HOME_BELT_MM */

    ESP_ERROR_CHECK(servo_init(PIN_SERVO, SERVO_LEDC_CHANNEL));
    servo_write_deg(PEN_UP_DEG);

    tmc5072_config_t cfg = {
        .host         = TMC_SPI_HOST,
        .pin_sck      = PIN_SCK,
        .pin_mosi     = PIN_MOSI,
        .pin_miso     = PIN_MISO,
        .pin_csn      = PIN_CSN,
        .pin_enn      = PIN_ENN,
        .clock_hz     = TMC_SPI_HZ,
        .enn_on_level = ENN_ON_LEVEL,
        .r_sense      = R_SENSE,
        .vsense_high  = VSENSE_HIGH,
    };
    ESP_ERROR_CHECK(tmc5072_init(&tmc, &cfg));

    run_bringup();   /* safe: link check + status + servo, no motor motion */

    wifi_init_sta();
    xTaskCreate(udp_listener_task,   "udp_listener",   4096, NULL, 5, NULL);
    xTaskCreate(pattern_stream_task, "pattern_stream", 4096, NULL, 5, NULL);

    web_server_start();
    xTaskCreate(web_draw_task, "web_draw", 8192, NULL, 5, NULL);

    /* Interactive console over native USB-Serial-JTAG. */
    esp_console_repl_config_t repl_cfg = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_cfg.prompt = "plotter>";
    esp_console_dev_usb_serial_jtag_config_t hw = ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_console_new_repl_usb_serial_jtag(&hw, &repl_cfg, &s_repl));

    esp_console_register_help_command();
    register_commands();

    ESP_ERROR_CHECK(esp_console_start_repl(s_repl));
}
