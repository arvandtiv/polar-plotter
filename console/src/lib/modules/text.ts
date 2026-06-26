// Text generator — built-in single-stroke font (no dependency, no font file), ideal
// for pen plotting. Registers on import. Pairs well with the Fill modifier if you want
// hatched lettering, but single-stroke draws solid-looking text directly.

import { register, num, type Module } from "../registry";
import { textToStrokes } from "../strokefont";
import type { Frame, Path } from "../frame";

export const textModule: Module = {
  key: "text",
  label: "Text",
  kind: "make",
  group: "Shapes & Imports",
  description: "Single-stroke plotter text (A–Z, 0–9, punctuation). Use \\n for new lines.",
  sections: [
    { title: "Text", fields: [
      { key: "text", label: "Text", type: "text", default: "HELLO", placeholder: "type here…" },
      { key: "size", label: "Size", type: "range", min: 4, max: 120, step: 1, unit: "mm", default: 30 },
      { key: "letterSpacing", label: "Letter spacing", type: "range", min: -5, max: 20, step: 0.5, unit: "mm", default: 2 },
      { key: "lineSpacing", label: "Line spacing", type: "range", min: 0, max: 60, step: 1, unit: "mm", default: 12 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params): Frame {
    const text = String(params.text ?? "");
    const size = num(params, "size", 30);
    const letterSpacing = num(params, "letterSpacing", 2);
    const lineSpacing = num(params, "lineSpacing", 12);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);

    const { strokes, width, height } = textToStrokes(text, { size, letterSpacing, lineSpacing });
    // centre the text block at (cx, cy)
    const ox = cx - width / 2, oy = cy - height / 2;
    const paths: Path[] = strokes.map((s) => ({ points: s.map((p) => ({ x: p.x + ox, y: p.y + oy })) }));
    return { widthMm: width || 1, heightMm: height || 1, paths, meta: { title: "Text" } };
  },
};

register(textModule);
