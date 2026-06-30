// Box text layout — font-agnostic word-wrap + auto-shrink-to-fit, plus a driver for
// real TTF/OTF fonts (via opentype.js). A FontDriver knows how to measure and render a
// single run of text; the box layout sits on top and works the same whether the run
// comes from the built-in stroke font (strokefont.ts) or an uploaded outline font.
// Pure & host-testable (the stroke-font path needs no DOM); see test/text.test.ts.

import type { Pt } from "./frame";
import { sampleBezier } from "./geom";

/** A font that can measure and draw one line of text. Origin at the left edge, the cap
 *  top near y=0 and the baseline ~y=size, x→right, y→down (screen-style, matches Frame). */
export interface FontDriver {
  /** Advance width (mm) of `text` at `size`, including `letterSpacing` between glyphs. */
  measureRun(text: string, size: number, letterSpacing: number): number;
  /** Stroke polylines (mm) for `text`, left edge at x=0. */
  renderRun(text: string, size: number, letterSpacing: number): Pt[][];
}

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";

export interface TextBoxOpts {
  boxW: number;            // box width (mm)
  boxH: number;            // box height (mm)
  size: number;            // MAX font size (mm); auto-fit only ever shrinks below this
  letterSpacing: number;   // extra mm between glyphs
  lineHeight: number;      // line pitch as a multiple of `size` (1.0 = tight)
  align: HAlign;           // horizontal alignment within the box
  vAlign: VAlign;          // vertical alignment within the box
  autoFit: boolean;        // shrink the font until the wrapped text fits the box
}

export interface TextBoxResult {
  strokes: Pt[][];         // box top-left at (0,0)
  size: number;            // the font size actually used (after any auto-fit shrink)
  lines: string[];         // the wrapped lines
}

/** Greedy word-wrap: break `text` (honouring explicit \n) into lines no wider than boxW. */
export function wrapLines(text: string, driver: FontDriver, size: number, ls: number, boxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const trial = line === "" ? word : line + " " + word;
      if (line !== "" && driver.measureRun(trial, size, ls) > boxW) { out.push(line); line = word; }
      else line = trial;
    }
    out.push(line);   // keep empty lines from blank paragraphs
  }
  return out;
}

function fitsBox(text: string, driver: FontDriver, size: number, opts: TextBoxOpts): boolean {
  const lines = wrapLines(text, driver, size, opts.letterSpacing, opts.boxW);
  if (lines.length * opts.lineHeight * size > opts.boxH + 1e-6) return false;
  for (const line of lines) if (driver.measureRun(line, size, opts.letterSpacing) > opts.boxW + 1e-6) return false;
  return true;
}

/** Lay text out inside boxW×boxH (top-left origin), wrapping words and — when autoFit is
 *  on — binary-searching the largest font size ≤ opts.size at which everything fits. */
export function layoutTextBox(text: string, driver: FontDriver, opts: TextBoxOpts): TextBoxResult {
  let size = opts.size;
  if (opts.autoFit && size > 0 && opts.boxW > 0 && opts.boxH > 0 && !fitsBox(text, driver, size, opts)) {
    let lo = 0, hi = size;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fitsBox(text, driver, mid, opts)) lo = mid; else hi = mid;
    }
    size = lo;
  }
  const ls = opts.letterSpacing;
  const lines = wrapLines(text, driver, size, ls, opts.boxW);
  const lineH = opts.lineHeight * size;
  const totalH = lines.length * lineH;
  const startY = opts.vAlign === "top" ? 0
               : opts.vAlign === "bottom" ? opts.boxH - totalH
               : (opts.boxH - totalH) / 2;
  const strokes: Pt[][] = [];
  lines.forEach((line, i) => {
    if (line === "") return;
    const w = driver.measureRun(line, size, ls);
    const xoff = opts.align === "left" ? 0 : opts.align === "right" ? opts.boxW - w : (opts.boxW - w) / 2;
    const yoff = startY + i * lineH;
    for (const s of driver.renderRun(line, size, ls)) strokes.push(s.map((p) => ({ x: p.x + xoff, y: p.y + yoff })));
  });
  return { strokes, size, lines };
}

// ---- real outline fonts (TTF/OTF) via opentype.js ----------------------------------

/** The subset of opentype.js's `Font` we use — structural so registry.ts needn't import
 *  opentype types. An uploaded `opentype.Font` satisfies this. */
export interface VectorFont {
  unitsPerEm: number;
  ascender: number;        // font units
  descender: number;       // font units (negative)
  getAdvanceWidth(text: string, fontSize: number): number;
  getPath(text: string, x: number, y: number, fontSize: number): { commands: OutlineCmd[] };
}

interface OutlineCmd {
  type: string;            // "M" | "L" | "Q" | "C" | "Z"
  x?: number; y?: number;
  x1?: number; y1?: number;
  x2?: number; y2?: number;
}

/** Wrap an opentype.js Font as a FontDriver: glyph outlines flattened to polylines.
 *  Outline fonts plot HOLLOW — pair with the Fill modifier to hatch them solid. */
export function opentypeFontDriver(font: VectorFont): FontDriver {
  const ascent = (size: number) => (font.ascender / font.unitsPerEm) * size;
  return {
    measureRun(text, size, ls) {
      if (!text) return 0;
      let w = 0;
      for (const ch of text) w += font.getAdvanceWidth(ch, size) + ls;
      return Math.max(0, w - ls);
    },
    renderRun(text, size, ls) {
      const out: Pt[][] = [];
      const yBase = ascent(size);
      const n = Math.max(4, Math.round(size / 2));   // bezier samples per curve
      let cursor = 0;
      for (const ch of text) {
        // place each glyph itself (so letterSpacing can be inserted between them)
        const { commands } = font.getPath(ch, cursor, yBase, size);
        let poly: Pt[] = [];
        let start: Pt | null = null;
        let prev: Pt | null = null;
        const flush = () => { if (poly.length > 1) out.push(poly); poly = []; };
        for (const c of commands) {
          switch (c.type) {
            case "M": flush(); start = { x: c.x!, y: c.y! }; poly = [start]; prev = start; break;
            case "L": { const p = { x: c.x!, y: c.y! }; poly.push(p); prev = p; break; }
            case "Q": {
              const p0 = prev ?? { x: c.x!, y: c.y! };
              const p3 = { x: c.x!, y: c.y! };
              // quadratic → cubic control points
              const c1 = { x: p0.x + (2 / 3) * (c.x1! - p0.x), y: p0.y + (2 / 3) * (c.y1! - p0.y) };
              const c2 = { x: p3.x + (2 / 3) * (c.x1! - p3.x), y: p3.y + (2 / 3) * (c.y1! - p3.y) };
              const seg = sampleBezier(p0, c1, c2, p3, n);
              for (let i = 1; i < seg.length; i++) poly.push(seg[i]);
              prev = p3; break;
            }
            case "C": {
              const p0 = prev ?? { x: c.x!, y: c.y! };
              const p3 = { x: c.x!, y: c.y! };
              const seg = sampleBezier(p0, { x: c.x1!, y: c.y1! }, { x: c.x2!, y: c.y2! }, p3, n);
              for (let i = 1; i < seg.length; i++) poly.push(seg[i]);
              prev = p3; break;
            }
            case "Z": if (start) poly.push({ ...start }); flush(); prev = start; break;
          }
        }
        flush();
        cursor += font.getAdvanceWidth(ch, size) + ls;
      }
      return out;
    },
  };
}
