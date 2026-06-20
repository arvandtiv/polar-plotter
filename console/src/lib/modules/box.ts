// First real generator: a rectangle. Exercises the full module contract
// (declarative fields + pure generate → Frame). Registers on import.
// See docs/v1.3/02-fields-and-registry.md.

import { register, num, type Module } from "../registry";
import { rectPath, type Frame } from "../frame";

export const boxModule: Module = {
  key: "box",
  label: "Box",
  kind: "make",
  group: "Shapes",
  description: "An axis-aligned rectangle.",
  sections: [
    {
      title: "Size",
      fields: [
        { key: "width",  label: "Width",  type: "range", min: 1, max: 600, step: 1, unit: "mm", default: 100 },
        { key: "height", label: "Height", type: "range", min: 1, max: 600, step: 1, unit: "mm", default: 100 },
      ],
    },
    {
      title: "Position",
      fields: [
        { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
        { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      ],
    },
  ],
  generate(params): Frame {
    const w = num(params, "width", 100);
    const h = num(params, "height", 100);
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    return { widthMm: w, heightMm: h, paths: [rectPath(cx, cy, w, h)], meta: { title: "Box" } };
  },
};

register(boxModule);
