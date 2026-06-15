/* Polar plotter firmware — Raspberry Pi Pico 2W (RP2350) port.
 *
 * Platform differences from the ESP32-S3 build:
 *   - pico-sdk replaces ESP-IDF; FreeRTOS API is identical
 *   - WiFi via cyw43_arch (blocking connect) instead of esp_wifi event loop
 *   - USB CDC stdio (pico_stdio_usb) replaces esp_console USB-Serial-JTAG REPL;
 *     the interactive console is a simple fgets() loop in main_task
 *   - time_us_64() replaces esp_timer_get_time() (both return µs as 64-bit int)
 *   - Servo: servo_init(gpio) only (no LEDC channel arg)
 *   - tmc5072_init returns bool, not esp_err_t
 *   - lwIP BSD sockets are available on both platforms; UDP tasks are unchanged
 *
 * Everything else — draw logic, motion, kinematics, SSE, web draw task — is
 * verbatim from the ESP32 build.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <math.h>

#include "pico/stdlib.h"
#include "pico/cyw43_arch.h"
#include "pico/time.h"

#include "FreeRTOS.h"
#include "task.h"

#include "lwip/sockets.h"
#include "lwip/netif.h"
#include "lwip/ip4_addr.h"

#include "board_config.h"
#include "tmc5072.h"
#include "servo.h"
#include "kinematics.h"
#include "web_server.h"

/* Lightweight shims so the body of this file can keep ESP_LOGx unchanged. */
#define ESP_LOGI(t, fmt, ...)  printf("[%s] "     fmt "\n", t, ##__VA_ARGS__)
#define ESP_LOGE(t, fmt, ...)  printf("[%s] ERR " fmt "\n", t, ##__VA_ARGS__)
#define ESP_LOGW(t, fmt, ...)  printf("[%s] WRN " fmt "\n", t, ##__VA_ARGS__)

static const char *TAG = "plotter";
static tmc5072_t   tmc;

static volatile bool s_wifi_connected = false;
static char          s_wifi_ip_str[20] = "";

static float    g_run_ma        = TEST_RUN_MA;
static float    g_hold_ma       = TEST_HOLD_MA;
static uint32_t g_vmax          = TEST_VMAX;
static uint32_t g_accel         = 500;
static float    g_home_belt_mm  = HOME_BELT_MM;
static float    g_motor_span_mm = MOTOR_SPAN_MM;
static float    g_steps_per_mm  = STEPS_PER_MM;
static float    g_x_min         = X_MIN_MM;
static float    g_x_max         = X_MAX_MM;
static float    g_y_min         = Y_MIN_MM;
static float    g_y_max         = Y_MAX_MM;
static bool     g_bounds_ellipse = false;
static bool     g_aimode        = false;

static plotter_geom_t g_geom = {
    .span_mm      = MOTOR_SPAN_MM,
    .drop_mm      = 0.0f,
    .steps_per_mm = STEPS_PER_MM,
    .left_sign    = LEFT_DIR_SIGN,
    .right_sign   = RIGHT_DIR_SIGN,
};

/* ---- Onboard LED (CYW43439 GPIO, Pico 2W) ----
 *
 * Patterns (priority high → low):
 *   fault   : triple-flash rapid, 700 ms off, repeat
 *   drawing : fast blink 5 Hz (100 ms on / 100 ms off)
 *   no-wifi : slow blink 1 Hz (500 ms on / 500 ms off)
 *   idle    : solid ON
 *
 * The LED is behind the CYW43439 so it is unavailable until
 * cyw43_arch_init() succeeds.  s_cyw43_ready gates all calls.
 */
static volatile bool s_cyw43_ready = false;

static inline void led_set(bool on)
{
    if (s_cyw43_ready)
        cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, on ? 1 : 0);
}

static void led_task(void *arg)
{
    (void)arg;
    while (!s_cyw43_ready) vTaskDelay(pdMS_TO_TICKS(100));

    for (;;) {
        if (g_drv_fault) {
            /* Triple-flash: on 100 ms, off 100 ms, ×3, then 700 ms off. */
            for (int i = 0; i < 3; i++) {
                led_set(true);  vTaskDelay(pdMS_TO_TICKS(100));
                led_set(false); vTaskDelay(pdMS_TO_TICKS(100));
            }
            vTaskDelay(pdMS_TO_TICKS(700));
        } else if (g_job_done < g_job_current) {
            /* Motor active — fast 5 Hz blink. */
            led_set(true);  vTaskDelay(pdMS_TO_TICKS(100));
            led_set(false); vTaskDelay(pdMS_TO_TICKS(100));
        } else if (!s_wifi_connected) {
            /* WiFi not up — slow 1 Hz blink. */
            led_set(true);  vTaskDelay(pdMS_TO_TICKS(500));
            led_set(false); vTaskDelay(pdMS_TO_TICKS(500));
        } else {
            /* Idle and ready — solid ON. */
            led_set(true);
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }
}

/* Forward declarations */
static void do_draw_goto(float x, float y);
static void do_draw_line(float x0, float y0, float x1, float y1, int cycles);
static void do_draw_square(float cx, float cy, float size, int cycles, int fill_mode, float hatch_angle, float hatch_spacing, bool outline);
static void do_draw_circle(float cx, float cy, float r, int cycles, int fill_mode, float hatch_angle, float hatch_spacing, bool outline);
static void do_draw_bullseye(float cx, float cy);
static void do_draw_grid(float cx, float cy);
static void do_draw_wobbly(float cx, float cy, float r, float bound_r, float wobble, int harmonics, int seed, int cycles);
static void do_draw_truchet(float cx, float cy, int n, float spacing, float angle_deg, int seed, uint32_t mask);

static void init_geometry(void)
{
    g_geom.span_mm      = g_motor_span_mm;
    g_geom.drop_mm      = plt_drop_from_home_belt(g_motor_span_mm, g_home_belt_mm);
    g_geom.steps_per_mm = g_steps_per_mm;
    ESP_LOGI(TAG, "geometry: span=%.1f mm  home_belt=%.1f mm  -> drop=%.2f mm  (%.1f steps/mm)",
             (double)g_motor_span_mm, (double)g_home_belt_mm, (double)g_geom.drop_mm,
             (double)g_geom.steps_per_mm);
}

static uint16_t mres_to_microsteps(uint8_t mres)
{
    static const uint16_t tbl[9] = {256, 128, 64, 32, 16, 8, 4, 2, 1};
    return (mres <= 8) ? tbl[mres] : 0;
}

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

#define DRV_FAULT_MASK ((1u << 25) | (1u << 27) | (1u << 28))

static uint32_t driver_fault_scan(void)
{
    uint32_t s0 = tmc5072_drv_status(&tmc, 0) & DRV_FAULT_MASK;
    uint32_t s1 = tmc5072_drv_status(&tmc, 1) & DRV_FAULT_MASK;
    uint32_t g  = tmc5072_read(&tmc, TMC5072_GSTAT, NULL) & 0x0E;
    uint32_t fault = s0 | s1 | g;
    if (fault) {
        snprintf(g_drv_flags, sizeof(g_drv_flags), "%s%s%s%s%s%s%s%s",
                 (s0 & (1u << 25)) ? "M1:OT "   : "",
                 (s0 & (1u << 27)) ? "M1:s2ga " : "",
                 (s0 & (1u << 28)) ? "M1:s2gb " : "",
                 (s1 & (1u << 25)) ? "M2:OT "   : "",
                 (s1 & (1u << 27)) ? "M2:s2ga " : "",
                 (s1 & (1u << 28)) ? "M2:s2gb " : "",
                 (g  & 0x06)       ? "GSTAT:drv_err " : "",
                 (g  & 0x08)       ? "GSTAT:uv_cp "   : "");
    }
    return fault;
}

static bool motion_should_abort(void)
{
    if (g_job_abort) return true;
    static uint64_t last_us = 0;
    uint64_t now = time_us_64();
    if (now - last_us < 80000ULL) return false;
    last_us = now;
    uint32_t f = driver_fault_scan();
    if (f) {
        if (!g_drv_fault) web_log("!! DRIVER FAULT: %s — job aborted", g_drv_flags);
        g_drv_fault  = f;
        g_job_abort  = true;
        return true;
    }
    return false;
}

void plotter_clear_fault(void)
{
    tmc5072_enable(&tmc, false);
    vTaskDelay(pdMS_TO_TICKS(5));
    tmc5072_enable(&tmc, true);
    g_drv_fault = 0;
    snprintf(g_drv_flags, sizeof(g_drv_flags), "ok");
    web_log("driver fault cleared — drivers re-enabled");
}

static bool wait_reached(int m, int timeout_ms)
{
    int waited = 0;
    while (!tmc5072_position_reached(&tmc, m)) {
        if (motion_should_abort()) return false;
        vTaskDelay(pdMS_TO_TICKS(20));
        waited += 20;
        if (waited >= timeout_ms) {
            ESP_LOGW(TAG, "M%d move timeout", m + 1);
            return false;
        }
    }
    return true;
}

static void home_gondola(void)
{
    int32_t stop_t = tmc5072_position(&tmc, MOTOR_THETA);
    int32_t stop_r = tmc5072_position(&tmc, MOTOR_RHO);
    tmc5072_move_to(&tmc, MOTOR_THETA, stop_t);
    tmc5072_move_to(&tmc, MOTOR_RHO,   stop_r);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    ESP_LOGW(TAG, "HARD STOP at M1=%ld M2=%ld -- homing (pen up, XTARGET=0)",
             (long)stop_t, (long)stop_r);
    servo_write_deg(PEN_UP_DEG);
    vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS));
    tmc5072_enable(&tmc, true);
    tmc5072_move_coordinated(&tmc, 0, 0);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    ESP_LOGI(TAG, "HOMING done: M1 pos=%ld  M2 pos=%ld",
             (long)tmc5072_position(&tmc, MOTOR_THETA),
             (long)tmc5072_position(&tmc, MOTOR_RHO));
}

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
    ESP_LOGW(TAG, "ORIGIN SET HERE: M1=%ld  M2=%ld (XTARGET=XACTUAL=0)",
             (long)tmc5072_position(&tmc, MOTOR_THETA),
             (long)tmc5072_position(&tmc, MOTOR_RHO));
}

static void print_status(int m)
{
    uint32_t s = tmc5072_drv_status(&tmc, m);
    ESP_LOGI(TAG, "M%d pos=%ld DRV_STATUS=0x%08lx  %s%s%s%s%s%s%s SG_RESULT=%lu CS_ACT=%lu",
             m + 1, (long)tmc5072_position(&tmc, m), (unsigned long)s,
             (s & (1u << 31)) ? "stst "    : "",
             (s & (1u << 24)) ? "STALL "   : "",
             (s & (1u << 25)) ? "OT! "     : "",
             (s & (1u << 26)) ? "otpw "    : "",
             (s & (1u << 27)) ? "s2ga! "   : "",
             (s & (1u << 28)) ? "s2gb! "   : "",
             ((s & (3u << 29))) ? "openload " : "",
             (unsigned long)(s & 0x3FF),
             (unsigned long)((s >> 16) & 0x1F));
}

static void apply_accel(uint32_t accel)
{
    tmc5072_set_accel(&tmc, MOTOR_THETA, accel);
    tmc5072_set_accel(&tmc, MOTOR_RHO,   accel);
    ESP_LOGI(TAG, "accel: AMAX=DMAX=%lu", (unsigned long)accel);
}

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
           (ver == 0x10) ? "OK" : "<-- expected 0x10!");
    printf("  GCONF  0x%08lx : single_driver=%lu shaft1=%lu shaft2=%lu\n",
           (unsigned long)gconf, (unsigned long)(gconf & 1),
           (unsigned long)((gconf >> 8) & 1), (unsigned long)((gconf >> 9) & 1));
    printf("  GSTAT  0x%08lx : reset=%lu drv_err1=%lu drv_err2=%lu uv_cp=%lu\n",
           (unsigned long)gstat, (unsigned long)(gstat & 1),
           (unsigned long)((gstat >> 1) & 1), (unsigned long)((gstat >> 2) & 1),
           (unsigned long)((gstat >> 3) & 1));
    if (s_wifi_connected)
        printf("  WiFi   SSID=%-16s IP=%s\n", WIFI_SSID, s_wifi_ip_str);
    else
        printf("  WiFi   SSID=%-16s <-- not connected\n", WIFI_SSID);
}

static void print_full_status(int m)
{
    uint32_t chop = tmc5072_read(&tmc, TMC5072_CHOPCONF(m), NULL);
    uint8_t  toff   = (chop >> 0)  & 0x0F;
    uint8_t  hstrt  = (chop >> 4)  & 0x07;
    uint8_t  hend   = (chop >> 7)  & 0x0F;
    uint8_t  tbl    = (chop >> 15) & 0x03;
    uint8_t  vsense = (chop >> 17) & 0x01;
    uint8_t  mres   = (chop >> 24) & 0x0F;
    uint32_t ihr   = tmc5072_get_ihold_irun(&tmc, m);
    uint8_t  ihold = (ihr >> 0)  & 0x1F;
    uint8_t  irun  = (ihr >> 8)  & 0x1F;
    uint8_t  ihd   = (ihr >> 16) & 0x0F;
    uint32_t ds    = tmc5072_drv_status(&tmc, m);
    uint8_t  csact = (ds >> 16) & 0x1F;

    printf("\n=== Motor %d ===\n", m + 1);
    printf("  XACTUAL=%ld  VACTUAL=%ld\n",
           (long)tmc5072_position(&tmc, m),
           (long)(int32_t)tmc5072_read(&tmc, TMC5072_VACTUAL(m), NULL));
    printf("  CHOPCONF 0x%08lx : TOFF=%u %s HSTRT=%u HEND=%u TBL=%u vsense=%u MRES=%u (%u usteps)\n",
           (unsigned long)chop, toff, toff ? "(on)" : "<-- DISABLED",
           hstrt, hend, tbl, vsense, mres, mres_to_microsteps(mres));
    printf("  IHOLD_IRUN(cfg) : IRUN=%u (~%.0f mA) IHOLD=%u (~%.0f mA) IHOLDDELAY=%u\n",
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

static bool link_check(void)
{
    uint8_t st = 0;
    uint32_t in = tmc5072_read(&tmc, TMC5072_INPUT, &st);
    uint8_t ver = (in >> 24) & 0xFF;
    ESP_LOGI(TAG, "SPI link: status=0x%02x INPUT=0x%08lx VERSION=0x%02x (expect 0x10)",
             st, (unsigned long)in, ver);
    if (ver == 0x00 || ver == 0xFF) {
        ESP_LOGE(TAG, "  -> BAD VERSION (0xFF=MISO high/no reply; 0x00=no MISO).");
        return false;
    }
    ESP_LOGI(TAG, "  -> SPI link looks good");
    return true;
}

/* Re-apply the full per-motor config (CHOPCONF/ramp) + current/speed/accel.
 * Used at boot and to recover after the TMC has been power-cycled while the
 * MCU kept running (Pico 2 has no RESET button — see ensure_configured()). */
static void reconfigure_drivers(void)
{
    tmc5072_config_motor(&tmc, MOTOR_THETA);
    tmc5072_config_motor(&tmc, MOTOR_RHO);
    apply_current(g_run_ma, g_hold_ma);
    apply_speed(g_vmax);
    apply_accel(g_accel);
}

/* Self-heal: if the TMC was reset (CHOPCONF back to 0 / TOFF=0 = output
 * disabled) the chip answers SPI and the ramp generator runs, but the coils
 * carry no current and the motors won't move. Detect that and re-push config
 * before a job runs, so a 12 V glitch no longer needs a reflash. Motion-task
 * only (keeps SPI single-owner). Returns true if a reconfigure happened. */
static bool ensure_configured(void)
{
    uint32_t chop = tmc5072_read(&tmc, TMC5072_CHOPCONF(MOTOR_THETA), NULL);
    if ((chop & 0x0F) != 0) return false;   /* TOFF != 0 -> already configured */
    ESP_LOGW(TAG, "TMC CHOPCONF=0 (driver reset?) — re-applying config");
    web_log("driver was reset — re-applying config");
    reconfigure_drivers();
    return true;
}

static void run_bringup(void)
{
    ESP_LOGI(TAG, "================ BRING-UP ================");
    bool link_ok = link_check();

    reconfigure_drivers();

    print_global_status();
    print_full_status(MOTOR_THETA);
    print_full_status(MOTOR_RHO);

    ESP_LOGI(TAG, "Servo test: pen up/down x3");
    for (int i = 0; i < 3; i++) {
        servo_write_deg(PEN_DOWN_DEG); vTaskDelay(pdMS_TO_TICKS(600));
        servo_write_deg(PEN_UP_DEG);   vTaskDelay(pdMS_TO_TICKS(600));
    }

    tmc5072_enable(&tmc, false);
    ESP_LOGI(TAG, "========== BRING-UP DONE ==========");
    if (!link_ok)
        ESP_LOGE(TAG, "SPI link FAILED — fix wiring before moving motors.");
    ESP_LOGI(TAG, "Calibrate: 'belt 0 0' -> place gondola -> 'sethome' -> 'goto'. 'help' for all.");
}

/* --------------------------------------------------------------------------- */
/* Draw helpers — identical to ESP32 build                                     */
/* --------------------------------------------------------------------------- */

static int motor_arg(const char *s)
{
    int v = atoi(s);
    return (v == 1 || v == 2) ? v - 1 : -1;
}

static void print_geom_vars(void)
{
    printf("  home_belt  = %.1f mm  (default %.1f)\n",  (double)g_home_belt_mm,  (double)HOME_BELT_MM);
    printf("  motor_span = %.1f mm  (default %.1f)\n",  (double)g_motor_span_mm, (double)MOTOR_SPAN_MM);
    printf("  steps/mm   = %.3f\n",   (double)g_steps_per_mm);
    printf("  -> drop    = %.2f mm\n", (double)g_geom.drop_mm);
}

static float ellipse_norm(float x, float y, float *cx, float *cy, float *rx, float *ry)
{
    float ccx = 0.5f * (g_x_min + g_x_max), ccy = 0.5f * (g_y_min + g_y_max);
    float arx = 0.5f * (g_x_max - g_x_min), ary = 0.5f * (g_y_max - g_y_min);
    if (cx) *cx = ccx;  if (cy) *cy = ccy;
    if (rx) *rx = arx;  if (ry) *ry = ary;
    if (arx <= 0.0f || ary <= 0.0f) return 0.0f;
    float nx2 = (x - ccx) / arx, ny2 = (y - ccy) / ary;
    return sqrtf(nx2 * nx2 + ny2 * ny2);
}

static bool clamp_xy(float *x, float *y)
{
    bool clamped = false;
    if (*x > g_x_max) { *x = g_x_max; clamped = true; }
    if (*x < g_x_min) { *x = g_x_min; clamped = true; }
    if (*y > g_y_max) { *y = g_y_max; clamped = true; }
    if (*y < g_y_min) { *y = g_y_min; clamped = true; }
    if (g_bounds_ellipse) {
        float cx, cy, rxe, rye;
        float r = ellipse_norm(*x, *y, &cx, &cy, &rxe, &rye);
        if (r > 1.0f) { *x = cx + (*x - cx) / r; *y = cy + (*y - cy) / r; clamped = true; }
    }
    if (clamped)
        ESP_LOGW(TAG, "point clamped (x=%.1f y=%.1f)", (double)*x, (double)*y);
    return clamped;
}

static void pen_lift(void) { servo_write_deg(PEN_UP_DEG);   vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS)); }
static void pen_drop(void) { servo_write_deg(PEN_DOWN_DEG); vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS)); }

static void move_to_xy(float x, float y)
{
    if (g_job_abort) return;
    clamp_xy(&x, &y);
    int32_t sl, sr;
    plt_xy_to_steps(&g_geom, x, y, &sl, &sr);
    tmc5072_move_coordinated(&tmc, sr, sl);
    wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
    wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
}

static void wait_both_near(int32_t tl, int32_t tr, int32_t lookahead, int timeout_ms)
{
    int waited = 0;
    while (waited < timeout_ms) {
        if (motion_should_abort()) return;
        int32_t al = tmc5072_position(&tmc, MOTOR_RHO);
        int32_t ar = tmc5072_position(&tmc, MOTOR_THETA);
        if (labs(tl - al) <= lookahead && labs(tr - ar) <= lookahead) return;
        vTaskDelay(pdMS_TO_TICKS(2));
        waited += 2;
    }
}

static struct {
    bool    active, first, have_pend;
    int32_t cur_l, cur_r, pend_l, pend_r;
    float   x, y;
} s_path;

static void path_begin(float x0, float y0)
{
    clamp_xy(&x0, &y0);
    plt_xy_to_steps(&g_geom, x0, y0, &s_path.cur_l, &s_path.cur_r);
    s_path.x = x0; s_path.y = y0;
    s_path.active = true; s_path.first = true; s_path.have_pend = false;
}

static void path_emit(bool last)
{
    int32_t tl = s_path.pend_l, tr = s_path.pend_r;
    if (s_path.first || last)
        tmc5072_move_scaled_from(&tmc, tr, tl, s_path.cur_r, s_path.cur_l);
    else
        tmc5072_move_rate_matched(&tmc, tr, tl, s_path.cur_r, s_path.cur_l);
    s_path.first = false;
    s_path.cur_l = tl; s_path.cur_r = tr;
    s_path.have_pend = false;
    if (last) {
        wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
        wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    } else {
        int32_t lookahead = (int32_t)(LINE_LOOKAHEAD_MM * g_geom.steps_per_mm);
        wait_both_near(tl, tr, lookahead, MOVE_TIMEOUT_MS);
    }
}

static void path_to(float x, float y)
{
    if (!s_path.active || motion_should_abort()) return;
    clamp_xy(&x, &y);
    float dx = x - s_path.x, dy = y - s_path.y;
    float len = sqrtf(dx * dx + dy * dy);
    int n = plt_line_segments(len, LINE_SEG_MM);
    for (int i = 1; i <= n; i++) {
        if (motion_should_abort()) return;
        float t = (float)i / (float)n;
        float px = s_path.x + dx * t, py = s_path.y + dy * t;
        clamp_xy(&px, &py);
        int32_t sl, sr;
        plt_xy_to_steps(&g_geom, px, py, &sl, &sr);
        int32_t rl = s_path.have_pend ? s_path.pend_l : s_path.cur_l;
        int32_t rr = s_path.have_pend ? s_path.pend_r : s_path.cur_r;
        if (sl == rl && sr == rr) continue;
        if (s_path.have_pend) path_emit(false);
        s_path.pend_l = sl; s_path.pend_r = sr; s_path.have_pend = true;
    }
    s_path.x = x; s_path.y = y;
}

static void path_end(void)
{
    if (!s_path.active) return;
    s_path.active = false;
    if (motion_should_abort()) return;
    if (s_path.have_pend) path_emit(true);
}

static void draw_line_mm(float x0, float y0, float x1, float y1)
{
    path_begin(x0, y0);
    path_to(x1, y1);
    path_end();
}

static int parse_cycles(const char *s) { int c = atoi(s); return (c < 1) ? 1 : c; }

static bool clip_to_rect(float cx2, float cy2, float h,
                          float lx, float ly, float dx, float dy,
                          float *s0, float *s1)
{
    *s0 = -1e9f; *s1 = 1e9f;
    float ps[4] = { -dx,  dx,  -dy,  dy };
    float qs[4] = { lx - (cx2 - h), (cx2 + h) - lx,
                    ly - (cy2 - h), (cy2 + h) - ly };
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

static bool clip_to_circle(float cx2, float cy2, float r,
                            float lx, float ly, float dx, float dy,
                            float *s0, float *s1)
{
    float ex = lx - cx2, ey = ly - cy2;
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

static void hatch_lines(float cx2, float cy2, bool is_circle, float shape_param,
                         float angle_deg, float spacing_mm)
{
    if (spacing_mm < 0.1f) spacing_mm = 0.1f;
    float theta = angle_deg * (PLT_PI / 180.0f);
    float cos_t = cosf(theta), sin_t = sinf(theta);
    float extent = is_circle ? shape_param
                              : shape_param * (fabsf(cos_t) + fabsf(sin_t));
    float t = -extent + spacing_mm;
    while (t < extent) {
        float lx = cx2 + t * (-sin_t);
        float ly = cy2 + t *   cos_t;
        float s0, s1;
        bool ok = is_circle
            ? clip_to_circle(cx2, cy2, shape_param, lx, ly, cos_t, sin_t, &s0, &s1)
            : clip_to_rect  (cx2, cy2, shape_param, lx, ly, cos_t, sin_t, &s0, &s1);
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
    tmc5072_enable(&tmc, true);
    move_to_xy(x, y);
    emit_pos_event();
}

static void do_draw_line(float x0, float y0, float x1, float y1, int cycles)
{
    tmc5072_enable(&tmc, true);
    pen_lift();
    move_to_xy(x0, y0);
    pen_drop();
    path_begin(x0, y0);
    for (int c = 0; c < cycles; c++) {
        if (c & 1) path_to(x0, y0);
        else       path_to(x1, y1);
    }
    path_end();
    pen_lift();
}

static void do_draw_square(float cx2, float cy2, float size, int cycles, int fill_mode,
                            float hatch_angle, float hatch_spacing, bool outline)
{
    float h = size * 0.5f;
    tmc5072_enable(&tmc, true);
    if (outline) {
        float xs[4] = { cx2 - h, cx2 + h, cx2 + h, cx2 - h };
        float ys[4] = { cy2 - h, cy2 - h, cy2 + h, cy2 + h };
        pen_lift();
        move_to_xy(xs[0], ys[0]);
        pen_drop();
        for (int c = 0; c < cycles; c++)
            for (int e = 0; e < 4; e++)
                draw_line_mm(xs[e], ys[e], xs[(e + 1) & 3], ys[(e + 1) & 3]);
    }
    if (fill_mode == 1) {
        hatch_lines(cx2, cy2, false, h, hatch_angle, hatch_spacing);
    } else if (fill_mode == 2) {
        float s_start = outline ? size - 2.0f * hatch_spacing : size;
        for (float s = s_start; s > 2.0f * hatch_spacing; s -= 2.0f * hatch_spacing) {
            float hi = s * 0.5f;
            float xi[4] = { cx2 - hi, cx2 + hi, cx2 + hi, cx2 - hi };
            float yi[4] = { cy2 - hi, cy2 - hi, cy2 + hi, cy2 + hi };
            pen_lift();
            move_to_xy(xi[0], yi[0]);
            pen_drop();
            for (int e = 0; e < 4; e++)
                draw_line_mm(xi[e], yi[e], xi[(e + 1) & 3], yi[(e + 1) & 3]);
        }
    }
    pen_lift();
}

static void do_draw_circle(float cx2, float cy2, float r, int cycles, int fill_mode,
                            float hatch_angle, float hatch_spacing, bool outline)
{
    int n = plt_arc_segments(r, CIRCLE_CHORD_ERR_MM);
    if (n < 3) n = 3;
    float dth = PLT_TWO_PI / (float)n;
    float dc = cosf(dth), ds2 = sinf(dth);
    tmc5072_enable(&tmc, true);
    if (outline) {
        pen_lift();
        move_to_xy(cx2 + r, cy2);
        pen_drop();
        path_begin(cx2 + r, cy2);
        for (int cyc = 0; cyc < cycles; cyc++) {
            float vx = r, vy = 0.0f;
            for (int k = 1; k <= n; k++) {
                float nvx = vx * dc - vy * ds2;
                float nvy = vx * ds2 + vy * dc;
                vx = nvx; vy = nvy;
                float px = (k == n) ? cx2 + r : cx2 + vx;
                float py = (k == n) ? cy2      : cy2 + vy;
                path_to(px, py);
            }
        }
        path_end();
    }
    if (fill_mode == 1) {
        hatch_lines(cx2, cy2, true, r, hatch_angle, hatch_spacing);
    } else if (fill_mode == 2) {
        float r_start = outline ? r - hatch_spacing : r;
        for (float ri = r_start; ri > hatch_spacing * 0.5f; ri -= hatch_spacing) {
            int ni = plt_arc_segments(ri, CIRCLE_CHORD_ERR_MM);
            if (ni < 3) ni = 3;
            float dth_i = PLT_TWO_PI / (float)ni;
            float dc_i = cosf(dth_i), ds_i = sinf(dth_i);
            pen_lift();
            move_to_xy(cx2 + ri, cy2);
            pen_drop();
            path_begin(cx2 + ri, cy2);
            float vx_i = ri, vy_i = 0.0f;
            for (int k = 1; k <= ni; k++) {
                float nvx = vx_i * dc_i - vy_i * ds_i;
                float nvy = vx_i * ds_i + vy_i * dc_i;
                vx_i = nvx; vy_i = nvy;
                float px = (k == ni) ? cx2 + ri : cx2 + vx_i;
                float py = (k == ni) ? cy2       : cy2 + vy_i;
                path_to(px, py);
            }
            path_end();
        }
    }
    pen_lift();
}

static void do_draw_bullseye(float cx2, float cy2)
{
    const float arm = 10.0f;
    tmc5072_enable(&tmc, true);
    for (int c = 0; c < 5; c++) {
        pen_lift();  move_to_xy(cx2 - arm, cy2);
        pen_drop();  draw_line_mm(cx2 - arm, cy2, cx2 + arm, cy2);
        pen_lift();  move_to_xy(cx2, cy2 - arm);
        pen_drop();  draw_line_mm(cx2, cy2 - arm, cx2, cy2 + arm);
    }
    pen_lift();
}

static void do_draw_grid(float cx2, float cy2)
{
    const int   n    = 10;
    const float gap  = 8.0f;
    const float hlen = 50.0f;
    tmc5072_enable(&tmc, true);
    for (int i = 0; i < n; i++) {
        float y = cy2 + (i - (n - 1) * 0.5f) * gap;
        pen_lift();  move_to_xy(cx2 - hlen, y);
        pen_drop();  draw_line_mm(cx2 - hlen, y, cx2 + hlen, y);
    }
    for (int i = 0; i < n; i++) {
        float x = cx2 + (i - (n - 1) * 0.5f) * gap;
        pen_lift();  move_to_xy(x, cy2 - hlen);
        pen_drop();  draw_line_mm(x, cy2 - hlen, x, cy2 + hlen);
    }
    pen_lift();
}

static void do_draw_border(void)
{
    tmc5072_enable(&tmc, true);
    float cx2, cy2, rx2, ry2;
    ellipse_norm(0.0f, 0.0f, &cx2, &cy2, &rx2, &ry2);
    pen_lift();
    if (g_bounds_ellipse) {
        const int N = 96;
        float px = cx2 + rx2, py = cy2;
        move_to_xy(px, py);
        pen_drop();
        for (int i = 1; i <= N; i++) {
            float th = (float)i / (float)N * 6.28318530718f;
            float nx = cx2 + rx2 * cosf(th);
            float ny = cy2 + ry2 * sinf(th);
            draw_line_mm(px, py, nx, ny);
            px = nx; py = ny;
        }
    } else {
        move_to_xy(g_x_min, g_y_min);
        pen_drop();
        draw_line_mm(g_x_min, g_y_min, g_x_max, g_y_min);
        draw_line_mm(g_x_max, g_y_min, g_x_max, g_y_max);
        draw_line_mm(g_x_max, g_y_max, g_x_min, g_y_max);
        draw_line_mm(g_x_min, g_y_max, g_x_min, g_y_min);
    }
    pen_lift();
    emit_pos_event();
}

static void do_draw_wobbly(float cx2, float cy2, float r, float bound_r,
                            float wobble, int harmonics, int seed, int cycles)
{
#define WOBBLY_MAX_PTS 128
    float px[WOBBLY_MAX_PTS], py[WOBBLY_MAX_PTS];
    if (harmonics < 1) harmonics = 1;
    if (harmonics > 8) harmonics = 8;
    int n = harmonics * 16;
    if (n < 24)  n = 24;
    if (n > WOBBLY_MAX_PTS) n = WOBBLY_MAX_PTS;
    srand((unsigned)seed);
    float amp[8], ph[8];
    for (int h = 0; h < harmonics; h++) {
        float rand_scale = (float)(rand() % 1000) / 1000.0f;
        amp[h] = wobble * r / (float)(h + 1) * rand_scale;
        ph[h]  = (float)(rand() % 1000) / 1000.0f * PLT_TWO_PI;
    }
    float min_r = r * 0.05f;
    for (int i = 0; i < n; i++) {
        float theta = PLT_TWO_PI * (float)i / (float)n;
        float ri = r;
        for (int h = 0; h < harmonics; h++)
            ri += amp[h] * sinf((float)(h + 1) * theta + ph[h]);
        if (bound_r > 0.0f && ri > bound_r) ri = bound_r;
        if (ri < min_r) ri = min_r;
        px[i] = cx2 + ri * cosf(theta);
        py[i] = cy2 + ri * sinf(theta);
    }
    tmc5072_enable(&tmc, true);
    pen_lift();
    move_to_xy(px[0], py[0]);
    pen_drop();
    path_begin(px[0], py[0]);
    for (int c = 0; c < cycles; c++)
        for (int i = 1; i <= n; i++)
            path_to(px[i % n], py[i % n]);
    path_end();
    pen_lift();
#undef WOBBLY_MAX_PTS
}

/* ---- Truchet tiling — verbatim from ESP32 build ---- */
enum {
    TM_BS = 0, TM_FS, TM_HB, TM_VB, TM_DOTS, TM_BLOB, TM_PLUS,
    TM_FNE, TM_FSW, TM_FNW, TM_FSE,
    TM_TN, TM_TS, TM_TE, TM_TW,
    TM_COUNT
};
#define TRUCHET_ALL_MASK      ((1u << TM_COUNT) - 1u)
#define TRUCHET_DEFAULT_MASK  0x07A3u
#define TRUCHET_MIN_CELL_MM   40.0f
#define TRUCHET_MAX_CELLS     1024

static const uint8_t tm_dot_edges[TM_COUNT] = {
    0, 0, 5, 10, 15, 0, 0,
    12, 3, 6, 9,
    4, 1, 8, 2,
};

static uint32_t s_tk_rng;
static inline uint32_t tk_rand(void)
{
    s_tk_rng = s_tk_rng * 1664525u + 1013904223u;
    return (s_tk_rng >> 16) & 0x7fff;
}

static struct { float x, y; bool down, valid; } s_tk_pen;

static void tk_break(void)
{
    path_end();
    if (s_tk_pen.down) { pen_lift(); s_tk_pen.down = false; }
    s_tk_pen.valid = false;
}

static bool tk_clip_seg(float x0, float y0, float x1, float y1, float *t0, float *t1)
{
    *t0 = 0.0f; *t1 = 1.0f;
    float dx = x1 - x0, dy = y1 - y0;
    float ps[4] = { -dx, dx, -dy, dy };
    float qs[4] = { x0 - g_x_min, g_x_max - x0, y0 - g_y_min, g_y_max - y0 };
    for (int k = 0; k < 4; k++) {
        if (fabsf(ps[k]) < 1e-9f) {
            if (qs[k] < 0.0f) return false;
        } else {
            float r = qs[k] / ps[k];
            if (ps[k] < 0.0f) { if (r > *t0) *t0 = r; }
            else               { if (r < *t1) *t1 = r; }
        }
    }
    if (g_bounds_ellipse) {
        float ccx, ccy, rx2, ry2;
        ellipse_norm(0, 0, &ccx, &ccy, &rx2, &ry2);
        if (rx2 <= 0.0f || ry2 <= 0.0f) return false;
        float ex = (x0 - ccx) / rx2, ey = (y0 - ccy) / ry2;
        float fx = dx / rx2,          fy = dy / ry2;
        float a = fx * fx + fy * fy;
        float b = 2.0f * (ex * fx + ey * fy);
        float c = ex * ex + ey * ey - 1.0f;
        if (a < 1e-12f) {
            if (c > 0.0f) return false;
        } else {
            float disc = b * b - 4.0f * a * c;
            if (disc < 0.0f) return false;
            float sq = sqrtf(disc);
            float u0 = (-b - sq) / (2.0f * a), u1 = (-b + sq) / (2.0f * a);
            if (u0 > *t0) *t0 = u0;
            if (u1 < *t1) *t1 = u1;
        }
    }
    return *t1 > *t0;
}

static void tk_seg(float x0, float y0, float x1, float y1)
{
    if (motion_should_abort()) return;
    float t0, t1;
    if (!tk_clip_seg(x0, y0, x1, y1, &t0, &t1)) { tk_break(); return; }
    float ax = x0 + (x1 - x0) * t0, ay = y0 + (y1 - y0) * t0;
    float bx = x0 + (x1 - x0) * t1, by = y0 + (y1 - y0) * t1;
    bool contig = s_tk_pen.valid && s_tk_pen.down &&
                  fabsf(ax - s_tk_pen.x) < 0.05f &&
                  fabsf(ay - s_tk_pen.y) < 0.05f;
    if (!contig) {
        path_end();
        if (s_tk_pen.down) pen_lift();
        s_tk_pen.down = false;
        move_to_xy(ax, ay);
        if (motion_should_abort()) return;
        pen_drop();
        s_tk_pen.down = true;
        path_begin(ax, ay);
    }
    path_to(bx, by);
    s_tk_pen.x = bx; s_tk_pen.y = by; s_tk_pen.valid = true;
}

static void tk_arc(float cx2, float cy2, float r, float a0_deg, float a1_deg)
{
    int n_full = plt_arc_segments(r, CIRCLE_CHORD_ERR_MM);
    int n = (int)ceilf(fabsf(a1_deg - a0_deg) / 360.0f * (float)n_full);
    if (n < 4) n = 4;
    float px = cx2 + r * cosf(a0_deg * PLT_PI / 180.0f);
    float py = cy2 + r * sinf(a0_deg * PLT_PI / 180.0f);
    for (int k = 1; k <= n && !g_job_abort; k++) {
        float a = (a0_deg + (a1_deg - a0_deg) * (float)k / (float)n) * PLT_PI / 180.0f;
        float nx = cx2 + r * cosf(a), ny = cy2 + r * sinf(a);
        tk_seg(px, py, nx, ny);
        px = nx; py = ny;
    }
}

static void tk_dot_half(int e, float x0, float y0, float sz, bool outer)
{
    static const float mu[4] = { 0.5f, 1.0f, 0.5f, 0.0f };
    static const float mv[4] = { 0.0f, 0.5f, 1.0f, 0.5f };
    static const float a_in[4] = { 0.0f, 90.0f, 180.0f, 270.0f };
    float a0 = a_in[e] + (outer ? 180.0f : 0.0f);
    tk_arc(x0 + mu[e] * sz, y0 + mv[e] * sz, sz / 6.0f, a0, a0 + 180.0f);
}

static void tk_motif_strokes(int m, float x0, float y0, float sz)
{
    const float A = sz / 3.0f, B = 2.0f * sz / 3.0f;
    const float nwx = x0,      nwy = y0;
    const float nex = x0 + sz, ney = y0;
    const float sex = x0 + sz, sey = y0 + sz;
    const float swx = x0,      swy = y0 + sz;
    switch (m) {
    case TM_BS:
        tk_arc(nex,ney,A,90,180); tk_arc(nex,ney,B,90,180);
        tk_arc(swx,swy,A,270,360); tk_arc(swx,swy,B,270,360); break;
    case TM_FS:
        tk_arc(nwx,nwy,A,0,90); tk_arc(nwx,nwy,B,0,90);
        tk_arc(sex,sey,A,180,270); tk_arc(sex,sey,B,180,270); break;
    case TM_HB:
        tk_seg(x0,y0+A,x0+sz,y0+A); tk_seg(x0+sz,y0+B,x0,y0+B); break;
    case TM_VB:
        tk_seg(x0+A,y0,x0+A,y0+sz); tk_seg(x0+B,y0+sz,x0+B,y0); break;
    case TM_DOTS: break;
    case TM_BLOB:
        tk_arc(nwx,nwy,A,0,90); tk_arc(swx,swy,A,270,360);
        tk_arc(sex,sey,A,180,270); tk_arc(nex,ney,A,90,180); break;
    case TM_PLUS:
        tk_seg(x0,y0+A,x0+A,y0+A); tk_seg(x0+B,y0+A,x0+sz,y0+A);
        tk_seg(x0,y0+B,x0+A,y0+B); tk_seg(x0+B,y0+B,x0+sz,y0+B);
        tk_seg(x0+A,y0,x0+A,y0+A); tk_seg(x0+A,y0+B,x0+A,y0+sz);
        tk_seg(x0+B,y0,x0+B,y0+A); tk_seg(x0+B,y0+B,x0+B,y0+sz); break;
    case TM_FNE: tk_arc(nex,ney,A,90,180); tk_arc(nex,ney,B,90,180); break;
    case TM_FSW: tk_arc(swx,swy,A,270,360); tk_arc(swx,swy,B,270,360); break;
    case TM_FNW: tk_arc(nwx,nwy,A,0,90); tk_arc(nwx,nwy,B,0,90); break;
    case TM_FSE: tk_arc(sex,sey,A,180,270); tk_arc(sex,sey,B,180,270); break;
    case TM_TN: tk_seg(x0,y0+B,x0+sz,y0+B);
        tk_arc(nwx,nwy,A,0,90); tk_arc(nex,ney,A,90,180); break;
    case TM_TS: tk_seg(x0,y0+A,x0+sz,y0+A);
        tk_arc(swx,swy,A,270,360); tk_arc(sex,sey,A,180,270); break;
    case TM_TE: tk_seg(x0+A,y0,x0+A,y0+sz);
        tk_arc(nex,ney,A,90,180); tk_arc(sex,sey,A,180,270); break;
    case TM_TW: tk_seg(x0+B,y0,x0+B,y0+sz);
        tk_arc(nwx,nwy,A,0,90); tk_arc(swx,swy,A,270,360); break;
    default: break;
    }
}

static inline float tk_d2(float u, float v, float px, float py)
{ float dx = u-px, dy = v-py; return dx*dx+dy*dy; }

static bool tk_inside_motif(int m, float u, float v)
{
    const float R1=1.0f/9.0f, R2=4.0f/9.0f;
    #define ANN(cx2,cy2) (tk_d2(u,v,cx2,cy2)>=R1 && tk_d2(u,v,cx2,cy2)<=R2)
    #define QD(cx2,cy2)  (tk_d2(u,v,cx2,cy2)<R1)
    switch(m){
    case TM_BS:   return ANN(1,0)||ANN(0,1);
    case TM_FS:   return ANN(0,0)||ANN(1,1);
    case TM_HB:   return v>=1.0f/3&&v<=2.0f/3;
    case TM_VB:   return u>=1.0f/3&&u<=2.0f/3;
    case TM_DOTS: return false;
    case TM_BLOB: return !(QD(0,0)||QD(1,0)||QD(1,1)||QD(0,1));
    case TM_PLUS: return (v>=1.0f/3&&v<=2.0f/3)||(u>=1.0f/3&&u<=2.0f/3);
    case TM_FNE:  return ANN(1,0);
    case TM_FSW:  return ANN(0,1);
    case TM_FNW:  return ANN(0,0);
    case TM_FSE:  return ANN(1,1);
    case TM_TN:   return v<=2.0f/3&&!QD(0,0)&&!QD(1,0);
    case TM_TS:   return v>=1.0f/3&&!QD(0,1)&&!QD(1,1);
    case TM_TE:   return u>=1.0f/3&&!QD(1,0)&&!QD(1,1);
    case TM_TW:   return u<=2.0f/3&&!QD(0,0)&&!QD(0,1);
    default:      return false;
    }
    #undef ANN
    #undef QD
}

static bool tk_hatch_excluded(int m, float u, float v)
{
    const float RD=1.0f/36.0f;
    if(tk_inside_motif(m,u,v)) return true;
    return tk_d2(u,v,0.5f,0.0f)<=RD || tk_d2(u,v,1.0f,0.5f)<=RD ||
           tk_d2(u,v,0.5f,1.0f)<=RD || tk_d2(u,v,0.0f,0.5f)<=RD;
}

static void tk_hatch_tile(int m, float x0, float y0, float sz,
                           float angle_deg, float spacing)
{
    float circ[12][3]; int nc=0;
    static const float mid[4][2]={{0.5f,0},{1,0.5f},{0.5f,1},{0,0.5f}};
    for(int e=0;e<4;e++){circ[nc][0]=mid[e][0];circ[nc][1]=mid[e][1];circ[nc][2]=1.0f/6.0f;nc++;}
    static const float cnr[4][2]={{0,0},{1,0},{1,1},{0,1}};
    #define ADD_C(ci,r2) do{circ[nc][0]=cnr[ci][0];circ[nc][1]=cnr[ci][1];circ[nc][2]=(r2);nc++;}while(0)
    switch(m){
    case TM_BS: ADD_C(1,1.0f/3);ADD_C(1,2.0f/3);ADD_C(3,1.0f/3);ADD_C(3,2.0f/3);break;
    case TM_FS: ADD_C(0,1.0f/3);ADD_C(0,2.0f/3);ADD_C(2,1.0f/3);ADD_C(2,2.0f/3);break;
    case TM_BLOB: ADD_C(0,1.0f/3);ADD_C(1,1.0f/3);ADD_C(2,1.0f/3);ADD_C(3,1.0f/3);break;
    case TM_FNE: ADD_C(1,1.0f/3);ADD_C(1,2.0f/3);break;
    case TM_FSW: ADD_C(3,1.0f/3);ADD_C(3,2.0f/3);break;
    case TM_FNW: ADD_C(0,1.0f/3);ADD_C(0,2.0f/3);break;
    case TM_FSE: ADD_C(2,1.0f/3);ADD_C(2,2.0f/3);break;
    case TM_TN:  ADD_C(0,1.0f/3);ADD_C(1,1.0f/3);break;
    case TM_TS:  ADD_C(3,1.0f/3);ADD_C(2,1.0f/3);break;
    case TM_TE:  ADD_C(1,1.0f/3);ADD_C(2,1.0f/3);break;
    case TM_TW:  ADD_C(0,1.0f/3);ADD_C(3,1.0f/3);break;
    default: break;
    }
    #undef ADD_C
    float lu[2], lv[2]; int nlu=0, nlv=0;
    switch(m){
    case TM_HB:   lv[nlv++]=1.0f/3;lv[nlv++]=2.0f/3;break;
    case TM_VB:   lu[nlu++]=1.0f/3;lu[nlu++]=2.0f/3;break;
    case TM_PLUS: lv[nlv++]=1.0f/3;lv[nlv++]=2.0f/3;lu[nlu++]=1.0f/3;lu[nlu++]=2.0f/3;break;
    case TM_TN:   lv[nlv++]=2.0f/3;break;
    case TM_TS:   lv[nlv++]=1.0f/3;break;
    case TM_TE:   lu[nlu++]=1.0f/3;break;
    case TM_TW:   lu[nlu++]=2.0f/3;break;
    default: break;
    }
    float th=angle_deg*PLT_PI/180.0f;
    float dx2=cosf(th), dy2=sinf(th);
    float nx2=-sinf(th), ny2=cosf(th);
    float offs[4]={x0*nx2+y0*ny2,(x0+sz)*nx2+y0*ny2,x0*nx2+(y0+sz)*ny2,(x0+sz)*nx2+(y0+sz)*ny2};
    float omin=offs[0], omax=offs[0];
    for(int i=1;i<4;i++){if(offs[i]<omin)omin=offs[i];if(offs[i]>omax)omax=offs[i];}
    int k0=(int)ceilf(omin/spacing), k1=(int)floorf(omax/spacing);
    for(int k=k0;k<=k1&&!motion_should_abort();k++){
        float lx2=(float)k*spacing*nx2, ly2=(float)k*spacing*ny2;
        float s0,s1;
        if(!clip_to_rect(x0+sz*0.5f,y0+sz*0.5f,sz*0.5f,lx2,ly2,dx2,dy2,&s0,&s1)) continue;
        float ts[32]; int nt=0;
        ts[nt++]=s0; ts[nt++]=s1;
        for(int i=0;i<nc&&nt<30;i++){
            float u0,u1;
            if(clip_to_circle(x0+circ[i][0]*sz,y0+circ[i][1]*sz,circ[i][2]*sz,lx2,ly2,dx2,dy2,&u0,&u1)){
                if(u0>s0&&u0<s1)ts[nt++]=u0;
                if(u1>s0&&u1<s1)ts[nt++]=u1;
            }
        }
        for(int i=0;i<nlu&&nt<31;i++){
            if(fabsf(dx2)>1e-7f){float t=(x0+lu[i]*sz-lx2)/dx2;if(t>s0&&t<s1)ts[nt++]=t;}
        }
        for(int i=0;i<nlv&&nt<31;i++){
            if(fabsf(dy2)>1e-7f){float t=(y0+lv[i]*sz-ly2)/dy2;if(t>s0&&t<s1)ts[nt++]=t;}
        }
        for(int i=1;i<nt;i++){float v=ts[i];int j=i-1;while(j>=0&&ts[j]>v){ts[j+1]=ts[j];j--;}ts[j+1]=v;}
        float keep[16][2]; int nk=0;
        for(int i=0;i+1<nt&&nk<16;i++){
            if(ts[i+1]-ts[i]<0.05f) continue;
            float tm2=0.5f*(ts[i]+ts[i+1]);
            float pu=(lx2+tm2*dx2-x0)/sz, pv=(ly2+tm2*dy2-y0)/sz;
            if(!tk_hatch_excluded(m,pu,pv)){keep[nk][0]=ts[i];keep[nk][1]=ts[i+1];nk++;}
        }
        for(int i=0;i<nk;i++){
            int idx=(k&1)?(nk-1-i):i;
            float a=keep[idx][0], b=keep[idx][1];
            if(k&1){float tmp=a;a=b;b=tmp;}
            tk_seg(lx2+a*dx2,ly2+a*dy2,lx2+b*dx2,ly2+b*dy2);
        }
    }
}

static void do_draw_truchet(float cx2, float cy2, int n, float spacing,
                             float angle_deg, int seed, uint32_t mask)
{
    static uint8_t picks[TRUCHET_MAX_CELLS];
    mask &= TRUCHET_ALL_MASK;
    if(mask==0) mask=TRUCHET_DEFAULT_MASK;
    int motifs[TM_COUNT], nm=0;
    for(int i=0;i<TM_COUNT;i++) if(mask&(1u<<i)) motifs[nm++]=i;
    float W=g_x_max-g_x_min, H=g_y_max-g_y_min;
    if(n<1) n=1;
    float sz=W/(float)n;
    if(sz<TRUCHET_MIN_CELL_MM){
        n=(int)(W/TRUCHET_MIN_CELL_MM);
        if(n<1)n=1;
        sz=W/(float)n;
        web_log("truchet: cells clamped to >=%.0f mm -> %d cols",(double)TRUCHET_MIN_CELL_MM,n);
    }
    int rows=(int)(H/sz);
    if(rows<1) rows=1;
    while(n*rows>TRUCHET_MAX_CELLS) rows--;
    if(isnan(cx2)) cx2=0.5f*(g_x_min+g_x_max);
    if(isnan(cy2)) cy2=0.5f*(g_y_min+g_y_max);
    float gx=cx2-(float)n*sz*0.5f, gy=cy2-(float)rows*sz*0.5f;
    s_tk_rng=(uint32_t)seed;
    for(int i=0;i<n*rows;i++) picks[i]=(uint8_t)motifs[tk_rand()%(uint32_t)nm];
    tmc5072_enable(&tmc, true);
    s_tk_pen.down=false; s_tk_pen.valid=false;
    pen_lift();
    web_log("truchet: %dx%d cells of %.0f mm, %d motifs, hatch %.1f mm @ %.0f deg",
            n,rows,(double)sz,nm,(double)spacing,(double)angle_deg);
    for(int ri=0;ri<rows&&!motion_should_abort();ri++){
        for(int c2=0;c2<n&&!motion_should_abort();c2++){
            int ci=(ri&1)?(n-1-c2):c2;
            float tx=gx+(float)ci*sz, ty=gy+(float)ri*sz;
            if(tx>g_x_max||tx+sz<g_x_min||ty>g_y_max||ty+sz<g_y_min) continue;
            int m2=picks[ri*n+ci];
            tk_motif_strokes(m2,tx,ty,sz);
            for(int e=0;e<4;e++){
                bool grid_edge=(e==0&&ri==0)||(e==2&&ri==rows-1)||
                               (e==3&&ci==0)||(e==1&&ci==n-1);
                if(tm_dot_edges[m2]&(1u<<e)) tk_dot_half(e,tx,ty,sz,false);
                if(grid_edge)                 tk_dot_half(e,tx,ty,sz,true);
            }
            if(spacing>=0.5f) tk_hatch_tile(m2,tx,ty,sz,angle_deg,spacing);
        }
    }
    tk_break();
    pen_lift();
    emit_pos_event();
}

/* ---- Exported to web layer ---- */

bool plotter_in_bounds(float x, float y)
{
    if (!(x >= g_x_min && x <= g_x_max && y >= g_y_min && y <= g_y_max)) return false;
    if (g_bounds_ellipse && ellipse_norm(x, y, NULL, NULL, NULL, NULL) > 1.0f) return false;
    return true;
}
void plotter_get_bounds(float *xn, float *xp, float *yn, float *yp)
{ *xn = g_x_min; *xp = g_x_max; *yn = g_y_min; *yp = g_y_max; }
bool plotter_bounds_ellipse(void) { return g_bounds_ellipse; }
void plotter_get_xy(float *x, float *y)
{
    int32_t sl = tmc5072_position(&tmc, MOTOR_RHO);
    int32_t sr = tmc5072_position(&tmc, MOTOR_THETA);
    plt_steps_to_xy(&g_geom, sl, sr, x, y);
}
void plotter_get_motion(uint32_t *vmax, uint32_t *amax, float *run_ma, float *hold_ma)
{
    if (vmax)    *vmax    = g_vmax;
    if (amax)    *amax    = g_accel;
    if (run_ma)  *run_ma  = g_run_ma;
    if (hold_ma) *hold_ma = g_hold_ma;
}
void plotter_abort_now(void)
{
    g_job_abort = true;
    tmc5072_stop(&tmc, MOTOR_THETA);
    tmc5072_stop(&tmc, MOTOR_RHO);
    if (g_draw_queue) xQueueReset(g_draw_queue);
    g_job_done = g_job_enqueued;
    pen_lift();
}

/* ---- web_draw_task — verbatim from ESP32 build ---- */

static const char *wcmd_name(wcmd_type_t t)
{
    switch (t) {
    case WCMD_CIRCLE:   return "circle";
    case WCMD_SQUARE:   return "square";
    case WCMD_LINE:     return "line";
    case WCMD_GOTO:     return "goto";
    case WCMD_HOME:     return "home";
    case WCMD_PEN_UP:   return "pen up";
    case WCMD_PEN_DOWN: return "pen down";
    case WCMD_PEN_DEG:  return "pen deg";
    case WCMD_STOP:     return "stop";
    case WCMD_BULLSEYE: return "bullseye";
    case WCMD_GRID:     return "grid";
    case WCMD_BORDER:   return "border";
    case WCMD_SETHOME:  return "sethome";
    case WCMD_BOUNDS:   return "bounds";
    case WCMD_SPEED:    return "speed";
    case WCMD_ACCEL:    return "accel";
    case WCMD_CURRENT:  return "current";
    case WCMD_WOBBLY:   return "wobbly";
    case WCMD_TRUCHET:  return "truchet";
    default:            return "?";
    }
}

static void web_draw_task(void *arg)
{
    (void)arg;
    wcmd_t cmd;
    for (;;) {
        if (xQueueReceive(g_draw_queue, &cmd, portMAX_DELAY) != pdTRUE) continue;
        g_job_abort = false;
        ensure_configured();   /* self-heal if the TMC was power-cycled under us */
        if (cmd.id) {
            g_job_current = cmd.id;
            switch (cmd.type) {
            case WCMD_LINE:
                snprintf(g_job_desc, sizeof(g_job_desc), "line (%.0f,%.0f)->(%.0f,%.0f)",
                         (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2],(double)cmd.p[3]);
                break;
            case WCMD_CIRCLE:
                snprintf(g_job_desc, sizeof(g_job_desc), "circle (%.0f,%.0f) r=%.0f",
                         (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2]);
                break;
            case WCMD_SQUARE:
                snprintf(g_job_desc, sizeof(g_job_desc), "square (%.0f,%.0f) s=%.0f",
                         (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2]);
                break;
            case WCMD_GOTO:
                snprintf(g_job_desc, sizeof(g_job_desc), "goto (%.0f,%.0f)",
                         (double)cmd.p[0],(double)cmd.p[1]);
                break;
            case WCMD_WOBBLY:
                snprintf(g_job_desc, sizeof(g_job_desc), "wobbly (%.0f,%.0f) r=%.0f",
                         (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2]);
                break;
            case WCMD_TRUCHET:
                snprintf(g_job_desc, sizeof(g_job_desc), "truchet %d sp=%.1f ang=%.0f",
                         (int)cmd.p[2],(double)cmd.p[3],(double)cmd.p[4]);
                break;
            default:
                snprintf(g_job_desc, sizeof(g_job_desc), "%s", wcmd_name(cmd.type));
                break;
            }
            if (g_aimode)
                printf("[AI] job %lu start: %s\n", (unsigned long)cmd.id, g_job_desc);
        }
        static const char *fill_label[] = { "", " [hatch]", " [concentric]" };
        switch (cmd.type) {
        case WCMD_CIRCLE: {
            int fm = (int)cmd.p[4];
            web_log("circle (%.1f,%.1f) r=%.1f x%d%s",
                    (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2],(int)cmd.p[3],
                    (fm>=0&&fm<=2)?fill_label[fm]:"");
            do_draw_circle(cmd.p[0],cmd.p[1],cmd.p[2],(int)cmd.p[3],fm,cmd.p[5],cmd.p[6],cmd.p[7]!=0.0f);
            emit_pos_event(); web_log("circle done"); break;
        }
        case WCMD_SQUARE: {
            int fm = (int)cmd.p[4];
            web_log("square (%.1f,%.1f) side=%.1f x%d%s",
                    (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2],(int)cmd.p[3],
                    (fm>=0&&fm<=2)?fill_label[fm]:"");
            do_draw_square(cmd.p[0],cmd.p[1],cmd.p[2],(int)cmd.p[3],fm,cmd.p[5],cmd.p[6],cmd.p[7]!=0.0f);
            emit_pos_event(); web_log("square done"); break;
        }
        case WCMD_LINE:
            web_log("line (%.1f,%.1f)->(%.1f,%.1f) x%d",
                    (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2],(double)cmd.p[3],(int)cmd.p[4]);
            do_draw_line(cmd.p[0],cmd.p[1],cmd.p[2],cmd.p[3],(int)cmd.p[4]);
            emit_pos_event(); web_log("line done"); break;
        case WCMD_GOTO:
            web_log("goto (%.1f, %.1f)",(double)cmd.p[0],(double)cmd.p[1]);
            do_draw_goto(cmd.p[0],cmd.p[1]); web_log("goto done"); break;
        case WCMD_HOME:
            web_log("home"); home_gondola(); emit_pos_event(); web_log("home done"); break;
        case WCMD_STOP:
            web_log("stop");
            tmc5072_stop(&tmc, MOTOR_THETA); tmc5072_stop(&tmc, MOTOR_RHO); break;
        case WCMD_PEN_UP:   web_log("pen up");   pen_lift(); break;
        case WCMD_PEN_DOWN: web_log("pen down"); pen_drop(); break;
        case WCMD_PEN_DEG:
            web_log("pen %.0f deg",(double)cmd.p[0]);
            servo_write_deg((int)cmd.p[0]); break;
        case WCMD_BULLSEYE:
            web_log("bullseye (%.1f, %.1f)",(double)cmd.p[0],(double)cmd.p[1]);
            do_draw_bullseye(cmd.p[0],cmd.p[1]); web_log("bullseye done"); break;
        case WCMD_GRID:
            web_log("grid (%.1f, %.1f)",(double)cmd.p[0],(double)cmd.p[1]);
            do_draw_grid(cmd.p[0],cmd.p[1]); web_log("grid done"); break;
        case WCMD_BORDER:
            web_log("border (%s)", g_bounds_ellipse ? "ellipse" : "rect");
            do_draw_border(); web_log("border done"); break;
        case WCMD_WOBBLY:
            web_log("wobbly (%.1f,%.1f) r=%.1f bound=%.1f wobble=%.2f h=%d seed=%d x%d",
                    (double)cmd.p[0],(double)cmd.p[1],(double)cmd.p[2],(double)cmd.p[3],
                    (double)cmd.p[4],(int)cmd.p[5],(int)cmd.p[6],(int)cmd.p[7]);
            do_draw_wobbly(cmd.p[0],cmd.p[1],cmd.p[2],cmd.p[3],
                           cmd.p[4],(int)cmd.p[5],(int)cmd.p[6],(int)cmd.p[7]);
            emit_pos_event(); web_log("wobbly done"); break;
        case WCMD_TRUCHET:
            web_log("truchet n=%d spacing=%.1f angle=%.0f seed=%d motifs=0x%x",
                    (int)cmd.p[2],(double)cmd.p[3],(double)cmd.p[4],(int)cmd.p[5],(unsigned)cmd.p[6]);
            do_draw_truchet(cmd.p[0],cmd.p[1],(int)cmd.p[2],cmd.p[3],
                            cmd.p[4],(int)cmd.p[5],(uint32_t)cmd.p[6]);
            web_log("truchet done"); break;
        case WCMD_SETHOME:
            web_log("sethome"); set_origin_here(); web_log("sethome done"); break;
        case WCMD_BOUNDS:
            g_x_min=cmd.p[0]; g_x_max=cmd.p[1]; g_y_min=cmd.p[2]; g_y_max=cmd.p[3];
            g_bounds_ellipse=(cmd.p[4]!=0.0f);
            web_log("bounds: x=[%.1f,%.1f] y=[%.1f,%.1f] mm (%s)",
                    (double)g_x_min,(double)g_x_max,(double)g_y_min,(double)g_y_max,
                    g_bounds_ellipse?"ellipse":"rect");
            break;
        case WCMD_SPEED:
            g_vmax=(uint32_t)cmd.p[0]; apply_speed(g_vmax);
            web_log("speed vmax=%lu",(unsigned long)g_vmax); break;
        case WCMD_ACCEL:
            g_accel=(uint32_t)cmd.p[0]; apply_accel(g_accel);
            web_log("accel amax=%lu",(unsigned long)g_accel); break;
        case WCMD_CURRENT:
            g_run_ma=cmd.p[0];
            if(cmd.p[1]>=0.0f) g_hold_ma=cmd.p[1];
            apply_current(g_run_ma,g_hold_ma);
            web_log("current run=%.0f hold=%.0f mA",(double)g_run_ma,(double)g_hold_ma); break;
        default: break;
        }
        if (cmd.id) {
            if (cmd.id > g_job_done) g_job_done = cmd.id;
            if (g_aimode)
                printf("[AI] job %lu %s: %s\n",(unsigned long)cmd.id,
                       g_job_abort?"ABORTED":"done",g_job_desc);
        }
    }
}

/* ---- Console commands ---- */

static int cmd_link(int argc, char **argv)   { (void)argc;(void)argv; link_check(); return 0; }

static int cmd_spiraw(int argc, char **argv)
{
    (void)argc; (void)argv;
    /* Read INPUT (0x04, contains VERSION) and GSTAT (0x01) raw bytes.
     * Prints both SPI phases so we can see exactly what the chip returns. */
    const struct { const char *name; uint8_t addr; const char *expect; } regs[] = {
        { "INPUT/VERSION", TMC5072_INPUT, "phase2 byte1 should be 0x10" },
        { "GSTAT",         TMC5072_GSTAT, "phase2 byte4 bit0=1 after reset" },
    };
    for (int r = 0; r < 2; r++) {
        uint8_t tx[5] = { regs[r].addr & 0x7F, 0, 0, 0, 0 };
        uint8_t p1[5] = {0}, p2[5] = {0};
        xSemaphoreTake(tmc.lock, portMAX_DELAY);
        gpio_put(tmc.pin_csn, 0);
        spi_write_read_blocking(tmc.spi_inst, tx, p1, 5);
        gpio_put(tmc.pin_csn, 1);
        sleep_us(10);
        gpio_put(tmc.pin_csn, 0);
        spi_write_read_blocking(tmc.spi_inst, tx, p2, 5);
        gpio_put(tmc.pin_csn, 1);
        xSemaphoreGive(tmc.lock);
        printf("%s:\n", regs[r].name);
        printf("  TX:      %02x %02x %02x %02x %02x\n",
               tx[0],tx[1],tx[2],tx[3],tx[4]);
        printf("  phase 1: %02x %02x %02x %02x %02x\n",
               p1[0],p1[1],p1[2],p1[3],p1[4]);
        printf("  phase 2: %02x %02x %02x %02x %02x  (%s)\n",
               p2[0],p2[1],p2[2],p2[3],p2[4], regs[r].expect);
    }
    return 0;
}
static int cmd_home(int argc, char **argv)   { (void)argc;(void)argv; home_gondola(); return 0; }
static int cmd_stat(int argc, char **argv)   { (void)argc;(void)argv; print_status(MOTOR_THETA); print_status(MOTOR_RHO); return 0; }
static int cmd_status(int argc, char **argv) { (void)argc;(void)argv; print_global_status(); print_full_status(MOTOR_THETA); print_full_status(MOTOR_RHO); return 0; }
static int cmd_reinit(int argc, char **argv)
{
    (void)argc;(void)argv;
    printf("re-applying TMC config (CHOPCONF/ramp/current/speed/accel)...\n");
    reconfigure_drivers();
    print_full_status(MOTOR_THETA); print_full_status(MOTOR_RHO);
    return 0;
}

static int cmd_cur(int argc, char **argv)
{
    if (argc < 2) { printf("usage: cur <run_mA> [hold_mA]\n"); return 0; }
    g_run_ma = atof(argv[1]);
    if (argc >= 3) g_hold_ma = atof(argv[2]);
    apply_current(g_run_ma, g_hold_ma); return 0;
}
static int cmd_speed(int argc, char **argv)
{
    if (argc < 2) { printf("usage: speed <vmax>\n"); return 0; }
    g_vmax = strtoul(argv[1], NULL, 0); apply_speed(g_vmax); return 0;
}
static int cmd_accel(int argc, char **argv)
{
    if (argc < 2) { printf("usage: accel <amax>\n"); return 0; }
    g_accel = strtoul(argv[1], NULL, 0); apply_accel(g_accel); return 0;
}
static int cmd_setsteps(int argc, char **argv)
{
    if (argc < 2) { print_geom_vars(); printf("usage: setsteps <steps_per_mm>\n"); return 0; }
    g_steps_per_mm = atof(argv[1]); init_geometry(); print_geom_vars(); return 0;
}
static int cmd_setspan(int argc, char **argv)
{
    if (argc < 2) { print_geom_vars(); printf("usage: setspan <mm>\n"); return 0; }
    g_motor_span_mm = atof(argv[1]); init_geometry(); print_geom_vars(); return 0;
}
static int cmd_setbelt(int argc, char **argv)
{
    if (argc < 2) { print_geom_vars(); printf("usage: setbelt <mm>\n"); return 0; }
    g_home_belt_mm = atof(argv[1]); init_geometry(); print_geom_vars(); return 0;
}
static int cmd_setbounds(int argc, char **argv)
{
    if (argc < 5) {
        printf("  bounds: x=[%.1f, %.1f]  y=[%.1f, %.1f] mm\n",
               (double)g_x_min,(double)g_x_max,(double)g_y_min,(double)g_y_max);
        printf("usage: setbounds <xmin> <xmax> <ymin> <ymax> [shape: 0=rect 1=ellipse]\n");
        return 0;
    }
    g_x_min=atof(argv[1]); g_x_max=atof(argv[2]);
    g_y_min=atof(argv[3]); g_y_max=atof(argv[4]);
    if (argc >= 6) g_bounds_ellipse = (atoi(argv[5]) != 0);
    printf("bounds set: x=[%.1f, %.1f]  y=[%.1f, %.1f] mm (%s)\n",
           (double)g_x_min,(double)g_x_max,(double)g_y_min,(double)g_y_max,
           g_bounds_ellipse?"ellipse":"rect");
    return 0;
}
static int cmd_belt(int argc, char **argv)
{
    if (argc < 3) { printf("usage: belt <x_mm> <y_mm>\n"); return 0; }
    float x=atof(argv[1]), y=atof(argv[2]);
    float bl=plt_belt_left(&g_geom,x,y), br=plt_belt_right(&g_geom,x,y);
    float l0=plt_home_belt(&g_geom);
    int32_t sl, sr;
    plt_xy_to_steps(&g_geom,x,y,&sl,&sr);
    float rx2, ry2;
    plt_steps_to_xy(&g_geom,sl,sr,&rx2,&ry2);
    printf("\n-- belt dry run for (x=%.1f, y=%.1f) mm --\n",(double)x,(double)y);
    printf("  geom: span=%.1f drop=%.1f steps/mm=%.3f  home_belt=%.2f mm\n",
           (double)g_geom.span_mm,(double)g_geom.drop_mm,(double)g_geom.steps_per_mm,(double)l0);
    printf("  belt: left=%.2f mm (%+.2f)  right=%.2f mm (%+.2f)\n",
           (double)bl,(double)(bl-l0),(double)br,(double)(br-l0));
    printf("  target: LEFT(M1)=%ld  RIGHT(M2)=%ld steps\n",(long)sl,(long)sr);
    printf("  round-trip: (%.2f, %.2f) mm  err=(%.3f, %.3f)\n",
           (double)rx2,(double)ry2,(double)(rx2-x),(double)(ry2-y));
    return 0;
}
static int cmd_goto(int argc, char **argv)
{
    if (argc < 3) { printf("usage: goto <x_mm> <y_mm>\n"); return 0; }
    float x=atof(argv[1]), y=atof(argv[2]);
    printf("goto (%.1f, %.1f) mm\n",(double)x,(double)y);
    do_draw_goto(x, y); return 0;
}
static int cmd_where(int argc, char **argv)
{
    (void)argc;(void)argv;
    int32_t sl=tmc5072_position(&tmc,MOTOR_RHO), sr=tmc5072_position(&tmc,MOTOR_THETA);
    float x, y;
    plt_steps_to_xy(&g_geom,sl,sr,&x,&y);
    printf("where: LEFT(M2)=%ld RIGHT(M1)=%ld -> (x=%.2f, y=%.2f) mm\n",
           (long)sl,(long)sr,(double)x,(double)y);
    return 0;
}
static int cmd_line(int argc, char **argv)
{
    if (argc < 5) { printf("usage: line <x0> <y0> <x1> <y1> [cycles]\n"); return 0; }
    float x0=atof(argv[1]),y0=atof(argv[2]),x1=atof(argv[3]),y1=atof(argv[4]);
    int cycles=(argc>=6)?parse_cycles(argv[5]):1;
    printf("line (%.1f,%.1f)->(%.1f,%.1f) x%d\n",(double)x0,(double)y0,(double)x1,(double)y1,cycles);
    do_draw_line(x0,y0,x1,y1,cycles);
    printf("line done\n"); return 0;
}
static int cmd_circle(int argc, char **argv)
{
    if (argc < 4) { printf("usage: circle <cx> <cy> <r> [cycles] [fill 0|1|2] [angle] [spacing] [outline 0|1]\n"); return 0; }
    float cx2=atof(argv[1]),cy2=atof(argv[2]),r=atof(argv[3]);
    if (r<=0) { printf("r must be > 0\n"); return 0; }
    int cycles=(argc>=5)?parse_cycles(argv[4]):1;
    int fill_mode=(argc>=6)?atoi(argv[5]):0;
    float hangle=(argc>=7)?atof(argv[6]):0.0f;
    float hspac=(argc>=8)?atof(argv[7]):HATCH_SPACING_MM;
    bool outline=(argc>=9)?(atoi(argv[8])!=0):true;
    printf("circle (%.1f,%.1f) r=%.1f x%d\n",(double)cx2,(double)cy2,(double)r,cycles);
    do_draw_circle(cx2,cy2,r,cycles,fill_mode,hangle,hspac,outline);
    printf("circle done\n"); return 0;
}
static int cmd_square(int argc, char **argv)
{
    if (argc < 4) { printf("usage: square <cx> <cy> <size> [cycles] [fill 0|1|2] [angle] [spacing] [outline 0|1]\n"); return 0; }
    float cx2=atof(argv[1]),cy2=atof(argv[2]),z=atof(argv[3]);
    if (z<=0) { printf("size must be > 0\n"); return 0; }
    int cycles=(argc>=5)?parse_cycles(argv[4]):1;
    int fill_mode=(argc>=6)?atoi(argv[5]):0;
    float hangle=(argc>=7)?atof(argv[6]):0.0f;
    float hspac=(argc>=8)?atof(argv[7]):HATCH_SPACING_MM;
    bool outline=(argc>=9)?(atoi(argv[8])!=0):true;
    printf("square (%.1f,%.1f) side=%.1f x%d\n",(double)cx2,(double)cy2,(double)z,cycles);
    do_draw_square(cx2,cy2,z,cycles,fill_mode,hangle,hspac,outline);
    printf("square done\n"); return 0;
}
static int cmd_bullseye(int argc, char **argv)
{
    float cx2=(argc>=3)?atof(argv[1]):0.0f, cy2=(argc>=3)?atof(argv[2]):0.0f;
    do_draw_bullseye(cx2,cy2); printf("bullseye done\n"); return 0;
}
static int cmd_grid(int argc, char **argv)
{
    float cx2=(argc>=3)?atof(argv[1]):0.0f, cy2=(argc>=3)?atof(argv[2]):0.0f;
    do_draw_grid(cx2,cy2); printf("grid done\n"); return 0;
}
static int cmd_wobbly(int argc, char **argv)
{
    if (argc < 4) { printf("usage: wobbly <cx> <cy> <r> [bound_r] [wobble] [harmonics] [seed] [cycles]\n"); return 0; }
    float cx2=atof(argv[1]),cy2=atof(argv[2]),r=atof(argv[3]);
    float bound_r=(argc>=5)?atof(argv[4]):r*1.5f;
    float wobble=(argc>=6)?atof(argv[5]):0.4f;
    int harmonics=(argc>=7)?atoi(argv[6]):3;
    int seed=(argc>=8)?atoi(argv[7]):42;
    int cycles=(argc>=9)?parse_cycles(argv[8]):1;
    if (r<=0) { printf("r must be > 0\n"); return 0; }
    do_draw_wobbly(cx2,cy2,r,bound_r,wobble,harmonics,seed,cycles);
    printf("wobbly done\n"); return 0;
}
static int cmd_truchet(int argc, char **argv)
{
    if (argc < 2) { printf("usage: truchet <n_cols> [spacing] [angle] [seed] [mask_hex]\n"); return 0; }
    int n=atoi(argv[1]);
    float spacing=(argc>=3)?atof(argv[2]):3.0f;
    float angle=(argc>=4)?atof(argv[3]):45.0f;
    int seed=(argc>=5)?atoi(argv[4]):42;
    uint32_t mask=(argc>=6)?(uint32_t)strtoul(argv[5],NULL,16):TRUCHET_DEFAULT_MASK;
    do_draw_truchet(NAN,NAN,n,spacing,angle,seed,mask);
    printf("truchet done\n"); return 0;
}
static int cmd_pen(int argc, char **argv)
{
    if (argc < 2) { printf("usage: pen <up|down|degrees>\n"); return 0; }
    if      (!strcmp(argv[1],"up"))   servo_write_deg(PEN_UP_DEG);
    else if (!strcmp(argv[1],"down")) servo_write_deg(PEN_DOWN_DEG);
    else                               servo_write_deg(atof(argv[1]));
    printf("pen -> %s\n", argv[1]); return 0;
}
static int cmd_en(int argc, char **argv)
{
    if (argc < 2) { printf("usage: en <0|1>\n"); return 0; }
    bool on = atoi(argv[1]) != 0;
    tmc5072_enable(&tmc, on);
    printf("drivers %s\n", on ? "ENABLED" : "disabled"); return 0;
}
static int cmd_jog(int argc, char **argv)
{
    if (argc < 3) { printf("usage: jog <1|2> <velocity>\n"); return 0; }
    int m = motor_arg(argv[1]);
    if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
    int32_t v = (int32_t)strtol(argv[2], NULL, 0);
    tmc5072_enable(&tmc, true);
    tmc5072_move_velocity(&tmc, m, v, g_accel);
    printf("M%d jogging at v=%ld. 'stop %d' to halt.\n", m+1, (long)v, m+1);
    return 0;
}
static int cmd_stop(int argc, char **argv)
{
    if (argc < 2) {
        tmc5072_stop(&tmc, MOTOR_THETA); tmc5072_stop(&tmc, MOTOR_RHO);
        printf("both motors decelerating\n"); return 0;
    }
    int m = motor_arg(argv[1]);
    if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
    tmc5072_stop(&tmc, m);
    printf("M%d decelerating\n", m+1); return 0;
}
static int cmd_aimode(int argc, char **argv)
{
    if (argc >= 2) g_aimode = (!strcmp(argv[1],"on") || atoi(argv[1]) != 0);
    else           g_aimode = !g_aimode;
    printf("AI mode %s\n", g_aimode ? "ON" : "OFF"); return 0;
}
static int cmd_jobs(int argc, char **argv)
{
    (void)argc;(void)argv;
    int pending = (int)(g_job_enqueued - g_job_done);
    printf("jobs: enqueued=%lu current=%lu done=%lu pending=%d -> %s\n",
           (unsigned long)g_job_enqueued,(unsigned long)g_job_current,
           (unsigned long)g_job_done, pending, pending==0?"IDLE":"BUSY");
    return 0;
}
static int cmd_estop(int argc, char **argv)
{
    (void)argc;(void)argv;
    plotter_abort_now();
    printf("ESTOP: motion stopped, queue flushed, pen up.\n"); return 0;
}
static int cmd_sethome(int argc, char **argv)
{
    if (argc >= 2 && !strcmp(argv[1],"sg")) {
        if (argc < 4) { printf("usage: sethome sg <1|2> <velocity> [sgt]\n"); return 0; }
        int m = motor_arg(argv[2]);
        if (m < 0) { printf("motor must be 1 or 2\n"); return 0; }
        int32_t v = (int32_t)strtol(argv[3], NULL, 0);
        int sgt = (argc >= 5) ? atoi(argv[4]) : 4;
        tmc5072_enable(&tmc, true);
        printf("M%d stallGuard home at v=%ld sgt=%d ...\n", m+1, (long)v, sgt);
        bool r = tmc5072_home_stallguard(&tmc, m, v, g_accel, sgt, MOVE_TIMEOUT_MS);
        printf("  -> %s (XACTUAL now %ld)\n",
               r ? "STALL detected, zeroed" : "NO stall (timeout) — adjust sgt/vel",
               (long)tmc5072_position(&tmc, m));
        return 0;
    }
    set_origin_here(); return 0;
}

/* ---- Simple console REPL (replaces esp_console) ---- */

typedef int (*cmd_fn_t)(int argc, char **argv);
typedef struct { const char *name; const char *help; cmd_fn_t fn; } cmd_entry_t;

static const cmd_entry_t s_cmds[] = {
    { "link",      "Re-read SPI link (VERSION check)",                   cmd_link      },
    { "spiraw",    "Raw SPI byte dump (debug)",                          cmd_spiraw    },
    { "cur",       "Set current: cur <run_mA> [hold_mA]",               cmd_cur       },
    { "speed",     "Set speed: speed <vmax>",                           cmd_speed     },
    { "accel",     "Set acceleration: accel <amax>",                    cmd_accel     },
    { "setbelt",   "Set home belt length (mm)",                         cmd_setbelt   },
    { "setspan",   "Set motor span (mm)",                               cmd_setspan   },
    { "setsteps",  "Set steps/mm",                                      cmd_setsteps  },
    { "setbounds", "Set drawable bounds (mm)",                          cmd_setbounds },
    { "belt",      "DRY RUN: belt lengths for (x,y) mm",               cmd_belt      },
    { "goto",      "Move gondola to (x,y) mm",                         cmd_goto      },
    { "line",      "Draw line: line <x0> <y0> <x1> <y1> [cycles]",    cmd_line      },
    { "circle",    "Draw circle: circle <cx> <cy> <r> [cycles] ...",   cmd_circle    },
    { "square",    "Draw square: square <cx> <cy> <size> [cycles] ...",cmd_square    },
    { "wobbly",    "Random closed curve",                               cmd_wobbly    },
    { "truchet",   "Truchet tiling: truchet <n_cols> [spacing] ...",   cmd_truchet   },
    { "bullseye",  "Calibration crosshair: bullseye [cx cy]",          cmd_bullseye  },
    { "grid",      "Calibration grid: grid [cx cy]",                   cmd_grid      },
    { "where",     "Read position (x,y) mm from XACTUAL",              cmd_where     },
    { "jog",       "Velocity jog: jog <1|2> <vel>",                   cmd_jog       },
    { "stop",      "Stop jog: stop [1|2]",                             cmd_stop      },
    { "pen",       "Servo: pen <up|down|degrees>",                     cmd_pen       },
    { "en",        "Enable/disable drivers: en <0|1>",                 cmd_en        },
    { "home",      "Return both motors to XTARGET=0",                  cmd_home      },
    { "sethome",   "Set origin: sethome | sethome sg <m> <vel> [sgt]",cmd_sethome   },
    { "stat",      "Brief DRV_STATUS + positions",                     cmd_stat      },
    { "status",    "Full register readback (both motors)",             cmd_status    },
    { "reinit",    "Re-apply TMC config after a driver power-cycle",     cmd_reinit    },
    { "aimode",    "Toggle job-progress printing: aimode [on|off]",    cmd_aimode    },
    { "jobs",      "Show job queue snapshot",                          cmd_jobs      },
    { "estop",     "ESCAPE: stop motion, flush queue, lift pen",       cmd_estop     },
};
#define N_CMDS (sizeof(s_cmds)/sizeof(s_cmds[0]))

static void console_loop(void)
{
    char line[256];
    char *argv[32];
    int  argc;
    int  pos = 0;

    printf("\r\nPlotter console ready. Type 'help' for commands.\r\nplotter> ");
    fflush(stdout);

    while (true) {
        /* Non-blocking read — yield so USB interrupt can deliver characters. */
        int c = getchar_timeout_us(0);
        if (c == PICO_ERROR_TIMEOUT) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if (c == '\r' || c == '\n') {
            line[pos] = '\0';
            printf("\r\n");
            pos = 0;
            if (!*line) { printf("plotter> "); fflush(stdout); continue; }

            argc = 0;
            char *p = strtok(line, " \t");
            while (p && argc < 32) { argv[argc++] = p; p = strtok(NULL, " \t"); }

            if (!strcmp(argv[0], "help")) {
                for (size_t i = 0; i < N_CMDS; i++)
                    printf("  %-12s %s\n", s_cmds[i].name, s_cmds[i].help);
            } else {
                bool found = false;
                for (size_t i = 0; i < N_CMDS; i++) {
                    if (!strcmp(argv[0], s_cmds[i].name)) {
                        s_cmds[i].fn(argc, argv);
                        found = true;
                        break;
                    }
                }
                if (!found)
                    printf("unknown command: %s (type 'help')\n", argv[0]);
            }
            printf("plotter> "); fflush(stdout);
        } else if (c == '\b' || c == 127) {
            if (pos > 0) { pos--; printf("\b \b"); fflush(stdout); }
        } else if (pos < (int)sizeof(line) - 1) {
            line[pos++] = (char)c;
            putchar(c); fflush(stdout);
        }
    }
}

/* ---- WiFi (Pico CYW43) ---- */

static void wifi_watchdog_task(void *arg)
{
    (void)arg;
    while (!s_cyw43_ready) vTaskDelay(pdMS_TO_TICKS(500));
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(10000));
        if (!s_wifi_connected) continue;
        int link = cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA);
        if (link == CYW43_LINK_JOIN) continue;
        s_wifi_connected = false;
        printf("[wifi] link lost (status %d), reconnecting...\n", link);
        int r = cyw43_arch_wifi_connect_timeout_ms(
                    WIFI_SSID, WIFI_PASS, CYW43_AUTH_WPA2_AES_PSK, 30000);
        if (r == 0) {
            s_wifi_connected = true;
            printf("[wifi] reconnected: %s\n",
                   ip4addr_ntoa(netif_ip4_addr(netif_default)));
            web_log("WiFi reconnected: http://%s/",
                    ip4addr_ntoa(netif_ip4_addr(netif_default)));
        } else {
            printf("[wifi] reconnect failed (%d), will retry\n", r);
        }
    }
}

static void wifi_init_sta(void)
{
    printf("[wifi] calling cyw43_arch_init...\n"); fflush(stdout);
    if (cyw43_arch_init()) {
        printf("[wifi] cyw43_arch_init failed\n"); fflush(stdout);
        return;
    }
    printf("[wifi] cyw43_arch_init ok\n"); fflush(stdout);
    s_cyw43_ready = true;   /* LED now driveable */
    cyw43_arch_enable_sta_mode();
    /* Disable WiFi power-save: the CYW43 default (PM2) sleeps between beacons,
     * which pushes ping latency to ~100 ms and adds jitter to every TCP exchange.
     * For a LAN-controlled plotter we want responsiveness over battery life. */
    cyw43_wifi_pm(&cyw43_state, CYW43_NONE_PM);
    printf("[wifi] connecting to '%s'...\n", WIFI_SSID);
    for (;;) {
        int r = cyw43_arch_wifi_connect_timeout_ms(
                    WIFI_SSID, WIFI_PASS, CYW43_AUTH_WPA2_AES_PSK, 30000);
        if (r == 0) break;
        printf("[wifi] connect failed (%d), retrying in 5 s\n", r);
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
    s_wifi_connected = true;
    snprintf(s_wifi_ip_str, sizeof(s_wifi_ip_str), "%s",
             ip4addr_ntoa(netif_ip4_addr(netif_default)));
    printf("[wifi] IP: %s  -> open http://%s/ in a browser\n",
           s_wifi_ip_str, s_wifi_ip_str);
    web_log("WiFi up: http://%s/", s_wifi_ip_str);
}

/* ---- UDP boundary-hit listener ---- */

static void udp_listener_task(void *arg)
{
    (void)arg;
    struct sockaddr_in addr = {
        .sin_family      = AF_INET,
        .sin_port        = htons(UDP_LISTEN_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) { printf("[udp] socket() failed\n"); vTaskDelete(NULL); }
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        printf("[udp] bind() to port %d failed\n", UDP_LISTEN_PORT);
        close(sock); vTaskDelete(NULL);
    }
    printf("[udp] listening on port %d\n", UDP_LISTEN_PORT);
    char buf[8];
    while (1) {
        struct sockaddr_in src; socklen_t src_len = sizeof(src);
        int len = recvfrom(sock, buf, sizeof(buf)-1, 0, (struct sockaddr *)&src, &src_len);
        if (len < 0) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        buf[len] = '\0';
        char code = buf[0];
        if (code=='1'||code=='2'||code=='3'||code=='4'||code=='o') {
            printf("[udp] boundary-hit '%c' -> homing\n", code);
            home_gondola();
        }
    }
}

/* ---- Pattern stream task ---- */

static void pattern_stream_task(void *arg)
{
    (void)arg;
    struct sockaddr_in addr = {
        .sin_family      = AF_INET,
        .sin_port        = htons(PATTERN_LISTEN_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) { printf("[pattern] socket() failed\n"); vTaskDelete(NULL); }
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        printf("[pattern] bind() to port %d failed\n", PATTERN_LISTEN_PORT);
        close(sock); vTaskDelete(NULL);
    }
    printf("[pattern] listening on port %d\n", PATTERN_LISTEN_PORT);
    bool pen_down = false;
    servo_write_deg(PEN_UP_DEG);
    char buf[32];
    while (1) {
        struct sockaddr_in src; socklen_t src_len = sizeof(src);
        int len = recvfrom(sock, buf, sizeof(buf)-1, 0, (struct sockaddr *)&src, &src_len);
        if (len < 0) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        buf[len] = '\0';
        int m1, m2, pen;
        if (sscanf(buf, "%d %d %d", &m1, &m2, &pen) != 3) continue;
        bool want_down = (pen != 0);
        servo_write_deg(want_down ? PEN_DOWN_DEG : PEN_UP_DEG);
        if (want_down != pen_down) {
            pen_down = want_down;
            vTaskDelay(pdMS_TO_TICKS(PEN_DWELL_MS));
        }
        tmc5072_enable(&tmc, true);
        tmc5072_move_coordinated(&tmc, (int32_t)m1, (int32_t)m2);
        wait_reached(MOTOR_THETA, MOVE_TIMEOUT_MS);
        wait_reached(MOTOR_RHO,   MOVE_TIMEOUT_MS);
    }
}

/* ---- Entry point ---- */

static void main_task(void *arg)
{
    (void)arg;

    /* Wait for the USB CDC host to open the port (max 30 s), then print.
     * A fixed delay drops output if screen opens after the window expires. */
    for (int i = 0; i < 300 && !stdio_usb_connected(); i++)
        vTaskDelay(pdMS_TO_TICKS(100));

    printf("\r\n====  Polar Plotter (Pico 2W)  ====\r\n");
    printf("[build] %s %s  (netconn=%d tcp_pcb=%d msl=%dms)\r\n",
           __DATE__, __TIME__, MEMP_NUM_NETCONN, MEMP_NUM_TCP_PCB, TCP_MSL);

    init_geometry();

    servo_init(PIN_SERVO);
    servo_write_deg(PEN_UP_DEG);

    tmc5072_config_t cfg = {
        .spi_inst     = TMC_SPI_INST,
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
    if (!tmc5072_init(&tmc, &cfg))
        printf("[main] WARNING: tmc5072_init failed — check wiring\n");

    run_bringup();

    /* web_server_init creates queues/stream buffer — call before WiFi so web_log
     * works from here on.  web_server_listen opens the TCP port after WiFi up. */
    printf("[main] web_server_init...\n"); fflush(stdout);
    web_server_init();
    printf("[main] task creates...\n"); fflush(stdout);
    xTaskCreate(web_draw_task, "web_draw", 4096, NULL, 5, NULL);
    xTaskCreate(led_task,      "led",       512, NULL, 2, NULL);
    printf("[main] wifi_init_sta...\n"); fflush(stdout);
    wifi_init_sta();   /* blocks until connected; sets s_cyw43_ready early inside */

    web_server_listen();
    xTaskCreate(udp_listener_task,   "udp",      1024, NULL, 5, NULL);
    xTaskCreate(pattern_stream_task, "pattern",  1024, NULL, 5, NULL);
    xTaskCreate(wifi_watchdog_task,  "wifi_wd",  512,  NULL, 2, NULL);

    console_loop();   /* runs forever; returns only if stdin closes */
    vTaskDelete(NULL);
}

int main(void)
{
    stdio_init_all();
    xTaskCreate(main_task, "main", 4096, NULL, 5, NULL);
    vTaskStartScheduler();
    return 0;
}
