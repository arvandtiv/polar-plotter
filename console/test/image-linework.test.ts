// Host test for image iso-contour linework (Day 21 / S15).
// Run: cd console && npx tsx test/image-linework.test.ts
import { isoContours, imageLineworkModule } from "../src/lib/modules/image-linework.ts";
import { frameBounds } from "../src/lib/frame.ts";
import type { GrayImage } from "../src/lib/registry.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

// horizontal gradient: gray increases left→right from 0..1
function gradient(w: number, h: number): GrayImage {
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = x / (w - 1);
  return { width: w, height: h, gray };
}

console.log("[1] isoContours on a gradient");
{
  const img = gradient(11, 8);
  const segs = isoContours(img.gray, img.width, img.height, 0.5);
  ok("produces contour segments", segs.length > 0, `segs=${segs.length}`);
  // level 0.5 on x/(w-1) → contour at x = 0.5*(w-1) = 5
  const allNearMid = segs.every(([a, b]) => Math.abs((a.x + b.x) / 2 - 5) < 1.0);
  ok("contour sits at the mid-brightness column", allNearMid, JSON.stringify(segs[0]));
  // empty (uniform) image → no contour
  const flat = new Float32Array(11 * 8).fill(0.5);
  ok("uniform image → no contours", isoContours(flat, 11, 8, 0.5).length === 0);
}

console.log("[2] module fits into the plot box");
{
  const img = gradient(20, 16);
  const f = imageLineworkModule.generate({ levels: 6, invert: false, plotSize: 200, cx: 0, cy: 0 }, { ...ctx, image: img });
  ok("paths produced", f.paths.length > 0, `paths=${f.paths.length}`);
  const b = frameBounds(f)!;
  ok("within ±100 plot box", b.x0 >= -101 && b.x1 <= 101 && b.y0 >= -101 && b.y1 <= 101, JSON.stringify(b));
  // 20×16 image, fit scale 10; contour corners span rows 0..15 → 150 mm tall
  ok("contours span the image-fit height (~150)", Math.abs((b.y1 - b.y0) - 150) < 6, `h=${(b.y1 - b.y0).toFixed(1)}`);
}

console.log("[3] no image → empty (safe)");
{
  ok("empty paths without an image", imageLineworkModule.generate({ levels: 6, invert: false, plotSize: 200, cx: 0, cy: 0 }, ctx).paths.length === 0);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
