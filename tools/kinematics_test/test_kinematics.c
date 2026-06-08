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
    /* Same numbers board_config.h feeds the firmware: span 985, measured
     * home belt 700 mm (the new easy-to-measure origin), 200*256/40 = 1280
     * steps/mm, both signs +1 (the default to calibrate). The drop is DERIVED
     * from the measured belt, exactly as init_geometry() does on the firmware. */
    float drop = plt_drop_from_home_belt(985.0f, 700.0f);
    plotter_geom_t g = {
        .span_mm = 985.0f, .drop_mm = drop, .steps_per_mm = 1280.0f,
        .left_sign = +1, .right_sign = +1,
    };

    printf("== TMC5072 polargraph kinematics dry run ==\n");
    printf("span=%.1f home_belt=700.0 -> drop=%.4f steps/mm=%.1f\n\n",
           g.span_mm, g.drop_mm, g.steps_per_mm);

    /* 1. Derived drop and home belt round to the measured 700 mm. */
    printf("[1] home geometry (origin from measured 700 mm belt)\n");
    chk("drop_from_home_belt(985,700)", drop, 497.4372, 0.001);
    chk("home_belt_mm", plt_home_belt(&g), 700.0000, 0.001);
    {
        int32_t sl, sr;
        plt_xy_to_steps(&g, 0.0f, 0.0f, &sl, &sr);
        chk("home steps left",  sl, 0.0, 0.0);
        chk("home steps right", sr, 0.0, 0.0);
    }

    /* 2. Independently hand-computed belt lengths at (100,0) with drop=497.4372:
     *    left  = sqrt(592.5^2 + 497.4372^2) = sqrt(598500) = 773.6278
     *    right = sqrt(392.5^2 + 497.4372^2) = sqrt(401500) = 633.6403 */
    printf("\n[2] belt lengths at (100, 0)\n");
    chk("belt_left(100,0)",  plt_belt_left(&g, 100.0f, 0.0f),  773.6278, 0.01);
    chk("belt_right(100,0)", plt_belt_right(&g, 100.0f, 0.0f), 633.6403, 0.01);

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

    printf("\n%s (%d failure%s)\n", g_fail ? "TESTS FAILED" : "ALL TESTS PASSED",
           g_fail, g_fail == 1 ? "" : "s");
    return g_fail ? 1 : 0;
}
