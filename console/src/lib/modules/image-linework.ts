// Image → Linework generator — brightness iso-contours (marching squares) of a source
// image, giving a "topographic" rendering. The image grid arrives via ctx.image (loaded
// by the Studio); the contour geometry here is pure & host-testable. Registers on import.

import { register, num, type Module } from "../registry";
import type { Frame, Path, Pt } from "../frame";

// Marching squares for one brightness level → list of [a,b] grid-space segments.
export function isoContours(gray: Float32Array, w: number, h: number, level: number): [Pt, Pt][] {
  const segs: [Pt, Pt][] = [];
  const lerp = (va: number, vb: number) => (Math.abs(vb - va) < 1e-9 ? 0.5 : (level - va) / (vb - va));
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = gray[y * w + x], tr = gray[y * w + x + 1];
      const br = gray[(y + 1) * w + x + 1], bl = gray[(y + 1) * w + x];
      const idx = (tl < level ? 1 : 0) | (tr < level ? 2 : 0) | (br < level ? 4 : 0) | (bl < level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const T: Pt = { x: x + lerp(tl, tr), y };
      const R: Pt = { x: x + 1, y: y + lerp(tr, br) };
      const B: Pt = { x: x + lerp(bl, br), y: y + 1 };
      const L: Pt = { x, y: y + lerp(tl, bl) };
      switch (idx) {
        case 1: case 14: segs.push([L, T]); break;
        case 2: case 13: segs.push([T, R]); break;
        case 3: case 12: segs.push([L, R]); break;
        case 4: case 11: segs.push([R, B]); break;
        case 6: case 9:  segs.push([T, B]); break;
        case 7: case 8:  segs.push([L, B]); break;
        case 5:  segs.push([L, T]); segs.push([R, B]); break;   // saddle
        case 10: segs.push([T, R]); segs.push([L, B]); break;   // saddle
      }
    }
  }
  return segs;
}

export const imageLineworkModule: Module = {
  key: "imageLinework",
  label: "Image Linework",
  kind: "make",
  group: "Image",
  description: "Brightness iso-contours of a source image (load one in the Studio).",
  sections: [
    { title: "Contours", fields: [
      { key: "levels", label: "Levels", type: "range", min: 1, max: 24, step: 1, default: 8 },
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
      return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Image Linework (load an image)" } };
    }
    const levels = Math.max(1, Math.round(num(params, "levels", 8)));
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);

    const g = invert ? img.gray.map((v) => 1 - v) : img.gray;
    // map the whole image frame into a plotSize box (preserve image aspect, centre at cx,cy),
    // so contours keep their spatial position within the photo.
    const s = Math.min(plot / img.width, plot / img.height);
    const offX = cx - (img.width * s) / 2, offY = cy - (img.height * s) / 2;
    const map = (p: Pt): Pt => ({ x: p.x * s + offX, y: p.y * s + offY });

    const paths: Path[] = [];
    for (let i = 1; i <= levels; i++) {
      const level = i / (levels + 1);
      for (const [a, b] of isoContours(g, img.width, img.height, level)) paths.push({ points: [map(a), map(b)] });
    }
    return { widthMm: img.width * s, heightMm: img.height * s, paths, meta: { title: "Image Linework" } };
  },
};

register(imageLineworkModule);
