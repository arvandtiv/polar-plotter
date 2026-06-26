// Host test for the v1.3 param persistence merge logic (Day 4 / S3).
// Run: cd console && npx tsx test/paramstore.test.ts
import { mergeDefaults } from "../src/lib/paramStore.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

const defaults = { width: 100, height: 100, mode: "smooth", outline: true };

console.log("[1] mergeDefaults");
{
  ok("null stored → defaults", JSON.stringify(mergeDefaults(defaults, null)) === JSON.stringify(defaults));

  const m = mergeDefaults(defaults, { width: 250, mode: "rough" });
  ok("stored overrides matching keys", m.width === 250 && m.mode === "rough");
  ok("missing keys keep defaults", m.height === 100 && m.outline === true);

  const t = mergeDefaults(defaults, { width: "oops", outline: "yes" });
  ok("type-mismatched values ignored", t.width === 100 && t.outline === true, JSON.stringify(t));

  const e = mergeDefaults(defaults, { width: 50, bogus: 9 });
  ok("unknown stored keys dropped", !("bogus" in e) && e.width === 50);

  ok("key set always = defaults", Object.keys(mergeDefaults(defaults, { x: 1 })).sort().join() === Object.keys(defaults).sort().join());
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
