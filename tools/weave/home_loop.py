"""Draws a square as an explicit closed loop through home: start at the
origin (place the gondola there and run `setorigin` first), then trace
left -> up -> right -> down by --side-mm each, ending back at the origin.

Plotter space is X+ = right, Y+ = down (CLAUDE.md), so from home (0, 0):
    left  -> x -= side        up    -> y -= side
    right -> x += side        down  -> y += side

Run (same venv as square.py / draw_weave.py):
    .venv/bin/python home_loop.py 192.168.1.53 --side-mm 50
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
                    help="print the waypoint -> step conversions without sending")
    args = ap.parse_args()

    s = args.side_mm
    waypoints = [
        (0.0, 0.0),   # home (start)
        (-s,  0.0),   # 5cm left
        (-s,  -s),    # 5cm up
        (0.0, -s),    # 5cm right
        (0.0, 0.0),   # 5cm down -- back to home
    ]
    labels = ["home (start)", "left", "up", "right", "down -> home"]

    print(f"square loop through home, {s:.0f} mm sides, pen down throughout")
    steps = [xy_to_steps(x, y) for x, y in waypoints]
    for label, (x, y), (m1, m2) in zip(labels, waypoints, steps):
        print(f"  {label:14s} ({x:+6.1f}, {y:+6.1f}) mm -> m1={m1:>7} m2={m2:>7}")

    if args.dry_run:
        return

    stream = PatternStream(args.host, args.port)
    for i, (m1, m2) in enumerate(steps):
        stream.send_point(m1, m2, pen_down=(i > 0))   # i=0: already home, no travel needed
    # Lift the pen at the end: same spot as the last point (zero-distance
    # "move", target == current) but pen up -- the firmware transitions pen
    # state *before* moving toward each point, so without this the pen is
    # left down, touching the paper, when the loop closes.
    stream.send_point(*steps[-1], pen_down=False)
    stream.close()
    print("sent home-loop square (5 points)")


if __name__ == "__main__":
    main()
