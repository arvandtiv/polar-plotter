// Host test for the spirograph + orbital weave generators (Days 12-13 / S8).
// Run: cd console && npx tsx test/patterns.test.ts
import { spirographModule } from "../src/lib/modules/spirograph.ts";
import { orbitalWeaveModule } from "../src/lib/modules/orbital-weave.ts";
import { frameBounds } from "../src/lib/frame.ts";
import { dist } from "../src/lib/geom.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

console.log("[1] spirograph");
{
  const f = spirographModule.generate({ R: 80, r: 30, d: 50, type: "hypo", cx: 0, cy: 0, cycles: 1 }, ctx);
  const pts = f.paths[0].points;
  ok("has a dense trace", pts.length > 200, `pts=${pts.length}`);
  const b = frameBounds(f)!;
  const span = (80 - 30) + 50;          // base + pen offset
  ok("within ±span envelope", b.x1 <= span + 1 && b.x0 >= -span - 1, JSON.stringify(b));
  // closed-form ⇒ deterministic
  const g = spirographModule.generate({ R: 80, r: 30, d: 50, type: "hypo", cx: 0, cy: 0, cycles: 1 }, ctx);
  ok("deterministic", JSON.stringify(g.paths) === JSON.stringify(f.paths));
  // hypo and epi differ
  const e = spirographModule.generate({ R: 80, r: 30, d: 50, type: "epi", cx: 0, cy: 0, cycles: 1 }, ctx);
  ok("epi ≠ hypo", JSON.stringify(e.paths) !== JSON.stringify(f.paths));
}

console.log("[2] orbital weave");
{
  const f = orbitalWeaveModule.generate(
    { orbitRadius: 50, orbitTurns: 1, majorRadius: 24, minorRadius: 24, traceTurns: 13, cx: 0, cy: 0, cycles: 1 }, ctx);
  const pts = f.paths[0].points;
  ok("dense trace", pts.length > 240, `pts=${pts.length}`);
  // integer turns ⇒ first and last points coincide (a closed weave)
  ok("returns to start", dist(pts[0], pts[pts.length - 1]) < 1e-6,
     `${dist(pts[0], pts[pts.length - 1])}`);
  const b = frameBounds(f)!;
  const span = 50 + 24;
  ok("within orbit+loop envelope", b.x1 <= span + 1 && b.y1 <= span + 1, JSON.stringify(b));
  const g = orbitalWeaveModule.generate(
    { orbitRadius: 50, orbitTurns: 1, majorRadius: 24, minorRadius: 24, traceTurns: 13, cx: 0, cy: 0, cycles: 1 }, ctx);
  ok("deterministic", JSON.stringify(g.paths) === JSON.stringify(f.paths));
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
