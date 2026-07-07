// Run: cd console && npx tsx test/gridScript.test.ts
import {
  normalizeMetadataWorkArea,
  gridCtxFromPlotterBounds,
  computeCell,
  resolveGridCtx,
  isIdentityMatrix,
  activeCellFor,
} from "../src/lib/gridScript.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

// Console DEFAULTS.bounds: Down(+Y)=115, Up(−Y)=273
const plotterBounds = { left: 276, right: 263, up: 115, down: 273, shape: "rect" as const };

console.log("[1] normalize UI-label metadata (y_min=-273, y_max=115)");
{
  const wa = normalizeMetadataWorkArea({ x_min: -276, x_max: 263, y_min: -273, y_max: 115 });
  ok("yn matches boundsToQuery", wa.yn === -115, `yn=${wa.yn}`);
  ok("yp matches boundsToQuery", wa.yp === 273, `yp=${wa.yp}`);
}

console.log("[2] plotter bounds → same firmware work area");
{
  const gc = gridCtxFromPlotterBounds(plotterBounds, { cols: 5, rows: 5, padding_mm: 10 });
  ok("full_yn", gc.full_yn === -115, `yn=${gc.full_yn}`);
  ok("full_yp", gc.full_yp === 273, `yp=${gc.full_yp}`);
  const c00 = computeCell(gc, 0, 0);
  const c40 = computeCell(gc, 0, 4);
  ok("row 0 above row 4 (smaller cy)", c00.cy < c40.cy, `cy0=${c00.cy} cy4=${c40.cy}`);
}

console.log("[3] resolveGridCtx: live bounds override flipped inline full_*");
{
  // The real machine work area (top yn=-115, bottom yp=273).
  const live = gridCtxFromPlotterBounds(plotterBounds, { cols: 4, rows: 4, padding_mm: 5 });
  // A grid_select command carrying Y-FLIPPED inline bounds (the bug we saw).
  const flippedCmd = {
    type: "grid_select", cols: 4, rows: 4, padding_mm: 5, col: 0, row: 0,
    full_xn: -276, full_xp: 263, full_yn: -273, full_yp: 115,   // upside-down
  };
  const gc = resolveGridCtx(flippedCmd, live)!;
  ok("bounds taken from live machine, not inline", gc.full_yn === -115 && gc.full_yp === 273,
     `yn=${gc.full_yn} yp=${gc.full_yp}`);
  ok("shape (cols/rows/padding) kept from command", gc.cols === 4 && gc.rows === 4 && gc.padding_mm === 5);
  const c00 = computeCell(gc, 0, 0);
  ok("row 0 cell now inside the real top bound (cy > -115)", c00.cy > -115, `cy0=${c00.cy}`);

  // No live ctx → fall back to the command's own bounds (legacy self-contained behaviour).
  const legacy = resolveGridCtx(flippedCmd, null)!;
  ok("legacy fallback uses inline bounds when no live ctx", legacy.full_yn === -273 && legacy.full_yp === 115);

  // grid_clear (no cols/rows) still gets authoritative bounds.
  const clr = resolveGridCtx({ type: "grid_clear", full_xn: -276, full_xp: 263, full_yn: -273, full_yp: 115 }, live)!;
  ok("grid_clear bounds from live ctx", clr.full_yn === -115 && clr.full_yp === 273);
}

console.log("[7] activeCellFor — cell identity that survives a cell-local affine");
{
  // simulate a stored active-grid record via a localStorage shim
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  const ag = { cols: 3, rows: 3, padding_mm: 5, full_xn: -276, full_xp: 263, full_yn: -115, full_yp: 273,
               col: 1, row: 2, cellW: 87.6, cellH: 74.3, cx: 45, cy: -12 };
  store["plotter.activeGrid"] = JSON.stringify(ag);
  const cellBounds = { xn: -43.8, xp: 43.8, yn: -37.15, yp: 37.15 };
  ok("pure placement matches by matrix",
     activeCellFor({ tx: 45, ty: -12 }, cellBounds)?.col === 1);
  ok("COMPOSED affine (tx shifted) still matches by BOUNDS",
     activeCellFor({ tx: 45 + 10, ty: -12 - 4 }, cellBounds)?.col === 1);
  ok("composed + no bounds -> null (cannot confirm)",
     activeCellFor({ tx: 55, ty: -16 }, null) === null);
  ok("full-area bounds -> no cell",
     activeCellFor({ tx: 55, ty: -16 }, { xn: -276, xp: 263, yn: -115, yp: 273 }) === null);
  delete store["plotter.activeGrid"];
  ok("no record -> null", activeCellFor({ tx: 45, ty: -12 }, cellBounds) === null);
}

console.log("[6] isIdentityMatrix — stale-cell detection from /api/status");
{
  ok("identity matrix -> true",
     isIdentityMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }) === true);
  ok("float-noise identity -> true",
     isIdentityMatrix({ a: 1.0004, b: -0.0002, c: 0, d: 0.9997, tx: 0.0005, ty: -0.0009 }) === true);
  ok("cell offset (tx/ty) -> false (cell active)",
     isIdentityMatrix({ a: 1, b: 0, c: 0, d: 1, tx: -87.5, ty: 42.3 }) === false);
  ok("rotation/shear -> false",
     isIdentityMatrix({ a: 0.9, b: 0.1, c: -0.1, d: 0.9, tx: 0, ty: 0 }) === false);
  ok("missing field -> null (old firmware)", isIdentityMatrix({ a: 1, b: 0 }) === null);
  ok("no matrix at all -> null", isIdentityMatrix(undefined) === null);
  ok("garbage -> null", isIdentityMatrix("nope") === null);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);