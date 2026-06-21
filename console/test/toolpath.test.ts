// Host test for travel optimization + wobbly generator (Days 8-9 / S6).
// Run: cd console && npx tsx test/toolpath.test.ts
import { optimizeOrder, travelDistance } from "../src/lib/toolpath.ts";
import { wobblyModule } from "../src/lib/modules/wobbly.ts";
import { frameBounds, type Frame } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

console.log("[1] optimizeOrder cuts pen-up travel");
{
  // deliberately bad order: zig-zag across the page
  const frame: Frame = {
    widthMm: 100, heightMm: 10, paths: [
      { points: [{ x: 0, y: 0 }, { x: 0, y: 10 }] },
      { points: [{ x: 100, y: 0 }, { x: 100, y: 10 }] },
      { points: [{ x: 10, y: 0 }, { x: 10, y: 10 }] },
    ],
  };
  const before = travelDistance(frame);
  const opt = optimizeOrder(frame);
  const after = travelDistance(opt);
  ok("travel reduced", after < before, `before=${before.toFixed(1)} after=${after.toFixed(1)}`);
  ok("same number of paths", opt.paths.length === frame.paths.length);
  // every original segment still present (as an unordered set of endpoint-pairs)
  const key = (p: { points: { x: number; y: number }[] }) => {
    const a = p.points[0], b = p.points[p.points.length - 1];
    return [a.x, a.y, b.x, b.y].join() < [b.x, b.y, a.x, a.y].join()
      ? `${a.x},${a.y}-${b.x},${b.y}` : `${b.x},${b.y}-${a.x},${a.y}`;
  };
  const sa = frame.paths.map(key).sort().join("|");
  const sb = opt.paths.map(key).sort().join("|");
  ok("same segment set (only reordered/reversed)", sa === sb);
}

console.log("[2] optimizeOrder is deterministic");
{
  const frame: Frame = {
    widthMm: 0, heightMm: 0, paths: [
      { points: [{ x: 5, y: 5 }, { x: 6, y: 6 }] },
      { points: [{ x: -20, y: 3 }, { x: -10, y: 3 }] },
    ],
  };
  ok("same input → same output",
     JSON.stringify(optimizeOrder(frame)) === JSON.stringify(optimizeOrder(frame)));
}

console.log("[3] wobbly generator");
{
  const f = wobblyModule.generate({ r: 60, wobble: 0.4, harmonics: 3, seed: 42, cx: 0, cy: 0, cycles: 1 }, ctx);
  ok("closed path", f.paths[0].closed === true);
  ok("has many points", f.paths[0].points.length >= 120);
  const b = frameBounds(f)!;
  ok("stays within wobble envelope", (b.x1 - b.x0) <= 2 * 60 * (1 + 0.4) + 1, JSON.stringify(b));

  const a = wobblyModule.generate({ r: 60, wobble: 0.4, harmonics: 3, seed: 42, cx: 0, cy: 0, cycles: 1 }, ctx);
  const c = wobblyModule.generate({ r: 60, wobble: 0.4, harmonics: 3, seed: 7, cx: 0, cy: 0, cycles: 1 }, ctx);
  ok("same seed → identical", JSON.stringify(a.paths) === JSON.stringify(f.paths));
  ok("different seed → different", JSON.stringify(c.paths) !== JSON.stringify(f.paths));
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
