// Host test for the stroke font + Text generator (Day 20 / S14).
// Run: cd console && npx tsx test/text.test.ts
import { textToStrokes } from "../src/lib/strokefont.ts";
import { textModule } from "../src/lib/modules/text.ts";
import { frameBounds } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const approx = (a: number, b: number, eps = 1.5) => Math.abs(a - b) <= eps;
const ctx = { bounds: { left: 300, right: 300, up: 300, down: 300 } };

console.log("[1] textToStrokes basics");
{
  const a = textToStrokes("A", { size: 7 });
  ok("A → 2 strokes", a.strokes.length === 2, `strokes=${a.strokes.length}`);
  ok("height ≈ size", approx(a.height, 7));
  // 'HI' wider than 'A'
  ok("more glyphs → wider", textToStrokes("HI", { size: 7, letterSpacing: 0 }).width > a.width);
  // space produces no strokes but advances
  const sp = textToStrokes("A A", { size: 7 });
  ok("space adds no strokes (still 2×A = 4)", sp.strokes.length === 4, `strokes=${sp.strokes.length}`);
  ok("space advances width", sp.width > textToStrokes("AA", { size: 7 }).width - 0.001);
}

console.log("[2] lowercase maps to uppercase");
{
  ok("'a' === 'A'", JSON.stringify(textToStrokes("a", { size: 7 }).strokes) === JSON.stringify(textToStrokes("A", { size: 7 }).strokes));
}

console.log("[3] newline starts a second line");
{
  const one = textToStrokes("A", { size: 10, lineSpacing: 5 });
  const two = textToStrokes("A\nA", { size: 10, lineSpacing: 5 });
  ok("two lines taller", two.height > one.height);
  ok("two lines → double strokes", two.strokes.length === one.strokes.length * 2);
}

console.log("[4] text module → centred Frame");
{
  const f = textModule.generate({ text: "AB", size: 20, letterSpacing: 2, lineSpacing: 12, cx: 0, cy: 0 }, ctx);
  ok("paths produced", f.paths.length > 0);
  const b = frameBounds(f)!;
  ok("cap height ≈ size·6/7", approx(b.y1 - b.y0, 20 * 6 / 7, 2), JSON.stringify(b));
  ok("centred on origin", approx((b.x0 + b.x1) / 2, 0, 2) && approx((b.y0 + b.y1) / 2, 0, 2.5));
  ok("empty/unknown safe", textModule.generate({ text: "~`", size: 10, letterSpacing: 0, lineSpacing: 0, cx: 0, cy: 0 }, ctx).paths.length === 0);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
