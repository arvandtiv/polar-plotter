"""Generates a Truchet/Smith-tile weave pattern and streams it, point by
point, to the polar_plotter firmware over WiFi/UDP (pattern_stream_task).

The pattern is a cols x rows grid of cell-mm x cell-mm tiles, centred on the
plotter's manually-homed origin. Curve geometry (truchet.py) is built with
svgpathtools, kept in a venv local to this directory -- one-time setup:

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

Then run from this directory:

    .venv/bin/python draw_weave.py 192.168.1.53 --cols 4 --rows 4 --cell-mm 40

Find the IP in the firmware's boot log ("WiFi: got IP ..."). Start with a
small grid and a generous --cell-mm until the kinematics signs (see
kinematics.py) are confirmed correct on real hardware -- a wrong sign sends
the gondola the wrong way, not just draws the pattern wrong.
"""
import argparse
import time

from kinematics import xy_to_steps
from preview import save_preview
from stream import PatternStream
from truchet import generate_weave


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host", help="ESP32 IP address (see its serial boot log)")
    ap.add_argument("--port", type=int, default=8889)
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--rows", type=int, default=4)
    ap.add_argument("--cell-mm", type=float, default=40.0,
                    help="real-world size of one Truchet tile, in mm")
    ap.add_argument("--seed", type=int, default=None,
                    help="random seed -- fix it to reproduce the same weave")
    ap.add_argument("--pace-s", type=float, default=0.0,
                    help="extra delay between sent points, seconds "
                         "(0 = let the firmware pace itself, which is the default and is fine)")
    ap.add_argument("--dry-run", action="store_true",
                    help="generate and print stats without sending anything")
    ap.add_argument("--preview", metavar="PNG_PATH",
                    help="render the weave to a PNG (plotter-space layout) before sending; "
                         "combine with --dry-run to only preview")
    args = ap.parse_args()

    strokes = generate_weave(args.cols, args.rows, seed=args.seed)
    n_points = sum(len(s) for s in strokes)
    width_mm, height_mm = args.cols * args.cell_mm, args.rows * args.cell_mm
    print(f"{len(strokes)} strokes, {n_points} points, "
          f"covering {width_mm:.0f} x {height_mm:.0f} mm centred on the origin")

    if args.preview:
        save_preview(strokes, args.preview, args.cols, args.rows, args.cell_mm)
        print(f"wrote preview to {args.preview}")

    if args.dry_run:
        return

    # Centre the cols x rows tile-unit grid on the plotter origin (0, 0).
    origin_x, origin_y = -args.cols / 2.0, -args.rows / 2.0

    stream = PatternStream(args.host, args.port)
    sent = 0
    for stroke in strokes:
        for i, (tx, ty) in enumerate(stroke):
            x_mm = (tx + origin_x) * args.cell_mm
            y_mm = (ty + origin_y) * args.cell_mm
            m1, m2 = xy_to_steps(x_mm, y_mm)
            stream.send_point(m1, m2, pen_down=(i > 0))   # first point of a stroke = travel move
            sent += 1
            if args.pace_s:
                time.sleep(args.pace_s)
            last_point = (m1, m2)
    # Lift the pen at the end: same spot as the last drawn point (zero-
    # distance "move", target == current) but pen up -- the firmware
    # transitions pen state *before* moving toward each point, so without
    # this the pen is left down, touching the paper, when streaming finishes.
    if strokes:
        stream.send_point(*last_point, pen_down=False)
        sent += 1
    stream.close()
    print(f"sent {sent} points")


if __name__ == "__main__":
    main()
