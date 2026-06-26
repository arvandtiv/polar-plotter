// Browser-only image loader: decode a File and downsample to a grayscale grid that the
// pure image modules consume via ctx.image. Only loadImageToGray touches the DOM/canvas;
// it's called from the Studio UI, never from a test. See docs/v1.3/06-text-image-maps.md.

import type { GrayImage } from "./registry";

/** Bilinear grayscale sample at a fractional grid coordinate (clamped to the image). */
export function sampleGray(img: GrayImage, x: number, y: number): number {
  const { width: w, height: h, gray } = img;
  const cx = Math.max(0, Math.min(w - 1, x));
  const cy = Math.max(0, Math.min(h - 1, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0, fy = cy - y0;
  const a = gray[y0 * w + x0], b = gray[y0 * w + x1], c = gray[y1 * w + x0], d = gray[y1 * w + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Fit an image into a plotSize box centred at (cx,cy), preserving aspect. */
export function imageFit(img: GrayImage, plotSize: number, cx: number, cy: number) {
  const s = Math.min(plotSize / img.width, plotSize / img.height);
  return { s, offX: cx - (img.width * s) / 2, offY: cy - (img.height * s) / 2, plotW: img.width * s, plotH: img.height * s };
}

/** Decode `file`, fit within `maxDim`, return a row-major grayscale (0..1) grid. */
export async function loadImageToGray(file: File, maxDim = 220): Promise<GrayImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("could not decode image"));
      im.src = url;
    });
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const s = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    if (!cx) throw new Error("no 2d canvas context");
    cx.drawImage(img, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    }
    return { width: w, height: h, gray };
  } finally {
    URL.revokeObjectURL(url);
  }
}
