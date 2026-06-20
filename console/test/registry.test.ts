// Host test for the v1.3 module registry + box generator (Day 3 / S2).
// Run: cd console && npx tsx test/registry.test.ts
import { getModule, listModules, defaultsOf } from "../src/lib/registry.ts";
import "../src/lib/modules/box.ts";              // side-effect: registers "box"
import { frameBounds } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log("[1] registration");
{
  const box = getModule("box");
  ok("box registered", !!box);
  ok("box is a make module", box?.kind === "make");
  ok("listModules('make') includes box", listModules("make").some((m) => m.key === "box"));
}

console.log("[2] defaultsOf folds every field default");
{
  const box = getModule("box")!;
  const d = defaultsOf(box);
  ok("has width/height/cx/cy", d.width === 100 && d.height === 100 && d.cx === 0 && d.cy === 0,
     JSON.stringify(d));
  const keyCount = box.sections.reduce((n, s) => n + s.fields.length, 0);
  ok("one value per field", Object.keys(d).length === keyCount);
}

console.log("[3] generate produces a Frame matching params");
{
  const box = getModule("box")!;
  const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };
  const frame = box.generate({ width: 80, height: 40, cx: 10, cy: -20 }, ctx);
  const b = frameBounds(frame)!;
  ok("width 80", approx(b.x1 - b.x0, 80), JSON.stringify(b));
  ok("height 40", approx(b.y1 - b.y0, 40));
  ok("centred at (10,-20)", approx((b.x0 + b.x1) / 2, 10) && approx((b.y0 + b.y1) / 2, -20));
  ok("one closed path", frame.paths.length === 1 && frame.paths[0].closed === true);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
