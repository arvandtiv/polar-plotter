"""Renders a generated weave to a PNG so you can see the strokes before
streaming them to the gondola -- the plotter-space layout (cell-mm scaled,
centred on the origin), not raw tile-unit coordinates."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def save_path_preview(waypoints, pen_down, path, title):
    """Renders a flat (x_mm, y_mm) waypoint list -- e.g. circle.py's or
    square.py's send order -- to a PNG. Drawn (pen-down) segments are solid;
    pen-up travel segments are dashed, so you can see exactly what the
    plotter will trace versus where it just moves."""
    fig, ax = plt.subplots(figsize=(6, 6))
    for i in range(1, len(waypoints)):
        (x0, y0), (x1, y1) = waypoints[i - 1], waypoints[i]
        style = "-" if pen_down[i] else "--"
        color = "black" if pen_down[i] else "tab:gray"
        ax.plot([x0, x1], [y0, y1], style, linewidth=1.5, color=color)
    ax.plot(0, 0, "+", color="tab:red", markersize=12, markeredgewidth=2, label="origin")
    ax.set_aspect("equal")
    ax.invert_yaxis()   # plotter Y+ is down
    ax.set_xlabel("x (mm)")
    ax.set_ylabel("y (mm)")
    ax.set_title(title)
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def save_preview(strokes, path, cols, rows, cell_mm):
    origin_x, origin_y = -cols / 2.0, -rows / 2.0
    fig, ax = plt.subplots(figsize=(6, 6))
    for stroke in strokes:
        xs = [(x + origin_x) * cell_mm for x, _ in stroke]
        ys = [(y + origin_y) * cell_mm for _, y in stroke]
        ax.plot(xs, ys, "-", linewidth=1.5, color="black")
    ax.set_aspect("equal")
    ax.invert_yaxis()   # plotter Y+ is down
    ax.set_xlabel("x (mm)")
    ax.set_ylabel("y (mm)")
    ax.set_title(f"weave preview: {cols}x{rows} tiles @ {cell_mm:.0f} mm "
                 f"({len(strokes)} strokes)")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
