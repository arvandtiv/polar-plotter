import { readFileSync, writeFileSync } from 'fs';
import { z } from 'zod';

const doc = {
  metadata: {
    work_area: { x_min: -276, x_max: 263, y_min: -273, y_max: 115 },
    grid: { cols: 5, rows: 5, padding_mm: 10 },
  },
  commands: [
    { type: 'grid_select', col: 0, row: 0 },
    { type: 'circle', cx: 0, cy: 0, r: 15 },
  ],
};

const schema = z.union([
  z.array(z.object({ type: z.string().optional() }).passthrough()).min(1),
  z.object({
    metadata: z.record(z.string(), z.unknown()).optional(),
    commands: z.array(z.object({ type: z.string().optional() }).passthrough()).min(1),
  }),
]);

const parsed = schema.safeParse(doc);
console.log('zod ok:', parsed.success, parsed.error?.issues);

function gridCtxFromMetadata(d) {
  const meta = d?.metadata;
  if (!meta?.work_area || !meta?.grid) return null;
  const wa = meta.work_area;
  const grid = meta.grid;
  return {
    cols: Number(grid.cols), rows: Number(grid.rows),
    padding_mm: Number(grid.padding_mm ?? 5),
    full_xn: Number(wa.x_min), full_xp: Number(wa.x_max),
    full_yn: Number(wa.y_min), full_yp: Number(wa.y_max),
  };
}

const gc = gridCtxFromMetadata(doc);
const cellW = ((gc.full_xp - gc.full_xn) - (gc.cols - 1) * gc.padding_mm) / gc.cols;
const cellH = ((gc.full_yp - gc.full_yn) - (gc.rows - 1) * gc.padding_mm) / gc.rows;
console.log('cell', cellW, cellH);

// Wrong: passing only inner commands array
const innerOnly = doc.commands;
try {
  const arr = innerOnly;
  const gridCtx = null;
  if (!gridCtx) console.log('INNER ONLY: grid_select would FAIL - no gridCtx');
} catch (e) { console.log(e); }