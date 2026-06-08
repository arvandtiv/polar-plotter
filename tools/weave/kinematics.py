"""Polargraph (x, y) -> motor microstep conversion.

Geometry from CLAUDE.md "Mechanical setup & calibration" -- same physical
machine as ../wall-plotter:
  - Two motors anchor the belts at the top corners, MOTOR_SPAN_MM apart.
  - Origin (0, 0) is the midpoint between the anchors, ORIGIN_DROP_MM below
    the motor line (where the gondola is manually homed and XACTUAL zeroed).
    X+ is right, Y+ is down.
  - Belt length = straight-line distance from an anchor to the gondola.
  - steps/mm = 5 * microsteps = 1280 at the TMC5072's native 256 microsteps.

A motor's XTARGET is the belt-length DELTA from the origin, in microsteps.
Whether winding a motor forward lengthens or shortens ITS belt depends on how
it's mounted -- motor B is mirror-mounted relative to motor A (CLAUDE.md), so
the two signs are opposite. The signs below are a starting guess: if a test
pattern comes out mirrored, flipped, or the gondola drives toward a boundary
instead of the pattern centre, flip the corresponding MOTOR_*_SIGN and re-run.
"""
import math

MOTOR_SPAN_MM  = 975.0    # MEASURED on the real machine: 97.5 cm anchor-to-anchor
                          # (replaces all the earlier interpolated guesses --
                          # ground truth beats curve-fitting from motion tests)
ORIGIN_DROP_MM = 400.0    # MEASURED: 40 cm from the anchor line down to the
                          # manually-homed origin
STEPS_PER_MM   = 1280     # 5 * 256 microsteps (CLAUDE.md "Mechanical setup")

# Anchor positions in plotter-space mm (origin at the manual-home point,
# anchors sit ORIGIN_DROP_MM *above* it, i.e. at negative Y).
ANCHOR_LEFT  = (-MOTOR_SPAN_MM / 2.0, -ORIGIN_DROP_MM)   # motor B / left anchor
ANCHOR_RIGHT = ( MOTOR_SPAN_MM / 2.0, -ORIGIN_DROP_MM)   # motor A / right anchor

# Belt length at the origin -- equal for both anchors by symmetry; this is
# the reference XACTUAL=0 represents after manual homing. CLAUDE.md gives
# this as ~634.5 mm, which sqrt((985/2)^2 + 400^2) reproduces.
_ORIGIN_BELT_MM = math.hypot(MOTOR_SPAN_MM / 2.0, ORIGIN_DROP_MM)

# board_config.h: MOTOR_THETA = "motor 1 / left", MOTOR_RHO = "motor 2 / right".
MOTOR_THETA_SIGN = +1   # left anchor  -> MOTOR_THETA
MOTOR_RHO_SIGN   = +1   # right anchor -> MOTOR_RHO -- flipped from -1: a single
                        # wrong motor sign converts an intended *differential*
                        # belt response (= physical X motion) into a *common-mode*
                        # one (= physical Y motion) and vice versa, which is
                        # exactly the "X command moved it in Y" symptom observed.
                        # If this overcorrects (still swapped, or now diagonal),
                        # put this back to -1 and flip MOTOR_THETA_SIGN instead --
                        # exactly one of the two must be wrong, never both.


def xy_to_steps(x_mm, y_mm):
    """Converts a plotter-space point (mm, origin = manual home point) to
    (m1_steps, m2_steps) -- raw absolute XTARGET values for MOTOR_THETA and
    MOTOR_RHO, i.e. exactly what pattern_stream_task expects on the wire."""
    left_belt  = math.hypot(x_mm - ANCHOR_LEFT[0],  y_mm - ANCHOR_LEFT[1])
    right_belt = math.hypot(x_mm - ANCHOR_RIGHT[0], y_mm - ANCHOR_RIGHT[1])

    m1 = MOTOR_THETA_SIGN * (left_belt  - _ORIGIN_BELT_MM) * STEPS_PER_MM
    m2 = MOTOR_RHO_SIGN   * (right_belt - _ORIGIN_BELT_MM) * STEPS_PER_MM
    return int(round(m1)), int(round(m2))


def flatten_straight(p0, p1, max_seg_mm):
    """Subdivides the straight Cartesian segment p0 -> p1 into chords no
    longer than max_seg_mm, returning the intermediate and end points
    (p0 excluded, p1 included).

    The firmware draws straight in motor/cord-length space, not (x, y) space
    -- it just sets both XTARGETs and waits for each motor to independently
    ramp there (pattern_stream_task in main.c), and that space's relationship
    to (x, y) is nonlinear. So a long Cartesian segment sent as just its two
    endpoints traces a curve that bows toward the anchors, not a line. Chords
    short enough that the bow within each one is physically invisible are the
    fix -- this is the same technique circle.py uses to flatten its arc."""
    length = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    n = max(1, math.ceil(length / max_seg_mm))
    return [(p0[0] + (p1[0] - p0[0]) * t / n,
             p0[1] + (p1[1] - p0[1]) * t / n) for t in range(1, n + 1)]
