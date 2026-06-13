/* web_server.c — HTTP server + Server-Sent Events log stream.
 *
 * Exposes drawing commands as GET /api/<cmd>?<params> and streams log output
 * to a browser at GET /events (Server-Sent Events). HTTP handlers push commands
 * onto g_draw_queue; web_draw_task in main.c executes them so handlers return
 * immediately. Only one SSE client is supported at a time (stream buffer is
 * single-reader). web_log() is safe to call from any task.
 */
#include "web_server.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <math.h>
#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"
#include "freertos/semphr.h"

static const char *TAG = "web";

QueueHandle_t g_draw_queue = NULL;

/* Job tracking & escape state (declared extern in web_server.h). */
volatile uint32_t g_job_enqueued = 0;
volatile uint32_t g_job_current  = 0;
volatile uint32_t g_job_done     = 0;
volatile bool     g_job_abort    = false;
char              g_job_desc[128] = "idle";

/* Driver-fault latch (set by the motion task's driver_fault_scan(), cleared only
 * by /api/clearfault). Sticky so a fault survives until explicitly acknowledged —
 * this is what the MCP polls to halt/pause a script. 0 = driver healthy. */
volatile uint32_t g_drv_fault     = 0;
char              g_drv_flags[96]  = "ok";

#define LOG_STREAM_BYTES 2048
static StreamBufferHandle_t s_log_stream  = NULL;
static SemaphoreHandle_t    s_log_mutex   = NULL;
static QueueHandle_t        s_sse_req_q   = NULL;  /* passes async req to sse_task */

/* SSE task: owns the long-lived EventSource connection so the httpd worker is free.
 *
 * Architecture: esp_http_server has ONE worker task. If handle_events() kept the
 * connection open in a loop, no other HTTP request could be served (the worker would
 * be stuck). Instead, handle_events() calls httpd_req_async_handler_begin() to hand
 * off the request to this dedicated task and returns immediately — freeing the worker
 * for circle/goto/stop calls while SSE streams in parallel.
 *
 * Only one SSE client at a time: xQueueOverwrite() drops the previous async_req when
 * a new browser tab connects, which also kills the old connection cleanly. */
static void sse_task(void *arg)
{
    (void)arg;
    for (;;) {
        httpd_req_t *req = NULL;
        /* Block here (no CPU usage) until handle_events() gives us an async request. */
        xQueueReceive(s_sse_req_q, &req, portMAX_DELAY);
        if (!req) continue;

        char buf[300];
        for (;;) {
            /* Block up to 2 s for data from the log stream. */
            size_t n = xStreamBufferReceive(s_log_stream, buf, sizeof(buf) - 1,
                                            pdMS_TO_TICKS(2000));
            esp_err_t err;
            if (n > 0) {
                /* Forward whatever the producers wrote (already SSE-framed). */
                err = httpd_resp_send_chunk(req, buf, (ssize_t)n);
            } else {
                /* No data for 2 s: send an SSE comment as a heartbeat so the
                 * browser doesn't time out and close the EventSource. */
                err = httpd_resp_send_chunk(req, ": hb\n\n", 6);
            }
            /* Any send error means the browser closed the tab — exit and wait
             * for the next connection. */
            if (err != ESP_OK) break;
        }
        /* Zero-length chunk signals end-of-response, then release the async slot. */
        httpd_resp_send_chunk(req, NULL, 0);
        httpd_req_async_handler_complete(req);
    }
}

/* ---- Log/event sink (producer side) ---- */

/* Write a fully-framed SSE event into the stream buffer. The SSE handler
 * passes bytes through verbatim, so producers own the framing.
 * The mutex serialises writes from web_log() and web_pos_event() which may be
 * called from different tasks (the draw task and any future sensor task). */
static void stream_write(const char *data, size_t len)
{
    if (!s_log_stream || !len) return;
    if (xSemaphoreTake(s_log_mutex, pdMS_TO_TICKS(20)) == pdTRUE) {
        xStreamBufferSend(s_log_stream, data, len, 0);   /* drop if full */
        xSemaphoreGive(s_log_mutex);
    }
}

/* web_log(): SSE-wrap a printf-style message as an unnamed event.
 * The browser's es.onmessage handler picks these up as plain log lines.
 * Format: "data: <text>\n\n" per the SSE spec. */
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

/* web_pos_event(): SSE-wrap an (x,y) position as a NAMED "pos" event.
 * Named events bypass es.onmessage and are caught by es.addEventListener('pos',…)
 * in usePlotter.ts — so position updates update the canvas dot without
 * polluting the log window with coordinate spam.
 * Format: "event: pos\ndata: {…}\n\n" per the SSE spec. */
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
static void get_qs(httpd_req_t *req, char *buf, size_t len)
{
    size_t qlen = httpd_req_get_url_query_len(req) + 1;
    buf[0] = '\0';
    if (qlen > 1 && qlen <= len)
        httpd_req_get_url_query_str(req, buf, qlen);
}

static float qf(const char *qs, const char *key, float def)
{
    char val[32] = {};
    if (qs && httpd_query_key_value(qs, key, val, sizeof(val)) == ESP_OK)
        return (float)atof(val);
    return def;
}

/* ---- Shared response ---- */
static void resp_json(httpd_req_t *req, const char *status, const char *msg)
{
    char buf[180];
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    snprintf(buf, sizeof(buf), "{\"status\":\"%s\",\"msg\":\"%s\"}\n", status, msg);
    httpd_resp_sendstr(req, buf);
}

/* Push a draw command onto the queue for web_draw_task (in main.c) to execute and
 * return its job id. HTTP handlers return immediately after this — the motor waits
 * happen in web_draw_task. The caller hands the id back to the client so it can poll
 * /api/status until g_job_done >= id ("wait till the job is actually done"). */
static uint32_t enqueue(wcmd_t *cmd)
{
    if (!g_draw_queue) return 0;
    uint32_t id = ++g_job_enqueued;
    cmd->id = id;
    if (xQueueSend(g_draw_queue, cmd, pdMS_TO_TICKS(200)) != pdTRUE) {
        /* Queue full: release the id so g_job_enqueued stays consistent. */
        --g_job_enqueued;
        return 0;
    }
    return id;
}

/* Same shape as resp_json but also carries the job id so the client can wait on it. */
static void resp_json_id(httpd_req_t *req, const char *status, const char *msg, uint32_t id)
{
    char buf[200];
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    snprintf(buf, sizeof(buf), "{\"status\":\"%s\",\"msg\":\"%s\",\"id\":%lu}\n",
             status, msg, (unsigned long)id);
    httpd_resp_sendstr(req, buf);
}

/* Enqueue helper: sends the queued-ok+id response or an error if the queue is full. */
static void resp_enqueue(httpd_req_t *req, const char *label, wcmd_t *cmd)
{
    uint32_t id = enqueue(cmd);
    if (id == 0) { resp_json(req, "error", "queue full"); return; }
    resp_json_id(req, "ok", label, id);
}

/* Out-of-bounds gate: reject (no enqueue) anything that would leave the work area
 * set in the console / via /api/bounds. pt_ok checks a single point; box_ok checks
 * the full bounding box of a shape (centre +/- half-extents). Returns false AND
 * sends the error response when the target is outside — caller just returns. */
static bool pt_ok(httpd_req_t *req, float x, float y)
{
    if (plotter_in_bounds(x, y)) return true;
    resp_json(req, "error", "target outside work area (see /api/status bounds)");
    return false;
}

static bool box_ok(httpd_req_t *req, float cx, float cy, float hx, float hy)
{
    if (plotter_in_bounds(cx - hx, cy - hy) && plotter_in_bounds(cx + hx, cy + hy) &&
        plotter_in_bounds(cx - hx, cy + hy) && plotter_in_bounds(cx + hx, cy - hy))
        return true;
    resp_json(req, "error", "shape extent outside work area (see /api/status bounds)");
    return false;
}

/* ---- API handlers ---- */

static esp_err_t handle_circle(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_CIRCLE };
    c.p[0] = qf(qs, "cx",       0.0f);
    c.p[1] = qf(qs, "cy",       0.0f);
    c.p[2] = qf(qs, "r",       50.0f);
    c.p[3] = qf(qs, "cycles",   1.0f);
    c.p[4] = qf(qs, "fill",     0.0f);
    c.p[5] = qf(qs, "angle",    0.0f);   /* hatch angle, degrees */
    c.p[6] = qf(qs, "spacing",  3.0f);   /* hatch line spacing, mm */
    c.p[7] = qf(qs, "outline",  1.0f);   /* 1 = draw perimeter, 0 = fill only */
    if (c.p[2] <= 0) { resp_json(req, "error", "r must be > 0"); return ESP_OK; }
    if (!box_ok(req, c.p[0], c.p[1], c.p[2], c.p[2])) return ESP_OK;
    resp_enqueue(req, "circle queued", &c);
    return ESP_OK;
}

static esp_err_t handle_square(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_SQUARE };
    c.p[0] = qf(qs, "cx",       0.0f);
    c.p[1] = qf(qs, "cy",       0.0f);
    c.p[2] = qf(qs, "size",   100.0f);
    c.p[3] = qf(qs, "cycles",   1.0f);
    c.p[4] = qf(qs, "fill",     0.0f);
    c.p[5] = qf(qs, "angle",    0.0f);   /* hatch angle, degrees */
    c.p[6] = qf(qs, "spacing",  3.0f);   /* hatch line spacing, mm */
    c.p[7] = qf(qs, "outline",  1.0f);   /* 1 = draw perimeter, 0 = fill only */
    if (c.p[2] <= 0) { resp_json(req, "error", "size must be > 0"); return ESP_OK; }
    if (!box_ok(req, c.p[0], c.p[1], c.p[2] * 0.5f, c.p[2] * 0.5f)) return ESP_OK;
    resp_enqueue(req, "square queued", &c);
    return ESP_OK;
}

static esp_err_t handle_line(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_LINE };
    c.p[0] = qf(qs, "x0",    0.0f);
    c.p[1] = qf(qs, "y0",    0.0f);
    c.p[2] = qf(qs, "x1",  100.0f);
    c.p[3] = qf(qs, "y1",    0.0f);
    c.p[4] = qf(qs, "cycles", 1.0f);
    if (!pt_ok(req, c.p[0], c.p[1]) || !pt_ok(req, c.p[2], c.p[3])) return ESP_OK;
    resp_enqueue(req, "line queued", &c);
    return ESP_OK;
}

static esp_err_t handle_goto(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_GOTO };
    c.p[0] = qf(qs, "x", 0.0f);
    c.p[1] = qf(qs, "y", 0.0f);
    if (!pt_ok(req, c.p[0], c.p[1])) return ESP_OK;
    resp_enqueue(req, "goto queued", &c);
    return ESP_OK;
}

static esp_err_t handle_home(httpd_req_t *req)
{
    wcmd_t c = { .type = WCMD_HOME };
    resp_enqueue(req, "home queued", &c);
    return ESP_OK;
}

static esp_err_t handle_stop(httpd_req_t *req)
{
    wcmd_t c = { .type = WCMD_STOP };
    /* SendToFront so STOP jumps ahead of any queued circle/square/etc. */
    if (g_draw_queue)
        xQueueSendToFront(g_draw_queue, &c, pdMS_TO_TICKS(200));
    resp_json(req, "ok", "stop sent");
    return ESP_OK;
}

static esp_err_t handle_pen(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    char pos[16] = {};
    httpd_query_key_value(qs, "pos", pos, sizeof(pos));
    wcmd_t c = {};
    if (strcmp(pos, "up") == 0)        c.type = WCMD_PEN_UP;
    else if (strcmp(pos, "down") == 0) c.type = WCMD_PEN_DOWN;
    else { c.type = WCMD_PEN_DEG; c.p[0] = qf(qs, "deg", 90.0f); }
    resp_enqueue(req, "pen queued", &c);
    return ESP_OK;
}

static esp_err_t handle_bullseye(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_BULLSEYE };
    c.p[0] = qf(qs, "cx", 0.0f);
    c.p[1] = qf(qs, "cy", 0.0f);
    if (!box_ok(req, c.p[0], c.p[1], 10.0f, 10.0f)) return ESP_OK;   /* 10mm arms */
    resp_enqueue(req, "bullseye queued", &c);
    return ESP_OK;
}

static esp_err_t handle_grid(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_GRID };
    c.p[0] = qf(qs, "cx", 0.0f);
    c.p[1] = qf(qs, "cy", 0.0f);
    if (!box_ok(req, c.p[0], c.p[1], 50.0f, 50.0f)) return ESP_OK;   /* 100mm lines */
    resp_enqueue(req, "grid queued", &c);
    return ESP_OK;
}

static esp_err_t handle_wobbly(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_WOBBLY };
    c.p[0] = qf(qs, "cx",        0.0f);
    c.p[1] = qf(qs, "cy",        0.0f);
    c.p[2] = qf(qs, "r",        50.0f);
    c.p[3] = qf(qs, "bound_r",   0.0f);   /* 0 = use r*1.5 default (set in do_draw_wobbly) */
    c.p[4] = qf(qs, "wobble",    0.4f);   /* 0=circle .. 1=max distortion */
    c.p[5] = qf(qs, "harmonics", 3.0f);   /* 1=gentle blob  8=complex jagged */
    c.p[6] = qf(qs, "seed",     42.0f);   /* integer seed for reproducibility */
    c.p[7] = qf(qs, "cycles",    1.0f);
    if (c.p[2] <= 0) { resp_json(req, "error", "r must be > 0"); return ESP_OK; }
    /* default bound_r = r * 1.5 when caller passes 0 */
    if (c.p[3] <= 0.0f) c.p[3] = c.p[2] * 1.5f;
    if (!box_ok(req, c.p[0], c.p[1], c.p[3], c.p[3])) return ESP_OK;   /* bound_r extent */
    resp_enqueue(req, "wobbly queued", &c);
    return ESP_OK;
}

static esp_err_t handle_truchet(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_TRUCHET };
    c.p[0] = qf(qs, "cx",      NAN);    /* NAN = centre of the work area */
    c.p[1] = qf(qs, "cy",      NAN);
    c.p[2] = qf(qs, "n",       4.0f);   /* columns; cell size clamps to >= 40 mm */
    c.p[3] = qf(qs, "spacing", 3.0f);   /* hatch spacing mm; < 0.5 = outlines only */
    c.p[4] = qf(qs, "angle",  45.0f);   /* hatch angle, degrees */
    c.p[5] = qf(qs, "seed",   42.0f);
    c.p[6] = qf(qs, "motifs",  0.0f);   /* enabled-motif bitmask; 0 = default set */
    if (c.p[2] < 1.0f || c.p[2] > 64.0f) { resp_json(req, "error", "n must be 1..64"); return ESP_OK; }
    resp_enqueue(req, "truchet queued", &c);
    return ESP_OK;
}

static esp_err_t handle_sethome(httpd_req_t *req)
{
    wcmd_t c = { .type = WCMD_SETHOME };
    resp_enqueue(req, "sethome queued", &c);
    return ESP_OK;
}

/* Trace the work-area limit path once (rect edges or ellipse perimeter, per the
 * current bounds shape). No params — the firmware uses its stored bounds. */
static esp_err_t handle_border(httpd_req_t *req)
{
    wcmd_t c = { .type = WCMD_BORDER };
    resp_enqueue(req, "border queued", &c);
    return ESP_OK;
}

static esp_err_t handle_bounds(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_BOUNDS };
    c.p[0] = qf(qs, "xn", -300.0f);   /* X− (left / negative-X limit)  */
    c.p[1] = qf(qs, "xp",  300.0f);   /* X+ (right / positive-X limit) */
    c.p[2] = qf(qs, "yn", -600.0f);   /* Y− (bottom / negative-Y limit) */
    c.p[3] = qf(qs, "yp",  400.0f);   /* Y+ (top / positive-Y limit)   */
    c.p[4] = qf(qs, "shape", 0.0f);   /* 0 = rectangle, 1 = inscribed ellipse */
    resp_enqueue(req, "bounds queued", &c);
    return ESP_OK;
}

static esp_err_t handle_speed(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_SPEED };
    c.p[0] = qf(qs, "vmax", 200000.0f);
    resp_enqueue(req, "speed queued", &c);
    return ESP_OK;
}

static esp_err_t handle_accel(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_ACCEL };
    c.p[0] = qf(qs, "amax", 500.0f);
    resp_enqueue(req, "accel queued", &c);
    return ESP_OK;
}

static esp_err_t handle_cur(httpd_req_t *req)
{
    char qs[256]; get_qs(req, qs, sizeof(qs));
    wcmd_t c = { .type = WCMD_CURRENT };
    c.p[0] = qf(qs, "run",   300.0f);
    c.p[1] = qf(qs, "hold",  -1.0f);   /* -1 = leave hold current unchanged */
    resp_enqueue(req, "current queued", &c);
    return ESP_OK;
}

/* Status report: the work area (bounds), live position, and the job queue cursor
 * (enqueued / current / done / pending). This is the MCP's source of truth — it
 * polls here to (a) learn the dimension limits set in the console and (b) wait
 * until g_done >= the id it was handed, i.e. its job actually finished. */
static esp_err_t handle_status(httpd_req_t *req)
{
    float xn, xp, yn, yp, x = 0.0f, y = 0.0f;
    plotter_get_bounds(&xn, &xp, &yn, &yp);
    plotter_get_xy(&x, &y);
    int pending = (int)(g_job_enqueued - g_job_done);
    bool idle = (pending == 0);

    char buf[700];
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    snprintf(buf, sizeof(buf),
        "{\"status\":\"ok\",\"enqueued\":%lu,\"current\":%lu,\"done\":%lu,"
        "\"pending\":%d,\"idle\":%s,\"aborting\":%s,\"job\":\"%s\","
        "\"drv_ok\":%s,\"drv_flags\":\"%s\","
        "\"x\":%.2f,\"y\":%.2f,"
        "\"bounds\":{\"xn\":%.1f,\"xp\":%.1f,\"yn\":%.1f,\"yp\":%.1f,\"ellipse\":%s}}\n",
        (unsigned long)g_job_enqueued, (unsigned long)g_job_current,
        (unsigned long)g_job_done, pending, idle ? "true" : "false",
        g_job_abort ? "true" : "false", g_job_desc,
        g_drv_fault ? "false" : "true", g_drv_flags,
        (double)x, (double)y, (double)xn, (double)xp, (double)yn, (double)yp,
        plotter_bounds_ellipse() ? "true" : "false");
    httpd_resp_sendstr(req, buf);
    return ESP_OK;
}

/* Escape / emergency stop: preempts the running job (not just queued ones), flushes
 * the pending queue, and lifts the pen. Unlike /api/stop (which only queues a STOP
 * behind the in-flight move), this interrupts immediately via the g_job_abort flag. */
static esp_err_t handle_abort(httpd_req_t *req)
{
    plotter_abort_now();
    resp_json(req, "ok", "ABORT: motion stopped, queue flushed, pen up");
    return ESP_OK;
}

/* Clear a latched driver fault: re-enables the drivers (the only way to clear a
 * latched short-to-GND) and drops g_drv_fault. The MCP calls this after a driver
 * fault is resolved, before resuming the paused script. */
static esp_err_t handle_clearfault(httpd_req_t *req)
{
    plotter_clear_fault();
    resp_json(req, "ok", "driver fault cleared, drivers re-enabled");
    return ESP_OK;
}

/* SSE handler: keeps the connection open and streams bytes from s_log_stream.
 * Producers (web_log, web_pos_event) write fully-framed SSE events.
 * Uses async handler so the httpd worker task is freed immediately. */
static esp_err_t handle_events(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/event-stream");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    httpd_resp_set_hdr(req, "Connection",    "keep-alive");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

    httpd_req_t *async_req;
    if (httpd_req_async_handler_begin(req, &async_req) != ESP_OK) {
        httpd_resp_send_500(req);
        return ESP_OK;
    }
    xQueueOverwrite(s_sse_req_q, &async_req);  /* drops previous client if any */
    return ESP_OK;
}

/* ---- Minimal web UI (served at /) ---- */
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

static esp_err_t handle_root(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_sendstr(req, s_html);
    return ESP_OK;
}

/* ---- Server init ---- */
esp_err_t web_server_start(void)
{
    s_log_stream = xStreamBufferCreate(LOG_STREAM_BYTES, 1);
    s_log_mutex  = xSemaphoreCreateMutex();
    g_draw_queue = xQueueCreate(256, sizeof(wcmd_t));
    s_sse_req_q  = xQueueCreate(1, sizeof(httpd_req_t *));
    if (!s_log_stream || !s_log_mutex || !g_draw_queue || !s_sse_req_q) {
        ESP_LOGE(TAG, "OOM allocating web server resources");
        return ESP_ERR_NO_MEM;
    }
    xTaskCreate(sse_task, "sse", 4096, NULL, 5, NULL);

    httpd_config_t cfg  = HTTPD_DEFAULT_CONFIG();
    cfg.max_open_sockets  = 7;    /* SSE connection + several API calls in flight */
    cfg.max_uri_handlers  = 25;   /* default 8 — silently drops routes beyond the cap, so bump it */
    cfg.stack_size        = 8192;
    cfg.lru_purge_enable  = true;

    httpd_handle_t srv = NULL;
    esp_err_t err = httpd_start(&srv, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start: %s", esp_err_to_name(err));
        return err;
    }

    static const httpd_uri_t routes[] = {
        { .uri = "/",             .method = HTTP_GET, .handler = handle_root     },
        { .uri = "/api/circle",   .method = HTTP_GET, .handler = handle_circle   },
        { .uri = "/api/square",   .method = HTTP_GET, .handler = handle_square   },
        { .uri = "/api/line",     .method = HTTP_GET, .handler = handle_line     },
        { .uri = "/api/goto",     .method = HTTP_GET, .handler = handle_goto     },
        { .uri = "/api/home",     .method = HTTP_GET, .handler = handle_home     },
        { .uri = "/api/stop",     .method = HTTP_GET, .handler = handle_stop     },
        { .uri = "/api/pen",      .method = HTTP_GET, .handler = handle_pen      },
        { .uri = "/api/bullseye", .method = HTTP_GET, .handler = handle_bullseye },
        { .uri = "/api/grid",     .method = HTTP_GET, .handler = handle_grid     },
        { .uri = "/api/border",   .method = HTTP_GET, .handler = handle_border   },
        { .uri = "/api/wobbly",   .method = HTTP_GET, .handler = handle_wobbly   },
        { .uri = "/api/truchet",  .method = HTTP_GET, .handler = handle_truchet  },
        { .uri = "/api/sethome",  .method = HTTP_GET, .handler = handle_sethome  },
        { .uri = "/api/bounds",   .method = HTTP_GET, .handler = handle_bounds   },
        { .uri = "/api/speed",    .method = HTTP_GET, .handler = handle_speed    },
        { .uri = "/api/accel",    .method = HTTP_GET, .handler = handle_accel    },
        { .uri = "/api/cur",      .method = HTTP_GET, .handler = handle_cur      },
        { .uri = "/api/status",   .method = HTTP_GET, .handler = handle_status   },
        { .uri = "/api/abort",    .method = HTTP_GET, .handler = handle_abort    },
        { .uri = "/api/clearfault", .method = HTTP_GET, .handler = handle_clearfault },
        { .uri = "/events",       .method = HTTP_GET, .handler = handle_events   },
    };
    for (size_t k = 0; k < sizeof(routes) / sizeof(routes[0]); k++)
        httpd_register_uri_handler(srv, &routes[k]);

    ESP_LOGI(TAG, "HTTP server started on port %d — open http://<ip>/ in a browser",
             cfg.server_port);
    return ESP_OK;
}
