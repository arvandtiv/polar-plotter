#pragma once
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

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
} wcmd_type_t;

typedef struct {
    wcmd_type_t type;
    float p[8];   /* cx, cy, r/size/x1/y1, cycles, fill, hatch_angle, hatch_spacing, deg */
} wcmd_t;

/* Queue shared between web_server.c (producer) and web_draw_task in main.c (consumer). */
extern QueueHandle_t g_draw_queue;

esp_err_t web_server_start(void);

/* Push a formatted log line to the SSE event stream (called from web_draw_task). */
void web_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
