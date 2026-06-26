// The v1.3 "Frame" — the declarative geometry IR every generator/modifier produces
// and the compiler consumes. Pure data, millimetres, plotter logical coords
// (origin = centre, +x right, +y down — same frame the firmware's goto/line accept,
// and the same one the G-code digester converts into). See docs/v1.3/ARCHITECTURE.md.

export interface Pt { x: number; y: number; }

export interface Path {
  points: Pt[];
  closed?: boolean;          // if true, the last→first segment is also drawn
  // presentation only (preview); the firmware ignores these:
  stroke?: string;
  cycles?: number;           // retrace count → firmware `cycles` (default 1)
}

export interface Frame {
  widthMm: number;
  heightMm: number;
  paths: Path[];
  meta?: { title?: string; anchor?: Pt; noSimplify?: boolean };
}

/** Axis-aligned bounds of every point in the frame, or null if empty. */
export function frameBounds(frame: Frame): { x0: number; y0: number; x1: number; y1: number } | null {
  let b: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const path of frame.paths) {
    for (const p of path.points) {
      if (!b) b = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      else {
        if (p.x < b.x0) b.x0 = p.x;
        if (p.y < b.y0) b.y0 = p.y;
        if (p.x > b.x1) b.x1 = p.x;
        if (p.y > b.y1) b.y1 = p.y;
      }
    }
  }
  return b;
}

/** Deep-copy a path (points cloned) so transforms don't mutate the source. */
export function clonePath(path: Path): Path {
  return { ...path, points: path.points.map((p) => ({ x: p.x, y: p.y })) };
}

/** Convenience: an axis-aligned rectangle path centred at (cx,cy). */
export function rectPath(cx: number, cy: number, w: number, h: number): Path {
  const hx = w / 2, hy = h / 2;
  return {
    closed: true,
    points: [
      { x: cx - hx, y: cy - hy },
      { x: cx + hx, y: cy - hy },
      { x: cx + hx, y: cy + hy },
      { x: cx - hx, y: cy + hy },
    ],
  };
}
