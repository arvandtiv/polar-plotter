/* web_server.c — lwIP BSD-socket HTTP + SSE server for RP2350/Pico 2W.
 *
 * Replaces the ESP-IDF esp_http_server with a hand-rolled TCP accept loop using
 * lwIP POSIX-compatible sockets.  The public interface (wcmd_t, g_draw_queue,
 * web_log, web_pos_event, web_server_init, web_server_listen) is identical to
 * the ESP32 build so main.c and the rest of the plotter logic are unchanged.
 *
 * Architecture:
 *   http_server_task   — accept loop; parses the request line, dispatches to
 *                        a handler function (int sock, const char *qs).
 *   sse_task           — owns the long-lived EventSource connection; the accept
 *                        loop hands over the socket fd via s_sse_fd_q so the
 *                        server can keep accepting API calls while SSE streams.
 *   stream_write / web_log / web_pos_event — produce SSE-framed data into
 *                        s_log_stream (a FreeRTOS StreamBuffer); sse_task reads
 *                        and forwards it.
 */
#include "web_server.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <math.h>
#include <ctype.h>

#include "lwip/sockets.h"

#include "FreeRTOS.h"
#include "queue.h"
#include "stream_buffer.h"
#include "semphr.h"
#include "task.h"

#define HTTP_PORT 80
#define DRAW_QUEUE_DEPTH 256   /* max jobs that can be PENDING at once */

QueueHandle_t g_draw_queue = NULL;

volatile uint32_t g_job_enqueued = 0;
volatile uint32_t g_job_current  = 0;
volatile uint32_t g_job_done     = 0;
volatile uint32_t g_job_rejected = 0;   /* cumulative enqueues refused (queue full) */
volatile uint32_t g_pending_peak = 0;   /* high-water mark of pending depth */
volatile bool     g_job_abort    = false;
volatile bool     g_paused       = false;
volatile bool     g_estop        = false;
char              g_job_desc[128] = "idle";

volatile uint32_t g_drv_fault    = 0;
char              g_drv_flags[96] = "ok";

#define LOG_STREAM_BYTES 2048
static StreamBufferHandle_t s_log_stream = NULL;
static SemaphoreHandle_t    s_log_mutex  = NULL;
/* Handoff queue: http_server_task pushes accepted /events fds here; sse_task
 * adopts them. Sized to hold a burst of new connections without dropping any. */
#define MAX_SSE_CLIENTS 4
static QueueHandle_t s_sse_fd_q = NULL;

/* ---- SSE task ---- */

static void sse_close(int *fd)
{
    if (*fd >= 0) { shutdown(*fd, SHUT_RDWR); close(*fd); *fd = -1; }
}

/* Holds up to MAX_SSE_CLIENTS live EventSource connections and broadcasts every
 * log line / heartbeat to all of them. Multiple clients (a reconnecting tab, a
 * second browser, the embedded page + the Astro console, a dev StrictMode double
 * mount) each get their own slot instead of evicting one another — which is what
 * caused the endless drop/reconnect loop with the old single-fd design. Dead
 * connections are reaped when a send() fails (within one heartbeat interval). */
static void sse_task(void *arg)
{
    (void)arg;
    int fds[MAX_SSE_CLIENTS];
    int count = 0;
    for (int i = 0; i < MAX_SSE_CLIENTS; i++) fds[i] = -1;

    for (;;) {
        /* Drain all pending new connections. Block up to 1 s only when idle. */
        int new_fd;
        TickType_t wait = (count == 0) ? pdMS_TO_TICKS(1000) : 0;
        while (xQueueReceive(s_sse_fd_q, &new_fd, wait) == pdTRUE) {
            wait = 0;
            int slot = -1;
            for (int i = 0; i < MAX_SSE_CLIENTS; i++) if (fds[i] < 0) { slot = i; break; }
            if (slot < 0) { sse_close(&fds[0]); slot = 0; count--; }  /* full: drop oldest */
            fds[slot] = new_fd; count++;
        }
        if (count == 0) continue;

        char buf[300];
        /* Block up to 2 s for log data; send a heartbeat comment if none arrives. */
        size_t n = xStreamBufferReceive(s_log_stream, buf, sizeof(buf) - 1,
                                        pdMS_TO_TICKS(2000));
        const char *out = (n > 0) ? buf : ": hb\n\n";
        int outlen      = (n > 0) ? (int)n : 6;

        for (int i = 0; i < MAX_SSE_CLIENTS; i++) {
            if (fds[i] < 0) continue;
            if (send(fds[i], out, outlen, 0) < 0) { sse_close(&fds[i]); count--; }
        }
    }
}

/* ---- Log/event stream (producer side) ---- */

static void stream_write(const char *data, size_t len)
{
    if (!s_log_stream || !len) return;
    if (xSemaphoreTake(s_log_mutex, pdMS_TO_TICKS(20)) == pdTRUE) {
        xStreamBufferSend(s_log_stream, data, len, 0);
        xSemaphoreGive(s_log_mutex);
    }
}

void web_log(const char *fmt, ...)
{
    if (!s_log_stream) return;
    char msg[240], event[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);
    if (n <= 0) return;
    if (n >= (int)sizeof(msg)) n = (int)sizeof(msg) - 1;
    int total = snprintf(event, sizeof(event), "data: %.*s\n\n", n, msg);
    if (total > 0) stream_write(event, (size_t)total);
}

void web_pos_event(float x, float y)
{
    if (!s_log_stream) return;
    char event[80];
    int total = snprintf(event, sizeof(event),
                         "event: pos\ndata: {\"x\":%.2f,\"y\":%.2f}\n\n",
                         (double)x, (double)y);
    if (total > 0) stream_write(event, (size_t)total);
}

/* ---- Query-string helpers ---- */

static float qf(const char *qs, const char *key, float def)
{
    if (!qs || !*qs) return def;
    size_t klen = strlen(key);
    const char *p = qs;
    while (*p) {
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            char val[32]; size_t vi = 0;
            const char *vs = p + klen + 1;
            while (*vs && *vs != '&' && vi < sizeof(val) - 1) val[vi++] = *vs++;
            val[vi] = '\0';
            return (float)atof(val);
        }
        while (*p && *p != '&') p++;
        if (*p == '&') p++;
    }
    return def;
}

/* URL-decode a query-string value into out. */
static void url_decode(char *out, size_t out_size, const char *src)
{
    size_t di = 0;
    while (*src && di < out_size - 1) {
        if (*src == '%' && isxdigit((unsigned char)src[1]) && isxdigit((unsigned char)src[2])) {
            char hex[3] = { src[1], src[2], '\0' };
            out[di++] = (char)strtol(hex, NULL, 16);
            src += 3;
        } else if (*src == '+') { out[di++] = ' '; src++; }
        else                    { out[di++] = *src++; }
    }
    out[di] = '\0';
}

static bool qs_str(const char *qs, const char *key, char *out, size_t out_size)
{
    if (!qs || !*qs) return false;
    size_t klen = strlen(key);
    const char *p = qs;
    while (*p) {
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            char raw[64]; size_t ri = 0;
            const char *vs = p + klen + 1;
            while (*vs && *vs != '&' && ri < sizeof(raw) - 1) raw[ri++] = *vs++;
            raw[ri] = '\0';
            url_decode(out, out_size, raw);
            return true;
        }
        while (*p && *p != '&') p++;
        if (*p == '&') p++;
    }
    return false;
}

/* ---- HTTP response helpers ---- */

static void send_response(int sock, int code, const char *ctype, const char *body)
{
    int body_len = (int)strlen(body);
    char hdr[256];
    int hlen = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %d\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n\r\n",
        code,
        code == 200 ? "OK" : (code == 404 ? "Not Found" : "Error"),
        ctype, body_len);
    send(sock, hdr, hlen, 0);
    send(sock, body, body_len, 0);
}

static void resp_json(int sock, const char *status, const char *msg)
{
    char buf[180];
    snprintf(buf, sizeof(buf), "{\"status\":\"%s\",\"msg\":\"%s\"}\n", status, msg);
    send_response(sock, 200, "application/json", buf);
}

static void resp_json_id(int sock, const char *status, const char *msg, uint32_t id)
{
    char buf[200];
    snprintf(buf, sizeof(buf), "{\"status\":\"%s\",\"msg\":\"%s\",\"id\":%lu}\n",
             status, msg, (unsigned long)id);
    send_response(sock, 200, "application/json", buf);
}

/* ---- Queue helpers ---- */

static uint32_t enqueue(wcmd_t *cmd)
{
    if (!g_draw_queue) return 0;
    uint32_t id = ++g_job_enqueued;
    cmd->id = id;
    if (xQueueSend(g_draw_queue, cmd, pdMS_TO_TICKS(50)) != pdTRUE) {
        --g_job_enqueued;
        ++g_job_rejected;   /* queue full — the exact firmware-side rejection */
        return 0;
    }
    uint32_t pend = g_job_enqueued - g_job_done;
    if (pend > g_pending_peak) g_pending_peak = pend;
    return id;
}

static void resp_enqueue(int sock, const char *label, wcmd_t *cmd)
{
    uint32_t id = enqueue(cmd);
    if (id == 0) { resp_json(sock, "error", "queue full"); return; }
    resp_json_id(sock, "ok", label, id);
}

/* ---- Bounds checks ---- */

static bool pt_ok(int sock, float x, float y)
{
    if (plotter_in_bounds(x, y)) return true;
    resp_json(sock, "error", "target outside work area (see /api/status bounds)");
    return false;
}

static bool box_ok(int sock, float cx, float cy, float hx, float hy)
{
    if (plotter_in_bounds(cx - hx, cy - hy) && plotter_in_bounds(cx + hx, cy + hy) &&
        plotter_in_bounds(cx - hx, cy + hy) && plotter_in_bounds(cx + hx, cy - hy))
        return true;
    resp_json(sock, "error", "shape extent outside work area (see /api/status bounds)");
    return false;
}

/* ---- API handlers ---- */

static void handle_circle(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_CIRCLE };
    c.p[0] = qf(qs, "cx",       0.0f);
    c.p[1] = qf(qs, "cy",       0.0f);
    c.p[2] = qf(qs, "r",       50.0f);
    c.p[3] = qf(qs, "cycles",   1.0f);
    c.p[4] = qf(qs, "fill",     0.0f);
    c.p[5] = qf(qs, "angle",    0.0f);
    c.p[6] = qf(qs, "spacing",  3.0f);
    c.p[7] = qf(qs, "outline",  1.0f);
    if (c.p[2] <= 0) { resp_json(sock, "error", "r must be > 0"); return; }
    if (!box_ok(sock, c.p[0], c.p[1], c.p[2], c.p[2])) return;
    resp_enqueue(sock, "circle queued", &c);
}

static void handle_square(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_SQUARE };
    c.p[0] = qf(qs, "cx",       0.0f);
    c.p[1] = qf(qs, "cy",       0.0f);
    c.p[2] = qf(qs, "size",   100.0f);
    c.p[3] = qf(qs, "cycles",   1.0f);
    c.p[4] = qf(qs, "fill",     0.0f);
    c.p[5] = qf(qs, "angle",    0.0f);
    c.p[6] = qf(qs, "spacing",  3.0f);
    c.p[7] = qf(qs, "outline",  1.0f);
    if (c.p[2] <= 0) { resp_json(sock, "error", "size must be > 0"); return; }
    if (!box_ok(sock, c.p[0], c.p[1], c.p[2] * 0.5f, c.p[2] * 0.5f)) return;
    resp_enqueue(sock, "square queued", &c);
}

static void handle_line(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_LINE };
    c.p[0] = qf(qs, "x0",    0.0f);
    c.p[1] = qf(qs, "y0",    0.0f);
    c.p[2] = qf(qs, "x1",  100.0f);
    c.p[3] = qf(qs, "y1",    0.0f);
    c.p[4] = qf(qs, "cycles", 1.0f);
    c.p[5] = qf(qs, "lift",   1.0f);   /* 1 = standalone (pen up/travel/down/draw/up); 0 = continuous (no bob) */
    c.p[6] = qf(qs, "flow",   0.0f);   /* 1 = more segments follow — chain into ONE streamed path, no stop at this vertex */
    if (!pt_ok(sock, c.p[0], c.p[1]) || !pt_ok(sock, c.p[2], c.p[3])) return;
    resp_enqueue(sock, "line queued", &c);
}

static void handle_goto(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_GOTO };
    c.p[0] = qf(qs, "x", 0.0f);
    c.p[1] = qf(qs, "y", 0.0f);
    if (!pt_ok(sock, c.p[0], c.p[1])) return;
    resp_enqueue(sock, "goto queued", &c);
}

static void handle_home(int sock, const char *qs)
{
    (void)qs;
    wcmd_t c = { .type = WCMD_HOME };
    resp_enqueue(sock, "home queued", &c);
}

static void handle_stop(int sock, const char *qs)
{
    (void)qs;
    plotter_stop_hold();   /* halt now, but KEEP the queue (resume to continue) */
    resp_json(sock, "ok", "STOP — motion halted, queue HELD (resume to continue)");
}

static void handle_pen(int sock, const char *qs)
{
    char pos[16] = "";
    qs_str(qs, "pos", pos, sizeof(pos));
    wcmd_t c = { 0 };
    if      (strcmp(pos, "up")   == 0) c.type = WCMD_PEN_UP;
    else if (strcmp(pos, "down") == 0) c.type = WCMD_PEN_DOWN;
    else { c.type = WCMD_PEN_DEG; c.p[0] = qf(qs, "deg", 90.0f); }
    resp_enqueue(sock, "pen queued", &c);
}

static void handle_bullseye(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_BULLSEYE };
    c.p[0] = qf(qs, "cx", 0.0f);
    c.p[1] = qf(qs, "cy", 0.0f);
    if (!box_ok(sock, c.p[0], c.p[1], 10.0f, 10.0f)) return;
    resp_enqueue(sock, "bullseye queued", &c);
}

static void handle_grid(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_GRID };
    c.p[0] = qf(qs, "cx", 0.0f);
    c.p[1] = qf(qs, "cy", 0.0f);
    if (!box_ok(sock, c.p[0], c.p[1], 50.0f, 50.0f)) return;
    resp_enqueue(sock, "grid queued", &c);
}

static void handle_wobbly(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_WOBBLY };
    c.p[0] = qf(qs, "cx",        0.0f);
    c.p[1] = qf(qs, "cy",        0.0f);
    c.p[2] = qf(qs, "r",        50.0f);
    c.p[3] = qf(qs, "bound_r",   0.0f);
    c.p[4] = qf(qs, "wobble",    0.4f);
    c.p[5] = qf(qs, "harmonics", 3.0f);
    c.p[6] = qf(qs, "seed",     42.0f);
    c.p[7] = qf(qs, "cycles",    1.0f);
    c.p[8]  = qf(qs, "fill",     0.0f);   /* 0 none/outline, 1 hatch, 2 concentric */
    c.p[9]  = qf(qs, "angle",    0.0f);   /* hatch angle (deg) */
    c.p[10] = qf(qs, "spacing",  3.0f);   /* hatch / ring spacing (mm) */
    c.p[11] = qf(qs, "outline",  1.0f);   /* 1 = draw the outline too */
    if (c.p[2] <= 0) { resp_json(sock, "error", "r must be > 0"); return; }
    if (c.p[3] <= 0.0f) c.p[3] = c.p[2] * 1.5f;
    if (!box_ok(sock, c.p[0], c.p[1], c.p[3], c.p[3])) return;
    resp_enqueue(sock, "wobbly queued", &c);
}

static void handle_sethome(int sock, const char *qs)
{
    (void)qs;
    wcmd_t c = { .type = WCMD_SETHOME };
    resp_enqueue(sock, "sethome queued", &c);
}

static void handle_border(int sock, const char *qs)
{
    (void)qs;
    wcmd_t c = { .type = WCMD_BORDER };
    resp_enqueue(sock, "border queued", &c);
}

static void handle_bounds(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_BOUNDS };
    c.p[0] = qf(qs, "xn", -300.0f);
    c.p[1] = qf(qs, "xp",  300.0f);
    c.p[2] = qf(qs, "yn", -600.0f);
    c.p[3] = qf(qs, "yp",  400.0f);
    c.p[4] = qf(qs, "shape", 0.0f);
    /* persist=1 → save to flash (survives reboot). Default 0 so grid cell bounds,
     * which churn every cell, never touch flash. */
    c.p[5] = qf(qs, "persist", 0.0f);
    resp_enqueue(sock, "bounds queued", &c);
}

/* Affine warp of the logical (x,y) command space (session-only, identity default).
 * Applied immediately — exploratory, not a queued drawing op. */
static void handle_matrix(int sock, const char *qs)
{
    plotter_set_matrix(qf(qs, "a", 1.0f), qf(qs, "b", 0.0f), qf(qs, "c", 0.0f),
                       qf(qs, "d", 1.0f), qf(qs, "tx", 0.0f), qf(qs, "ty", 0.0f));
    resp_json(sock, "ok", "matrix applied");
}

static void handle_arc(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_ARC };
    c.p[0] = qf(qs, "cx", 0.0f);
    c.p[1] = qf(qs, "cy", 0.0f);
    c.p[2] = qf(qs, "r",  10.0f);
    c.p[3] = qf(qs, "a0", 0.0f);     /* start angle (rad) */
    c.p[4] = qf(qs, "a1", 0.0f);     /* end angle (rad) */
    c.p[5] = qf(qs, "cw", 0.0f);     /* 1 = clockwise */
    c.p[6] = qf(qs, "cycles", 1.0f);
    c.p[7] = qf(qs, "lift", 1.0f);   /* 0 = continuous (no pen bob) */
    c.p[8] = qf(qs, "flow", 0.0f);   /* 1 = chain into the surrounding streamed path (no stop after the sweep) */
    resp_enqueue(sock, "arc queued", &c);
}

static void handle_speed(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_SPEED };
    c.p[0] = qf(qs, "vmax", 200000.0f);
    resp_enqueue(sock, "speed queued", &c);
}

static void handle_accel(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_ACCEL };
    c.p[0] = qf(qs, "amax", 500.0f);
    resp_enqueue(sock, "accel queued", &c);
}

/* Ramp SHAPE tuning (line-crispness experiments — docs/motion_native_tmc5072.md
 * §5.2): a1r/dmaxr/d1r are ratios of AMAX, v1/vstop/tzw absolutes. Queued like
 * speed/accel so it applies in order within a script. Defaults = current shape. */
static void handle_ramp(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_RAMP };
    c.p[0] = qf(qs, "a1r",   2.0f);
    c.p[1] = qf(qs, "v1",    50000.0f);
    c.p[2] = qf(qs, "dmaxr", 1.0f);
    c.p[3] = qf(qs, "d1r",   2.8f);
    c.p[4] = qf(qs, "vstop", 10.0f);
    c.p[5] = qf(qs, "tzw",   0.0f);
    resp_enqueue(sock, "ramp queued", &c);
}

static void handle_cur(int sock, const char *qs)
{
    wcmd_t c = { .type = WCMD_CURRENT };
    c.p[0] = qf(qs, "run",   300.0f);
    c.p[1] = qf(qs, "hold",  -1.0f);
    resp_enqueue(sock, "current queued", &c);
}

static void handle_status(int sock, const char *qs)
{
    (void)qs;
    float xn, xp, yn, yp, x = 0.0f, y = 0.0f;
    plotter_get_bounds(&xn, &xp, &yn, &yp);
    plotter_get_xy(&x, &y);
    int pending = (int)(g_job_enqueued - g_job_done);
    bool idle = (pending == 0);
    uint32_t mv = 0, ma = 0; float run_ma = 0.0f, hold_ma = 0.0f;
    plotter_get_motion(&mv, &ma, &run_ma, &hold_ma);
    float ma_a, ma_b, ma_c, ma_d, ma_tx, ma_ty;
    plotter_get_matrix(&ma_a, &ma_b, &ma_c, &ma_d, &ma_tx, &ma_ty);

    char buf[960];
    snprintf(buf, sizeof(buf),
        "{\"status\":\"ok\",\"enqueued\":%lu,\"current\":%lu,\"done\":%lu,"
        "\"pending\":%d,\"qcap\":%d,\"rejected\":%lu,\"peak\":%lu,"
        "\"idle\":%s,\"aborting\":%s,\"paused\":%s,\"estop\":%s,\"estop_pin\":%d,\"pen_down\":%s,\"job\":\"%s\","
        "\"drv_ok\":%s,\"drv_flags\":\"%s\","
        "\"x\":%.2f,\"y\":%.2f,"
        "\"bounds\":{\"xn\":%.1f,\"xp\":%.1f,\"yn\":%.1f,\"yp\":%.1f,\"ellipse\":%s},"
        "\"motion\":{\"vmax\":%lu,\"amax\":%lu,\"run_ma\":%.1f,\"hold_ma\":%.1f},"
        "\"matrix\":{\"a\":%.5f,\"b\":%.5f,\"c\":%.5f,\"d\":%.5f,\"tx\":%.3f,\"ty\":%.3f}}\n",
        (unsigned long)g_job_enqueued, (unsigned long)g_job_current,
        (unsigned long)g_job_done, pending, DRAW_QUEUE_DEPTH,
        (unsigned long)g_job_rejected, (unsigned long)g_pending_peak,
        idle ? "true" : "false",
        g_job_abort ? "true" : "false", g_paused ? "true" : "false",
        g_estop ? "true" : "false", plotter_estop_level(),
        plotter_pen_is_down() ? "true" : "false", g_job_desc,
        g_drv_fault ? "false" : "true", g_drv_flags,
        (double)x, (double)y, (double)xn, (double)xp, (double)yn, (double)yp,
        plotter_bounds_ellipse() ? "true" : "false",
        (unsigned long)mv, (unsigned long)ma, (double)run_ma, (double)hold_ma,
        (double)ma_a, (double)ma_b, (double)ma_c, (double)ma_d, (double)ma_tx, (double)ma_ty);
    send_response(sock, 200, "application/json", buf);
}

static void handle_abort(int sock, const char *qs)
{
    (void)qs;
    plotter_abort_now();
    resp_json(sock, "ok", "ABORT: motion stopped, queue flushed, pen up");
}

/* Pause/resume preserve the queue. The draw task parks (pen up) at the next job
 * boundary while paused, then continues with the rest of the stack on resume. */
static void handle_pause(int sock, const char *qs)
{
    (void)qs;
    g_paused = true;
    resp_json(sock, "ok", "paused — queue preserved; parks pen-up after the current job");
}

static void handle_resume(int sock, const char *qs)
{
    (void)qs;
    g_paused = false;
    resp_json(sock, "ok", "resumed");
}

static void handle_clearfault(int sock, const char *qs)
{
    (void)qs;
    plotter_clear_fault();
    resp_json(sock, "ok", "driver fault cleared, drivers re-enabled");
}

/* SSE: sends response headers, then transfers socket ownership to sse_task.
 * Caller must NOT close the socket after this returns. */
static void handle_events(int sock)
{
    const char *hdr =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: keep-alive\r\n"
        "Access-Control-Allow-Origin: *\r\n\r\n";
    send(sock, hdr, strlen(hdr), 0);
    /* Bound send() so one stalled client can't freeze the broadcast to the rest. */
    struct timeval snd = { .tv_sec = 2, .tv_usec = 0 };
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &snd, sizeof(snd));
    if (xQueueSend(s_sse_fd_q, &sock, pdMS_TO_TICKS(100)) != pdTRUE) {
        shutdown(sock, SHUT_RDWR); close(sock);   /* handoff queue full — reject */
    }
}

/* ---- Embedded web UI ---- */
static const char s_html[] =
    "<!DOCTYPE html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Polar Plotter</title><style>"
    "body{font:13px monospace;background:#111;color:#ccc;padding:16px;max-width:680px;margin:0 auto}"
    "h1{color:#7af;font-size:1.1em;margin:0 0 12px}"
    "h2{color:#aaf;font-size:.85em;margin:10px 0 5px;border-bottom:1px solid #333;padding-bottom:2px}"
    ".row{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-bottom:6px}"
    "input[type=number]{width:65px;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;border-radius:3px}"
    "button{background:#245;color:#eee;border:1px solid #356;padding:3px 9px;border-radius:3px;cursor:pointer}"
    "button:hover{background:#356}"
    ".stop{background:#522;border-color:#744}.stop:hover{background:#633}"
    "label{display:flex;align-items:center;gap:3px}"
    "#log{background:#000;padding:8px;height:220px;overflow-y:auto;border:1px solid #333;font-size:11px;line-height:1.5}"
    "#st{font-size:.8em;color:#888;margin-bottom:8px}"
    ".ok{color:#8f8}.err{color:#f88}.cmd{color:#88f}"
    "</style></head><body>"
    "<h1>&#9997; Polar Plotter</h1><div id=st>Connecting to log stream...</div>"
    "<h2>Control</h2><div class=row>"
    "<button class=stop onclick=\"c('abort')\">&#9632; STOP</button>"
    "<button onclick=\"c('home')\">Home</button>"
    "<button onclick=\"c('sethome')\">Set Home</button>"
    "<button onclick=\"c('pen?pos=up')\">Pen Up</button>"
    "<button onclick=\"c('pen?pos=down')\">Pen Down</button>"
    "</div>"
    "<h2>Motion Parameters</h2>"
    "<div class=row>"
    "Speed (VMAX)<input type=number id=pv value=200000 style=width:85px>"
    "<button onclick=\"c('speed?vmax='+v('pv'))\">Set</button>"
    "&nbsp; Accel (AMAX)<input type=number id=pa value=500 style=width:65px>"
    "<button onclick=\"c('accel?amax='+v('pa'))\">Set</button>"
    "</div>"
    "<div class=row>"
    "Run mA<input type=number id=pr value=600 style=width:65px>"
    "Hold mA<input type=number id=ph value=200 style=width:65px>"
    "<button onclick=\"c('cur?run='+v('pr')+'&hold='+v('ph'))\">Set Current</button>"
    "</div>"
    "<h2>Canvas Bounds (mm)</h2>"
    "<div class=row>"
    "X&#8722;<input type=number id=bxn value=-300 style=width:60px>"
    "X+<input type=number id=bxx value=300 style=width:60px>"
    "Y&#8722;<input type=number id=byn value=-600 style=width:60px>"
    "Y+<input type=number id=byx value=400 style=width:60px>"
    "<button onclick=\"c('bounds?xn='+v('bxn')+'&xp='+v('bxx')+'&yn='+v('byn')+'&yp='+v('byx'))\">Set</button>"
    "</div>"
    "<h2>Goto</h2><div class=row>"
    "X<input type=number id=gx value=0>"
    "Y<input type=number id=gy value=0>"
    "<button onclick=\"c('goto?x='+v('gx')+'&y='+v('gy'))\">Go</button>"
    "</div>"
    "<h2>Circle</h2><div class=row>"
    "CX<input type=number id=ccx value=0>"
    "CY<input type=number id=ccy value=0>"
    "R<input type=number id=cr value=50>"
    "C<input type=number id=cc value=1 style=width:40px>"
    "Fill<select id=cfi style=background:#222;color:#eee;border:1px solid #444;border-radius:3px;padding:2px>"
    "<option value=0>None</option><option value=1>Hatch</option><option value=2>Concentric</option></select>"
    "&#8736;<input type=number id=ca value=0 style=width:50px title='Hatch angle (deg)'>&#176;"
    "&#9632;<input type=number id=cs value=3 step=0.5 style=width:50px title='Spacing (mm)'>mm"
    "<button onclick=\"c('circle?cx='+v('ccx')+'&cy='+v('ccy')+'&r='+v('cr')+'&cycles='+v('cc')+'&fill='+v('cfi')+'&angle='+v('ca')+'&spacing='+v('cs'))\">Draw</button>"
    "</div>"
    "<h2>Square</h2><div class=row>"
    "CX<input type=number id=scx value=0>"
    "CY<input type=number id=scy value=0>"
    "Side<input type=number id=ssz value=100 title='Side length (mm)'>"
    "C<input type=number id=sc value=1 style=width:40px>"
    "Fill<select id=sfi style=background:#222;color:#eee;border:1px solid #444;border-radius:3px;padding:2px>"
    "<option value=0>None</option><option value=1>Hatch</option><option value=2>Concentric</option></select>"
    "&#8736;<input type=number id=sa value=0 style=width:50px title='Hatch angle (deg)'>&#176;"
    "&#9632;<input type=number id=ss value=3 step=0.5 style=width:50px title='Spacing (mm)'>mm"
    "<button onclick=\"c('square?cx='+v('scx')+'&cy='+v('scy')+'&size='+v('ssz')+'&cycles='+v('sc')+'&fill='+v('sfi')+'&angle='+v('sa')+'&spacing='+v('ss'))\">Draw</button>"
    "</div>"
    "<h2>Line</h2><div class=row>"
    "X0<input type=number id=lx0 value=0>"
    "Y0<input type=number id=ly0 value=0>"
    "X1<input type=number id=lx1 value=100>"
    "Y1<input type=number id=ly1 value=0>"
    "C<input type=number id=lc value=1 style=width:40px>"
    "<button onclick=\"c('line?x0='+v('lx0')+'&y0='+v('ly0')+'&x1='+v('lx1')+'&y1='+v('ly1')+'&cycles='+v('lc'))\">Draw</button>"
    "</div>"
    "<h2>Calibration</h2><div class=row>"
    "CX<input type=number id=bcx value=0>"
    "CY<input type=number id=bcy value=0>"
    "<button onclick=\"c('bullseye?cx='+v('bcx')+'&cy='+v('bcy'))\">Bullseye</button>"
    "<button onclick=\"c('grid?cx='+v('bcx')+'&cy='+v('bcy'))\">Grid</button>"
    "</div>"
    "<h2>Log</h2><div id=log></div>"
    "<script>"
    "function v(x){return document.getElementById(x).value}"
    "function i(x){return document.getElementById(x)}"
    "var L=document.getElementById('log');"
    "function add(t,cls){"
    "  var d=document.createElement('div');d.className=cls||'';"
    "  d.textContent=t;L.appendChild(d);"
    "  if(L.children.length>600)L.removeChild(L.firstChild);"
    "  L.scrollTop=L.scrollHeight;"
    "}"
    "function c(ep){"
    "  add('> '+ep,'cmd');"
    "  fetch('/api/'+ep).then(r=>r.json())"
    "  .then(d=>add((d.status=='ok'?'[ok] ':'[err] ')+d.msg,d.status=='ok'?'ok':'err'))"
    "  .catch(e=>add('[net] '+e,'err'));"
    "}"
    "var es=new EventSource('/events');"
    "es.onopen=function(){"
    "  var st=document.getElementById('st');"
    "  st.textContent='Log stream connected';st.style.color='#8f8';"
    "};"
    "es.onmessage=function(e){add(e.data);};"
    "es.onerror=function(){"
    "  var st=document.getElementById('st');"
    "  st.textContent='Log stream disconnected (reconnecting...)';st.style.color='#f88';"
    "};"
    "</script></body></html>";

/* ---- Batch endpoint (POST /api/batch) ----
 * Body = newline-separated draw ops ("line?x0=..", "goto?x=..", "pen?pos=up", "arc?..").
 * Enqueues them all in ONE request → ~80x fewer TCP connections than one request per op,
 * which is what makes large streamed designs (tens of thousands of segments) practical. */
#define BATCH_BODY_MAX 8192
static char s_batch_body[BATCH_BODY_MAX + 1];

static int hdr_content_length(const char *req)
{
    const char *p = strstr(req, "Content-Length:");
    if (!p) p = strstr(req, "content-length:");
    if (!p) return -1;
    p += 15;
    while (*p == ' ') p++;
    return atoi(p);
}

static bool batch_build_cmd(const char *path, const char *qs, wcmd_t *c)
{
    memset(c, 0, sizeof(*c));
    if (strcmp(path, "line") == 0) {
        c->type = WCMD_LINE;
        c->p[0] = qf(qs, "x0", 0); c->p[1] = qf(qs, "y0", 0);
        c->p[2] = qf(qs, "x1", 0); c->p[3] = qf(qs, "y1", 0);
        c->p[4] = qf(qs, "cycles", 1); c->p[5] = qf(qs, "lift", 1);
        c->p[6] = qf(qs, "flow", 0);
        return true;
    }
    if (strcmp(path, "goto") == 0) {
        c->type = WCMD_GOTO; c->p[0] = qf(qs, "x", 0); c->p[1] = qf(qs, "y", 0); return true;
    }
    if (strcmp(path, "arc") == 0) {
        c->type = WCMD_ARC;
        c->p[0] = qf(qs, "cx", 0); c->p[1] = qf(qs, "cy", 0); c->p[2] = qf(qs, "r", 10);
        c->p[3] = qf(qs, "a0", 0); c->p[4] = qf(qs, "a1", 0); c->p[5] = qf(qs, "cw", 0);
        c->p[6] = qf(qs, "cycles", 1); c->p[7] = qf(qs, "lift", 1);
        c->p[8] = qf(qs, "flow", 0);
        return true;
    }
    if (strcmp(path, "pen") == 0) {
        char pos[16] = ""; qs_str(qs, "pos", pos, sizeof(pos));
        if (strcmp(pos, "down") == 0)      c->type = WCMD_PEN_DOWN;
        else if (strcmp(pos, "up") == 0)   c->type = WCMD_PEN_UP;
        else { c->type = WCMD_PEN_DEG; c->p[0] = qf(qs, "deg", 90.0f); }
        return true;
    }
    return false;
}

static void handle_batch(int sock, const char *req, int total)
{
    int clen = hdr_content_length(req);
    const char *bstart = strstr(req, "\r\n\r\n");
    int have = 0;
    if (bstart) { bstart += 4; have = total - (int)(bstart - req); }
    if (clen < 0) clen = have;
    if (clen > BATCH_BODY_MAX) { resp_json(sock, "error", "batch too large"); return; }
    int n = have > clen ? clen : have;
    if (n > 0) memcpy(s_batch_body, bstart, (size_t)n);
    while (n < clen) {
        int r = recv(sock, s_batch_body + n, clen - n, 0);
        if (r <= 0) break;
        n += r;
    }
    s_batch_body[n] = '\0';
    if (n < clen) {
        /* recv timed out or connection dropped before the full body arrived.
         * Return an error so the client retries rather than silently losing ops. */
        printf("[web] batch body truncated: got %d of %d bytes — returning error\n", n, clen);
        resp_json(sock, "error", "body truncated");
        return;
    }

    uint32_t accepted = 0, rejected = 0, lastId = 0;
    char *save = NULL;
    for (char *line = strtok_r(s_batch_body, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        size_t L = strlen(line);
        if (L && line[L - 1] == '\r') line[--L] = '\0';
        if (L == 0) continue;
        char *q = strchr(line, '?');
        const char *qs = "";
        if (q) { *q = '\0'; qs = q + 1; }
        wcmd_t c;
        if (!batch_build_cmd(line, qs, &c)) { rejected++; continue; }
        uint32_t id = enqueue(&c);
        if (id == 0) rejected++; else { accepted++; lastId = id; }
    }
    char out[112];
    snprintf(out, sizeof(out), "{\"status\":\"ok\",\"accepted\":%lu,\"rejected\":%lu,\"id\":%lu}\n",
             (unsigned long)accepted, (unsigned long)rejected, (unsigned long)lastId);
    send_response(sock, 200, "application/json", out);
}

/* ---- Route table ---- */

typedef void (*handler_fn_t)(int sock, const char *qs);
typedef struct { const char *path; handler_fn_t fn; } route_t;

static const route_t s_routes[] = {
    { "/api/circle",     handle_circle     },
    { "/api/square",     handle_square     },
    { "/api/line",       handle_line       },
    { "/api/arc",        handle_arc        },
    { "/api/goto",       handle_goto       },
    { "/api/home",       handle_home       },
    { "/api/stop",       handle_stop       },
    { "/api/pen",        handle_pen        },
    { "/api/bullseye",   handle_bullseye   },
    { "/api/grid",       handle_grid       },
    { "/api/border",     handle_border     },
    { "/api/wobbly",     handle_wobbly     },
    { "/api/sethome",    handle_sethome    },
    { "/api/bounds",     handle_bounds     },
    { "/api/matrix",     handle_matrix     },
    { "/api/speed",      handle_speed      },
    { "/api/accel",      handle_accel      },
    { "/api/ramp",       handle_ramp       },
    { "/api/cur",        handle_cur        },
    { "/api/status",     handle_status     },
    { "/api/abort",      handle_abort      },
    { "/api/pause",      handle_pause      },
    { "/api/resume",     handle_resume     },
    { "/api/clearfault", handle_clearfault },
};
#define N_ROUTES (sizeof(s_routes) / sizeof(s_routes[0]))

/* ---- HTTP server task ---- */

static void http_server_task(void *arg)
{
    (void)arg;

    int srv_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv_sock < 0) { printf("[web] socket() failed\n"); vTaskDelete(NULL); }

    int yes = 1;
    setsockopt(srv_sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr = {
        .sin_family      = AF_INET,
        .sin_port        = htons(HTTP_PORT),
        .sin_addr.s_addr = INADDR_ANY,
    };
    if (bind(srv_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        printf("[web] bind() failed\n"); close(srv_sock); vTaskDelete(NULL);
    }
    listen(srv_sock, 10);
    printf("[web] HTTP server on port %d\n", HTTP_PORT);

    char req_buf[1024];
    for (;;) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int client_sock = accept(srv_sock, (struct sockaddr *)&client_addr, &client_len);
        if (client_sock < 0) continue;

        /* 3-second receive timeout so a stalled client doesn't block the loop. */
        struct timeval tv = { .tv_sec = 3, .tv_usec = 0 };
        setsockopt(client_sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        /* AND a send timeout: this server is single-threaded, so a blocked send()
         * (full TCP window when the WiFi link hiccups) would otherwise freeze the
         * whole accept loop forever — no status, no batch, every client hangs. With
         * SO_SNDTIMEO the send fails fast, we close the socket, and keep serving. */
        struct timeval snd = { .tv_sec = 4, .tv_usec = 0 };
        setsockopt(client_sock, SOL_SOCKET, SO_SNDTIMEO, &snd, sizeof(snd));

        /* Accumulate until we see the end of headers (\r\n\r\n). */
        int total = 0; bool got_end = false;
        while (total < (int)sizeof(req_buf) - 1) {
            int n = recv(client_sock, req_buf + total, sizeof(req_buf) - 1 - total, 0);
            if (n <= 0) break;
            total += n;
            req_buf[total] = '\0';
            if (strstr(req_buf, "\r\n\r\n")) { got_end = true; break; }
        }
        if (!got_end || total < 4) { close(client_sock); continue; }

        /* Parse the request line: "METHOD /path?qs HTTP/x.y". */
        char *eol = strstr(req_buf, "\r\n");
        if (!eol) { close(client_sock); continue; }
        *eol = '\0';

        char *sp1 = strchr(req_buf, ' ');
        char *sp2 = sp1 ? strchr(sp1 + 1, ' ') : NULL;
        if (!sp1 || !sp2) { close(client_sock); continue; }
        *sp2 = '\0';
        char *url = sp1 + 1;

        /* Split path from query string. */
        char *qmark = strchr(url, '?');
        const char *qs = "";
        if (qmark) { *qmark = '\0'; qs = qmark + 1; }

        /* Root: serve the embedded web UI. */
        if (strcmp(url, "/") == 0) {
            send_response(client_sock, 200, "text/html; charset=utf-8", s_html);
            close(client_sock);
            continue;
        }

        /* SSE: transfer socket to sse_task — do NOT close it here. */
        if (strcmp(url, "/events") == 0) {
            handle_events(client_sock);
            continue;
        }

        /* Batch enqueue: needs the headers + body, not just the query string.
         * The request line has been null-terminated at *eol, so we pass eol+1
         * (the '\n' that follows) as the start of the headers — strstr("\r\n\r\n")
         * and strstr("Content-Length:") both work fine on the unmodified headers. */
        if (strcmp(url, "/api/batch") == 0) {
            int hdr_off = (int)(eol + 1 - req_buf);
            handle_batch(client_sock, eol + 1, total - hdr_off);
            close(client_sock);
            continue;
        }

        /* Dispatch API routes. */
        bool found = false;
        for (size_t k = 0; k < N_ROUTES; k++) {
            if (strcmp(url, s_routes[k].path) == 0) {
                s_routes[k].fn(client_sock, qs);
                found = true;
                break;
            }
        }
        if (!found)
            send_response(client_sock, 404, "application/json",
                          "{\"status\":\"error\",\"msg\":\"not found\"}\n");
        close(client_sock);
    }
}

/* ---- Two-phase init ---- */

void web_server_init(void)
{
    s_log_stream = xStreamBufferCreate(LOG_STREAM_BYTES, 1);
    s_log_mutex  = xSemaphoreCreateMutex();
    g_draw_queue = xQueueCreate(DRAW_QUEUE_DEPTH, sizeof(wcmd_t));
    s_sse_fd_q   = xQueueCreate(MAX_SSE_CLIENTS, sizeof(int));
    if (!s_log_stream || !s_log_mutex || !g_draw_queue || !s_sse_fd_q) {
        printf("[web] OOM\n"); return;
    }
    xTaskCreate(sse_task, "sse", 2048, NULL, 5, NULL);
}

void web_server_listen(void)
{
    xTaskCreate(http_server_task, "http", 4096, NULL, 5, NULL);
}
