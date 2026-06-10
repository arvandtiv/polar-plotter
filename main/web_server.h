#pragma once
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include <stdbool.h>
#include <stdint.h>

/* Drawing command types dispatched from HTTP handlers to web_draw_task in main.c. */
typedef enum {
    WCMD_CIRCLE,
    WCMD_SQUARE,
    WCMD_LINE,
    WCMD_GOTO,
    WCMD_HOME,
    WCMD_PEN_UP,
    WCMD_PEN_DOWN,
    WCMD_PEN_DEG,
    WCMD_STOP,
    WCMD_BULLSEYE,
    WCMD_GRID,
    WCMD_SETHOME,
    WCMD_BOUNDS,
    WCMD_SPEED,
    WCMD_ACCEL,
    WCMD_CURRENT,
    WCMD_WOBBLY,   /* random closed curve via Fourier harmonics; p[]: cx cy r bound_r wobble harmonics seed cycles */
} wcmd_type_t;

typedef struct {
    wcmd_type_t type;
    uint32_t    id;   /* monotonic job id assigned at enqueue (0 = untracked, e.g. STOP) */
    float p[8];   /* cx, cy, r/size/x1/y1, cycles, fill, hatch_angle, hatch_spacing, deg */
} wcmd_t;

/* Queue shared between web_server.c (producer) and web_draw_task in main.c (consumer). */
extern QueueHandle_t g_draw_queue;

/* ---- Job tracking & escape, shared between web_server.c, web_draw_task, and the
 * console. A "job" is one enqueued draw/config command. The MCP enqueues, gets the
 * returned id, then polls /api/status until g_job_done >= id ("wait till done"). */
extern volatile uint32_t g_job_enqueued;  /* last id handed out (also = total enqueued) */
extern volatile uint32_t g_job_current;   /* id currently executing (0 before first job) */
extern volatile uint32_t g_job_done;      /* last id that finished                       */
extern volatile bool     g_job_abort;     /* set to interrupt the running job + skip rest */
extern char              g_job_desc[48];  /* human label of the current/last job          */

/* Implemented in main.c (where the geometry / motor / pen state lives), used by the
 * web layer for out-of-bounds rejection, the /api/status report, and /api/abort. */
bool plotter_in_bounds(float x, float y);
void plotter_get_bounds(float *xn, float *xp, float *yn, float *yp);
void plotter_get_xy(float *x, float *y);
void plotter_abort_now(void);   /* stop motors, flush the queue, lift the pen, set g_job_abort */

esp_err_t web_server_start(void);

/* Push a formatted log line to the SSE event stream (called from web_draw_task). */
void web_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/* Push a structured position event to the SSE stream: event: pos / data: {"x":…,"y":…} */
void web_pos_event(float x, float y);
