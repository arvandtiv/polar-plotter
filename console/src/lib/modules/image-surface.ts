// Image → Depth Map generator — a 2D height-field "ridgeline" plot (Joy Division /
// terrain look): scanline rows pushed up by image brightness, with an oblique shear so
// it reads as 3D. Pure, no three.js; one continuous stroke per row (plotter-friendly).
// Reads ctx.image. Registers on import.

import { register, num, type Module } from "../registry";
import { sampleGray, imageFit } from "../image";
import type { Frame, Path, Pt } from "../frame";

export const imageSurfaceModule: Module = {
  key: "imageSurface",
  label: "Depth Map",
  kind: "make",
  group: "Image",
  description: "An image as stacked ridgelines — brightness becomes height, sheared into a 3D look.",
  sections: [
    { title: "Surface", fields: [
      { key: "rows", label: "Rows", type: "range", min: 5, max: 160, step: 1, default: 60 },
      { key: "height", label: "Height", type: "range", min: 0, max: 80, step: 1, unit: "mm", default: 22 },
      { key: "shear", label: "3D shear", type: "range", min: -1, max: 1, step: 0.02, default: 0.4 },
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
    if (!img || img.width < 2 || img.height < 2) {
      return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Depth Map (load an image)" } };
    }
    const rows = Math.max(2, Math.round(num(params, "rows", 60)));
    const height = num(params, "height", 22);
    const shear = num(params, "shear", 0.4);
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const { s, offX, offY, plotW, plotH } = imageFit(img, plot, cx, cy);

    const cols = Math.min(img.width, 240);
    const rowStep = plotH / (rows - 1);
    const shearX = shear * rowStep;   // horizontal lean added per row (oblique projection)

    const paths: Path[] = [];
    for (let ri = 0; ri < rows; ri++) {
      const gy = (ri / (rows - 1)) * (img.height - 1);
      const baseY = offY + ri * rowStep;
      const xShift = ri * shearX;
      const row: Pt[] = [];
      for (let ci = 0; ci < cols; ci++) {
        const gx = (ci / (cols - 1)) * (img.width - 1);
        let v = sampleGray(img, gx, gy);
        if (invert) v = 1 - v;
        const lift = v * height;                       // brighter = taller
        row.push({ x: offX + (ci / (cols - 1)) * plotW + xShift, y: baseY - lift });
      }
      paths.push({ points: row });
    }
    // s only affects imageFit; referenced to keep the mapping explicit
    void s;
    return { widthMm: plotW + (rows - 1) * Math.abs(shearX), heightMm: plotH + height, paths, meta: { title: "Depth Map" } };
  },
};

register(imageSurfaceModule);
