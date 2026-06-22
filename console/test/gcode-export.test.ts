// Host test for Frame → G-code export (Day 27).
// Run: cd console && npx tsx test/gcode-export.test.ts
import { exportGcode, DEFAULT_EXPORT } from "../src/lib/gcode-export.ts";
import type { Frame } from "../src/lib/frame.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};

const frame: Frame = { widthMm: 100, heightMm: 100, paths: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 20 }] }] };

console.log("[1] z-mode (default)");
{
  const g = exportGcode(frame, { ...DEFAULT_EXPORT, flipY: false });
  ok("units header", g.includes("G21"));
  ok("rapid to start", g.includes("G0 X0 Y0"));
  ok("pen down via Z", g.includes("G1 Z0"));
  ok("draw with feed", /G1 X10 Y20 F1200/.test(g), g);
  ok("pen up via Z", g.includes(`G0 Z${DEFAULT_EXPORT.penUpZ}`));
  ok("footer M2", g.trim().endsWith("M2"));
}

console.log("[2] spindle mode");
{
  const g = exportGcode(frame, { ...DEFAULT_EXPORT, penMode: "spindle", flipY: false });
  ok("pen down = M3", g.includes("M3"));
  ok("pen up = M5", g.includes("M5"));
  ok("no Z words", !/[Gg]\d* Z/.test(g));
}

console.log("[3] flipY negates Y");
{
  const g = exportGcode(frame, { ...DEFAULT_EXPORT, flipY: true });
  ok("Y flipped to -20", g.includes("Y-20"), g);
}

console.log("[4] mach4 profile header");
{
  const g = exportGcode(frame, { ...DEFAULT_EXPORT, profile: "mach4" });
  ok("mach4 cancels comp/tool", g.includes("G40") && g.includes("G49"));
  ok("mach4 ends M30", g.trim().endsWith("M30"));
}

console.log("[5] closed path closes back to start");
{
  const sq: Frame = { widthMm: 0, heightMm: 0, paths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] };
  const g = exportGcode(sq, { ...DEFAULT_EXPORT, flipY: false });
  const g1count = (g.match(/G1 X/g) || []).length;
  ok("3 sides drawn (closing segment included)", g1count === 3, `g1=${g1count}`);
}

console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
process.exit(fails ? 1 : 0);
