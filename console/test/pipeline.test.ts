// Host test for the layer pipeline (Day 16 / S10).
// Run: cd console && npx tsx test/pipeline.test.ts
import { evaluate, type Layer } from "../src/lib/pipeline.ts";
import { register, defaultsOf, getModule, type Module } from "../src/lib/registry.ts";
import "../src/lib/modules/box.ts";   // registers "box"
import { frameBounds } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const bounds = { left: 300, right: 300, up: 300, down: 300 };

// a tiny test-only modifier: keep only the FIRST path of the layer below
const keepFirst: Module = {
  key: "test:keepFirst", label: "Keep First", kind: "modify", sections: [],
  generate: (_p, ctx) => ({ ...(ctx.lowerFrame!), paths: ctx.lowerFrame!.paths.slice(0, 1) }),
};
register(keepFirst);

const box = getModule("box")!;
const mk = (moduleKey: string, params = {}): Layer =>
  ({ id: moduleKey + Math.random(), moduleKey, params: { ...(getModule(moduleKey) ? defaultsOf(getModule(moduleKey)!) : {}), ...params } });

console.log("[1] makes compose (paths add)");
{
  const f = evaluate([mk("box", { cx: -50 }), mk("box", { cx: 50 })], bounds);
  ok("two boxes → two paths", f.paths.length === 2, `paths=${f.paths.length}`);
  const b = frameBounds(f)!;
  ok("bbox spans both", b.x0 <= -100 && b.x1 >= 100, JSON.stringify(b));
}

console.log("[2] modifier reads lowerFrame and replaces it");
{
  const f = evaluate([mk("box", { cx: -50 }), mk("box", { cx: 50 }), mk("test:keepFirst")], bounds);
  ok("modifier dropped to 1 path", f.paths.length === 1, `paths=${f.paths.length}`);
}

console.log("[3] order matters");
{
  // modifier BEFORE the second box → it only sees the first box, second box still adds
  const f = evaluate([mk("box", { cx: -50 }), mk("test:keepFirst"), mk("box", { cx: 50 })], bounds);
  ok("modifier then make → 1 + 1 = 2 paths", f.paths.length === 2, `paths=${f.paths.length}`);
}

console.log("[4] unknown module skipped");
{
  ok("missing key ignored", evaluate([mk("box"), { id: "x", moduleKey: "nope", params: {} }], bounds).paths.length === 1);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
