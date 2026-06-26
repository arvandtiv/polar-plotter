// Host test for arc fitting (Day 26 / S19).
// Run: cd console && npx tsx test/arcfit.test.ts
import { fitArcs, type ArcSeg } from "../src/lib/arcfit.ts";
import type { Pt } from "../src/lib/frame.ts";
import { compile } from "../src/lib/compile.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

const sampleArc = (cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] =>
  Array.from({ length: n + 1 }, (_, k) => { const a = a0 + (a1 - a0) * (k / n); return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; });

console.log("[1] a sampled circle → arc(s) with the right radius/centre");
{
  const pts = sampleArc(10, -5, 50, 0, 2 * Math.PI, 48);
  const prims = fitArcs(pts, 0.3);
  const arcs = prims.filter((p): p is ArcSeg => p.kind === "arc");
  ok("at least one arc", arcs.length >= 1, `arcs=${arcs.length}, prims=${prims.length}`);
  ok("radius ≈ 50", arcs.every((a) => Math.abs(a.r - 50) < 0.5), JSON.stringify(arcs.map((a) => +a.r.toFixed(1))));
  ok("centre ≈ (10,-5)", arcs.every((a) => Math.abs(a.cx - 10) < 0.5 && Math.abs(a.cy + 5) < 0.5));
  // arc primitives should dominate (few line bits at most)
  ok("mostly arcs", prims.filter((p) => p.kind === "line").length <= 1);
}

console.log("[2] a square (corners) → all lines, no arcs");
{
  const sq: Pt[] = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }, { x: -50, y: -50 }];
  const prims = fitArcs(sq, 0.3);
  ok("no arcs on a polygon", prims.every((p) => p.kind === "line"), JSON.stringify(prims.map((p) => p.kind)));
}

console.log("[3] a straight line → one line, no arc");
{
  const line = Array.from({ length: 10 }, (_, k) => ({ x: k * 5, y: 0 }));
  const prims = fitArcs(line, 0.3);
  ok("collinear → no arc", prims.every((p) => p.kind === "line"));
}

console.log("[4] direction (cw flag) reflects sweep");
{
  const ccw = fitArcs(sampleArc(0, 0, 40, 0, Math.PI, 24), 0.3).find((p): p is ArcSeg => p.kind === "arc");
  const cw = fitArcs(sampleArc(0, 0, 40, 0, -Math.PI, 24), 0.3).find((p): p is ArcSeg => p.kind === "arc");
  ok("ccw arc detected", !!ccw && ccw.cw === false, `cw=${ccw?.cw}`);
  ok("cw arc detected", !!cw && cw.cw === true, `cw=${cw?.cw}`);
}

console.log("[5] compile arcTol opt-in emits arc jobs; default stays line-only");
{
  const circle: Pt[] = sampleArc(0, 0, 40, 0, 2 * Math.PI, 40);
  const frame = { widthMm: 80, heightMm: 80, paths: [{ points: circle, closed: true }] };
  const lineOnly = compile(frame);                       // default — no arcs
  const withArcs = compile(frame, { arcTol: 0.3 });      // opt-in
  ok("default emits no arc jobs", !lineOnly.some((q) => q.startsWith("arc?")));
  ok("arcTol emits arc job(s)", withArcs.some((q) => q.startsWith("arc?")), JSON.stringify(withArcs.filter((q) => q.startsWith("arc?"))));
  ok("arcs cut the op count", withArcs.length < lineOnly.length, `${withArcs.length} < ${lineOnly.length}`);
  // a box is unaffected even with arcTol on
  const box: Pt[] = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }];
  const boxArcs = compile({ widthMm: 100, heightMm: 100, paths: [{ points: box, closed: true }] }, { arcTol: 0.3 });
  ok("box never becomes an arc", !boxArcs.some((q) => q.startsWith("arc?")));
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
