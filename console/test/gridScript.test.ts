// Run: cd console && npx tsx test/gridScript.test.ts
import {
  normalizeMetadataWorkArea,
  gridCtxFromPlotterBounds,
  computeCell,
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

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);