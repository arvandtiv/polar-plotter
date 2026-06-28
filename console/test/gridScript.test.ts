// Run: cd console && npx tsx test/gridScript.test.ts
import {
  normalizeMetadataWorkArea,
  gridCtxFromPlotterBounds,
  computeCell,
  resolveGridCtx,
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

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);