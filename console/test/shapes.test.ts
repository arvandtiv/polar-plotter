// Host test for the circle + square generators (Days 6-7 / S5).
// Run: cd console && npx tsx test/shapes.test.ts
import { circleModule, arcSegments } from "../src/lib/modules/circle.ts";
import { squareModule } from "../src/lib/modules/square.ts";
import { frameBounds } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const approx = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

console.log("[1] circle");
{
  const f = circleModule.generate({ r: 50, cx: 10, cy: -20, cycles: 2 }, ctx);
  const b = frameBounds(f)!;
  ok("diameter ≈ 100", approx(b.x1 - b.x0, 100) && approx(b.y1 - b.y0, 100), JSON.stringify(b));
  ok("centred at (10,-20)", approx((b.x0 + b.x1) / 2, 10) && approx((b.y0 + b.y1) / 2, -20));
  ok("closed path", f.paths[0].closed === true);
  ok("cycles propagate", f.paths[0].cycles === 2);
  ok("bigger radius → more segments", arcSegments(200, 0.2) > arcSegments(20, 0.2));
  ok("segments clamped ≥ 8", arcSegments(0.1, 0.2) >= 8);
  ok("segments clamped ≤ 720", arcSegments(1e6, 0.001) <= 720);
}

console.log("[2] square");
{
  const f = squareModule.generate({ size: 100, cx: 0, cy: 0, rotation: 0, cycles: 1 }, ctx);
  const b = frameBounds(f)!;
  ok("unrotated bbox = 100×100", approx(b.x1 - b.x0, 100) && approx(b.y1 - b.y0, 100), JSON.stringify(b));
  ok("4 corners closed", f.paths[0].points.length === 4 && f.paths[0].closed === true);

  const r = squareModule.generate({ size: 100, cx: 0, cy: 0, rotation: 45, cycles: 1 }, ctx);
  const rb = frameBounds(r)!;
  const diag = 100 * Math.SQRT2;
  ok("rotated 45° bbox = diagonal", approx(rb.x1 - rb.x0, diag) && approx(rb.y1 - rb.y0, diag),
     `${(rb.x1 - rb.x0).toFixed(1)} vs ${diag.toFixed(1)}`);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
