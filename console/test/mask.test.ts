// Host test for polyline clipping + the Shape Mask modifier (Day 17 / S11).
// Run: cd console && npx tsx test/mask.test.ts
import { pointInPolygon, clipPolylineToPolygon } from "../src/lib/clip.ts";
import { maskModule } from "../src/lib/modules/mask.ts";
import { dist } from "../src/lib/geom.ts";
import type { Frame, Pt } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };
const square = (h: number): Pt[] => [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];

console.log("[1] point in polygon");
{
  ok("inside", pointInPolygon({ x: 0, y: 0 }, square(50)));
  ok("outside", !pointInPolygon({ x: 100, y: 0 }, square(50)));
}

console.log("[2] clip a line to a square region");
{
  const line: Pt[] = [{ x: -100, y: 0 }, { x: 100, y: 0 }];
  const inside = clipPolylineToPolygon(line, square(50), true);
  ok("one inside piece", inside.length === 1, `pieces=${inside.length}`);
  ok("piece spans roughly -50..50", Math.abs(inside[0][0].x) - 50 < 0.01 && Math.abs(inside[0][1].x) - 50 < 0.01,
     JSON.stringify(inside[0]));
  const outside = clipPolylineToPolygon(line, square(50), false);
  ok("two outside pieces", outside.length === 2, `pieces=${outside.length}`);
}

console.log("[3] mask modifier clips lowerFrame");
{
  const lower: Frame = { widthMm: 0, heightMm: 0, paths: [{ points: [{ x: -100, y: 0 }, { x: 100, y: 0 }] }] };
  const f = maskModule.generate(
    { shape: "circle", mode: "inside", size: 50, sides: 6, rotation: 0, showMask: false, cx: 0, cy: 0 },
    { ...ctx, lowerFrame: lower });
  ok("kept one clipped stroke", f.paths.length === 1, `paths=${f.paths.length}`);
  const p = f.paths[0].points;
  ok("clipped near ±50 (circle radius)", Math.abs(dist(p[0], p[p.length - 1]) - 100) < 1, `len=${dist(p[0], p[p.length - 1])}`);

  const withMask = maskModule.generate(
    { shape: "circle", mode: "inside", size: 50, sides: 6, rotation: 0, showMask: true, cx: 0, cy: 0 },
    { ...ctx, lowerFrame: lower });
  ok("showMask adds the outline path", withMask.paths.length === 2 && withMask.paths[1].closed === true);

  const outside = maskModule.generate(
    { shape: "circle", mode: "outside", size: 50, sides: 6, rotation: 0, showMask: false, cx: 0, cy: 0 },
    { ...ctx, lowerFrame: lower });
  ok("outside mode keeps the two tails", outside.paths.length === 2, `paths=${outside.paths.length}`);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
