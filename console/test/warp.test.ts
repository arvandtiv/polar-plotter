// Host test for the Warp / Ripple modifier (Day 19 / S13).
// Run: cd console && npx tsx test/warp.test.ts
import { warpModule } from "../src/lib/modules/warp.ts";
import { dist } from "../src/lib/geom.ts";
import type { Frame, Pt } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };
const line = (): Pt[] => [{ x: -100, y: 0 }, { x: -50, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];

console.log("[1] amplitude 0 (no resample) is identity");
{
  const lower: Frame = { widthMm: 0, heightMm: 0, paths: [{ points: line() }] };
  const f = warpModule.generate({ mode: "water", amplitude: 0, wavelength: 60, falloff: 0.01, resample: false, cx: 0, cy: 0 }, { ...ctx, lowerFrame: lower });
  ok("points unchanged", JSON.stringify(f.paths[0].points) === JSON.stringify(line()));
}

console.log("[2] water warp displaces points");
{
  const lower: Frame = { widthMm: 0, heightMm: 0, paths: [{ points: line() }] };
  const f = warpModule.generate({ mode: "water", amplitude: 8, wavelength: 60, falloff: 0, resample: false, cx: 0, cy: 0 }, { ...ctx, lowerFrame: lower });
  // y=0 input → dy = 8*sin(k*x) varies along the line, so some point leaves the axis
  ok("line is no longer flat", f.paths[0].points.some((p) => Math.abs(p.y) > 0.5), JSON.stringify(f.paths[0].points.map((p) => Math.round(p.y))));
  ok("deterministic", JSON.stringify(warpModule.generate({ mode: "water", amplitude: 8, wavelength: 60, falloff: 0, resample: false, cx: 0, cy: 0 }, { ...ctx, lowerFrame: lower }).paths) === JSON.stringify(f.paths));
}

console.log("[3] droplet displaces radially from the centre");
{
  const ring: Pt[] = [{ x: 30, y: 0 }, { x: 0, y: 30 }, { x: -30, y: 0 }, { x: 0, y: -30 }];
  const lower: Frame = { widthMm: 0, heightMm: 0, paths: [{ points: ring, closed: true }] };
  const f = warpModule.generate({ mode: "droplet", amplitude: 10, wavelength: 40, falloff: 0, resample: false, cx: 0, cy: 0 }, { ...ctx, lowerFrame: lower });
  const moved = f.paths[0].points.some((p, i) => dist(p, ring[i]) > 1);
  ok("ring points moved radially", moved);
  ok("closed flag preserved", f.paths[0].closed === true);
}

console.log("[4] resample densifies before warping");
{
  const lower: Frame = { widthMm: 0, heightMm: 0, paths: [{ points: [{ x: -100, y: 0 }, { x: 100, y: 0 }] }] };
  const f = warpModule.generate({ mode: "water", amplitude: 8, wavelength: 40, falloff: 0, resample: true, cx: 0, cy: 0 }, { ...ctx, lowerFrame: lower });
  ok("more points than the 2-point input", f.paths[0].points.length > 2, `pts=${f.paths[0].points.length}`);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
