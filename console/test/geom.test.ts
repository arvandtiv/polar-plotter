// Host test for the v1.3 geometry toolkit (Day 2 / S2).
// Run: cd console && npx tsx test/geom.test.ts
import {
  bounds, polylineLength, resample, translate, rotate, scale,
  sampleBezier, seededRandom, fitToBounds,
} from "../src/lib/geom.ts";
import { rectPath, frameBounds, type Frame } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log("[1] bounds + length");
{
  const pts = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }];
  const b = bounds(pts)!;
  ok("bbox correct", b.x0 === 0 && b.y0 === 0 && b.x1 === 3 && b.y1 === 4, JSON.stringify(b));
  ok("length 3+4=7", approx(polylineLength(pts), 7));
  ok("empty bounds null", bounds([]) === null);
}

console.log("[2] resample keeps endpoints, ~uniform spacing");
{
  const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const rs = resample(line, 2);
  ok("first preserved", rs[0].x === 0 && rs[0].y === 0);
  ok("last preserved", approx(rs[rs.length - 1].x, 10));
  ok("≈ 6 points (0..10 step 2)", rs.length === 6, `got ${rs.length}`);
  let uniform = true;
  for (let i = 1; i < rs.length - 1; i++) if (!approx(rs[i].x - rs[i - 1].x, 2, 1e-6)) uniform = false;
  ok("interior spacing = 2", uniform);
}

console.log("[3] affine transforms");
{
  const p = [{ x: 1, y: 0 }];
  ok("translate", translate(p, 2, 3)[0].x === 3 && translate(p, 2, 3)[0].y === 3);
  ok("scale about origin", scale(p, 2)[0].x === 2);
  const r = rotate([{ x: 1, y: 0 }], Math.PI / 2)[0];
  ok("rotate 90°", approx(r.x, 0) && approx(r.y, 1), `${r.x},${r.y}`);
}

console.log("[4] bezier");
{
  const b = sampleBezier({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, 10);
  ok("11 samples", b.length === 11, `got ${b.length}`);
  ok("starts at p0", b[0].x === 0);
  ok("ends at p3", approx(b[10].x, 10));
  ok("midpoint on axis", approx(b[5].y, 0));
}

console.log("[5] seededRandom deterministic");
{
  const a = seededRandom(42), b = seededRandom(42), c = seededRandom(7);
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  ok("same seed → same stream", JSON.stringify(sa) === JSON.stringify(sb));
  ok("diff seed → diff stream", JSON.stringify(sa) !== JSON.stringify(sc));
  ok("in [0,1)", sa.every((v) => v >= 0 && v < 1));
}

console.log("[6] fitToBounds: shrink-to-fit + centre, aspect preserved");
{
  // 200×100 box → fit into a 100×100 target → scale 0.5, centred at target centre
  const frame: Frame = { widthMm: 0, heightMm: 0, paths: [rectPath(999, -999, 200, 100)] };
  const fitted = fitToBounds(frame, { x0: -50, y0: -50, x1: 50, y1: 50 });
  const b = frameBounds(fitted)!;
  ok("scaled to 100×50 (0.5×)", approx(b.x1 - b.x0, 100) && approx(b.y1 - b.y0, 50), JSON.stringify(b));
  ok("centred at origin", approx((b.x0 + b.x1) / 2, 0) && approx((b.y0 + b.y1) / 2, 0));
  // smaller-than-target stays original size (never enlarged)
  const small: Frame = { widthMm: 0, heightMm: 0, paths: [rectPath(0, 0, 20, 20)] };
  const sb = frameBounds(fitToBounds(small, { x0: -50, y0: -50, x1: 50, y1: 50 }))!;
  ok("small box not enlarged", approx(sb.x1 - sb.x0, 20));
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
