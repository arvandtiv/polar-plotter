#pragma once
#include <stdint.h>

/* SG90 servo driver built on the RP2350 hardware PWM peripheral.
 * 50 Hz (20 ms period); pulse width 500–2500 µs maps to 0–180°.
 * The GPIO number is stored at init and used by every subsequent call. */

void servo_init(int gpio);
void servo_write_us(uint32_t microseconds);
void servo_write_deg(float degrees);
