// Grid tiling helpers — shared by the console Script tab and MCP plot_script.
// Bounds changes are QUEUED draw jobs; matrix is applied immediately over HTTP.
// Always wait for the bounds job to finish before applying matrix, or circles
// are validated against the previous (full-area) bounds and rejected.

export interface GridCtx {
  cols: number;
  rows: number;
  padding_mm: number;
  full_xn: number;
  full_xp: number;
  full_yn: number;
  full_yp: number;
}

export interface CellLayout {
  cellW: number;
  cellH: number;
  cx: number;
  cy: number;
  boundsQuery: string;
  matrixQuery: string;
}

const rn = (n: number) => Math.round(n * 100) / 100;

/** PlotterBounds → firmware xn/xp/yn/yp (same mapping as boundsToQuery). */
export function firmwareWorkAreaFromPlotter(b: {
  left: number;
  right: number;
  up: number;
  down: number;
}): { xn: number; xp: number; yn: number; yp: number } {
  return { xn: -b.left, xp: b.right, yn: -b.up, yp: b.down };
}

/**
 * Metadata work_area often copies the Work Area UI labels literally:
 *   y_min = −(Up −Y extent),  y_max = (Down +Y extent)
 * while boundsToQuery / the console store the crossed fields (up = Down, down = Up).
 * Detect that pattern and convert to the firmware convention.
 */
export function normalizeMetadataWorkArea(wa: Record<string, number>): {
  xn: number;
  xp: number;
  yn: number;
  yp: number;
} {
  const xn = Number(wa.x_min ?? wa.xn);
  const xp = Number(wa.x_max ?? wa.xp);
  let yn = Number(wa.y_min ?? wa.yn);
  let yp = Number(wa.y_max ?? wa.yp);
  if (yn < 0 && yp > 0 && -yn > yp) {
    return { xn, xp, yn: -yp, yp: -yn };
  }
  return { xn, xp, yn, yp };
}

/** Build grid context from the console Work Area (authoritative on the Script tab). */
export function gridCtxFromPlotterBounds(
  b: { left: number; right: number; up: number; down: number },
  grid: { cols: number; rows: number; padding_mm?: number },
): GridCtx {
  const wa = firmwareWorkAreaFromPlotter(b);
  return {
    cols: grid.cols,
    rows: grid.rows,
    padding_mm: Number(grid.padding_mm ?? 5),
    full_xn: wa.xn,
    full_xp: wa.xp,
    full_yn: wa.yn,
    full_yp: wa.yp,
  };
}

/** Extract grid + work area from a { metadata } wrapper document. */
export function gridCtxFromMetadata(doc: {
  metadata?: {
    work_area?: Record<string, number>;
    grid?: Record<string, number>;
  };
}): GridCtx | null {
  const meta = doc?.metadata;
  if (!meta?.work_area || !meta?.grid) return null;
  const wa = meta.work_area;
  const grid = meta.grid;
  const { xn, xp, yn, yp } = normalizeMetadataWorkArea(wa);
  const cols = Number(grid.cols);
  const rows = Number(grid.rows);
  if (![xn, xp, yn, yp, cols, rows].every(isFinite) || cols < 1 || rows < 1) return null;
  return {
    cols, rows,
    padding_mm: Number(grid.padding_mm ?? 5),
    full_xn: xn, full_xp: xp, full_yn: yn, full_yp: yp,
  };
}

export function computeCell(gc: GridCtx, col: number, row: number): CellLayout {
  if (col >= gc.cols) throw new Error(`grid_select: col ${col} ≥ cols ${gc.cols}`);
  if (row >= gc.rows) throw new Error(`grid_select: row ${row} ≥ rows ${gc.rows}`);
  const cellW = ((gc.full_xp - gc.full_xn) - (gc.cols - 1) * gc.padding_mm) / gc.cols;
  const cellH = ((gc.full_yp - gc.full_yn) - (gc.rows - 1) * gc.padding_mm) / gc.rows;
  if (cellW <= 0 || cellH <= 0) throw new Error("grid_select: padding_mm too large for this work area");
  const lx = gc.full_xn + col * (cellW + gc.padding_mm);
  const ty = gc.full_yn + row * (cellH + gc.padding_mm);
  const cx = rn(lx + cellW / 2);
  const cy = rn(ty + cellH / 2);
  return {
    cellW: rn(cellW), cellH: rn(cellH), cx, cy,
    boundsQuery: `bounds?xn=${rn(-cellW / 2)}&xp=${rn(cellW / 2)}&yn=${rn(-cellH / 2)}&yp=${rn(cellH / 2)}&shape=0`,
    matrixQuery: `matrix?a=1&b=0&c=0&d=1&tx=${cx}&ty=${cy}`,
  };
}

/**
 * Resolve the effective GridCtx for a single grid_select / grid_clear command.
 *
 * Grid SHAPE (cols/rows/padding) is taken from the command's own fields when it carries
 * them, else from `ctx`. The work-area BOUNDS (full_xn…yp) ALWAYS come from `ctx` when one
 * is given, because `ctx` is the live machine work area (read from firmware) — it is
 * authoritative over any inline full_* a script baked in, which may be stale or in the
 * wrong (UI-label) convention. This is what stops a Y-flipped generated script from
 * placing cells off the canvas: the machine's real bounds win, not the script's numbers.
 *
 * With no `ctx` (no live bounds available), fall back to the command's own full grid
 * definition (legacy self-contained behaviour).
 */
export function resolveGridCtx(
  cmd: Record<string, unknown>,
  ctx: GridCtx | null,
): GridCtx | null {
  const n = (k: string) => Number(cmd[k]);
  const hasShape = isFinite(n("cols")) && isFinite(n("rows"));
  if (!ctx) {
    if (!isFinite(n("full_xn"))) return null;     // nothing to build from
    return {
      cols: hasShape ? n("cols") : 1,
      rows: hasShape ? n("rows") : 1,
      padding_mm: isFinite(n("padding_mm")) ? n("padding_mm") : 5,
      full_xn: n("full_xn"), full_xp: n("full_xp"),
      full_yn: n("full_yn"), full_yp: n("full_yp"),
    };
  }
  return {
    cols: hasShape ? n("cols") : ctx.cols,
    rows: hasShape ? n("rows") : ctx.rows,
    padding_mm: isFinite(n("padding_mm")) ? n("padding_mm") : ctx.padding_mm,
    full_xn: ctx.full_xn, full_xp: ctx.full_xp,   // ← live machine bounds win over inline
    full_yn: ctx.full_yn, full_yp: ctx.full_yp,
  };
}

export function gridClearQueries(gc: GridCtx): { boundsQuery: string; matrixQuery: string } {
  return {
    boundsQuery: `bounds?xn=${gc.full_xn}&xp=${gc.full_xp}&yn=${gc.full_yn}&yp=${gc.full_yp}&shape=0`,
    matrixQuery: "matrix?a=1&b=0&c=0&d=1&tx=0&ty=0",
  };
}

/** Bake metadata into each grid_select / grid_clear so commands are self-contained. */
export function hydrateGridCommands<T extends { type?: string }>(
  commands: T[],
  gc: GridCtx | null,
): T[] {
  if (!gc) return commands;
  return commands.map((cmd) => {
    if (cmd.type === "grid_select") {
      return {
        ...gc,
        ...cmd,
        type: "grid_select",
      } as T;
    }
    if (cmd.type === "grid_clear" && !isFinite(Number((cmd as Record<string, unknown>).full_xn))) {
      return {
        ...gc,
        ...cmd,
        full_xn: gc.full_xn,
        full_xp: gc.full_xp,
        full_yn: gc.full_yn,
        full_yp: gc.full_yp,
        type: "grid_clear",
      } as T;
    }
    return cmd;
  });
}