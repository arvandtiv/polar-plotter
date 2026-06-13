#include "servo.h"
#include "hardware/pwm.h"
#include "hardware/gpio.h"
#include "hardware/clocks.h"

/* 50 Hz with a 20 000-tick period, 1 tick = 1 µs.
 * sys_clk / clkdiv / wrap = freq  →  150 000 000 / 150 / 20 000 = 50 Hz.
 * (RP2350 default sys_clk is 150 MHz.) */
#define SERVO_WRAP      19999u   /* wrap = 20 000 – 1 */
#define SERVO_CLKDIV    150.0f   /* float divider: 150 MHz / 150 = 1 µs tick */

static uint s_slice;
static uint s_channel;

void servo_init(int gpio)
{
    gpio_set_function(gpio, GPIO_FUNC_PWM);
    s_slice   = pwm_gpio_to_slice_num((uint)gpio);
    s_channel = pwm_gpio_to_channel((uint)gpio);

    pwm_config cfg = pwm_get_default_config();
    pwm_config_set_clkdiv(&cfg, SERVO_CLKDIV);
    pwm_config_set_wrap(&cfg, SERVO_WRAP);
    pwm_init(s_slice, &cfg, true);

    /* Start at neutral (1500 µs = 90°). */
    pwm_set_chan_level(s_slice, s_channel, 1500u);
}

void servo_write_us(uint32_t microseconds)
{
    if (microseconds > 20000u) microseconds = 20000u;
    pwm_set_chan_level(s_slice, s_channel, (uint16_t)microseconds);
}

void servo_write_deg(float degrees)
{
    if (degrees < 0.0f)   degrees = 0.0f;
    if (degrees > 180.0f) degrees = 180.0f;
    servo_write_us(500u + (uint32_t)(degrees / 180.0f * 2000.0f));
}
