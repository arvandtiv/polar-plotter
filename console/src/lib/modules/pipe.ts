// Pipe generator — a tube of hand-wobbled circles laid along an invisible SPINE:
// a circular ARC (up to a full ring) or a straight LINE. Circle size runs rMin→rMax
// along the spine, or follows a MULTI-POINT size profile (`sizeStops`, e.g. "1,8,2,10"
// — same convention as ruledLines' densityStops) for swell-and-shrink gradients.
// Registers on import. Pure.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import { parseSizeStops, pipeAlongSpine, type PipeOpts } from "../pipe";
import type { Frame, Path, Pt } from "../frame";

export const pipeModule: Module = {
  key: "pipe",
  label: "Pipe",
  kind: "make",
  group: "Shapes",
  description: "Growing circles along an invisible arc or line spine — a tapered tube. Multi-point size stops (\"1,8,2,10\") make the tube swell and shrink.",
  sections: [
    { title: "Spine", fields: [
      { key: "spine", label: "Spine", type: "select", default: "arc", options: [
        { value: "arc",  label: "Arc (up to full ring)" },
        { value: "line", label: "Straight line" },
      ]},
      { key: "cx", label: "Arc centre X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Arc centre Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "spineR", label: "Arc radius", type: "range", min: 5, max: 300, step: 1, unit: "mm", default: 80 },
      { key: "a0", label: "Start angle", type: "range", min: -360, max: 360, step: 5, unit: "°", default: 0 },
      { key: "a1", label: "End angle", type: "range", min: -360, max: 360, step: 5, unit: "°", default: 360 },
      { key: "x0", label: "Line X0", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: -100 },
      { key: "y0", label: "Line Y0", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "x1", label: "Line X1", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 100 },
      { key: "y1", label: "Line Y1", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Circles", fields: [
      { key: "rMin",      label: "Start radius (min r)", type: "range", min: 0.5, max: 60, step: 0.5, unit: "mm", default: 2 },
      { key: "rMax",      label: "End radius (max r)",   type: "range", min: 0.5, max: 60, step: 0.5, unit: "mm", default: 12 },
      { key: "sizeStops", label: "Size stops", type: "text", placeholder: "e.g. 1,8,2,10  (overrides min/max)", default: "" },
      { key: "spacing",   label: "Circle spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 6 },
      { key: "jitter",    label: "Hand jitter", type: "range", min: 0, max: 4, step: 0.1, unit: "mm", default: 0.8 },
      { key: "seed",      label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
    ]},
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "×", default: 1 },
    ]},
  ],
  generate(params): Frame {
    const spineKind = String(params.spine ?? "arc");
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const o: PipeOpts = {
      rMin: Math.max(0.1, num(params, "rMin", 2)),
      rMax: Math.max(0.1, num(params, "rMax", 12)),
      sizeStops: parseSizeStops(params.sizeStops),
      spacing: Math.max(0.5, num(params, "spacing", 6)),
      jitter: Math.max(0, num(params, "jitter", 0.8)),
      rng: seededRandom(Math.round(num(params, "seed", 42))),
    };

    const spine: Pt[] = [];
    let w = 200, h = 200;
    if (spineKind === "line") {
      const x0 = num(params, "x0", -100), y0 = num(params, "y0", 0);
      const x1 = num(params, "x1", 100), y1 = num(params, "y1", 0);
      spine.push({ x: x0, y: y0 }, { x: x1, y: y1 });
      w = Math.abs(x1 - x0) + 2 * o.rMax;
      h = Math.abs(y1 - y0) + 2 * o.rMax;
    } else {
      // Arc spine sampled every ~2 mm so the tube hugs the curve exactly.
      const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
      const R = Math.max(1, num(params, "spineR", 80));
      const a0 = (num(params, "a0", 0) * Math.PI) / 180;
      const a1 = (num(params, "a1", 360) * Math.PI) / 180;
      const span = a1 - a0;
      const len = Math.abs(span) * R;
      const n = Math.max(8, Math.ceil(len / 2));
      for (let i = 0; i <= n; i++) {
        const a = a0 + span * (i / n);
        spine.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
      }
      w = h = 2 * (R + Math.max(o.rMax, ...(o.sizeStops.length ? o.sizeStops : [0])));
    }

    const paths: Path[] = [];
    pipeAlongSpine(spine, o, paths, cycles);
    return { widthMm: w, heightMm: h, paths, meta: { title: "Pipe" } };
  },
};

register(pipeModule);
