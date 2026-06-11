#include "tmc5072.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include <math.h>
#include <string.h>

static const char *TAG = "tmc5072";

static inline float vfs_of(bool vsense_high) { return vsense_high ? 0.180f : 0.325f; }

esp_err_t tmc5072_init(tmc5072_t *dev, const tmc5072_config_t *cfg)
{
    memset(dev, 0, sizeof(*dev));
    dev->lock = xSemaphoreCreateMutex();
    if (!dev->lock) return ESP_ERR_NO_MEM;
    dev->pin_enn      = cfg->pin_enn;
    dev->enn_on_level = cfg->enn_on_level;
    dev->r_sense      = cfg->r_sense;
    dev->vsense_high  = cfg->vsense_high;

    /* ENN as output, start disabled (motors freewheel until configured). */
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << cfg->pin_enn,
        .mode         = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&io));
    gpio_set_level(cfg->pin_enn, !cfg->enn_on_level);

    spi_bus_config_t bus = {
        .mosi_io_num     = cfg->pin_mosi,
        .miso_io_num     = cfg->pin_miso,
        .sclk_io_num     = cfg->pin_sck,
        .quadwp_io_num   = -1,
        .quadhd_io_num   = -1,
        .max_transfer_sz = 0,
    };
    esp_err_t err = spi_bus_initialize(cfg->host, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) return err;

    /* TMC5072 SPI is mode 3 (CPOL=1, CPHA=1), MSB first, 40-bit datagrams. */
    spi_device_interface_config_t dcfg = {
        .mode           = 3,
        .clock_speed_hz = cfg->clock_hz,
        .spics_io_num   = cfg->pin_csn,
        .queue_size     = 1,
    };
    err = spi_bus_add_device(cfg->host, &dcfg, &dev->spi);
    if (err != ESP_OK) return err;

    /* Clear the power-on reset flag and select dual-motor / internal-ramp mode. */
    tmc5072_read(dev, TMC5072_GSTAT, NULL);
    tmc5072_write(dev, TMC5072_GCONF, 0x00000000);

    ESP_LOGI(TAG, "init ok (SPI %d Hz on host %d, R_sense=%.3f, vsense_hi=%d)",
             cfg->clock_hz, cfg->host, (double)cfg->r_sense, cfg->vsense_high);
    return ESP_OK;
}

esp_err_t tmc5072_write(tmc5072_t *dev, uint8_t reg, uint32_t value)
{
    uint8_t tx[5] = {
        (uint8_t)(reg | TMC5072_WRITE_BIT),
        (uint8_t)(value >> 24),
        (uint8_t)(value >> 16),
        (uint8_t)(value >> 8),
        (uint8_t)(value),
    };
    spi_transaction_t t = { .length = 40, .tx_buffer = tx };
    xSemaphoreTake(dev->lock, portMAX_DELAY);
    esp_err_t err = spi_device_polling_transmit(dev->spi, &t);
    xSemaphoreGive(dev->lock);
    return err;
}

uint32_t tmc5072_read(tmc5072_t *dev, uint8_t reg, uint8_t *status)
{
    uint8_t tx[5] = { (uint8_t)(reg & 0x7F), 0, 0, 0, 0 };
    uint8_t rx[5] = { 0 };
    spi_transaction_t t = { .length = 40, .tx_buffer = tx, .rx_buffer = rx };

    /* First transfer latches the address; the data comes back on the second.
     * Both must run back-to-back under the lock -- otherwise another task's
     * transaction could land between them and we'd read back its reply instead. */
    xSemaphoreTake(dev->lock, portMAX_DELAY);
    spi_device_polling_transmit(dev->spi, &t);
    spi_device_polling_transmit(dev->spi, &t);
    xSemaphoreGive(dev->lock);

    if (status) *status = rx[0];
    return ((uint32_t)rx[1] << 24) | ((uint32_t)rx[2] << 16) |
           ((uint32_t)rx[3] << 8)  |  (uint32_t)rx[4];
}

void tmc5072_enable(tmc5072_t *dev, bool en)
{
    gpio_set_level(dev->pin_enn, en ? dev->enn_on_level : !dev->enn_on_level);
}

esp_err_t tmc5072_config_motor(tmc5072_t *dev, int m)
{
    /* spreadCycle chopper, native 256 microsteps (TOFF=3 -> driver enabled). */
    uint32_t chop = 0x000100C3;
    if (dev->vsense_high) chop |= (1u << 17);
    dev->chopconf[m] = chop;
    tmc5072_write(dev, TMC5072_CHOPCONF(m), chop);

    /* Conservative default current (CS: IRUN=10, IHOLD=4) until set explicitly. */
    tmc5072_set_current_cs(dev, m, 10, 4, 6);

    /* sixPoint positioning ramp — Trinamic reference profile (microstep units).
     * Held in base_ramp so coordinated moves can scale a copy of it per segment;
     * tmc5072_set_ramp_scale() writes the eight registers below. */
    dev->base_ramp = (tmc5072_ramp_t){
        .vstart = 0,    .a1   = 1000,  .v1   = 50000, .amax  = 500,
        .vmax   = 200000, .dmax = 700, .d1   = 1400,  .vstop = 10,
    };
    tmc5072_set_ramp_scale(dev, m, 1.0f);
    tmc5072_write(dev, TMC5072_TZEROWAIT(m), 0);
    tmc5072_write(dev, TMC5072_RAMPMODE(m),  0);  /* positioning mode */
    return ESP_OK;
}

/* I_rms = (CS+1)/32 * Vfs/(Rsense+0.02) / sqrt(2)  ->  solve for CS. */
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

esp_err_t tmc5072_set_current_cs(tmc5072_t *dev, int m, uint8_t irun, uint8_t ihold, uint8_t ihold_delay)
{
    uint32_t v = ((uint32_t)(ihold_delay & 0x0F) << 16) |
                 ((uint32_t)(irun & 0x1F) << 8) |
                  (uint32_t)(ihold & 0x1F);
    dev->ihold_irun[m] = v;   /* shadow: IHOLD_IRUN is write-only */
    return tmc5072_write(dev, TMC5072_IHOLD_IRUN(m), v);
}

uint32_t tmc5072_get_ihold_irun(tmc5072_t *dev, int motor)
{
    return dev->ihold_irun[motor];
}

esp_err_t tmc5072_set_current_ma(tmc5072_t *dev, int m, float run_ma, float hold_ma)
{
    uint8_t irun  = tmc5072_ma_to_cs(run_ma,  dev->r_sense, dev->vsense_high);
    uint8_t ihold = tmc5072_ma_to_cs(hold_ma, dev->r_sense, dev->vsense_high);
    return tmc5072_set_current_cs(dev, m, irun, ihold, 6);
}

esp_err_t tmc5072_set_vmax(tmc5072_t *dev, int m, uint32_t vmax)
{
    /* Update the shared master profile and re-assert it at full scale (this also
     * clears any down-scaling a coordinated move left on this motor). */
    dev->base_ramp.vmax = vmax;
    tmc5072_set_ramp_scale(dev, m, 1.0f);
    return ESP_OK;
}

esp_err_t tmc5072_set_accel(tmc5072_t *dev, int m, uint32_t amax_dmax)
{
    dev->base_ramp.amax = amax_dmax;
    dev->base_ramp.dmax = amax_dmax;
    /* Also scale the sub-V1 ramp legs. The TMC5072 6-point ramp uses A1 to
     * accelerate up to V1 and only then AMAX up to VMAX (and D1 for the final
     * V1->VSTOP decel). Short streamed goto/line sub-segments never exceed V1, so
     * touching only AMAX/DMAX left the accel knob with no effect on them. Keep the
     * original default ratios (A1 = 2*AMAX, D1 = 2.8*AMAX) so at the default accel
     * the profile is byte-identical to the previous tuning, but now the whole ramp
     * stiffens/softens with the setting. */
    dev->base_ramp.a1 = amax_dmax * 2;          /* 1000 at the 500 default */
    dev->base_ramp.d1 = amax_dmax * 14 / 5;     /* 1400 at the 500 default */
    tmc5072_set_ramp_scale(dev, m, 1.0f);
    return ESP_OK;
}

/* base value * scale, rounded, clamped to a floor (D1/VSTOP must never be 0 in
 * positioning mode, and A1/AMAX/VMAX/V1 must stay >=1 so a tiny-travel motor
 * still has a valid ramp). */
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
    tmc5072_write(dev, TMC5072_D1(m),     ramp_scl(r->d1,     scale, 1));  /* never 0 */
    tmc5072_write(dev, TMC5072_VSTOP(m),  ramp_scl(r->vstop,  scale, 1));  /* never 0 */
    dev->applied_scale[m] = scale;
}

esp_err_t tmc5072_move_coordinated(tmc5072_t *dev, int32_t t0, int32_t t1)
{
    /* Δsteps for this segment = target - current position, per motor. (Read at a
     * standstill -- see the header precondition -- so XACTUAL is the true start.) */
    int32_t p0 = (int32_t)tmc5072_read(dev, TMC5072_XACTUAL(0), NULL);
    int32_t p1 = (int32_t)tmc5072_read(dev, TMC5072_XACTUAL(1), NULL);
    int32_t d0 = t0 - p0; if (d0 < 0) d0 = -d0;
    int32_t d1 = t1 - p1; if (d1 < 0) d1 = -d1;
    int32_t dlong = (d0 > d1) ? d0 : d1;

    /* The longer-travel motor runs the full master ramp (= the move's duration T);
     * the shorter one gets that same ramp scaled by its distance ratio, so its
     * (smaller) travel takes the identical T. Geometrically similar ramps ->
     * equal time, with no explicit T computation. Re-scale a motor only when its
     * ratio actually changed, to hold per-segment SPI traffic to ~8 writes. */
    if (dlong > 0) {
        float s0 = (float)d0 / (float)dlong;
        float s1 = (float)d1 / (float)dlong;
        if (fabsf(s0 - dev->applied_scale[0]) > 0.002f) tmc5072_set_ramp_scale(dev, 0, s0);
        if (fabsf(s1 - dev->applied_scale[1]) > 0.002f) tmc5072_set_ramp_scale(dev, 1, s1);
    }

    /* Ensure both axes are in positioning mode (a prior jog/stop/stallGuard home
     * may have left velocity mode, where XTARGET is ignored), then write the two
     * targets back-to-back: both ramp generators latch and start within one SPI
     * frame of each other and ramp to target in parallel on their own. */
    tmc5072_write(dev, TMC5072_RAMPMODE(0), 0);
    tmc5072_write(dev, TMC5072_RAMPMODE(1), 0);
    tmc5072_write(dev, TMC5072_XTARGET(0), (uint32_t)t0);
    tmc5072_write(dev, TMC5072_XTARGET(1), (uint32_t)t1);
    return ESP_OK;
}

esp_err_t tmc5072_move_to(tmc5072_t *dev, int motor, int32_t position)
{
    /* Force positioning mode: a prior jog/stop or stallGuard home may have left
     * RAMPMODE in velocity mode (1/2), in which XTARGET is ignored. */
    tmc5072_write(dev, TMC5072_RAMPMODE(motor), 0);
    return tmc5072_write(dev, TMC5072_XTARGET(motor), (uint32_t)position);
}

int32_t tmc5072_position(tmc5072_t *dev, int motor)
{
    return (int32_t)tmc5072_read(dev, TMC5072_XACTUAL(motor), NULL);
}

bool tmc5072_position_reached(tmc5072_t *dev, int motor)
{
    /* Use the ramp generator's own live position_reached flag (RAMP_STAT bit 9)
     * rather than comparing XACTUAL to XTARGET ourselves: one SPI read instead of
     * two, and it is the chip's definitive "ramp finished" signal. (RAMP_STAT's
     * latched *event* bits are clear-on-read, but bit 9 is a live status bit, so
     * reading it here does not disturb anything we rely on.) */
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

/* --------------------------- velocity mode + homing ------------------------- */

esp_err_t tmc5072_move_velocity(tmc5072_t *dev, int m, int32_t velocity, uint32_t amax)
{
    uint32_t vmag = (velocity < 0) ? (uint32_t)(-velocity) : (uint32_t)velocity;
    tmc5072_write(dev, TMC5072_AMAX(m), amax ? amax : 1);
    tmc5072_write(dev, TMC5072_VMAX(m), vmag);
    /* RAMPMODE 1 = velocity toward +, 2 = velocity toward -. A zero velocity in
     * mode 1 just decelerates to standstill, which is what tmc5072_stop() wants. */
    tmc5072_write(dev, TMC5072_RAMPMODE(m), (velocity < 0) ? 2 : 1);
    dev->applied_scale[m] = -1.0f;   /* ramp regs no longer match base profile */
    return ESP_OK;
}

esp_err_t tmc5072_stop(tmc5072_t *dev, int m)
{
    /* Hold direction, ramp VMAX down to 0 -> controlled decel to standstill. */
    tmc5072_write(dev, TMC5072_VMAX(m), 0);
    return ESP_OK;
}

esp_err_t tmc5072_home_stallguard(tmc5072_t *dev, int m, int32_t velocity,
                                  uint32_t amax, int sgt, int timeout_ms)
{
    /* stallGuard2 sensorless homing, modeled on the switch-homing pattern in
     * joshua-8/TMC5072 but using a stall event instead of a reference switch:
     *
     *   1. COOLCONF.SGT = stall threshold; SFILT on for a steadier reading.
     *   2. TCOOLTHRS/VCOOLTHRS define the velocity window where stallGuard is
     *      valid (it is meaningless below a minimum speed). We open it wide
     *      (TCOOLTHRS large) so stallGuard is active across the homing sweep.
     *   3. SW_MODE.sg_stop = 1 makes the ramp generator itself halt on a stall;
     *      en_softstop = 0 for an immediate hard stop at the obstruction.
     *   4. Run velocity mode toward the hard stop; poll RAMP_STAT.event_stop_sg.
     *   5. On stall: latch is automatic; zero XACTUAL here as the new origin.
     *
     * EXPERIMENTAL: SGT must be tuned per machine/current/speed on real hardware
     * (too sensitive -> false stop mid-travel; too coarse -> rams the end). Start
     * with the motor's load behaviour from the `stat` SG_RESULT readout. */
    tmc5072_write(dev, TMC5072_COOLCONF(m), TMC5072_COOLCONF_SGT(sgt) | TMC5072_COOLCONF_SFILT);
    tmc5072_write(dev, TMC5072_VCOOLTHRS(m), 1);          /* stallGuard valid above a low speed */
    tmc5072_write(dev, TMC5072_SW_MODE(m), TMC5072_SW_SG_STOP);  /* hard stop on stall */

    tmc5072_read(dev, TMC5072_RAMP_STAT(m), NULL);        /* clear any stale latched events */
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

    tmc5072_write(dev, TMC5072_SW_MODE(m), 0);            /* disarm sg_stop */
    tmc5072_write(dev, TMC5072_VMAX(m), 0);
    tmc5072_write(dev, TMC5072_RAMPMODE(m), 0);           /* back to positioning mode */
    if (stalled) {
        tmc5072_write(dev, TMC5072_XACTUAL(m), 0);        /* define the stop as origin */
        tmc5072_write(dev, TMC5072_XTARGET(m), 0);
    }
    return stalled ? ESP_OK : ESP_ERR_TIMEOUT;
}
