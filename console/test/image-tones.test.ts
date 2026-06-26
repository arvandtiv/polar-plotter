// Host test for halftone + squiggle image generators (Day 22 / S16).
// Run: cd console && npx tsx test/image-tones.test.ts
import { sampleGray } from "../src/lib/image.ts";
import { imageHalftoneModule } from "../src/lib/modules/image-halftone.ts";
import { imageSquiggleModule } from "../src/lib/modules/image-squiggle.ts";
import { bounds } from "../src/lib/geom.ts";
import type { GrayImage } from "../src/lib/registry.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };
const fill = (w: number, h: number, v: number): GrayImage => ({ width: w, height: h, gray: new Float32Array(w * h).fill(v) });
// top half dark (0), bottom half light (1)
function topDark(w: number, h: number): GrayImage {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = y < h / 2 ? 0 : 1;
  return { width: w, height: h, gray: g };
}

console.log("[1] sampleGray");
{
  ok("samples a flat image", Math.abs(sampleGray(fill(8, 8, 0.5), 3.5, 2.2) - 0.5) < 1e-6);
}

console.log("[2] halftone: darkness → dots");
{
  const dark = imageHalftoneModule.generate({ spacing: 10, maxDot: 6, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: fill(20, 20, 0) });
  const light = imageHalftoneModule.generate({ spacing: 10, maxDot: 6, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: fill(20, 20, 1) });
  ok("dark image → many dots", dark.paths.length > 50, `dots=${dark.paths.length}`);
  ok("white image → no dots", light.paths.length === 0, `dots=${light.paths.length}`);
  ok("dots are closed circles", dark.paths.every((p) => p.closed && p.points.length === 12));
  ok("no image → empty", imageHalftoneModule.generate({ spacing: 10, maxDot: 6, invert: false, plotSize: 200, cx: 0, cy: 0 }, ctx).paths.length === 0);
}

console.log("[3] squiggle: darkness → amplitude");
{
  const f = imageSquiggleModule.generate({ rowSpacing: 8, wavelength: 6, maxAmp: 4, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: topDark(20, 20) });
  ok("one path per row", f.paths.length > 1, `rows=${f.paths.length}`);
  const ampOf = (p: { points: { x: number; y: number }[] }) => { const b = bounds(p.points)!; return b.y1 - b.y0; };
  const topRow = f.paths[0], bottomRow = f.paths[f.paths.length - 1];
  ok("dark (top) row wiggles more than light (bottom) row", ampOf(topRow) > ampOf(bottomRow) + 1,
     `top=${ampOf(topRow).toFixed(1)} bottom=${ampOf(bottomRow).toFixed(1)}`);
  ok("rows are open strokes", f.paths.every((p) => !p.closed));
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
