/* Polargraph / V-plotter kinematics — pure, dependency-free, host-testable.
 *
 * This is the (x, y) mm  <->  per-motor microstep conversion that used to live
 * only on the Python side (tools/weave/kinematics.py). Bringing it into the
 * firmware lets you calibrate straight from the serial console (`goto`, `belt`,
 * `where`) with no PC in the loop. It deliberately includes only <math.h> and
 * <stdint.h> so the identical code compiles into both the ESP32 firmware and the
 * host dry-run test (tools/kinematics_test/test_kinematics.c).
 *
 * Geometry (see CLAUDE.md "Mechanical setup & calibration"):
 *   - Two anchors on a horizontal motor line, `span_mm` apart.
 *   - Origin (0,0) is the midpoint between the anchors, `drop_mm` BELOW the line.
 *   - X+ = right, Y+ = DOWN (toward the floor).
 *   - Left anchor  L = (-span/2, -drop), right anchor R = (+span/2, -drop),
 *     measured in the origin's frame (anchors are above the origin, so -drop).
 *   - Belt length to an anchor = straight-line distance anchor->gondola.
 *   - Microsteps are measured RELATIVE TO HOME (the origin): at (0,0) both belt
 *     lengths equal `home_belt_mm()` and both motor targets are 0. This matches
 *     the firmware's manual-homing convention (setorigin zeroes XACTUAL at the
 *     true origin), so XTARGET = (belt_len - home_belt_len) * steps_per_mm.
 *
 * Sign calibration: belt-lengthening maps to +steps or -steps depending on how
 * each motor is wound, and the left motor is mirror-mounted relative to the
 * right (CLAUDE.md). `left_sign` / `right_sign` (each +1 or -1) capture that and
 * MUST be confirmed on the real machine — this is exactly the axis/sign issue
 * that bit the earlier calibration. Use the `belt` dry-run command to check the
 * predicted step directions before driving the motors.
 */
#pragma once
#include <math.h>
#include <stdint.h>

#define PLT_PI      3.14159265358979323846f
#define PLT_TWO_PI  (2.0f * PLT_PI)

typedef struct {
    float span_mm;        /* anchor-to-anchor distance (MOTOR_SPAN_MM) */
    float drop_mm;        /* origin below the motor line */
    float steps_per_mm;   /* microsteps per mm of belt travel */
    float x_scale;        /* multiplier on x before belt calculation (default 1.0) */
    float y_scale;        /* multiplier on y before belt calculation (default 1.0) */
    int   left_sign;      /* +1/-1: sign of steps as the LEFT belt lengthens  */
    int   right_sign;     /* +1/-1: sign of steps as the RIGHT belt lengthens */
} plotter_geom_t;

/* Belt length (mm) from each anchor to the gondola at (x, y). */
static inline float plt_belt_left(const plotter_geom_t *g, float x, float y)
{
    float dx = g->span_mm * 0.5f + x * g->x_scale;
    float dy = g->drop_mm        + y * g->y_scale;
    return sqrtf(dx * dx + dy * dy);
}

static inline float plt_belt_right(const plotter_geom_t *g, float x, float y)
{
    float dx = g->span_mm * 0.5f - x * g->x_scale;
    float dy = g->drop_mm        + y * g->y_scale;
    return sqrtf(dx * dx + dy * dy);
}

/* Belt length at the origin (equal for both belts by symmetry). */
static inline float plt_home_belt(const plotter_geom_t *g)
{
    return plt_belt_left(g, 0.0f, 0.0f);
}

/* Derive the origin drop (vertical motor-line-to-origin distance) from a MEASURED
 * belt length at the origin. At the midpoint both belts are equal, so
 *   home_belt^2 = (span/2)^2 + drop^2   ->   drop = sqrt(home_belt^2 - (span/2)^2).
 * This is the easy-to-calibrate path: rather than measuring the vertical drop,
 * just measure one belt (motor->gondola) with the gondola at the midpoint origin
 * and feed it in here. Returns 0 if the belt is too short to span the half-width
 * (geometrically impossible -> check your span/belt numbers). */
static inline float plt_drop_from_home_belt(float span_mm, float home_belt_mm)
{
    float half = span_mm * 0.5f;
    float d2 = home_belt_mm * home_belt_mm - half * half;
    return (d2 > 0.0f) ? sqrtf(d2) : 0.0f;
}

/* Forward kinematics: (x, y) mm -> absolute motor targets in microsteps,
 * measured relative to home (origin = 0 steps on both motors). */
static inline void plt_xy_to_steps(const plotter_geom_t *g, float x, float y,
                                   int32_t *left_steps, int32_t *right_steps)
{
    float l0 = plt_home_belt(g);
    *left_steps  = (int32_t)lroundf((float)g->left_sign  *
                                    (plt_belt_left(g, x, y)  - l0) * g->steps_per_mm);
    *right_steps = (int32_t)lroundf((float)g->right_sign *
                                    (plt_belt_right(g, x, y) - l0) * g->steps_per_mm);
}

/* Number of straight chords to approximate a circle/arc of `radius_mm` so that
 * the chord's bulge (sagitta) stays within `max_chord_err_mm`. Sagitta of a
 * chord spanning angle a on radius r is r*(1 - cos(a/2)); solving for a and
 * dividing 2*pi by it gives the count. Adaptive segmentation is the real
 * efficiency win: small circles get few segments, big ones get enough to look
 * round, neither over- nor under-shoots. Clamped to [8, 720]. */
static inline int plt_arc_segments(float radius_mm, float max_chord_err_mm)
{
    if (radius_mm <= 0.0f || max_chord_err_mm <= 0.0f) return 8;
    float ratio = 1.0f - max_chord_err_mm / radius_mm;   /* cos(a/2) */
    if (ratio < -1.0f) ratio = -1.0f;
    if (ratio >  1.0f) ratio =  1.0f;
    float a = 2.0f * acosf(ratio);                        /* angle per chord */
    int n = (a > 1e-6f) ? (int)ceilf(PLT_TWO_PI / a) : 720;
    if (n < 8)   n = 8;
    if (n > 720) n = 720;
    return n;
}

/* Number of sub-segments to split a straight Cartesian line of `len_mm` into so
 * each piece is at most `max_seg_mm` long. A single coordinated move draws a line
 * that is straight in STEP space, which bows in Cartesian space on a polargraph;
 * keeping each piece short makes that bow negligible. Always >= 1. */
static inline int plt_line_segments(float len_mm, float max_seg_mm)
{
    if (max_seg_mm <= 0.0f) return 1;
    int n = (int)ceilf(len_mm / max_seg_mm);
    return (n < 1) ? 1 : n;
}

/* Inverse kinematics: motor microsteps -> (x, y) mm. Recovers the two belt
 * lengths, then intersects the two circles centered on the anchors. Used for
 * `where` (read XACTUAL back as a coordinate) and to round-trip-verify the
 * forward math in the dry-run test. Returns the lower intersection (y >= line),
 * which is the physically reachable solution below the motors. */
static inline void plt_steps_to_xy(const plotter_geom_t *g, int32_t left_steps,
                                   int32_t right_steps, float *x, float *y)
{
    float l0 = plt_home_belt(g);
    float al = l0 + ((float)g->left_sign  * (float)left_steps)  / g->steps_per_mm;
    float ar = l0 + ((float)g->right_sign * (float)right_steps) / g->steps_per_mm;
    float d  = g->span_mm;

    /* With x_scale: belt eqs use (x*x_scale). Subtracting eliminates y:
     *   aL^2 - aR^2 = 2*d*(x*x_scale)  ->  x = (aL^2-aR^2)/(2*d*x_scale) */
    float xs = (al * al - ar * ar) / (2.0f * d);   /* = x * x_scale */
    *x = xs / g->x_scale;
    float yy = al * al - (xs + d * 0.5f) * (xs + d * 0.5f);
    if (yy < 0.0f) yy = 0.0f;
    /* With y_scale: drop + y*y_scale = sqrt(yy)  ->  y = (sqrt(yy)-drop)/y_scale */
    *y = (sqrtf(yy) - g->drop_mm) / g->y_scale;
}
