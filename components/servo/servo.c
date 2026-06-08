#include "servo.h"
#include "driver/ledc.h"

#define SERVO_MODE        LEDC_LOW_SPEED_MODE
#define SERVO_TIMER       LEDC_TIMER_0
#define SERVO_RES_BITS    LEDC_TIMER_14_BIT     /* 16384 ticks per period */
#define SERVO_FREQ_HZ     50                    /* 20 ms period */
#define SERVO_PERIOD_US   20000
#define SERVO_TICKS_MAX   (1u << 14)

static int s_channel;

static uint32_t us_to_duty(uint32_t us)
{
    if (us > SERVO_PERIOD_US) us = SERVO_PERIOD_US;
    return (uint32_t)(((uint64_t)us * SERVO_TICKS_MAX) / SERVO_PERIOD_US);
}

esp_err_t servo_init(int gpio, int channel)
{
    ledc_timer_config_t timer = {
        .speed_mode      = SERVO_MODE,
        .duty_resolution = SERVO_RES_BITS,
        .timer_num       = SERVO_TIMER,
        .freq_hz         = SERVO_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    esp_err_t err = ledc_timer_config(&timer);
    if (err != ESP_OK) return err;

    ledc_channel_config_t ch = {
        .gpio_num   = gpio,
        .speed_mode = SERVO_MODE,
        .channel    = channel,
        .timer_sel  = SERVO_TIMER,
        .duty       = 0,
        .hpoint     = 0,
    };
    err = ledc_channel_config(&ch);
    if (err != ESP_OK) return err;

    s_channel = channel;
    return ESP_OK;
}

void servo_write_us(uint32_t microseconds)
{
    ledc_set_duty(SERVO_MODE, s_channel, us_to_duty(microseconds));
    ledc_update_duty(SERVO_MODE, s_channel);
}

void servo_write_deg(float degrees)
{
    if (degrees < 0.0f)   degrees = 0.0f;
    if (degrees > 180.0f) degrees = 180.0f;
    servo_write_us(500u + (uint32_t)(degrees / 180.0f * 2000.0f));
}
