"""Draws a circle -- same minimal, standalone-test shape as square.py, just a
different outline. Approximates the circle as a --segments-sided polygon
(the firmware only understands point-to-point moves, so any curve has to be
flattened before sending).

Starts and ends at the origin (0, 0) -- place the gondola there and run
`setorigin` first. The path: travel (pen up) from home to a point on the
circle, trace the outline (pen down) back to that same point, then travel
(pen up) back to home.

Sends are paced (--pace-s, default 0.1s) -- the firmware processes one point
at a time and blocks until the move finishes, but its UDP receive queue holds
only 6 datagrams, so an unpaced burst of the ~70 points a circle needs gets
mostly dropped (symptom: the shape stops a few points in and motion halts).

Run from this directory (same venv as square.py / draw_weave.py):
    .venv/bin/python circle.py 192.168.1.53 --radius-mm 25
"""
import argparse
import math
import time

from kinematics import xy_to_steps
from preview import save_path_preview
from stream import PatternStream


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host", help="ESP32 IP address (see its serial boot log)")
    ap.add_argument("--port", type=int, default=8889)
    ap.add_argument("--radius-mm", type=float, default=25.0)
    ap.add_argument("--segments", type=int, default=72,
                    help="number of straight-line segments approximating the circle")
    ap.add_argument("--pace-s", type=float, default=0.1,
                    help="delay between sent points, seconds (default 0.1). The "
                         "firmware processes one point at a time and blocks until "
                         "each move finishes, but its UDP receive queue holds only "
                         "6 datagrams (CONFIG_LWIP_UDP_RECVMBOX_SIZE) -- send faster "
                         "than it drains and the rest are silently dropped (symptom: "
                         "the shape stops a few points in). Raise this if points are "
                         "still going missing; 0 disables pacing entirely.")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the waypoint -> step conversions without sending")
    ap.add_argument("--preview", metavar="PNG_PATH", default=None,
                    help="render the planned path (plotter-space mm) to a PNG "
                         "before sending; combine with --dry-run to only preview")
    args = ap.parse_args()

    r = args.radius_mm
    n = args.segments
    # Circle centred on the origin, starting at its rightmost point (r, 0) so
    # the first drawn point sits exactly --radius-mm to the right of home --
    # an easy distance to check with a ruler.
    rim = [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n))
           for i in range(n + 1)]   # last point == first, closing the loop

    waypoints = [(0.0, 0.0)] + rim + [(0.0, 0.0)]
    pen_down = [False] + [False] + [True] * (len(rim) - 1) + [False]
    labels = (["home (start)", "travel to rim"]
              + ["rim"] * (len(rim) - 2) + ["rim (close)", "travel home"])

    print(f"circle: {r:.0f} mm radius, {n} segments, "
          f"starting and ending at origin (0, 0)")

    if args.preview:
        save_path_preview(waypoints, pen_down, args.preview,
                          title=f"circle preview: {r:.0f} mm radius, {n} segments")
        print(f"wrote preview to {args.preview}")

    steps = [xy_to_steps(x, y) for x, y in waypoints]
    if args.dry_run:
        for label, (x, y), (m1, m2), pd in zip(labels, waypoints, steps, pen_down):
            print(f"  {label:17s} ({x:+6.1f}, {y:+6.1f}) mm -> m1={m1:>7} m2={m2:>7}"
                  f"  pen={'down' if pd else 'up'}")
        return

    stream = PatternStream(args.host, args.port)
    for (m1, m2), pd in zip(steps, pen_down):
        stream.send_point(m1, m2, pen_down=pd)
        if args.pace_s:
            time.sleep(args.pace_s)
    stream.close()
    print(f"sent circle ({len(steps)} points: out, {len(rim)} rim points, "
          f"back home -- pen already up)")


if __name__ == "__main__":
    main()
