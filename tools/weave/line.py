"""Draws a single straight line along X or Y -- the simplest possible
isolated test of one axis at a time: start at the origin, draw --length-mm
in the chosen direction (pen down), lift the pen, travel back to the origin.

IMPORTANT -- the firmware does NOT interpolate between points: it just sets
both motors' XTARGET and waits for each to independently ramp there
(pattern_stream_task in main.c). A straight line in motor/cord-length space
is *not* a straight line in (x, y) space -- the kinematics are nonlinear --
so sending only the two endpoints of a long segment draws a curve that bows
toward the anchors at both ends, not a line. To get an actually-straight
line, this script flattens the path into many short --segment-mm chords
(same technique circle.py uses for its arc) and sends every intermediate
point; each chord is short enough that the bow within it is invisible.

Starts and ends at the origin (0, 0) -- place the gondola there and run
`setorigin` first. Plotter space is X+ = right, Y+ = down (CLAUDE.md).

Run from this directory (same venv as square.py / circle.py):
    .venv/bin/python line.py 192.168.1.53 --length-mm 50            # X (right)
    .venv/bin/python line.py 192.168.1.53 --length-mm 50 --axis y   # Y (down)
"""
import argparse
import time

from kinematics import flatten_straight, xy_to_steps
from stream import PatternStream


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host", help="ESP32 IP address (see its serial boot log)")
    ap.add_argument("--port", type=int, default=8889)
    ap.add_argument("--length-mm", type=float, default=50.0)
    ap.add_argument("--axis", choices=["x", "y"], default="x",
                    help="direction to draw in: x = right, y = down (default x)")
    ap.add_argument("--segment-mm", type=float, default=5.0,
                    help="max chord length used to flatten the line (default 5mm) -- "
                         "the firmware draws straight in motor-space, not (x,y) space, "
                         "so long segments bow toward the anchors; shorter chords make "
                         "that bow physically invisible")
    ap.add_argument("--pace-s", type=float, default=0.1,
                    help="delay between sent points, seconds (default 0.1) -- the "
                         "firmware's UDP receive queue holds only 6 datagrams "
                         "(CONFIG_LWIP_UDP_RECVMBOX_SIZE) and it processes one point "
                         "at a time, so an unpaced burst of a flattened line's many "
                         "points mostly gets dropped. 0 disables pacing.")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the waypoint -> step conversions without sending")
    args = ap.parse_args()

    L = args.length_mm
    far = (L, 0.0) if args.axis == "x" else (0.0, L)
    axis_desc = "+X (right)" if args.axis == "x" else "+Y (down)"

    # Flatten home -> far -> home into chords no longer than --segment-mm.
    home = (0.0, 0.0)
    out_pts  = flatten_straight(home, far, args.segment_mm)
    back_pts = flatten_straight(far, home, args.segment_mm)
    waypoints = [home] + out_pts + back_pts
    pen_down  = [False] + [True] * len(out_pts) + [False] * len(back_pts)

    print(f"line: {L:.0f} mm along {axis_desc}, flattened into {len(out_pts)} chords, "
          f"starting and ending at origin (0, 0)")
    steps = [xy_to_steps(x, y) for x, y in waypoints]
    if args.dry_run:
        for i, ((x, y), (m1, m2), pd) in enumerate(zip(waypoints, steps, pen_down)):
            print(f"  [{i:>3}] ({x:+7.2f}, {y:+7.2f}) mm -> m1={m1:>7} m2={m2:>7}"
                  f"  pen={'down' if pd else 'up'}")
        return

    stream = PatternStream(args.host, args.port)
    for (m1, m2), pd in zip(steps, pen_down):
        stream.send_point(m1, m2, pen_down=pd)
        if args.pace_s:
            time.sleep(args.pace_s)
    stream.close()
    print(f"sent line ({len(steps)} points: out and back, flattened, pen already up)")


if __name__ == "__main__":
    main()
