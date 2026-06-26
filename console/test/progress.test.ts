// Host test for buildProgressPaths (drawing-order scrubber) — Day 24 / S17.
// Run: cd console && npx tsx test/progress.test.ts
import { buildProgressPaths } from "../src/lib/toolpath.ts";
import { polylineLength } from "../src/lib/geom.ts";
import type { Frame } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

// two 100mm horizontal segments → total drawn length 200
const frame: Frame = {
  widthMm: 100, heightMm: 0, paths: [
    { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { points: [{ x: 0, y: 10 }, { x: 100, y: 10 }] },
  ],
};
const totalLen = (f: Frame) => f.paths.reduce((s, p) => s + polylineLength(p.points), 0);

console.log("[1] endpoints");
{
  ok("0% → nothing", buildProgressPaths(frame, 0).paths.length === 0);
  ok("100% → full length", Math.abs(totalLen(buildProgressPaths(frame, 1)) - 200) < 1e-6);
}

console.log("[2] partial");
{
  const half = buildProgressPaths(frame, 0.5);
  ok("50% → ~100mm drawn", Math.abs(totalLen(half) - 100) < 1e-6, `len=${totalLen(half)}`);
  ok("50% → just the first path complete", half.paths.length === 1);

  const q3 = buildProgressPaths(frame, 0.75);
  ok("75% → ~150mm drawn", Math.abs(totalLen(q3) - 150) < 1e-6, `len=${totalLen(q3)}`);
  ok("75% → first path + half of second", q3.paths.length === 2);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
