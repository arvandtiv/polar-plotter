// Host test for the Fill modifier (Day 18 / S12).
// Run: cd console && npx tsx test/fill.test.ts
import { fillModule } from "../src/lib/modules/fill.ts";
import { bounds } from "../src/lib/geom.ts";
import type { Frame, Path } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

// a closed 100×100 square centred at origin
const squarePath: Path = { closed: true, points: [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }] };
const lower: Frame = { widthMm: 100, heightMm: 100, paths: [squarePath] };

console.log("[1] hatch fill");
{
  const f = fillModule.generate({ mode: "hatch", spacing: 10, angle: 0, keepOutline: true }, { ...ctx, lowerFrame: lower });
  const hatch = f.paths.filter((p) => !p.closed);
  ok("outline kept + hatch added", f.paths.length > 1 && f.paths.some((p) => p.closed));
  ok("several hatch lines", hatch.length >= 8, `lines=${hatch.length}`);
  const inside = hatch.every((p) => { const b = bounds(p.points)!; return b.x0 >= -50.01 && b.x1 <= 50.01 && b.y0 >= -50.01 && b.y1 <= 50.01; });
  ok("hatch clipped inside the square", inside);
}

console.log("[2] keepOutline=false drops the outline");
{
  const f = fillModule.generate({ mode: "hatch", spacing: 10, angle: 0, keepOutline: false }, { ...ctx, lowerFrame: lower });
  ok("no closed outline remains", !f.paths.some((p) => p.closed), JSON.stringify(f.paths.map((p) => p.closed)));
}

console.log("[3] concentric fill");
{
  const f = fillModule.generate({ mode: "concentric", spacing: 10, angle: 0, keepOutline: true }, { ...ctx, lowerFrame: lower });
  const rings = f.paths.filter((p) => p.closed);
  ok("multiple concentric rings", rings.length >= 3, `rings=${rings.length}`);
  // rings shrink toward the centre
  const sizes = rings.map((p) => { const b = bounds(p.points)!; return b.x1 - b.x0; });
  ok("rings get smaller", sizes[sizes.length - 1] < sizes[0], JSON.stringify(sizes.map((s) => Math.round(s))));
}

console.log("[4] open paths are not filled");
{
  const openFrame: Frame = { widthMm: 0, heightMm: 0, paths: [{ points: [{ x: -50, y: 0 }, { x: 50, y: 0 }] }] };
  const f = fillModule.generate({ mode: "hatch", spacing: 10, angle: 0, keepOutline: true }, { ...ctx, lowerFrame: openFrame });
  ok("open stroke passes through unfilled", f.paths.length === 1);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
