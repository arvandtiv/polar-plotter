// Host test for Studio document save/load helpers (Day 25 / S18).
// Run: cd console && npx tsx test/studiodoc.test.ts
import { sanitizeLayers, serializeDoc, parseDocFile } from "../src/lib/studioDoc.ts";
import "../src/lib/modules/box.ts";   // registers "box"
import "../src/lib/modules/circle.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

console.log("[1] sanitizeLayers");
{
  const raw = [
    { id: "a", moduleKey: "box", params: { width: 50 } },
    { id: "b", moduleKey: "nope", params: {} },     // unknown → dropped
    { moduleKey: "circle" },                          // missing id/params → filled
    null, 42,                                         // junk → dropped
  ];
  const out = sanitizeLayers(raw);
  ok("keeps known modules only", out.length === 2, `n=${out.length}`);
  ok("box params preserved", out[0].params.width === 50);
  ok("missing id/params filled", typeof out[1].id === "string" && typeof out[1].params === "object");
  ok("non-array → []", sanitizeLayers("nope").length === 0);
}

console.log("[2] serialize / parse round-trip");
{
  const layers = sanitizeLayers([{ id: "a", moduleKey: "box", params: { width: 120 } }]);
  const text = serializeDoc("My Design", layers);
  const back = parseDocFile(text);
  ok("name round-trips", back.name === "My Design");
  ok("layers round-trip", back.layers.length === 1 && back.layers[0].params.width === 120);
  // accepts a bare array too
  ok("bare array accepted", parseDocFile(JSON.stringify(layers)).layers.length === 1);
  // unknown modules stripped on import
  ok("import strips unknown", parseDocFile(JSON.stringify({ layers: [{ moduleKey: "ghost" }] })).layers.length === 0);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
