"""Draws a plain square -- a minimal, standalone test of (x, y) -> steps
kinematics + UDP point streaming, independent of the weave generator. If a
square comes out wrong, the problem is in this short, inspectable path
(coordinates -> xy_to_steps -> PatternStream), not buried in pattern logic.

Starts and ends at the origin (0, 0) -- place the gondola there and run
`setorigin` first. The path: travel (pen up) from home to the square's
near corner, trace the four sides (pen down), then travel (pen up) back
to home -- so a correct run both draws a square AND returns to its start,
giving you a visual home-return check for free.

Run from this directory (same venv as draw_weave.py):
    .venv/bin/python square.py 192.168.1.53 --side-mm 50
"""
import argparse

from kinematics import xy_to_steps
from stream import PatternStream


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host", help="ESP32 IP address (see its serial boot log)")
    ap.add_argument("--port", type=int, default=8889)
    ap.add_argument("--side-mm", type=float, default=50.0)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the corner -> step conversions without sending")
    args = ap.parse_args()

    h = args.side_mm / 2.0
    # Home -> near corner (travel) -> 4 sides (drawn, closing the loop back
    # to the near corner) -> home (travel). Pen is down only for the moves
    # that trace a side; up for the home<->corner travel legs.
    waypoints = [(0.0, 0.0), (-h, -h), (h, -h), (h, h), (-h, h), (-h, -h), (0.0, 0.0)]
    pen_down  = [False,      False,    True,    True,   True,   True,      False]
    labels    = ["home (start)", "travel to corner", "side", "side", "side",
                 "side (close)", "travel home"]

    print(f"square: {args.side_mm:.0f} mm side, starting and ending at origin (0, 0)")
    steps = [xy_to_steps(x, y) for x, y in waypoints]
    for label, (x, y), (m1, m2), pd in zip(labels, waypoints, steps, pen_down):
        print(f"  {label:17s} ({x:+6.1f}, {y:+6.1f}) mm -> m1={m1:>7} m2={m2:>7}"
              f"  pen={'down' if pd else 'up'}")

    if args.dry_run:
        return

    stream = PatternStream(args.host, args.port)
    for (m1, m2), pd in zip(steps, pen_down):
        stream.send_point(m1, m2, pen_down=pd)
    stream.close()
    print(f"sent square ({len(steps)} points: out, 4 sides, back home -- pen already up)")


if __name__ == "__main__":
    main()
