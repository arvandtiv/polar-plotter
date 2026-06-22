// Host test for the Depth Map (image-surface) generator.
// Run: cd console && npx tsx test/image-surface.test.ts
import { imageSurfaceModule } from "../src/lib/modules/image-surface.ts";
import { bounds } from "../src/lib/geom.ts";
import type { GrayImage } from "../src/lib/registry.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

// bright band across the middle image rows, dark top/bottom
function band(w: number, h: number): GrayImage {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (y > h * 0.4 && y < h * 0.6) ? 1 : 0;
  return { width: w, height: h, gray: g };
}

console.log("[1] one open stroke per row");
{
  const f = imageSurfaceModule.generate({ rows: 40, height: 20, shear: 0.4, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: band(40, 40) });
  ok("rows = 40 paths", f.paths.length === 40, `paths=${f.paths.length}`);
  ok("rows are open strokes", f.paths.every((p) => !p.closed));
  ok("each row has many points", f.paths[0].points.length > 10);
}

console.log("[2] brightness lifts a row by ~height");
{
  // same bright band row, height 0 vs 30 → the row should rise by ~30 (bright v≈1)
  const flat = imageSurfaceModule.generate({ rows: 40, height: 0, shear: 0, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: band(40, 40) });
  const tall = imageSurfaceModule.generate({ rows: 40, height: 30, shear: 0, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: band(40, 40) });
  const yMid = (f: typeof flat, i: number) => f.paths[i].points[10].y;   // row 20 is over the bright band
  ok("bright band row lifted ~30mm", Math.abs((yMid(flat, 20) - yMid(tall, 20)) - 30) < 1.5,
     `lift=${(yMid(flat, 20) - yMid(tall, 20)).toFixed(1)}`);
  ok("dark row barely lifts", Math.abs(yMid(flat, 2) - yMid(tall, 2)) < 1.5);
  void bounds;
}

console.log("[3] shear leans rows (front row offset right of back row)");
{
  const f = imageSurfaceModule.generate({ rows: 30, height: 0, shear: 0.5, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: band(30, 30) });
  const backX0 = f.paths[0].points[0].x;
  const frontX0 = f.paths[f.paths.length - 1].points[0].x;
  ok("front row sheared right of back row", frontX0 > backX0 + 10, `back=${backX0.toFixed(1)} front=${frontX0.toFixed(1)}`);
}

console.log("[4] no image → empty (safe)");
{
  ok("empty without image", imageSurfaceModule.generate({ rows: 40, height: 20, shear: 0.4, invert: false, plotSize: 200, cx: 0, cy: 0 }, ctx).paths.length === 0);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
