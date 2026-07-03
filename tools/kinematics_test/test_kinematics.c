/* Host-side dry run for the firmware polargraph kinematics (main/kinematics.h).
 *
 * Compiles and runs on the dev machine (no ESP32) so the (x,y)<->steps math is
 * proven before flashing. Build & run:
 *
 *     cc tools/kinematics_test/test_kinematics.c -o /tmp/ktest -lm && /tmp/ktest
 *
 * Exits 0 if every check passes, 1 otherwise (so it can gate a build).
 */
#include <stdio.h>
#include <math.h>
#include "../../main/kinematics.h"

static int g_fail = 0;

/* approx-equal check with a label */
static void chk(const char *what, double got, double want, double tol)
{
    double err = fabs(got - want);
    if (err > tol) {
        printf("  FAIL %-34s got %.5f  want %.5f  (err %.5f > tol %.5f)\n",
               what, got, want, err, tol);
        g_fail++;
    } else {
        printf("  ok   %-34s %.5f (~%.5f)\n", what, got, want);
    }
}

static void chk_true(const char *what, int cond)
{
    if (!cond) { printf("  FAIL %-34s (condition false)\n", what); g_fail++; }
    else       { printf("  ok   %-34s\n", what); }
}

int main(void)
{
    /* Same numbers board_config.h feeds the firmware: span MOTOR_SPAN_MM,
     * measured home belt HOME_BELT_MM, STEPS_PER_MM = 200*256/40 = 1280,
     * both signs +1 (default to calibrate). Drop is DERIVED from the
     * measured belt, exactly as init_geometry() does on the firmware. */
    float span = 978.0f;
    float home_belt = 715.0f;
    float spm = 1280.0f;   /* 200 * 256 / 40 = STEPS_PER_MM */
    float drop = plt_drop_from_home_belt(span, home_belt);
    plotter_geom_t g = {
        .span_mm = span, .drop_mm = drop, .steps_per_mm = spm,
        .left_sign = +1, .right_sign = +1,
    };
    plt_affine_identity(&g);   /* default warp = passthrough (else zero-init = degenerate) */

    printf("== TMC5072 polargraph kinematics dry run ==\n");
    printf("span=%.1f home_belt=%.1f -> drop=%.4f steps/mm=%.1f\n\n",
           g.span_mm, home_belt, g.drop_mm, g.steps_per_mm);

    /* 1. Derived drop and home belt round to the measured value.
     * drop = sqrt(715^2 - 489^2) = sqrt(511225 - 239121) = sqrt(272104) ~ 521.636 */
    printf("[1] home geometry (origin from measured %.1f mm belt)\n", home_belt);
    chk("drop_from_home_belt(978,715)", drop, 521.636, 0.01);
    chk("home_belt_mm", plt_home_belt(&g), home_belt, 0.001);
    {
        int32_t sl, sr;
        plt_xy_to_steps(&g, 0.0f, 0.0f, &sl, &sr);
        chk("home steps left",  sl, 0.0, 0.0);
        chk("home steps right", sr, 0.0, 0.0);
    }

    /* 2. Hand-computed belt lengths at (100,0) with span=978, drop=521.636:
     *    half_span = 489; drop = 521.636
     *    left  = sqrt((489+100)^2 + 521.636^2) = sqrt(589^2 + 521.636^2)
     *          = sqrt(346921 + 272103) = sqrt(619024) ~ 786.78
     *    right = sqrt((489-100)^2 + 521.636^2) = sqrt(389^2 + 521.636^2)
     *          = sqrt(151321 + 272103) = sqrt(423424) ~ 650.71 */
    printf("\n[2] belt lengths at (100, 0)\n");
    chk("belt_left(100,0)",  plt_belt_left(&g, 100.0f, 0.0f),  786.78, 0.5);
    chk("belt_right(100,0)", plt_belt_right(&g, 100.0f, 0.0f), 650.71, 0.5);

    /* 3. Left/right symmetry: with equal signs, the left target at (x,y) equals
     *    the right target at (-x,y) (the machine is mirror-symmetric in X). */
    printf("\n[3] mirror symmetry about X=0\n");
    {
        int32_t la, ra, lb, rb;
        plt_xy_to_steps(&g,  120.0f, 80.0f, &la, &ra);
        plt_xy_to_steps(&g, -120.0f, 80.0f, &lb, &rb);
        chk_true("left(x)  == right(-x)", la == rb);
        chk_true("right(x) == left(-x)",  ra == lb);
    }

    /* 4. Direction sense: moving DOWN (y+) lengthens both belts, so with +signs
     *    both motor targets increase from home. */
    printf("\n[4] direction sense (y down -> both belts longer)\n");
    {
        int32_t sl, sr;
        plt_xy_to_steps(&g, 0.0f, 150.0f, &sl, &sr);
        chk_true("left steps > 0 moving down",  sl > 0);
        chk_true("right steps > 0 moving down", sr > 0);
    }

    /* 5. Forward then inverse must round-trip across a grid (integer step
     *    rounding is the only error source -> sub-0.05mm). */
    printf("\n[5] forward->inverse round trip over a grid\n");
    {
        double worst = 0.0;
        for (float y = 50.0f; y <= 350.0f; y += 50.0f) {
            for (float x = -300.0f; x <= 300.0f; x += 60.0f) {
                int32_t sl, sr; float rx, ry;
                plt_xy_to_steps(&g, x, y, &sl, &sr);
                plt_steps_to_xy(&g, sl, sr, &rx, &ry);
                double e = fabs(rx - x) + fabs(ry - y);
                if (e > worst) worst = e;
            }
        }
        chk("worst round-trip error (mm)", worst, 0.0, 0.05);
    }

    /* 6. Sign flip actually negates that motor's targets (calibration knob). */
    printf("\n[6] right_sign flip negates the right target\n");
    {
        plotter_geom_t gf = g; gf.right_sign = -1;
        int32_t sl, sr, slf, srf;
        plt_xy_to_steps(&g,  90.0f, 120.0f, &sl,  &sr);
        plt_xy_to_steps(&gf, 90.0f, 120.0f, &slf, &srf);
        chk_true("left unchanged by right_sign", sl == slf);
        chk_true("right negated by right_sign",  sr == -srf);
    }

    /* 7. Adaptive arc segmentation: count rises with radius, clamps, and the
     *    resulting chord sagitta actually stays within tolerance. */
    printf("\n[7] adaptive circle segmentation (chord err 0.3mm)\n");
    {
        int n_small = plt_arc_segments(5.0f,   0.3f);
        int n_big   = plt_arc_segments(200.0f, 0.3f);
        chk_true("clamps small radius to >= 8", n_small >= 8);
        chk_true("bigger radius -> more segs",  n_big > n_small);
        chk_true("clamps to <= 720",            plt_arc_segments(1e6f, 0.001f) <= 720);
        /* verify the actual sagitta of the chosen segmentation is within tol */
        float r = 200.0f, tol = 0.3f;
        int n = plt_arc_segments(r, tol);
        float sagitta = r * (1.0f - cosf((float)M_PI / (float)n));
        chk("r=200 sagitta within tol", sagitta, 0.0, tol + 1e-4);
    }

    /* 8. Straight-line sub-segmentation: at least 1, and every piece <= max. */
    printf("\n[8] line sub-segmentation (max 2mm)\n");
    {
        chk_true("zero-length line -> 1 seg", plt_line_segments(0.0f, 2.0f) == 1);
        int n = plt_line_segments(100.0f, 2.0f);
        chk_true("100mm/2mm -> 50 segs", n == 50);
        chk_true("7mm/2mm -> 4 segs (rounds up)", plt_line_segments(7.0f, 2.0f) == 4);
        chk_true("piece length <= max", (100.0f / (float)n) <= 2.0f + 1e-4f);
    }

    /* 9. Affine warp: identity is a no-op, and a non-trivial warp round-trips
     *    (forward through plt_xy_to_steps, inverse through plt_steps_to_xy
     *    recovers the LOGICAL coordinate the caller commanded). */
    printf("\n[9] affine warp round-trip\n");
    {
        /* identity must equal the no-affine result for an arbitrary point */
        int32_t il, ir;
        plt_xy_to_steps(&g, 73.0f, -41.0f, &il, &ir);
        plotter_geom_t gn = g; gn.aff_a = gn.aff_d = 1; gn.aff_b = gn.aff_c = gn.aff_tx = gn.aff_ty = 0;
        int32_t nl, nr; plt_xy_to_steps(&gn, 73.0f, -41.0f, &nl, &nr);
        chk_true("identity == passthrough", il == nl && ir == nr);

        /* a rotate+scale+shift warp: command logical p, recover it after warp */
        plotter_geom_t gw = g;
        gw.aff_a = 0.97f; gw.aff_b = 0.10f; gw.aff_tx = 12.0f;
        gw.aff_c = -0.08f; gw.aff_d = 1.04f; gw.aff_ty = -7.0f;
        float worst = 0.0f;
        for (float x = -150; x <= 150; x += 50) {
            for (float y = -150; y <= 200; y += 50) {
                int32_t sl, sr;
                plt_xy_to_steps(&gw, x, y, &sl, &sr);
                float rx, ry;
                plt_steps_to_xy(&gw, sl, sr, &rx, &ry);
                float e = fabsf(rx - x), f2 = fabsf(ry - y);
                if (e > worst) worst = e;
                if (f2 > worst) worst = f2;
            }
        }
        chk("warp forward->inverse recovers logical (mm)", worst, 0.0, 0.05);
    }

    /* ---- Phase 2.5: curvature-aware hand-off look-ahead ---- */
    {
        /* straight run: collinear vectors → the max cap governs */
        chk("lookahead straight = max", plt_flow_lookahead_mm(5, 0, 5, 0, 0.3f, 2.0f, 8.0f), 8.0, 1e-4);
        /* 90-degree turn, 5 mm segment: D = sqrt(8*0.3*5/(pi/2)) = 2.76 mm */
        chk("lookahead 90deg turn", plt_flow_lookahead_mm(5, 0, 0, 5, 0.3f, 2.0f, 8.0f), 2.7639, 0.01);
        /* gentle arc (r=100mm, 5mm chords, theta=0.05 rad): raw 15.5 mm → clamped to max */
        chk("lookahead gentle arc clamps to max",
            plt_flow_lookahead_mm(5, 0, 5.0f * cosf(0.05f), 5.0f * sinf(0.05f), 0.3f, 2.0f, 8.0f), 8.0, 1e-3);
        /* full reversal (180 deg): D = sqrt(12/pi) = 1.95 < min → clamped to min */
        chk("lookahead reversal = min",
            plt_flow_lookahead_mm(5, 0, -5, 0, 0.3f, 2.0f, 8.0f), 2.0, 1e-3);
        /* degenerate zero-length vector → min */
        chk("lookahead degenerate = min", plt_flow_lookahead_mm(0, 0, 5, 0, 0.3f, 2.0f, 8.0f), 2.0, 1e-4);
    }

    printf("\n%s (%d failure%s)\n", g_fail ? "TESTS FAILED" : "ALL TESTS PASSED",
           g_fail, g_fail == 1 ? "" : "s");
    return g_fail ? 1 : 0;
}
