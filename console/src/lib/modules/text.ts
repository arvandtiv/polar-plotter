// Text generator — lays text out inside a width×height box: word-wraps, optionally
// auto-shrinks the font to fit, with line-height + alignment control. Three font sources:
// the built-in single-stroke Sans/Bold (dependency-free, draw solid) or an uploaded
// TTF/OTF outline font (ctx.font, supplied by the Studio — plots HOLLOW, pair with Fill).
// Registers on import. See lib/textbox.ts for the (pure) layout + drivers.

import { register, num, type Module } from "../registry";
import { strokeFontDriver, STROKE_FONTS, type StrokeFontName } from "../strokefont";
import { layoutTextBox, opentypeFontDriver, type FontDriver, type HAlign, type VAlign } from "../textbox";
import { rectPath } from "../frame";
import type { Frame, Path } from "../frame";

export const textModule: Module = {
  key: "text",
  label: "Text",
  kind: "make",
  group: "Shapes & Imports",
  description: "Box text: word-wraps inside a width×height box, auto-shrinks to fit. Built-in Sans/Bold or an uploaded TTF/OTF font.",
  sections: [
    { title: "Text", fields: [
      { key: "text", label: "Text", type: "text", default: "The quick brown fox jumps over the lazy dog", placeholder: "type here…" },
      { key: "font", label: "Font", type: "select", default: "sans", options: [
        ...STROKE_FONTS,
        { value: "custom", label: "Upload TTF/OTF…" },
      ]},
      { key: "size", label: "Max size", type: "range", min: 4, max: 120, step: 1, unit: "mm", default: 28 },
      { key: "letterSpacing", label: "Letter spacing", type: "range", min: -5, max: 20, step: 0.5, unit: "mm", default: 1 },
      { key: "lineHeight", label: "Line height", type: "range", min: 0.8, max: 3, step: 0.05, unit: "×", default: 1.3 },
      { key: "align", label: "Align", type: "select", default: "left", options: [
        { value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" },
      ]},
    ]},
    { title: "Box", fields: [
      { key: "boxW", label: "Box width", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 160 },
      { key: "boxH", label: "Box height", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 100 },
      { key: "vAlign", label: "Vertical align", type: "select", default: "top", options: [
        { value: "top", label: "Top" }, { value: "middle", label: "Middle" }, { value: "bottom", label: "Bottom" },
      ]},
      { key: "autoFit", label: "Shrink to fit", type: "toggle", default: true },
      { key: "showBorder", label: "Draw box border", type: "toggle", default: false },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params, ctx): Frame {
    const text = String(params.text ?? "");
    const fontSel = String(params.font ?? "sans");
    const boxW = num(params, "boxW", 160), boxH = num(params, "boxH", 100);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);

    // pick the driver: uploaded outline font when "custom" + a font is loaded, else built-in
    const driver: FontDriver = fontSel === "custom" && ctx.font
      ? opentypeFontDriver(ctx.font)
      : strokeFontDriver((fontSel === "bold" ? "bold" : "sans") as StrokeFontName);

    const { strokes } = layoutTextBox(text, driver, {
      boxW, boxH,
      size: num(params, "size", 28),
      letterSpacing: num(params, "letterSpacing", 1),
      lineHeight: num(params, "lineHeight", 1.3),
      align: String(params.align ?? "left") as HAlign,
      vAlign: String(params.vAlign ?? "top") as VAlign,
      autoFit: params.autoFit !== false,
    });

    // box top-left at (0,0) → centre the box at (cx, cy)
    const ox = cx - boxW / 2, oy = cy - boxH / 2;
    const paths: Path[] = strokes.map((s) => ({ points: s.map((p) => ({ x: p.x + ox, y: p.y + oy })) }));
    if (params.showBorder) paths.push(rectPath(cx, cy, boxW, boxH));

    return { widthMm: boxW, heightMm: boxH, paths, meta: { title: "Text" } };
  },
};

register(textModule);
