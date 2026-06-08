"""Smith-tile / Truchet weave pattern generator.

Generates a dense woven pattern by tiling a unit square with the classic
"Smith tile" motif -- two quarter-circle arcs that join the midpoints of
adjacent sides (Carlson, "Multi-Scale Truchet Patterns", Bridges 2018,
Figure 1 -- the single-scale tile the paper's multi-scale "winged tile"
version generalizes from). Randomly rotating each tile by a multiple of 90
degrees still leaves every arc endpoint sitting on an edge midpoint, so
neighbouring tiles' arcs always meet exactly where they touch -- chaining
fragmented arcs into long continuous flowing curves across the grid. That
chaining (not the arcs themselves) is what produces the "weave": tracing
those curves end-to-end is the job of generate_weave() below.

The paper's multi-scale extension (recursive subdivision, "winged" tiles at
multiple scales) is a natural follow-on once this base layer draws reliably.
"""
import math
import random
from collections import defaultdict

import svgpathtools as spt

ARC_SEGMENTS = 16   # points sampled per quarter-circle arc (drawing resolution)

TILE_CENTER = complex(0.5, 0.5)

# The two Smith-tile arcs in unit-square [0,1]^2 local coordinates: each is
# (center_x, center_y, radius, start_angle_deg, end_angle_deg). Both are
# quarter circles anchored at opposite corners, each joining the midpoints of
# the two sides meeting at that corner -- the classic Truchet "S" motif.
_BASE_ARC_SPECS = [
    (0.0, 0.0, 0.5,   0.0,  90.0),   # corner (0,0): joins bottom-mid <-> left-mid
    (1.0, 1.0, 0.5, 180.0, 270.0),   # corner (1,1): joins top-mid    <-> right-mid
]


def _arc_from_center_and_angles(cx, cy, r, a0_deg, a1_deg):
    """Builds an exact svgpathtools.Arc for a quarter circle specified in
    center+radius+angle form (more natural to write down than SVG's native
    endpoint parameterization, which wants start/end points plus large-arc and
    sweep flags). The `sweep` flag picks which of the two arcs joining `start`
    and `end` to draw; rather than hand-deriving its sign convention, we just
    keep whichever reproduces the analytic midpoint -- exact and unambiguous,
    since a quarter circle never trips the large-arc case."""
    a0, a1 = math.radians(a0_deg), math.radians(a1_deg)
    start = complex(cx + r * math.cos(a0), cy + r * math.sin(a0))
    end   = complex(cx + r * math.cos(a1), cy + r * math.sin(a1))
    a_mid = (a0 + a1) / 2.0
    expected_mid = complex(cx + r * math.cos(a_mid), cy + r * math.sin(a_mid))
    radius = complex(r, r)
    for sweep in (False, True):
        arc = spt.Arc(start, radius, rotation=0, large_arc=False, sweep=sweep, end=end)
        if abs(arc.point(0.5) - expected_mid) < 1e-9:
            return arc
    raise AssertionError("quarter-circle arc: no sweep flag matched the analytic midpoint")


# Built once at import time -- these are the exact curve objects every tile's
# arcs are a rotated+translated copy of (svgpathtools.Arc.rotated/.translated,
# not hand-rolled trig, do the transforming).
_BASE_ARCS = [_arc_from_center_and_angles(*spec) for spec in _BASE_ARC_SPECS]


def _sample_arc(arc, segments):
    """Samples `segments` + 1 points along an svgpathtools curve via its
    exact parametric .point(t) -- the library's analytic evaluation of the
    arc, not a hand-rolled cos/sin loop. Flattening to a polyline still has to
    happen somewhere: the firmware's wire protocol is discrete XTARGET points,
    not curve descriptions, so this is the one place that boundary is crossed."""
    pts = []
    for i in range(segments + 1):
        z = arc.point(i / segments)
        pts.append((z.real, z.imag))
    return pts


def _port_key(local_x, local_y, col, row):
    """Identifies which edge-midpoint an arc endpoint sits on, with a key
    that's identical for the two cells sharing that edge -- e.g. cell
    (col, row)'s top edge and cell (col, row+1)'s bottom edge both resolve
    to ('h', col, row+1). That shared identity is what lets _trace_strokes
    walk from one tile's arc into its neighbour's."""
    if abs(local_y) < 1e-6:
        return ('h', col, row)
    if abs(local_y - 1.0) < 1e-6:
        return ('h', col, row + 1)
    if abs(local_x) < 1e-6:
        return ('v', col, row)
    if abs(local_x - 1.0) < 1e-6:
        return ('v', col + 1, row)
    raise ValueError(f"arc endpoint ({local_x}, {local_y}) is not an edge midpoint")


def _trace_strokes(edges):
    """Chains arcs end-to-end through shared edge-midpoint ports into
    continuous strokes. Every interior port has exactly two arc-ends
    (degree 2, one from each neighbouring tile); every boundary port has
    exactly one (degree 1). That means the arcs decompose into simple open
    paths (running boundary-port to boundary-port) and simple closed loops
    (entirely interior) -- never branch, so each can be walked unambiguously.
    Returns a list of strokes, each a list of (x, y) points in tile-units,
    meant to be drawn pen-down continuously (pen lifts only between strokes).
    """
    incident = defaultdict(list)
    for i, (pa, pb, _) in enumerate(edges):
        incident[pa].append(i)
        incident[pb].append(i)

    used = [False] * len(edges)

    def walk(start_port, start_edge):
        stroke = []
        port, edge_idx = start_port, start_edge
        while True:
            pa, pb, pts = edges[edge_idx]
            used[edge_idx] = True
            seg, other = (pts, pb) if port == pa else (pts[::-1], pa)
            stroke.extend(seg if not stroke else seg[1:])  # don't repeat the joint point
            port = other
            remaining = [i for i in incident[port] if not used[i]]
            if not remaining:
                return stroke
            edge_idx = remaining[0]

    strokes = []
    for port, edge_idxs in incident.items():           # 1) open paths start at boundary ports
        if len(edge_idxs) == 1 and not used[edge_idxs[0]]:
            strokes.append(walk(port, edge_idxs[0]))
    for i, (pa, _, _) in enumerate(edges):              # 2) whatever's left is closed loops
        if not used[i]:
            strokes.append(walk(pa, i))
    return strokes


def generate_weave(cols, rows, seed=None):
    """Lays out a cols x rows grid of randomly-rotated Smith tiles and traces
    the connected arcs into continuous strokes.

    Returns a list of strokes, each a list of (x, y) points in
    [0, cols] x [0, rows] "tile units" -- multiply by your real-world cell
    size (and offset) to get plotter-space coordinates.
    """
    rng = random.Random(seed)
    edges = []
    for row in range(rows):
        for col in range(cols):
            rotation_steps = rng.randrange(4)
            for base_arc in _BASE_ARCS:
                arc = base_arc.rotated(rotation_steps * 90, origin=TILE_CENTER)
                local_pts = _sample_arc(arc, ARC_SEGMENTS)
                port_a = _port_key(local_pts[0][0],  local_pts[0][1],  col, row)
                port_b = _port_key(local_pts[-1][0], local_pts[-1][1], col, row)
                world_pts = [(col + x, row + y) for (x, y) in local_pts]
                edges.append((port_a, port_b, world_pts))
    return _trace_strokes(edges)
