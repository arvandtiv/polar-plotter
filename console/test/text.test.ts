// Host test for the stroke font + box-text layout + Text generator (Day 20 / S14).
// Run: cd console && npx tsx test/text.test.ts
import { textToStrokes, strokeFontDriver } from "../src/lib/strokefont.ts";
import { wrapLines, layoutTextBox } from "../src/lib/textbox.ts";
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

console.log("[4] box layout: wrap + auto-fit");
{
  const d = strokeFontDriver("sans");
  ok("measure grows with glyphs", d.measureRun("HI", 10, 1) > d.measureRun("I", 10, 1));
  ok("bold has more strokes", strokeFontDriver("bold").renderRun("A", 10, 0).length > d.renderRun("A", 10, 0).length);
  // a string too wide for a narrow box wraps onto multiple lines
  const lines = wrapLines("AAA AAA AAA AAA", d, 10, 1, 30);
  ok("wraps to multiple lines", lines.length >= 2, `lines=${lines.length}`);
  // auto-fit shrinks the font so a long string fits a small box
  const big = layoutTextBox("the quick brown fox jumps", d,
    { boxW: 40, boxH: 20, size: 30, letterSpacing: 1, lineHeight: 1.3, align: "left", vAlign: "top", autoFit: true });
  ok("auto-fit shrinks below max", big.size < 30, `size=${big.size.toFixed(1)}`);
  ok("every fitted line within box width", big.lines.every((l) => d.measureRun(l, big.size, 1) <= 40 + 1e-3));
  // no shrink needed when it already fits
  const small = layoutTextBox("HI", d,
    { boxW: 160, boxH: 100, size: 20, letterSpacing: 1, lineHeight: 1.3, align: "left", vAlign: "top", autoFit: true });
  ok("no shrink when it fits", small.size === 20);
}

console.log("[5] alignment shifts strokes right");
{
  const d = strokeFontDriver("sans");
  const opts = { boxW: 160, boxH: 100, size: 20, letterSpacing: 1, lineHeight: 1.3, vAlign: "top" as const, autoFit: false };
  const left = layoutTextBox("HI", d, { ...opts, align: "left" });
  const right = layoutTextBox("HI", d, { ...opts, align: "right" });
  const minX = (r: { strokes: { x: number }[][] }) => Math.min(...r.strokes.flat().map((p) => p.x));
  ok("right-aligned starts further right", minX(right) > minX(left));
}

console.log("[6] text module → box Frame");
{
  const f = textModule.generate({ text: "AB", font: "sans", size: 20, letterSpacing: 2, lineHeight: 1.3,
    align: "center", boxW: 120, boxH: 80, vAlign: "middle", autoFit: true, showBorder: false, cx: 0, cy: 0 }, ctx);
  ok("paths produced", f.paths.length > 0);
  ok("frame size = box", f.widthMm === 120 && f.heightMm === 80);
  const b = frameBounds(f)!;
  ok("text within box", b.x0 >= -61 && b.x1 <= 61 && b.y0 >= -41 && b.y1 <= 41, JSON.stringify(b));
  const bordered = textModule.generate({ text: "AB", font: "sans", size: 20, letterSpacing: 2, lineHeight: 1.3,
    align: "center", boxW: 120, boxH: 80, vAlign: "middle", autoFit: true, showBorder: true, cx: 0, cy: 0 }, ctx);
  ok("border adds one closed path", bordered.paths.length === f.paths.length + 1);
  ok("custom font with no upload falls back (no crash)",
    textModule.generate({ text: "AB", font: "custom", size: 20, boxW: 120, boxH: 80, cx: 0, cy: 0 }, ctx).paths.length > 0);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
