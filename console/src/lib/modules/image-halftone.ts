// Image → Halftone generator — a grid of dots sized by local darkness. Pure (reads
// ctx.image). Registers on import.

import { register, num, type Module } from "../registry";
import { sampleGray, imageFit } from "../image";
import type { Frame, Path, Pt } from "../frame";

export const imageHalftoneModule: Module = {
  key: "imageHalftone",
  label: "Image Halftone",
  kind: "make",
  group: "Image",
  description: "A grid of dots sized by the image's darkness (load an image in the Studio).",
  sections: [
    { title: "Halftone", fields: [
      { key: "spacing", label: "Dot spacing", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 4 },
      { key: "maxDot", label: "Max dot", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 4 },
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
    if (!img || img.width < 2) return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Image Halftone (load an image)" } };
    const spacing = Math.max(1, num(params, "spacing", 4));
    const maxDot = num(params, "maxDot", 4);
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const { s, offX, offY, plotW, plotH } = imageFit(img, plot, cx, cy);

    const paths: Path[] = [];
    for (let my = offY + spacing / 2; my < offY + plotH; my += spacing) {
      for (let mx = offX + spacing / 2; mx < offX + plotW; mx += spacing) {
        let v = sampleGray(img, (mx - offX) / s, (my - offY) / s);
        if (invert) v = 1 - v;
        const r = (1 - v) * maxDot / 2;
        if (r < 0.3) continue;
        const n = 12, pts: Pt[] = [];
        for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pts.push({ x: mx + r * Math.cos(a), y: my + r * Math.sin(a) }); }
        paths.push({ points: pts, closed: true });
      }
    }
    return { widthMm: plotW, heightMm: plotH, paths, meta: { title: "Image Halftone" } };
  },
};

register(imageHalftoneModule);
