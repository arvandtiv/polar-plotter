// Host test for the moiré curtain + pattern maker generators (Days 14-15 / S9).
// Run: cd console && npx tsx test/patterns2.test.ts
import { moireCurtainModule } from "../src/lib/modules/moire-curtain.ts";
import { patternMakerModule } from "../src/lib/modules/pattern-maker.ts";
import { frameBounds } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

console.log("[1] moiré curtain");
{
  const f = moireCurtainModule.generate({ w: 200, h: 200, spacing: 4, angle: 90, offsetAngle: 6, cx: 0, cy: 0 }, ctx);
  ok("two gratings → many lines", f.paths.length > 40, `paths=${f.paths.length}`);
  ok("each path is a clipped segment", f.paths.every((p) => p.points.length === 2));
  const b = frameBounds(f)!;
  ok("clipped within the field", b.x0 >= -101 && b.x1 <= 101 && b.y0 >= -101 && b.y1 <= 101, JSON.stringify(b));
  // wider spacing → fewer lines
  const sparse = moireCurtainModule.generate({ w: 200, h: 200, spacing: 10, angle: 90, offsetAngle: 6, cx: 0, cy: 0 }, ctx);
  ok("wider spacing → fewer lines", sparse.paths.length < f.paths.length);
}

console.log("[2] pattern maker");
{
  const f = patternMakerModule.generate({ shape: "square", fillRatio: 0.8, rotateStep: 7, cols: 8, rows: 6, cell: 24, cx: 0, cy: 0 }, ctx);
  ok("one path per cell (8×6=48)", f.paths.length === 48, `paths=${f.paths.length}`);
  ok("cells are closed", f.paths.every((p) => p.closed === true));
  const b = frameBounds(f)!;
  ok("grid spans ≈ cols×cell", Math.abs((b.x1 - b.x0) - (8 - 1 + 0.8) * 24) < 24, JSON.stringify(b));
  // rotation changes geometry
  const noRot = patternMakerModule.generate({ shape: "square", fillRatio: 0.8, rotateStep: 0, cols: 8, rows: 6, cell: 24, cx: 0, cy: 0 }, ctx);
  ok("rotateStep changes output", JSON.stringify(noRot.paths) !== JSON.stringify(f.paths));
  ok("circle option = 32-gon cells", patternMakerModule.generate({ shape: "circle", cols: 2, rows: 1, cell: 20, fillRatio: 1, rotateStep: 0, cx: 0, cy: 0 }, ctx).paths[0].points.length === 32);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
