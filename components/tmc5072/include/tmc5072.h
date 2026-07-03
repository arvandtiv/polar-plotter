#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "hardware/spi.h"
#include "FreeRTOS.h"
#include "semphr.h"

/* ============================================================================
 *  TMC5072 register map  (datasheet Rev 1.23, section 6)
 *  Unchanged from the ESP32 port — this is purely the chip protocol.
 * ========================================================================== */
#define TMC5072_WRITE_BIT     0x80

/* --- General configuration (single instance, 0x00..0x0F) --- */
#define TMC5072_GCONF         0x00
#define TMC5072_GSTAT         0x01
#define TMC5072_IFCNT         0x02
#define TMC5072_SLAVECONF     0x03
#define TMC5072_INPUT         0x04
#define TMC5072_OUTPUT        0x04
#define TMC5072_X_COMPARE     0x05

/* --- Voltage PWM / stealthChop (M1 0x10..0x17, M2 0x18..0x1F) --- */
#define TMC5072_PWMCONF(m)    (0x10 + (m) * 0x08)
#define TMC5072_PWM_STATUS(m) (0x11 + (m) * 0x08)

/* --- Ramp generator motion control (M1 0x20..0x2D, M2 0x40..0x4D) --- */
#define TMC5072_RAMPMODE(m)   (0x20 + (m) * 0x20)
#define TMC5072_XACTUAL(m)    (0x21 + (m) * 0x20)
#define TMC5072_VACTUAL(m)    (0x22 + (m) * 0x20)
#define TMC5072_VSTART(m)     (0x23 + (m) * 0x20)
#define TMC5072_A1(m)         (0x24 + (m) * 0x20)
#define TMC5072_V1(m)         (0x25 + (m) * 0x20)
#define TMC5072_AMAX(m)       (0x26 + (m) * 0x20)
#define TMC5072_VMAX(m)       (0x27 + (m) * 0x20)
#define TMC5072_DMAX(m)       (0x28 + (m) * 0x20)
#define TMC5072_D1(m)         (0x2A + (m) * 0x20)
#define TMC5072_VSTOP(m)      (0x2B + (m) * 0x20)
#define TMC5072_TZEROWAIT(m)  (0x2C + (m) * 0x20)
#define TMC5072_XTARGET(m)    (0x2D + (m) * 0x20)

/* --- Ramp / driver feature control (M1 0x30..0x36, M2 0x50..0x56) --- */
#define TMC5072_IHOLD_IRUN(m) (0x30 + (m) * 0x20)
#define TMC5072_VCOOLTHRS(m)  (0x31 + (m) * 0x20)
#define TMC5072_VHIGH(m)      (0x32 + (m) * 0x20)
#define TMC5072_VDCMIN(m)     (0x33 + (m) * 0x20)
#define TMC5072_SW_MODE(m)    (0x34 + (m) * 0x20)
#define TMC5072_RAMP_STAT(m)  (0x35 + (m) * 0x20)
#define TMC5072_XLATCH(m)     (0x36 + (m) * 0x20)

/* --- Motor driver registers (M1 0x6A..0x6F, M2 0x7A..0x7F) --- */
#define TMC5072_MSCNT(m)      (0x6A + (m) * 0x10)
#define TMC5072_MSCURACT(m)   (0x6B + (m) * 0x10)
#define TMC5072_CHOPCONF(m)   (0x6C + (m) * 0x10)
#define TMC5072_COOLCONF(m)   (0x6D + (m) * 0x10)
#define TMC5072_DCCTRL(m)     (0x6E + (m) * 0x10)
#define TMC5072_DRV_STATUS(m) (0x6F + (m) * 0x10)

/* --- Selected register bit fields --- */
#define TMC5072_RS_EVENT_STOP_SG   (1u << 6)
#define TMC5072_RS_EVENT_POS_REACH (1u << 7)
#define TMC5072_RS_VELOCITY_REACH  (1u << 8)
#define TMC5072_RS_POSITION_REACH  (1u << 9)

#define TMC5072_SW_STOP_L_ENABLE   (1u << 0)
#define TMC5072_SW_SG_STOP         (1u << 10)
#define TMC5072_SW_EN_SOFTSTOP     (1u << 11)

#define TMC5072_COOLCONF_SGT(v)    (((uint32_t)((int32_t)(v) & 0x7F)) << 16)
#define TMC5072_COOLCONF_SFILT     (1u << 24)

/* ---- Types ---- */

typedef struct {
    spi_inst_t *spi_inst;   /* spi0 or spi1 */
    int   pin_sck;
    int   pin_mosi;
    int   pin_miso;
    int   pin_csn;          /* manual chip-select GPIO (Pico SPI has no auto-CS) */
    int   pin_enn;
    int   clock_hz;
    int   enn_on_level;     /* GPIO level that ENABLES the driver (0=active-LOW) */
    float r_sense;
    bool  vsense_high;
} tmc5072_config_t;

typedef struct {
    uint32_t vstart, a1, v1, amax, vmax, dmax, d1, vstop;
} tmc5072_ramp_t;

typedef struct {
    spi_inst_t *spi_inst;
    int      pin_csn;
    int      pin_enn;
    int      enn_on_level;
    float    r_sense;
    bool     vsense_high;
    uint32_t chopconf[2];
    uint32_t ihold_irun[2];
    tmc5072_ramp_t base_ramp;
    /* Ramp SHAPE: how set_accel derives the sixPoint profile from AMAX. Live-tunable
     * (tmc5072_set_ramp_shape) so launch softness / stop hardness / the A1-vs-AMAX
     * crossover (V1) can be tuned on paper without reflashing. Defaults reproduce the
     * historical behaviour exactly (a1=2×, d1=2.8×, dmax=1×, v1=50000, vstop=10). */
    float    a1_ratio;        /* A1   = a1_ratio   × AMAX (accel below V1 — launch kick) */
    float    d1_ratio;        /* D1   = d1_ratio   × AMAX (decel below V1 — landing)     */
    float    dmax_ratio;      /* DMAX = dmax_ratio × AMAX (main decel; >1 = brisker stops) */
    uint32_t tzerowait;       /* pause at zero crossing on reversals (reduces jerk)      */
    float    applied_scale[2];
    SemaphoreHandle_t lock;
    volatile bool hard_off;   /* hardware E-STOP latch: when set, enable() is forced off */
} tmc5072_t;

/* ---- API (same logic as ESP32 port, Pico SPI layer underneath) ---- */

bool      tmc5072_init(tmc5072_t *dev, const tmc5072_config_t *cfg);
void      tmc5072_write(tmc5072_t *dev, uint8_t reg, uint32_t value);
uint32_t  tmc5072_read(tmc5072_t *dev, uint8_t reg, uint8_t *status);
void      tmc5072_enable(tmc5072_t *dev, bool en);
void      tmc5072_config_motor(tmc5072_t *dev, int motor);

uint8_t   tmc5072_ma_to_cs(float run_ma, float r_sense, bool vsense_high);
float     tmc5072_cs_to_ma(uint8_t cs, float r_sense, bool vsense_high);
void      tmc5072_set_current_cs(tmc5072_t *dev, int motor, uint8_t irun, uint8_t ihold, uint8_t ihold_delay);
void      tmc5072_set_current_ma(tmc5072_t *dev, int motor, float run_ma, float hold_ma);
uint32_t  tmc5072_get_ihold_irun(tmc5072_t *dev, int motor);

void      tmc5072_set_vmax(tmc5072_t *dev, int motor, uint32_t vmax);
void      tmc5072_set_accel(tmc5072_t *dev, int motor, uint32_t amax_dmax);
/* Set the sixPoint ramp SHAPE (both motors): a1/d1/dmax as ratios of AMAX, plus V1,
 * VSTOP and TZEROWAIT absolutes. Re-derives + re-applies the profile at the current
 * AMAX immediately. Values are floored so D1/VSTOP can never be 0 (datasheet §6.2.1). */
void      tmc5072_set_ramp_shape(tmc5072_t *dev, float a1_ratio, uint32_t v1,
                                  float dmax_ratio, float d1_ratio,
                                  uint32_t vstop, uint32_t tzerowait);
void      tmc5072_set_ramp_scale(tmc5072_t *dev, int motor, float scale);

/* Internal-oscillator unit conversions (CLK16 grounded → fCLK ≈ 13.2 MHz, datasheet):
 *   velocity: v[µsteps/s]  = reg × fCLK / 2^24
 *   accel:    a[µsteps/s²] = reg × fCLK² / 2^41                                    */
#define TMC5072_FCLK_HZ    13200000.0f
#define TMC5072_VEL_UNIT   (TMC5072_FCLK_HZ / 16777216.0f)                 /* ≈ 0.787 */
#define TMC5072_ACC_UNIT   ((TMC5072_FCLK_HZ * TMC5072_FCLK_HZ) / 2199023255552.0f) /* ≈ 79.2 */

void      tmc5072_move_coordinated(tmc5072_t *dev, int32_t target0, int32_t target1);
void      tmc5072_move_scaled_from(tmc5072_t *dev, int32_t t0, int32_t t1,
                                    int32_t from0, int32_t from1);
void      tmc5072_move_rate_matched(tmc5072_t *dev, int32_t target0, int32_t target1,
                                     int32_t from0, int32_t from1, uint32_t vmax_cap);
void      tmc5072_move_to(tmc5072_t *dev, int motor, int32_t position);
int32_t   tmc5072_position(tmc5072_t *dev, int motor);
bool      tmc5072_position_reached(tmc5072_t *dev, int motor);
uint32_t  tmc5072_drv_status(tmc5072_t *dev, int motor);
uint32_t  tmc5072_ramp_status(tmc5072_t *dev, int motor);

void      tmc5072_move_velocity(tmc5072_t *dev, int motor, int32_t velocity, uint32_t amax);
void      tmc5072_stop(tmc5072_t *dev, int motor);
bool      tmc5072_home_stallguard(tmc5072_t *dev, int motor, int32_t velocity,
                                   uint32_t amax, int sgt, int timeout_ms);
