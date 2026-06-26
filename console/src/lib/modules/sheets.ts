// Sheets generator — a grid of points is randomly displaced, grouped into columns,
// then columns are interpolated to produce flowing near-vertical lines.
//
// Algorithm: https://www.generativehut.com/post/generative-art-python-tutorial-for-penplotter
//   1. Build a rows×cols grid; perturb each point by random (xJitter, yJitter).
//   2. Group points by column.
//   3. Between every adjacent column pair lerp `interpSteps` intermediate columns.
//   4. Draw each (original + intermediate) column as a polyline top→bottom.

import { register, num, type Module } from "../registry";
import { seededRandom } from "../geom";
import type { Frame, Path, Pt } from "../frame";

export const sheetsModule: Module = {
  key: "sheets",
  label: "Sheets",
  kind: "make",
  group: "Lines & Patterns",
  description: "Randomly displaced grid columns, smoothly interpolated — produces flowing curtain-like lines.",
  sections: [
    { title: "Grid", fields: [
      { key: "cols",   label: "Columns",  type: "range", min: 2,  max: 60,  step: 1, default: 25 },
      { key: "rows",   label: "Rows",     type: "range", min: 2,  max: 60,  step: 1, default: 20 },
      { key: "xJitter", label: "X jitter", type: "range", min: 0, max: 50, step: 0.5, unit: "mm", default: 8 },
      { key: "yJitter", label: "Y jitter", type: "range", min: 0, max: 50, step: 0.5, unit: "mm", default: 5 },
    ]},
    { title: "Interpolation", fields: [
      { key: "interpSteps", label: "Steps between cols", type: "range", min: 0, max: 30, step: 1, default: 9 },
    ]},
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
    ]},
    { title: "Seed", fields: [
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
    ]},
  ],

  generate(params, ctx): Frame {
    const cols        = Math.max(2, Math.round(num(params, "cols", 25)));
    const rows        = Math.max(2, Math.round(num(params, "rows", 20)));
    const xJitter     = num(params, "xJitter", 8);
    const yJitter     = num(params, "yJitter", 5);
    const interpSteps = Math.max(0, Math.round(num(params, "interpSteps", 9)));
    const cx          = num(params, "cx", 0);
    const cy          = num(params, "cy", 0);
    const seed        = Math.round(num(params, "seed", 42));

    const rng = seededRandom(seed);

    const { left, right, up, down } = ctx.bounds;
    const xMin = -left, xMax = right;
    const yMin = -up,   yMax = down;
    const w = xMax - xMin, h = yMax - yMin;

    const cellW = w / (cols - 1);
    const cellH = h / (rows - 1);

    // Step 1 & 2: build grid, grouped by column.
    // grid[col][row] = displaced point.
    const grid: Pt[][] = [];
    for (let col = 0; col < cols; col++) {
      const column: Pt[] = [];
      for (let row = 0; row < rows; row++) {
        column.push({
          x: xMin + col * cellW + (rng() - 0.5) * 2 * xJitter + cx,
          y: yMin + row * cellH + (rng() - 0.5) * 2 * yJitter + cy,
        });
      }
      grid.push(column);
    }

    // Step 3 & 4: emit original columns interleaved with interpolated ones.
    // Order: colA → interp_1 → interp_2 → … → interp_N → colB → …
    // This sweeps left-to-right so the plotter minimises travel.
    const paths: Path[] = [];

    const addColumn = (pts: Pt[]) => {
      if (pts.length > 1) paths.push({ points: pts, closed: false });
    };

    for (let col = 0; col < cols - 1; col++) {
      const colA = grid[col];
      const colB = grid[col + 1];

      // Draw the original column A
      addColumn(colA.map(p => ({ ...p })));

      // Draw interpSteps intermediate columns between A and B
      for (let step = 1; step <= interpSteps; step++) {
        const t = step / (interpSteps + 1);
        addColumn(
          colA.map((a, row) => ({
            x: a.x + t * (colB[row].x - a.x),
            y: a.y + t * (colB[row].y - a.y),
          }))
        );
      }
    }

    // Draw the final column
    addColumn(grid[cols - 1].map(p => ({ ...p })));

    return { widthMm: w, heightMm: h, paths, meta: { title: "Sheets" } };
  },
};

register(sheetsModule);
