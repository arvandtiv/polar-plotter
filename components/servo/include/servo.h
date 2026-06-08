#pragma once
#include <stdint.h>
#include "esp_err.h"

/* Minimal SG90 (50 Hz) pen-lift driver built on the LEDC peripheral.
 * channel is an ledc_channel_t value (e.g. LEDC_CHANNEL_0). */
esp_err_t servo_init(int gpio, int channel);

/* Raw pulse width in microseconds (SG90: ~500..2500 us). */
void servo_write_us(uint32_t microseconds);

/* Convenience: 0..180 degrees mapped to 500..2500 us. */
void servo_write_deg(float degrees);
