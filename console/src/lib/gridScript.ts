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

/**
 * True when a firmware /api/status "matrix" object is (numerically) the identity —
 * i.e. NO grid cell is active. A non-identity matrix means a cell's tx/ty offset is
 * live, so the firmware's reported bounds are that CELL's bounds, NOT the full work
 * area — deriving a grid from them tiles the inside of the stale cell (art lands
 * squished/offset) and grid_clear "restores" the wrong area. Returns null when the
 * status has no matrix field (older firmware) — caller should assume live-is-full.
 */
export function isIdentityMatrix(
  m: unknown,
  eps = 1e-3,
): boolean | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const vals = [o.a, o.b, o.c, o.d, o.tx, o.ty].map(Number);
  if (!vals.every(isFinite)) return null;
  const [a, b, c, d, tx, ty] = vals;
  return Math.abs(a - 1) < eps && Math.abs(b) < eps && Math.abs(c) < eps &&
         Math.abs(d - 1) < eps && Math.abs(tx) < eps && Math.abs(ty) < eps;
}

export function gridClearQueries(gc: GridCtx): { boundsQuery: string; matrixQuery: string } {
  return {
    boundsQuery: `bounds?xn=${gc.full_xn}&xp=${gc.full_xp}&yn=${gc.full_yn}&yp=${gc.full_yp}&shape=0`,
    matrixQuery: "matrix?a=1&b=0&c=0&d=1&tx=0&ty=0",
  };
}

/* ---- Active-cell memory (browser-only; no-ops under node / the MCP bundle) ------
 * The console records the last grid cell IT activated so the UI can say WHICH cell
 * the live affine offset belongs to ("cell (1,2) of 3×3") and the Studio export can
 * embed the cell setup. Cells selected by other clients (MCP) are unknown here —
 * consumers must verify the stored centre still matches the live matrix tx/ty. */
export interface ActiveGridInfo extends GridCtx {
  col: number;
  row: number;
  cellW: number;
  cellH: number;
  cx: number;   /* cell centre in GLOBAL coords = the matrix tx/ty it was applied with */
  cy: number;
}

const ACTIVE_GRID_KEY = "plotter.activeGrid";

export function saveActiveGrid(info: ActiveGridInfo): void {
  try { localStorage.setItem(ACTIVE_GRID_KEY, JSON.stringify(info)); } catch { /* node / private mode */ }
}

export function clearActiveGrid(): void {
  try { localStorage.removeItem(ACTIVE_GRID_KEY); } catch { /* ignore */ }
}

export function loadActiveGrid(): ActiveGridInfo | null {
  try {
    const raw = localStorage.getItem(ACTIVE_GRID_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as ActiveGridInfo;
    const nums = [o.cols, o.rows, o.col, o.row, o.cellW, o.cellH, o.cx, o.cy];
    return nums.every((n) => isFinite(Number(n))) ? o : null;
  } catch { return null; }
}

/** The stored cell info, but ONLY if it matches the live matrix offset (i.e. the
 *  active cell really is the one the console selected — not stale, not MCP-set). */
export function activeGridMatching(
  m: { tx: number; ty: number } | undefined | null,
  tolMm = 0.5,
): ActiveGridInfo | null {
  if (!m) return null;
  const ag = loadActiveGrid();
  if (!ag) return null;
  return Math.abs(ag.cx - m.tx) <= tolMm && Math.abs(ag.cy - m.ty) <= tolMm ? ag : null;
}

/** Cell identification that SURVIVES a composed affine: matches the stored cell by the
 *  live matrix offset OR by the live firmware BOUNDS equalling the cell's ±W/2 × ±H/2
 *  clip. Once the user sculpts a cell-local affine (matrix tx/ty = centre + user offset),
 *  the tx/ty test fails but the bounds — which only grid_select/clear touch — still name
 *  the cell. */
export function activeCellFor(
  m: { tx: number; ty: number } | undefined | null,
  liveBounds: { xn: number; xp: number; yn: number; yp: number } | undefined | null,
  tolMm = 0.5,
): ActiveGridInfo | null {
  const byMatrix = activeGridMatching(m, tolMm);
  if (byMatrix) return byMatrix;
  if (!liveBounds) return null;
  const ag = loadActiveGrid();
  if (!ag) return null;
  const bw = Math.abs(liveBounds.xn + ag.cellW / 2) <= tolMm && Math.abs(liveBounds.xp - ag.cellW / 2) <= tolMm;
  const bh = Math.abs(liveBounds.yn + ag.cellH / 2) <= tolMm && Math.abs(liveBounds.yp - ag.cellH / 2) <= tolMm;
  return bw && bh ? ag : null;
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