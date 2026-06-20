// Host test for the v1.3 Frame compiler (Day 1 / S1).
// Run: cd console && npx tsx test/compile.test.ts
import { compile } from "../src/lib/compile.ts";
import { rectPath, frameBounds, type Frame } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

// ---- [1] a 100x100 box centred at origin ----
console.log("[1] compile a closed box");
{
  const frame: Frame = { widthMm: 100, heightMm: 100, paths: [rectPath(0, 0, 100, 100)] };
  const q = compile(frame);
  ok("starts pen up", q[0] === "pen?pos=up");
  ok("travels to first corner", q[1] === "goto?x=-50&y=-50", q[1]);
  ok("drops pen before drawing", q[2] === "pen?pos=down");
  const lines = q.filter((s) => s.startsWith("line?"));
  ok("closed box = 4 line segments", lines.length === 4, `got ${lines.length}`);
  ok("every segment is lift=0 (continuous)", lines.every((s) => s.includes("&lift=0")));
  ok("closing segment returns to start",
     lines[3] === "line?x0=-50&y0=50&x1=-50&y1=-50&cycles=1&lift=0", lines[3]);
  ok("ends pen up", q[q.length - 1] === "pen?pos=up");
}

// ---- [2] open path: no closing segment, one pen-down run ----
console.log("[2] open polyline");
{
  const frame: Frame = {
    widthMm: 100, heightMm: 100,
    paths: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
  };
  const q = compile(frame);
  const lines = q.filter((s) => s.startsWith("line?"));
  ok("open path = 2 segments", lines.length === 2, `got ${lines.length}`);
  ok("exactly one pen down", q.filter((s) => s === "pen?pos=down").length === 1);
}

// ---- [3] cycles propagate ----
console.log("[3] cycles");
{
  const frame: Frame = {
    widthMm: 100, heightMm: 100,
    paths: [{ points: [{ x: 0, y: 0 }, { x: 20, y: 0 }], cycles: 3 }],
  };
  const q = compile(frame);
  ok("cycles=3 in segment", q.some((s) => s.includes("&cycles=3&")), JSON.stringify(q));
}

// ---- [4] frame helpers ----
console.log("[4] frameBounds / rectPath");
{
  const b = frameBounds({ widthMm: 0, heightMm: 0, paths: [rectPath(10, 20, 40, 60)] });
  ok("bbox matches rect", !!b && b.x0 === -10 && b.x1 === 30 && b.y0 === -10 && b.y1 === 50,
     JSON.stringify(b));
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
