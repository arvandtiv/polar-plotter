// Dev sanity check: render the Truchet preview path (the exact generator the
// firmware mirrors) to an SVG. Run: npx tsx truchet_preview_test.ts
import { writeFileSync } from 'node:fs';
import { buildPath, type TruchetCmd } from './src/hooks/usePlotter';

const cases: { name: string; cmd: TruchetCmd }[] = [
  { name: 'default-rect', cmd: { type: 'truchet', n: 4, spacing: 3, angle: 45, seed: 42, motifs: 0,
      left: 240, right: 240, up: 200, down: 200, shape: 'rect' } },
  { name: 'arcs-ellipse', cmd: { type: 'truchet', n: 6, spacing: 4, angle: 45, seed: 7, motifs: 0b11,
      left: 240, right: 240, up: 200, down: 200, shape: 'ellipse' } },
  { name: 'mixed-nohatch', cmd: { type: 'truchet', n: 5, spacing: 0, angle: 45, seed: 3, motifs: 0x7fff,
      left: 240, right: 240, up: 200, down: 200, shape: 'rect' } },
];

for (const { name, cmd } of cases) {
  const pts = buildPath(cmd);
  const w = cmd.left + cmd.right, h = cmd.up + cmd.down;
  let d = '';
  for (const p of pts) d += `${p.pen ? 'L' : 'M'}${(p.x + cmd.left).toFixed(2)},${(p.y + cmd.down).toFixed(2)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}">
<rect width="${w}" height="${h}" fill="white"/>
<path d="${d}" fill="none" stroke="black" stroke-width="0.6"/>
</svg>`;
  writeFileSync(`/tmp/truchet-${name}.svg`, svg);
  console.log(`${name}: ${pts.length} points -> /tmp/truchet-${name}.svg`);
}
