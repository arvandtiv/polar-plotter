// Unified pipeline — expandGenerator uses simplify + optimize like Studio Run.
// Run: cd console && npx tsx test/runpipeline.test.ts
import "../src/lib/modules/index";
import { expandGenerator } from "../src/lib/runPipeline.ts";
import { getModule } from "../src/lib/registry.ts";
import { compile } from "../src/lib/compile.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

const bounds = { left: 50, right: 50, up: 50, down: 50 };

console.log("[1] expandGenerator produces queries");
{
  const q = expandGenerator(
    { key: "randomWalker", params: { count: 2, steps: 50, seed: 1, x1: -10, y1: 0, x2: 10, y2: 0 } },
    bounds,
  );
  ok("returns firmware queries", q.length > 4, `n=${q.length}`);
  ok("starts pen up", q[0] === "pen?pos=up");
  ok("has line segments", q.some((s) => s.startsWith("line?")));
}

console.log("[2] unified path is leaner than raw compile (optimize + simplify)");
{
  const mod = getModule("randomWalker")!;
  const raw = mod.generate({ count: 5, steps: 200, seed: 42 }, { bounds });
  const naive = compile(raw, { clipBounds: bounds });
  const unified = expandGenerator({ key: "randomWalker", params: { count: 5, steps: 200, seed: 42 } }, bounds);
  ok("unified has fewer or equal ops than naive", unified.length <= naive.length,
    `unified=${unified.length} naive=${naive.length}`);
}

console.log("[3] unknown generator throws");
{
  let threw = false;
  try { expandGenerator({ key: "nope", params: {} }, bounds); }
  catch { threw = true; }
  ok("throws on unknown key", threw);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);