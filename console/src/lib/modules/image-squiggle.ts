// Image → Squiggle generator — horizontal scanline rows that wiggle; the wave amplitude
// grows with local darkness. One continuous stroke per row = very few pen lifts, ideal
// for plotting photos. Pure (reads ctx.image). Registers on import.

import { register, num, type Module } from "../registry";
import { sampleGray, imageFit } from "../image";
import type { Frame, Path, Pt } from "../frame";

export const imageSquiggleModule: Module = {
  key: "imageSquiggle",
  label: "Image Squiggle",
  kind: "make",
  group: "Image",
  description: "Wavy scanlines whose amplitude tracks darkness (load an image in the Studio).",
  sections: [
    { title: "Squiggle", fields: [
      { key: "rowSpacing", label: "Row spacing", type: "range", min: 1, max: 20, step: 0.5, unit: "mm", default: 4 },
      { key: "wavelength", label: "Wavelength", type: "range", min: 1, max: 30, step: 0.5, unit: "mm", default: 6 },
      { key: "maxAmp", label: "Max amplitude", type: "range", min: 0.5, max: 15, step: 0.5, unit: "mm", default: 2.5 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
    ]},
    { title: "Placement", fields: [
      { key: "plotSize", label: "Plot size", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
  ],
  generate(params, ctx): Frame {
    const img = ctx.image;
    if (!img || img.width < 2) return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Image Squiggle (load an image)" } };
    const rowSpacing = Math.max(1, num(params, "rowSpacing", 4));
    const wl = Math.max(1, num(params, "wavelength", 6));
    const maxAmp = num(params, "maxAmp", 2.5);
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const { s, offX, offY, plotW, plotH } = imageFit(img, plot, cx, cy);
    const stepX = Math.max(0.5, wl / 12);
    const k = (2 * Math.PI) / wl;

    const paths: Path[] = [];
    for (let my = offY + rowSpacing / 2; my < offY + plotH; my += rowSpacing) {
      const row: Pt[] = [];
      for (let mx = offX; mx <= offX + plotW; mx += stepX) {
        let v = sampleGray(img, (mx - offX) / s, (my - offY) / s);
        if (invert) v = 1 - v;
        const amp = (1 - v) * maxAmp;
        row.push({ x: mx, y: my + amp * Math.sin(k * mx) });
      }
      if (row.length > 1) paths.push({ points: row });
    }
    return { widthMm: plotW, heightMm: plotH, paths, meta: { title: "Image Squiggle" } };
  },
};

register(imageSquiggleModule);
