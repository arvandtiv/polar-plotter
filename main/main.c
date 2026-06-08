/* Polar plotter hardware bring-up / self-test.
 *
 * On boot it runs an automatic sequence (SPI link check -> servo sweep ->
 * motor 1 back-and-forth -> motor 2 back-and-forth) then drops into an
 * interactive serial console so you can change current/speed/travel and
 * re-run individual tests while checking the wiring.
 *
 * Console (type `help`):
 *   link                 re-read the TMC over SPI (VERSION should be 0x10)
 *   cur <run_mA> [hold]  set run/hold current on both motors
 *   speed <vmax>         set VMAX (speed) on both motors
 *   move <m> <pos>       absolute move, motor m = 1 or 2
 *   vmove <m1> <m2>      coordinated move: both motors reach target together
 *                        (ramp of the shorter-travel motor scaled so the two
 *                        finish in the same time -- straight-line segments)
 *   belt <x> <y>         DRY RUN: print belt lengths + motor targets for (x,y)
 *                        mm without moving -- use this first when calibrating
 *   goto <x> <y>         move gondola to (x,y) mm via firmware kinematics
 *   where                read XACTUAL back as an (x,y) mm coordinate
 *   jog  <m> <vel>       velocity-mode jog (RAMPMODE 1/2); `stop` to halt
 *   stop [m]             decelerate a jog to standstill (both if no motor given)
 *   shome <m> <vel>[sgt] EXPERIMENTAL stallGuard2 sensorless home of one motor
 *   wig  <m> [amp] [n]   back-and-forth n times by +/- amp microsteps
 *   pen  <up|down|deg>   servo position
 *   en   <0|1>           disable / enable the drivers (ENN)
 *   stat                 dump DRV_STATUS + positions for both motors
 *   test                 re-run the full self-test
 *   home                 return both motors to XTARGET=0 (also triggered by UDP boundary hits)
 *   setorigin            calibrate: define the gondola's CURRENT physical spot as
 *                        (0,0) -- place it at the true geometric origin first! This
 *                        is the manual-homing step tools/weave/kinematics.py assumes
 *                        has been done; nothing else in the firmware performs it
 *                        (do_wiggle/cmd_verify zero XACTUAL too, but only as a side
 *                        effect of their own bring-up checks, wherever they happen
 *                        to run from -- not a deliberate origin calibration).
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

static const char *TAG = "plotter-test";
static tmc5072_t   tmc;

/* WiFi connection state, updated by wifi_event_handler() and surfaced in
 * print_global_status()/`status` so you can check connectivity + IP without
 * scrolling back through the boot log for the one-shot "got IP" line. */
static volatile bool      s_wifi_connected = false;
static esp_netif_ip_info_t s_wifi_ip;

/* Live-adjustable test parameters (seeded from board_config.h). */
static float    g_run_ma  = TEST_RUN_MA;
static float    g_hold_ma = TEST_HOLD_MA;
static uint32_t g_vmax    = TEST_VMAX;
static uint32_t g_accel   = 500;          /* AMAX/DMAX */
static int32_t  g_amp     = TEST_AMPLITUDE;

/* Machine geometry for the firmware-side kinematics (see kinematics.h). Built
 * from board_config.h so calibration is a matter of editing constants there.
 * `drop_mm` is derived at startup from the measured HOME_BELT_MM (sqrtf can't run
 * in a static initializer), so it's filled in app_main via init_geometry(). */
static plotter_geom_t g_geom = {
    .span_mm      = MOTOR_SPAN_MM,
    .drop_mm      = 0.0f,   /* set in init_geometry() from HOME_BELT_MM */
    .steps_per_mm = STEPS_PER_MM,
    .left_sign    = LEFT_DIR_SIGN,
    .right_sign   = RIGHT_DIR_SIGN,
};

static void init_geometry(void)
{
    g_geom.drop_mm = plt_drop_from_home_belt(MOTOR_SPAN_MM, HOME_BELT_MM);
    ESP_LOGI(TAG, "geometry: span=%.1f mm  home_belt=%.1f mm  -> origin drop=%.2f mm  (%.1f steps/mm)",
             (double)MOTOR_SPAN_MM, (double)HOME_BELT_MM,
             (double)g_geom.drop_mm, (double)g_geom.steps_per_mm);
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

static void do_wiggle(int m, int32_t amp, int cycles)
{
    tmc5072_enable(&tmc, true);
    /* Single-motor test: undo any ramp down-scaling a coordinated move may have
     * left on this motor, so it wiggles at the full configured speed. */
    tmc5072_set_ramp_scale(&tmc, m, 1.0f);
    /* Zero both XTARGET and XACTUAL together so the ramp generator sees target==actual
     * (no motion is triggered) while redefining "wherever the gondola physically is right
     * now" as position 0 -- i.e. treat the current spot as the new coordinate origin for
     * this test, regardless of what XACTUAL held before. */
    tmc5072_write(&tmc, TMC5072_XTARGET(m), 0);
    tmc5072_write(&tmc, TMC5072_XACTUAL(m), 0);

    for (int i = 0; i < cycles; i++) {
        tmc5072_move_to(&tmc, m, amp);
        wait_reached(m, MOVE_TIMEOUT_MS);
        tmc5072_move_to(&tmc, m, -amp);
        wait_reached(m, MOVE_TIMEOUT_MS);
        ESP_LOGI(TAG, "M%d cycle %d/%d done", m + 1, i + 1, cycles);
    }
    tmc5072_move_to(&tmc, m, 0);
    wait_reached(m, MOVE_TIMEOUT_MS);
    print_status(m);
}

/* "Home" the gondola: lift the pen, then return both motors to XTARGET=0.
 *
 * NOTE on what "home" means here: per CLAUDE.md this machine has no endstops
 * and no sensorless homing -- (0,0) only means something once the gondola has
 * been physically placed at the true origin and XACTUAL zeroed there (the
 * manual homing procedure). This routine does NOT perform that procedure; it
 * just returns to wherever position 0 currently is for each motor. That is
 * the true origin only if it was established that way earlier in the session
 * (e.g. fresh after manual homing, before any do_wiggle/wig call redefined it).
 *
 * Triggered by: the `home` console command, and by udp_listener_task() on any
 * boundary-hit code from the camera tracker. */
static void home_gondola(void)
{
    /* HARD STOP, first thing: redirect each motor's XTARGET to its current
     * XACTUAL. The sixPoint ramp generator (RAMPMODE=0) recomputes its ramp
     * the instant XTARGET changes, so this makes it decelerate to a stop
     * right where the gondola already is -- as fast as DMAX/D1/VSTOP allow --
     * instead of finishing whatever distant move (e.g. a `move 1 40000` test)
     * was in flight and THEN turning back to home. That "finish first, home
     * after" behaviour is exactly what this avoids: the redirect is a single
     * register write per motor, so it lands within the current SPI mutex's
     * microsecond-scale hold time regardless of what `wait_reached` elsewhere
     * is doing -- no shared abort flag or extra polling loop needed, so the
     * normal move path (cmd_move/do_wiggle/wait_reached) is untouched and free
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
 * ("place the gondola at the true origin, then zero XACTUAL there") -- until
 * now nothing in the firmware actually performed it. (do_wiggle/cmd_verify
 * also zero XACTUAL, but at whatever position they happen to run from -- a
 * side effect of their own bring-up checks, not a deliberate calibration --
 * which is exactly what was silently redefining "0" out from under any
 * earlier calibration and throwing off Python-side pattern placement.)
 *
 * Use: physically place the gondola at the true geometric origin (midpoint
 * between the anchors, where both belts measure HOME_BELT_MM -- see CLAUDE.md
 * "Mechanical setup & calibration"), then run `setorigin`. From that point on
 * XTARGET=0 means "true origin" -- until the next `setorigin`, `test`, or
 * `verify` redefines it -- which is the assumption tools/weave/kinematics.py
 * makes when it converts (x, y) mm to absolute XTARGET microsteps. */
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
    ESP_LOGI(TAG, "Motors NOT moved. Commands: 'wig 1' / 'wig 2' (one motor),");
    ESP_LOGI(TAG, "'test' (full motion), 'status', 'help'.");
}

/* Full self-test: safe bring-up, then back-and-forth on both motors. */
static void run_selftest(void)
{
    run_bringup();
    ESP_LOGI(TAG, "Motor 1 (left): back-and-forth +/-%ld x%d", (long)g_amp, TEST_CYCLES);
    do_wiggle(MOTOR_THETA, g_amp, TEST_CYCLES);
    ESP_LOGI(TAG, "Motor 2 (right): back-and-forth +/-%ld x%d", (long)g_amp, TEST_CYCLES);
    do_wiggle(MOTOR_RHO, g_amp, TEST_CYCLES);
    tmc5072_enable(&tmc, false);
    ESP_LOGI(TAG, "========== SELF TEST DONE ==========");
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

static int cmd_move(int argc, char **argv)
{
    if (argc < 3) { printf("usage: move <1|2> <position>\n"); return 0; }
    int m = motor_arg(argv[1]);
    if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
    tmc5072_enable(&tmc, true);
    tmc5072_set_ramp_scale(&tmc, m, 1.0f);   /* full speed for a single-motor move */
    tmc5072_move_to(&tmc, m, (int32_t)strtol(argv[2], NULL, 0));
    wait_reached(m, MOVE_TIMEOUT_MS);
    print_status(m);
    return 0;
}

static int cmd_wig(int argc, char **argv)
{
    if (argc < 2) { printf("usage: wig <1|2> [amp] [cycles]\n"); return 0; }
    int m = motor_arg(argv[1]);
    if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
    int32_t amp = (argc >= 3) ? (int32_t)strtol(argv[2], NULL, 0) : g_amp;
    int cycles  = (argc >= 4) ? atoi(argv[3]) : TEST_CYCLES;
    do_wiggle(m, amp, cycles);
    return 0;
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
    printf("  geom: span=%.1f drop=%.1f steps/mm=%.3f  home_belt=%.2f mm\n",
           (double)g_geom.span_mm, (double)g_geom.drop_mm,
           (double)g_geom.steps_per_mm, (double)l0);
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
 * to have been set (manual home + `setorigin`) for the coordinates to be true. */
static int cmd_goto(int argc, char **argv)
{
    if (argc < 3) { printf("usage: goto <x_mm> <y_mm>\n"); return 0; }
    float x = atof(argv[1]);
    float y = atof(argv[2]);
    int32_t sl, sr;
    plt_xy_to_steps(&g_geom, x, y, &sl, &sr);
    printf("goto (%.1f, %.1f) mm -> LEFT(M1)=%ld RIGHT(M2)=%ld steps\n",
           (double)x, (double)y, (long)sl, (long)sr);
    tmc5072_enable(&tmc, true);
    tmc5072_move_coordinated(&tmc, sl, sr);   /* MOTOR_THETA=left, MOTOR_RHO=right */
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    return 0;
}

/* Read both motors' XACTUAL back and convert to an (x,y) mm coordinate, so you
 * can see where the firmware thinks the gondola is (inverse kinematics). */
static int cmd_where(int argc, char **argv)
{
    (void)argc; (void)argv;
    int32_t sl = tmc5072_position(&tmc, MOTOR_THETA);
    int32_t sr = tmc5072_position(&tmc, MOTOR_RHO);
    float x, y;
    plt_steps_to_xy(&g_geom, sl, sr, &x, &y);
    printf("where: LEFT(M1)=%ld RIGHT(M2)=%ld steps -> (x=%.2f, y=%.2f) mm\n",
           (long)sl, (long)sr, (double)x, (double)y);
    return 0;
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

/* EXPERIMENTAL stallGuard2 sensorless homing of one motor (see
 * tmc5072_home_stallguard). Drives toward a hard stop until the belt stalls,
 * then zeroes that motor. SGT needs tuning -- start coarse. */
static int cmd_shome(int argc, char **argv)
{
    if (argc < 3) {
        printf("usage: shome <1|2> <velocity> [sgt]   (EXPERIMENTAL — tune sgt!)\n");
        return 0;
    }
    int m = motor_arg(argv[1]);
    if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
    int32_t v = (int32_t)strtol(argv[2], NULL, 0);
    int sgt   = (argc >= 4) ? atoi(argv[3]) : 4;
    tmc5072_enable(&tmc, true);
    printf("M%d stallGuard homing at v=%ld sgt=%d ...\n", m + 1, (long)v, sgt);
    esp_err_t r = tmc5072_home_stallguard(&tmc, m, v, g_accel, sgt, MOVE_TIMEOUT_MS);
    printf("  -> %s (XACTUAL now %ld)\n",
           (r == ESP_OK) ? "STALL detected, zeroed" : "NO stall (timeout) — adjust sgt/velocity",
           (long)tmc5072_position(&tmc, m));
    return 0;
}

static int cmd_vmove(int argc, char **argv)
{
    if (argc < 3) { printf("usage: vmove <m1_target> <m2_target>\n"); return 0; }
    int32_t t0 = (int32_t)strtol(argv[1], NULL, 0);
    int32_t t1 = (int32_t)strtol(argv[2], NULL, 0);
    tmc5072_enable(&tmc, true);
    /* Coordinated, time-synced move of both motors (same as the pattern stream). */
    tmc5072_move_coordinated(&tmc, t0, t1);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    print_status(MOTOR_THETA);
    print_status(MOTOR_RHO);
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

/* Adapted from the wall-plotter `verify`: there it proved two UART-addressed
 * drivers were independent. Here the two drivers share one SPI chip and are
 * addressed by register offset, so we prove the per-motor offsets are correct
 * by writing distinct currents + positions and confirming they read back
 * independently. */
static int cmd_verify(int argc, char **argv)
{
    (void)argc; (void)argv;
    printf("\n-- verify per-motor independence --\n");

    /* Test 1: write DIFFERENT currents to each driver, then read back via the
     * IHOLD_IRUN shadow. If the per-motor register-offset macros (CLAUDE.md:
     * "the address stride differs per register group") were wrong, both reads
     * would alias to the same physical register and come back equal -> FAIL. */
    tmc5072_set_current_ma(&tmc, MOTOR_THETA, 400, g_hold_ma);
    tmc5072_set_current_ma(&tmc, MOTOR_RHO,   900, g_hold_ma);
    uint8_t csA = (tmc5072_get_ihold_irun(&tmc, MOTOR_THETA) >> 8) & 0x1F;
    uint8_t csB = (tmc5072_get_ihold_irun(&tmc, MOTOR_RHO)   >> 8) & 0x1F;
    printf("  current: M1 IRUN=%u (wrote 400mA)  M2 IRUN=%u (wrote 900mA) -> %s\n",
           csA, csB, (csA != csB) ? "PASS" : "FAIL");

    /* Test 2: same idea for the position registers. Disable the output stage first
     * (ENN) so this is a pure register exercise that cannot spin the motors, and
     * write XTARGET == XACTUAL together so even with the driver re-enabled later,
     * the ramp generator sees "already at target" and won't suddenly move. */
    tmc5072_enable(&tmc, false);
    tmc5072_write(&tmc, TMC5072_XTARGET(MOTOR_THETA), 1111);
    tmc5072_write(&tmc, TMC5072_XACTUAL(MOTOR_THETA), 1111);
    tmc5072_write(&tmc, TMC5072_XTARGET(MOTOR_RHO),   2222);
    tmc5072_write(&tmc, TMC5072_XACTUAL(MOTOR_RHO),   2222);
    int32_t pA = tmc5072_position(&tmc, MOTOR_THETA);
    int32_t pB = tmc5072_position(&tmc, MOTOR_RHO);
    printf("  position: M1 XACTUAL=%ld (wrote 1111)  M2 XACTUAL=%ld (wrote 2222) -> %s\n",
           (long)pA, (long)pB, (pA == 1111 && pB == 2222) ? "PASS" : "FAIL");

    /* Reset origins and restore configured current. */
    for (int m = 0; m < 2; m++) {
        tmc5072_write(&tmc, TMC5072_XTARGET(m), 0);
        tmc5072_write(&tmc, TMC5072_XACTUAL(m), 0);
    }
    apply_current(g_run_ma, g_hold_ma);
    printf("  current restored to run=%.0f mA\n", (double)g_run_ma);
    return 0;
}

static int cmd_test(int argc, char **argv) { (void)argc; (void)argv; run_selftest(); return 0; }
static int cmd_home(int argc, char **argv) { (void)argc; (void)argv; home_gondola(); return 0; }
static int cmd_setorigin(int argc, char **argv) { (void)argc; (void)argv; set_origin_here(); return 0; }

static void register_commands(void)
{
    const esp_console_cmd_t cmds[] = {
        { .command = "link",   .help = "Re-read the TMC over SPI (VERSION check)",  .func = cmd_link },
        { .command = "cur",    .help = "Set current: cur <run_mA> [hold_mA]",       .func = cmd_cur },
        { .command = "speed",  .help = "Set speed: speed <vmax>",                   .func = cmd_speed },
        { .command = "accel",  .help = "Set acceleration: accel <amax>",            .func = cmd_accel },
        { .command = "move",   .help = "Absolute move: move <1|2> <position>",      .func = cmd_move },
        { .command = "vmove",  .help = "Coordinated move (both finish together): vmove <m1> <m2>", .func = cmd_vmove },
        { .command = "belt",   .help = "DRY RUN: print belt lengths + targets for goto <x> <y> (no motion)", .func = cmd_belt },
        { .command = "goto",   .help = "Move gondola to (x,y) mm via kinematics: goto <x_mm> <y_mm>", .func = cmd_goto },
        { .command = "where",  .help = "Read XACTUAL back as an (x,y) mm coordinate", .func = cmd_where },
        { .command = "jog",    .help = "Velocity-mode jog: jog <1|2> <velocity> (stop to halt)", .func = cmd_jog },
        { .command = "stop",   .help = "Stop velocity jog: stop [1|2]",             .func = cmd_stop },
        { .command = "shome",  .help = "EXPERIMENTAL stallGuard home: shome <1|2> <vel> [sgt]", .func = cmd_shome },
        { .command = "wig",    .help = "Back-and-forth: wig <1|2> [amp] [cycles]",  .func = cmd_wig },
        { .command = "pen",    .help = "Servo: pen <up|down|degrees>",              .func = cmd_pen },
        { .command = "en",     .help = "Enable/disable drivers: en <0|1>",          .func = cmd_en },
        { .command = "home",   .help = "Home: return both motors to XTARGET=0",     .func = cmd_home },
        { .command = "setorigin", .help = "Calibrate: define current spot as (0,0) -- place gondola at the true origin first!", .func = cmd_setorigin },
        { .command = "stat",   .help = "Brief DRV_STATUS + positions",              .func = cmd_stat },
        { .command = "status", .help = "Full register readback (both motors)",      .func = cmd_status },
        { .command = "verify", .help = "Prove the two motors are independent",      .func = cmd_verify },
        { .command = "test",   .help = "Re-run the full self-test",                 .func = cmd_test },
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
                      "  <-- point gondola_boundary_keeper.py's ARDUINO_IP at this",
                 IP2STR(&evt->ip_info.ip));
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
    xTaskCreate(udp_listener_task,  "udp_listener",  4096, NULL, 5, NULL);
    xTaskCreate(pattern_stream_task, "pattern_stream", 4096, NULL, 5, NULL);

    /* Interactive console over native USB-Serial-JTAG. */
    esp_console_repl_t *repl = NULL;
    esp_console_repl_config_t repl_cfg = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_cfg.prompt = "plotter>";
    esp_console_dev_usb_serial_jtag_config_t hw = ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_console_new_repl_usb_serial_jtag(&hw, &repl_cfg, &repl));

    esp_console_register_help_command();
    register_commands();

    ESP_ERROR_CHECK(esp_console_start_repl(repl));
}
