#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "driver/spi_master.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

/* ============================================================================
 *  TMC5072 register map  (datasheet Rev 1.23, section 6)
 *  - All registers reset to 0 on power-up unless noted.
 *  - For WRITE access, OR the address with 0x80 (TMC5072_WRITE_BIT).
 *  - The TMC5072 is a DUAL controller: most registers exist once per motor.
 *    Per-motor macros take m = 0 (driver 1) or m = 1 (driver 2). The address
 *    offset between motors differs per register group, so each group encodes
 *    its own stride.
 * ========================================================================== */
#define TMC5072_WRITE_BIT     0x80

/* --- General configuration (single instance, 0x00..0x0F) --- */
#define TMC5072_GCONF         0x00  /* RW  global config (bit0 single_driver, bit8/9 shaft1/2) */
#define TMC5072_GSTAT         0x01  /* R+C global status (bit0 reset, bit1/2 drv_err, bit3 uv_cp) */
#define TMC5072_IFCNT         0x02  /* R   UART frame counter (unused in SPI) */
#define TMC5072_SLAVECONF     0x03  /* W   UART slave address / send delay */
#define TMC5072_INPUT         0x04  /* R   input pin states + VERSION (bits31..24, =0x10) */
#define TMC5072_OUTPUT        0x04  /* W   output pin states / direction */
#define TMC5072_X_COMPARE     0x05  /* W   position compare for motor 1 */

/* --- Voltage PWM / stealthChop (M1 0x10..0x17, M2 0x18..0x1F) --- */
#define TMC5072_PWMCONF(m)    (0x10 + (m) * 0x08)  /* W */
#define TMC5072_PWM_STATUS(m) (0x11 + (m) * 0x08)  /* R */

/* --- Ramp generator motion control (M1 0x20..0x2D, M2 0x40..0x4D) --- */
#define TMC5072_RAMPMODE(m)   (0x20 + (m) * 0x20)  /* RW 0=pos 1=vel+ 2=vel- 3=hold */
#define TMC5072_XACTUAL(m)    (0x21 + (m) * 0x20)  /* RW actual position (signed) */
#define TMC5072_VACTUAL(m)    (0x22 + (m) * 0x20)  /* R  actual velocity (signed) */
#define TMC5072_VSTART(m)     (0x23 + (m) * 0x20)  /* W  start velocity */
#define TMC5072_A1(m)         (0x24 + (m) * 0x20)  /* W  first acceleration */
#define TMC5072_V1(m)         (0x25 + (m) * 0x20)  /* W  accel threshold velocity */
#define TMC5072_AMAX(m)       (0x26 + (m) * 0x20)  /* W  max acceleration */
#define TMC5072_VMAX(m)       (0x27 + (m) * 0x20)  /* W  max/target velocity */
#define TMC5072_DMAX(m)       (0x28 + (m) * 0x20)  /* W  max deceleration */
#define TMC5072_D1(m)         (0x2A + (m) * 0x20)  /* W  decel from V1 (never 0!) */
#define TMC5072_VSTOP(m)      (0x2B + (m) * 0x20)  /* W  stop velocity (>= VSTART, never 0!) */
#define TMC5072_TZEROWAIT(m)  (0x2C + (m) * 0x20)  /* W  wait at zero crossing */
#define TMC5072_XTARGET(m)    (0x2D + (m) * 0x20)  /* RW target position (write triggers move) */

/* --- Ramp / driver feature control (M1 0x30..0x36, M2 0x50..0x56) --- */
#define TMC5072_IHOLD_IRUN(m) (0x30 + (m) * 0x20)  /* W  IHOLD[4:0] IRUN[12:8] IHOLDDELAY[19:16] */
#define TMC5072_VCOOLTHRS(m)  (0x31 + (m) * 0x20)  /* W  coolStep/stallGuard lower velocity */
#define TMC5072_VHIGH(m)      (0x32 + (m) * 0x20)  /* W  high-velocity switching */
#define TMC5072_VDCMIN(m)     (0x33 + (m) * 0x20)  /* W  dcStep minimum velocity */
#define TMC5072_SW_MODE(m)    (0x34 + (m) * 0x20)  /* RW reference switch / sg_stop config */
#define TMC5072_RAMP_STAT(m)  (0x35 + (m) * 0x20)  /* R+C ramp + switch event status */
#define TMC5072_XLATCH(m)     (0x36 + (m) * 0x20)  /* R  latched position */

/* --- Motor driver registers (M1 0x6A..0x6F, M2 0x7A..0x7F) --- */
#define TMC5072_MSCNT(m)      (0x6A + (m) * 0x10)  /* R   microstep counter */
#define TMC5072_MSCURACT(m)   (0x6B + (m) * 0x10)  /* R   actual microstep current A/B */
#define TMC5072_CHOPCONF(m)   (0x6C + (m) * 0x10)  /* RW  chopper / MRES / TOFF (TOFF>0 enables driver) */
#define TMC5072_COOLCONF(m)   (0x6D + (m) * 0x10)  /* W   coolStep + stallGuard2 (SGT) */
#define TMC5072_DCCTRL(m)     (0x6E + (m) * 0x10)  /* W   dcStep control */
#define TMC5072_DRV_STATUS(m) (0x6F + (m) * 0x10)  /* R   stallGuard2 result + error flags */

/* --- Selected register bit fields (verified against Trinamic TMC-API) ------- */
/* RAMP_STAT (0x35/0x55), read+clear-on-read status of the ramp generator. */
#define TMC5072_RS_EVENT_STOP_SG   (1u << 6)   /* stallGuard stop event (latched) */
#define TMC5072_RS_EVENT_POS_REACH (1u << 7)   /* XTARGET reached event (latched) */
#define TMC5072_RS_VELOCITY_REACH  (1u << 8)   /* VACTUAL == VMAX (live) */
#define TMC5072_RS_POSITION_REACH  (1u << 9)   /* XACTUAL == XTARGET (live) */

/* SW_MODE (0x34/0x54), reference-switch / stallGuard-stop configuration. */
#define TMC5072_SW_STOP_L_ENABLE   (1u << 0)   /* enable left reference switch stop */
#define TMC5072_SW_SG_STOP         (1u << 10)  /* enable stallGuard2 stop (sensorless) */
#define TMC5072_SW_EN_SOFTSTOP     (1u << 11)  /* 1 = soft (ramped) stop, 0 = hard stop */

/* COOLCONF (0x6D/0x7D): stallGuard2 threshold SGT is a 7-bit SIGNED value. */
#define TMC5072_COOLCONF_SGT(v)    (((uint32_t)((int32_t)(v) & 0x7F)) << 16)
#define TMC5072_COOLCONF_SFILT     (1u << 24)  /* stallGuard filter (more accurate, slower) */

typedef struct {
    spi_host_device_t host;
    int   pin_sck;
    int   pin_mosi;
    int   pin_miso;
    int   pin_csn;
    int   pin_enn;
    int   clock_hz;
    int   enn_on_level;   /* GPIO level that ENABLES the driver (after the optocoupler) */
    float r_sense;        /* sense resistor on the BOB, ohms (for mA <-> CS conversion) */
    bool  vsense_high;    /* CHOPCONF vsense: false=0.325V (range), true=0.180V (resolution) */
} tmc5072_config_t;

/* sixPoint ramp profile, in the TMC5072's internal microstep velocity/accel
 * units. This is the "master" profile both motors run at full speed. A
 * coordinated move scales a copy of it down for the shorter-travel motor (see
 * tmc5072_move_coordinated) so the two ramps are geometrically similar and
 * therefore take the same total time. */
typedef struct {
    uint32_t vstart, a1, v1, amax, vmax, dmax, d1, vstop;
} tmc5072_ramp_t;

typedef struct {
    spi_device_handle_t spi;
    int      pin_enn;
    int      enn_on_level;
    float    r_sense;
    bool     vsense_high;
    uint32_t chopconf[2];    /* shadow of last CHOPCONF written, per motor */
    uint32_t ihold_irun[2];  /* shadow of IHOLD_IRUN (write-only on the 5072) */
    tmc5072_ramp_t base_ramp;   /* master profile (shared; both motors identical) */
    float    applied_scale[2];  /* ramp scale currently written to each motor */
    /* Guards each SPI transaction (incl. the two-phase read's transfer pair) so
     * that concurrent callers -- e.g. the console task and a network listener
     * task -- can't interleave on the bus and corrupt a 40-bit datagram. */
    SemaphoreHandle_t lock;
} tmc5072_t;

/* Brings up the SPI bus + device and the ENN GPIO (driver left disabled). */
esp_err_t tmc5072_init(tmc5072_t *dev, const tmc5072_config_t *cfg);

/* 40-bit SPI access. read() returns the 32-bit payload; *status (may be NULL)
 * receives the SPI status byte. */
esp_err_t tmc5072_write(tmc5072_t *dev, uint8_t reg, uint32_t value);
uint32_t  tmc5072_read(tmc5072_t *dev, uint8_t reg, uint8_t *status);

/* Drives ENN. en=true -> enn_on_level, en=false -> motors freewheel. */
void tmc5072_enable(tmc5072_t *dev, bool en);

/* Loads a spreadCycle chopper + sixPoint positioning ramp for one motor and a
 * conservative default current. Call set_current/set_vmax afterwards to tune. */
esp_err_t tmc5072_config_motor(tmc5072_t *dev, int motor);

/* --- Current control --- */
/* Convert between motor RMS current (mA) and the 5-bit current scale (0..31),
 * given the sense resistor and vsense selection. Pure helpers. */
uint8_t tmc5072_ma_to_cs(float run_ma, float r_sense, bool vsense_high);
float   tmc5072_cs_to_ma(uint8_t cs, float r_sense, bool vsense_high);
/* Set run/hold current directly (CS 0..31) or in milliamps (uses dev->r_sense). */
esp_err_t tmc5072_set_current_cs(tmc5072_t *dev, int motor, uint8_t irun, uint8_t ihold, uint8_t ihold_delay);
esp_err_t tmc5072_set_current_ma(tmc5072_t *dev, int motor, float run_ma, float hold_ma);

/* Last IHOLD_IRUN written to this motor (the register itself is write-only). */
uint32_t tmc5072_get_ihold_irun(tmc5072_t *dev, int motor);

/* --- Motion --- */
esp_err_t tmc5072_set_vmax(tmc5072_t *dev, int motor, uint32_t vmax);
/* Sets the ramp acceleration. Updates AMAX/DMAX (the >V1 ramp phase) AND scales
 * the sub-V1 legs A1/D1 by the same default ratio, so the setting governs the
 * WHOLE ramp — short streamed goto/line sub-segments live below V1 and would
 * otherwise ignore it (they'd always use the fixed A1). At the default accel the
 * resulting profile is identical to the original tuning. */
esp_err_t tmc5072_set_accel(tmc5072_t *dev, int motor, uint32_t amax_dmax);

/* Re-write one motor's ramp registers as the base profile scaled by `scale`
 * (1.0 = full speed). Scaling every velocity/accel value by the same factor
 * keeps the ramp shape similar, so move duration scales with distance.
 * Independent (single-motor) moves should call this with 1.0 first to undo any
 * down-scaling a previous coordinated move left behind. */
void tmc5072_set_ramp_scale(tmc5072_t *dev, int motor, float scale);

/* Coordinated absolute move of both motors that finishes simultaneously: sizes
 * each motor's travel (target - current XACTUAL), scales the shorter motor's
 * ramp by its distance ratio so both ramps take the same time, then writes both
 * XTARGETs back-to-back. The integrated ramp generators then run in parallel,
 * autonomously, with no further ESP32 involvement.
 * PRECONDITION: both motors at standstill (it rewrites ramp registers) -- call
 * only after the previous move has reached its target. */
esp_err_t tmc5072_move_coordinated(tmc5072_t *dev, int32_t target0, int32_t target1);

esp_err_t tmc5072_move_to(tmc5072_t *dev, int motor, int32_t position);
int32_t   tmc5072_position(tmc5072_t *dev, int motor);
bool      tmc5072_position_reached(tmc5072_t *dev, int motor);
uint32_t  tmc5072_drv_status(tmc5072_t *dev, int motor);

/* Read the ramp generator's status word (RAMP_STAT). NOTE: this register is
 * clear-on-read for its latched event bits, so reading it acknowledges them. */
uint32_t  tmc5072_ramp_status(tmc5072_t *dev, int motor);

/* --- Velocity mode (RAMPMODE 1/2): run continuously at a target velocity ----
 * Useful for jogging during calibration and for sensorless homing. `velocity`
 * sign sets direction (RAMPMODE 1 = positive, 2 = negative); `amax` is the
 * acceleration ramp used to reach it. tmc5072_stop() ramps back to v=0. After
 * stopping, call any position move (tmc5072_move_to / _move_coordinated) to
 * return to positioning mode. */
esp_err_t tmc5072_move_velocity(tmc5072_t *dev, int motor, int32_t velocity, uint32_t amax);
esp_err_t tmc5072_stop(tmc5072_t *dev, int motor);

/* --- stallGuard2 sensorless homing (EXPERIMENTAL — needs SGT tuning on real
 * hardware before trusting it; see the .c body). Drives the motor at `velocity`
 * until the belt stalls (stallGuard2 trips), then zeroes XACTUAL at the stop.
 * `sgt` is the stall threshold (-64..63; higher = less sensitive). Returns
 * ESP_OK on a detected stall, ESP_ERR_TIMEOUT if none seen within timeout_ms.
 * Restores positioning mode (RAMPMODE 0) before returning. */
esp_err_t tmc5072_home_stallguard(tmc5072_t *dev, int motor, int32_t velocity,
                                  uint32_t amax, int sgt, int timeout_ms);
