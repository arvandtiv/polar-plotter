#pragma once
#include "FreeRTOS.h"
#include "queue.h"
#include "stream_buffer.h"
#include <stdbool.h>
#include <stdint.h>

/* Drawing command types dispatched from HTTP handlers to web_draw_task. */
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
    WCMD_BORDER,
    WCMD_SETHOME,
    WCMD_BOUNDS,
    WCMD_SPEED,
    WCMD_ACCEL,
    WCMD_CURRENT,
    WCMD_WOBBLY,
    WCMD_TRUCHET,
} wcmd_type_t;

typedef struct {
    wcmd_type_t type;
    uint32_t    id;
    float p[12];
} wcmd_t;

extern QueueHandle_t g_draw_queue;

extern volatile uint32_t g_job_enqueued;
extern volatile uint32_t g_job_current;
extern volatile uint32_t g_job_done;
extern volatile bool     g_job_abort;
extern volatile bool     g_paused;
extern volatile bool     g_estop;   /* hardware E-STOP latch (set in the GPIO ISR) */
extern char              g_job_desc[128];

extern volatile uint32_t g_drv_fault;
extern char              g_drv_flags[96];

/* Implemented in main.c */
bool plotter_in_bounds(float x, float y);
void plotter_get_bounds(float *xn, float *xp, float *yn, float *yp);
bool plotter_bounds_ellipse(void);
void plotter_get_xy(float *x, float *y);
void plotter_get_motion(uint32_t *vmax, uint32_t *amax, float *run_ma, float *hold_ma);
void plotter_set_matrix(float a, float b, float c, float d, float tx, float ty);
void plotter_get_matrix(float *a, float *b, float *c, float *d, float *tx, float *ty);
bool plotter_pen_is_down(void);   /* live pen state for /api/status */
void plotter_abort_now(void);
void plotter_stop_hold(void);
void plotter_clear_fault(void);
int  plotter_estop_level(void);   /* live GP14 level: 1=HIGH/idle, 0=LOW/pressed */

/* Two-phase init: init() sets up queues/streams (call early so web_log works
 * from bring-up); listen() opens the TCP socket (call after WiFi is connected). */
void web_server_init(void);
void web_server_listen(void);

void web_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void web_pos_event(float x, float y);
