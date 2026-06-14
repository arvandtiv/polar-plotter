#include "tmc5072.h"
#include "hardware/spi.h"
#include "hardware/gpio.h"
#include "pico/stdlib.h"
#include "FreeRTOS.h"
#include "task.h"
#include <math.h>
#include <string.h>
#include <stdio.h>

static inline float vfs_of(bool vsense_high) { return vsense_high ? 0.180f : 0.325f; }

/* Low-level 40-bit SPI transfer with manual CS.
 * The TMC5072 uses SPI mode 3 (CPOL=1, CPHA=1), MSB-first, 40-bit datagrams.
 * The Pico SPI peripheral operates on 8-bit words, so we send 5 bytes. CS is
 * driven manually because we need it to go HIGH between the two transfers of a
 * two-phase read (each 40-bit transaction is CS-low → 5 bytes → CS-high). */
static void spi_xfer(tmc5072_t *dev, const uint8_t *tx, uint8_t *rx, size_t len)
{
    gpio_put(dev->pin_csn, 0);
    busy_wait_us_32(1);   /* CS setup time — TMC needs ~1 µs after CS↓ before first clock */
    if (rx)
        spi_write_read_blocking(dev->spi_inst, tx, rx, len);
    else
        spi_write_blocking(dev->spi_inst, tx, len);
    gpio_put(dev->pin_csn, 1);
    busy_wait_us_32(2);   /* CS inter-frame hold: without this the two-phase read returns 0x00 on data bytes */
}

bool tmc5072_init(tmc5072_t *dev, const tmc5072_config_t *cfg)
{
    memset(dev, 0, sizeof(*dev));
    dev->lock = xSemaphoreCreateMutex();
    if (!dev->lock) return false;

    dev->spi_inst     = cfg->spi_inst;
    dev->pin_csn      = cfg->pin_csn;
    dev->pin_enn      = cfg->pin_enn;
    dev->enn_on_level = cfg->enn_on_level;
    dev->r_sense      = cfg->r_sense;
    dev->vsense_high  = cfg->vsense_high;

    /* SPI bus: mode 3 (CPOL=1, CPHA=1), MSB-first, 8-bit words. */
    spi_init(dev->spi_inst, (uint)cfg->clock_hz);
    spi_set_format(dev->spi_inst, 8, SPI_CPOL_1, SPI_CPHA_1, SPI_MSB_FIRST);
    gpio_set_function(cfg->pin_sck,  GPIO_FUNC_SPI);
    gpio_set_function(cfg->pin_mosi, GPIO_FUNC_SPI);
    gpio_set_function(cfg->pin_miso, GPIO_FUNC_SPI);
    gpio_pull_up(cfg->pin_miso);   /* pull-up so MISO idles HIGH; TMC SDO overrides LOW */

    /* CS starts high (deselected). */
    gpio_init(cfg->pin_csn);
    gpio_set_dir(cfg->pin_csn, GPIO_OUT);
    gpio_put(cfg->pin_csn, 1);

    /* ENN: start disabled (motors freewheel until configured). */
    gpio_init(cfg->pin_enn);
    gpio_set_dir(cfg->pin_enn, GPIO_OUT);
    gpio_put(cfg->pin_enn, cfg->enn_on_level ? 0 : 1);   /* disabled = opposite of on-level */

    /* Clear the power-on reset flag. */
    tmc5072_read(dev, TMC5072_GSTAT, NULL);
    tmc5072_write(dev, TMC5072_GCONF, 0x00000000);

    printf("[tmc5072] init ok (SPI %d Hz, R_sense=%.3f, vsense_hi=%d)\n",
           cfg->clock_hz, (double)cfg->r_sense, cfg->vsense_high);
    return true;
}

void tmc5072_write(tmc5072_t *dev, uint8_t reg, uint32_t value)
{
    uint8_t tx[5] = {
        (uint8_t)(reg | TMC5072_WRITE_BIT),
        (uint8_t)(value >> 24),
        (uint8_t)(value >> 16),
        (uint8_t)(value >> 8),
        (uint8_t)(value),
    };
    xSemaphoreTake(dev->lock, portMAX_DELAY);
    spi_xfer(dev, tx, NULL, 5);
    xSemaphoreGive(dev->lock);
}

uint32_t tmc5072_read(tmc5072_t *dev, uint8_t reg, uint8_t *status)
{
    uint8_t tx[5] = { (uint8_t)(reg & 0x7F), 0, 0, 0, 0 };
    uint8_t rx[5] = {0};

    /* Two-phase read: first transfer latches the address (data returned is stale),
     * second transfer returns the actual register content.  Both must run back-to-
     * back under the lock.  CS must go HIGH between them (ends each transaction). */
    xSemaphoreTake(dev->lock, portMAX_DELAY);
    spi_xfer(dev, tx, rx, 5);   /* phase 1: latch address */
    spi_xfer(dev, tx, rx, 5);   /* phase 2: read data     */
    xSemaphoreGive(dev->lock);

    if (status) *status = rx[0];
    return ((uint32_t)rx[1] << 24) | ((uint32_t)rx[2] << 16) |
           ((uint32_t)rx[3] << 8)  |  (uint32_t)rx[4];
}

void tmc5072_enable(tmc5072_t *dev, bool en)
{
    gpio_put(dev->pin_enn, en ? dev->enn_on_level : !dev->enn_on_level);
}

void tmc5072_config_motor(tmc5072_t *dev, int m)
{
    uint32_t chop = 0x000100C3;   /* spreadCycle, TOFF=3, 256 µsteps */
    if (dev->vsense_high) chop |= (1u << 17);
    dev->chopconf[m] = chop;
    tmc5072_write(dev, TMC5072_CHOPCONF(m), chop);

    tmc5072_set_current_cs(dev, m, 10, 4, 6);

    dev->base_ramp = (tmc5072_ramp_t){
        .vstart = 0,    .a1   = 1000,   .v1   = 50000, .amax  = 500,
        .vmax   = 200000, .dmax = 700,  .d1   = 1400,  .vstop = 10,
    };
    tmc5072_set_ramp_scale(dev, m, 1.0f);
    tmc5072_write(dev, TMC5072_TZEROWAIT(m), 0);
    tmc5072_write(dev, TMC5072_RAMPMODE(m),  0);
}

uint8_t tmc5072_ma_to_cs(float run_ma, float r_sense, bool vsense_high)
{
    float vfs = vfs_of(vsense_high);
    int cs = (int)lroundf((run_ma / 1000.0f) * 1.41421356f * 32.0f *
                          (r_sense + 0.02f) / vfs) - 1;
    if (cs < 0)  cs = 0;
    if (cs > 31) cs = 31;
    return (uint8_t)cs;
}

float tmc5072_cs_to_ma(uint8_t cs, float r_sense, bool vsense_high)
{
    float vfs = vfs_of(vsense_high);
    return ((cs + 1) / 32.0f) * vfs / (r_sense + 0.02f) / 1.41421356f * 1000.0f;
}

void tmc5072_set_current_cs(tmc5072_t *dev, int m, uint8_t irun, uint8_t ihold, uint8_t ihold_delay)
{
    uint32_t v = ((uint32_t)(ihold_delay & 0x0F) << 16) |
                 ((uint32_t)(irun & 0x1F) << 8) |
                  (uint32_t)(ihold & 0x1F);
    dev->ihold_irun[m] = v;
    tmc5072_write(dev, TMC5072_IHOLD_IRUN(m), v);
}

void tmc5072_set_current_ma(tmc5072_t *dev, int m, float run_ma, float hold_ma)
{
    uint8_t irun  = tmc5072_ma_to_cs(run_ma,  dev->r_sense, dev->vsense_high);
    uint8_t ihold = tmc5072_ma_to_cs(hold_ma, dev->r_sense, dev->vsense_high);
    tmc5072_set_current_cs(dev, m, irun, ihold, 6);
}

uint32_t tmc5072_get_ihold_irun(tmc5072_t *dev, int motor)
{
    return dev->ihold_irun[motor];
}

void tmc5072_set_vmax(tmc5072_t *dev, int m, uint32_t vmax)
{
    dev->base_ramp.vmax = vmax;
    tmc5072_set_ramp_scale(dev, m, 1.0f);
}

void tmc5072_set_accel(tmc5072_t *dev, int m, uint32_t amax_dmax)
{
    dev->base_ramp.amax = amax_dmax;
    dev->base_ramp.dmax = amax_dmax;
    dev->base_ramp.a1   = amax_dmax * 2;
    dev->base_ramp.d1   = amax_dmax * 14 / 5;
    tmc5072_set_ramp_scale(dev, m, 1.0f);
}

static uint32_t ramp_scl(uint32_t base, float scale, uint32_t floor_val)
{
    long x = lroundf((float)base * scale);
    if (x < (long)floor_val) x = (long)floor_val;
    return (uint32_t)x;
}

void tmc5072_set_ramp_scale(tmc5072_t *dev, int m, float scale)
{
    const tmc5072_ramp_t *r = &dev->base_ramp;
    tmc5072_write(dev, TMC5072_VSTART(m), ramp_scl(r->vstart, scale, 0));
    tmc5072_write(dev, TMC5072_A1(m),     ramp_scl(r->a1,     scale, 1));
    tmc5072_write(dev, TMC5072_V1(m),     ramp_scl(r->v1,     scale, 1));
    tmc5072_write(dev, TMC5072_AMAX(m),   ramp_scl(r->amax,   scale, 1));
    tmc5072_write(dev, TMC5072_VMAX(m),   ramp_scl(r->vmax,   scale, 1));
    tmc5072_write(dev, TMC5072_DMAX(m),   ramp_scl(r->dmax,   scale, 1));
    tmc5072_write(dev, TMC5072_D1(m),     ramp_scl(r->d1,     scale, 1));
    tmc5072_write(dev, TMC5072_VSTOP(m),  ramp_scl(r->vstop,  scale, 1));
    dev->applied_scale[m] = scale;
}

void tmc5072_move_scaled_from(tmc5072_t *dev, int32_t t0, int32_t t1,
                               int32_t from0, int32_t from1)
{
    int32_t d0 = t0 - from0; if (d0 < 0) d0 = -d0;
    int32_t d1 = t1 - from1; if (d1 < 0) d1 = -d1;
    int32_t dlong = (d0 > d1) ? d0 : d1;

    if (dlong > 0) {
        float s0 = (float)d0 / (float)dlong;
        float s1 = (float)d1 / (float)dlong;
        if (fabsf(s0 - dev->applied_scale[0]) > 0.002f) tmc5072_set_ramp_scale(dev, 0, s0);
        if (fabsf(s1 - dev->applied_scale[1]) > 0.002f) tmc5072_set_ramp_scale(dev, 1, s1);
    }

    tmc5072_write(dev, TMC5072_RAMPMODE(0), 0);
    tmc5072_write(dev, TMC5072_RAMPMODE(1), 0);
    tmc5072_write(dev, TMC5072_XTARGET(0), (uint32_t)t0);
    tmc5072_write(dev, TMC5072_XTARGET(1), (uint32_t)t1);
}

void tmc5072_move_coordinated(tmc5072_t *dev, int32_t t0, int32_t t1)
{
    int32_t p0 = (int32_t)tmc5072_read(dev, TMC5072_XACTUAL(0), NULL);
    int32_t p1 = (int32_t)tmc5072_read(dev, TMC5072_XACTUAL(1), NULL);
    tmc5072_move_scaled_from(dev, t0, t1, p0, p1);
}

void tmc5072_move_rate_matched(tmc5072_t *dev, int32_t t0, int32_t t1,
                                int32_t from0, int32_t from1)
{
    int32_t d0 = t0 - from0; if (d0 < 0) d0 = -d0;
    int32_t d1 = t1 - from1; if (d1 < 0) d1 = -d1;
    int32_t dlong = (d0 > d1) ? d0 : d1;
    if (dlong > 0) {
        uint32_t v0 = ramp_scl(dev->base_ramp.vmax, (float)d0 / (float)dlong, 1);
        uint32_t v1 = ramp_scl(dev->base_ramp.vmax, (float)d1 / (float)dlong, 1);
        tmc5072_write(dev, TMC5072_VMAX(0), v0);
        tmc5072_write(dev, TMC5072_VMAX(1), v1);
        dev->applied_scale[0] = -1.0f;
        dev->applied_scale[1] = -1.0f;
    }
    tmc5072_write(dev, TMC5072_XTARGET(0), (uint32_t)t0);
    tmc5072_write(dev, TMC5072_XTARGET(1), (uint32_t)t1);
}

void tmc5072_move_to(tmc5072_t *dev, int motor, int32_t position)
{
    tmc5072_write(dev, TMC5072_RAMPMODE(motor), 0);
    tmc5072_write(dev, TMC5072_XTARGET(motor), (uint32_t)position);
}

int32_t tmc5072_position(tmc5072_t *dev, int motor)
{
    return (int32_t)tmc5072_read(dev, TMC5072_XACTUAL(motor), NULL);
}

bool tmc5072_position_reached(tmc5072_t *dev, int motor)
{
    return (tmc5072_read(dev, TMC5072_RAMP_STAT(motor), NULL) & TMC5072_RS_POSITION_REACH) != 0;
}

uint32_t tmc5072_ramp_status(tmc5072_t *dev, int motor)
{
    return tmc5072_read(dev, TMC5072_RAMP_STAT(motor), NULL);
}

uint32_t tmc5072_drv_status(tmc5072_t *dev, int motor)
{
    return tmc5072_read(dev, TMC5072_DRV_STATUS(motor), NULL);
}

void tmc5072_move_velocity(tmc5072_t *dev, int m, int32_t velocity, uint32_t amax)
{
    uint32_t vmag = (velocity < 0) ? (uint32_t)(-velocity) : (uint32_t)velocity;
    tmc5072_write(dev, TMC5072_AMAX(m), amax ? amax : 1);
    tmc5072_write(dev, TMC5072_VMAX(m), vmag);
    tmc5072_write(dev, TMC5072_RAMPMODE(m), (velocity < 0) ? 2 : 1);
    dev->applied_scale[m] = -1.0f;
}

void tmc5072_stop(tmc5072_t *dev, int m)
{
    tmc5072_write(dev, TMC5072_VMAX(m), 0);
}

bool tmc5072_home_stallguard(tmc5072_t *dev, int m, int32_t velocity,
                              uint32_t amax, int sgt, int timeout_ms)
{
    tmc5072_write(dev, TMC5072_COOLCONF(m), TMC5072_COOLCONF_SGT(sgt) | TMC5072_COOLCONF_SFILT);
    tmc5072_write(dev, TMC5072_VCOOLTHRS(m), 1);
    tmc5072_write(dev, TMC5072_SW_MODE(m), TMC5072_SW_SG_STOP);

    tmc5072_read(dev, TMC5072_RAMP_STAT(m), NULL);   /* clear stale latched events */
    tmc5072_move_velocity(dev, m, velocity, amax);

    int waited = 0;
    bool stalled = false;
    while (waited < timeout_ms) {
        vTaskDelay(pdMS_TO_TICKS(10));
        waited += 10;
        if (tmc5072_read(dev, TMC5072_RAMP_STAT(m), NULL) & TMC5072_RS_EVENT_STOP_SG) {
            stalled = true;
            break;
        }
    }

    tmc5072_write(dev, TMC5072_SW_MODE(m), 0);
    tmc5072_write(dev, TMC5072_VMAX(m), 0);
    tmc5072_write(dev, TMC5072_RAMPMODE(m), 0);
    if (stalled) {
        tmc5072_write(dev, TMC5072_XACTUAL(m), 0);
        tmc5072_write(dev, TMC5072_XTARGET(m), 0);
    }
    return stalled;
}
