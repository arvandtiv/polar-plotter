// Built-in single-stroke vector font for pen plotting (Hershey-style). Public-domain
// approach: each glyph is one or more open polylines on a grid (x 0..4, y 0..6 top→down,
// commas/descenders reach 7). No dependency, no font file. Lowercase maps to uppercase.
// Strokes encoded compactly: strokes split by '|', points by ' ', coords by ','.

import type { Pt } from "./frame";

const GRID_H = 7;   // scaling height (cap height occupies 0..6)
const ADVANCE = 5;  // grid units per glyph cell

const GLYPHS: Record<string, string> = {
  "A": "0,6 2,0 4,6|1,4 3,4",
  "B": "0,0 0,6|0,0 3,0 4,1 4,2 3,3 0,3|0,3 3,3 4,4 4,5 3,6 0,6",
  "C": "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5",
  "D": "0,0 0,6|0,0 3,0 4,1 4,5 3,6 0,6",
  "E": "4,0 0,0 0,6 4,6|0,3 3,3",
  "F": "4,0 0,0 0,6|0,3 3,3",
  "G": "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3",
  "H": "0,0 0,6|4,0 4,6|0,3 4,3",
  "I": "1,0 3,0|2,0 2,6|1,6 3,6",
  "J": "3,0 3,5 2,6 1,6 0,5",
  "K": "0,0 0,6|4,0 0,3 4,6",
  "L": "0,0 0,6 4,6",
  "M": "0,6 0,0 2,3 4,0 4,6",
  "N": "0,6 0,0 4,6 4,0",
  "O": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0",
  "P": "0,6 0,0 3,0 4,1 4,2 3,3 0,3",
  "Q": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2,4 4,6",
  "R": "0,6 0,0 3,0 4,1 4,2 3,3 0,3|2,3 4,6",
  "S": "4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5",
  "T": "0,0 4,0|2,0 2,6",
  "U": "0,0 0,5 1,6 3,6 4,5 4,0",
  "V": "0,0 2,6 4,0",
  "W": "0,0 1,6 2,3 3,6 4,0",
  "X": "0,0 4,6|4,0 0,6",
  "Y": "0,0 2,3 4,0|2,3 2,6",
  "Z": "0,0 4,0 0,6 4,6",
  "0": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|0,5 4,1",
  "1": "1,1 2,0 2,6|1,6 3,6",
  "2": "0,1 1,0 3,0 4,1 4,2 0,6 4,6",
  "3": "0,0 4,0 2,3|2,3 4,4 4,5 3,6 1,6 0,5",
  "4": "3,6 3,0 0,4 4,4",
  "5": "4,0 1,0 0,3 3,3 4,4 4,5 3,6 1,6 0,5",
  "6": "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3",
  "7": "0,0 4,0 1,6",
  "8": "1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3 1,3|1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3",
  "9": "0,5 1,6 3,6 4,5 4,1 3,0 1,0 0,1 0,2 1,3 4,3",
  ".": "2,5 2,6",
  ",": "2,5 2,6 1,7",
  "-": "1,3 3,3",
  "+": "2,2 2,5|0.5,3.5 3.5,3.5",
  "/": "4,0 0,6",
  "!": "2,0 2,4|2,5 2,6",
  "?": "0,1 1,0 3,0 4,1 4,2 2,4 2,4|2,5 2,6",
  ":": "2,2 2,3|2,4 2,5",
  " ": "",
};

function parseGlyph(spec: string): Pt[][] {
  if (!spec) return [];
  return spec.split("|").map((stroke) =>
    stroke.trim().split(/\s+/).map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    }));
}

export interface TextLayoutOpts {
  size: number;            // cap-to-baseline height in mm
  letterSpacing?: number;  // extra mm between glyphs
  lineSpacing?: number;    // extra mm between lines
}

/** Lay a string out into stroke polylines (mm), origin at top-left, x→right, y→down. */
export function textToStrokes(text: string, opts: TextLayoutOpts): { strokes: Pt[][]; width: number; height: number } {
  const scale = opts.size / GRID_H;
  const letterSpacing = opts.letterSpacing ?? 0;
  const lineSpacing = opts.lineSpacing ?? opts.size * 0.4;
  const strokes: Pt[][] = [];
  let cursorX = 0, lineY = 0, maxX = 0;

  for (const raw of text) {
    if (raw === "\n") { maxX = Math.max(maxX, cursorX); cursorX = 0; lineY += opts.size + lineSpacing; continue; }
    const ch = raw.toUpperCase();
    const spec = ch in GLYPHS ? GLYPHS[ch] : GLYPHS[" "];
    for (const stroke of parseGlyph(spec)) {
      strokes.push(stroke.map((p) => ({ x: cursorX + p.x * scale, y: lineY + p.y * scale })));
    }
    cursorX += ADVANCE * scale + letterSpacing;
  }
  maxX = Math.max(maxX, cursorX - letterSpacing);
  return { strokes, width: maxX, height: lineY + opts.size };
}
