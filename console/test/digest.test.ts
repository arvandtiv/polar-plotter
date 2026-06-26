// Isolated host test for the G-code digester + .bgcode decoder.
// Run: cd console && npx tsx test/digest.test.ts
// (no browser needed — Node 18+ provides DecompressionStream/Blob/Response)
import { deflateSync } from 'node:zlib';
import { digestGcode } from '../src/lib/gcode.ts';
import { decodeBgcode } from '../src/lib/bgcode.ts';

let fails = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`);
  if (!cond) fails++;
};

// ---- bgcode container builder (little-endian) ----
function buildBgcode(opts: {
  compression: number; encoding: number; data: Uint8Array; uncompressed: number;
}): ArrayBuffer {
  const { compression, encoding, data, uncompressed } = opts;
  const parts: number[] = [];
  const u16 = (v: number) => { parts.push(v & 0xFF, (v >> 8) & 0xFF); };
  const u32 = (v: number) => { parts.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF); };
  // header: "GCDE" + version + checksum_type(0 = none)
  parts.push(0x47, 0x43, 0x44, 0x45); u32(1); u16(0);
  // one GCode block (type 1)
  u16(1); u16(compression); u32(uncompressed);
  if (compression !== 0) u32(data.length);   // compressed size
  u16(encoding);                              // GCode encoding param
  for (const b of data) parts.push(b);
  // checksum_type is 0 → no trailing CRC
  return new Uint8Array(parts).buffer;
}

async function main() {
  // ============ [1] G-code digest, raw placement (predictable coords) ============
  console.log('[1] digest: G0 travel / G1 draw, raw placement');
  {
    const prog = `
      G21
      G90
      G0 X10 Y20
      G1 X30 Y20
      G1 X30 Y40
    `;
    const r = digestGcode(prog, { penMode: 'g01', placeMode: 'raw',
      bounds: { left: 300, right: 300, up: 300, down: 300 } });
    ok('detects 2 draws', r.draws === 2, `draws=${r.draws}`);
    ok('detects 1 travel', r.travels === 1, `travels=${r.travels}`);
    ok('first op is pen up', r.queries[0] === 'pen?pos=up');
    ok('travel emits goto to (10,20)', r.queries.includes('goto?x=10&y=20'),
       r.queries[1]);
    ok('pen goes down before draw', r.queries.includes('pen?pos=down'));
    ok('draw line (10,20)->(30,20)', r.queries.includes('line?x0=10&y0=20&x1=30&y1=20&cycles=1&lift=0'));
    ok('ends pen up', r.queries[r.queries.length - 1] === 'pen?pos=up');
  }

  // ============ [2] Z-height pen + auto-detect ============
  console.log('[2] digest: Z-height pen, auto-detect, raw+flip');
  {
    // pen drops at (0,0), draws to (10,20); Y-flip sends the drawn endpoint to -20.
    const prog = `G90\nG0 Z2\nG0 X0 Y0\nG1 Z0\nG1 X10 Y20\nG0 Z2`;
    const r = digestGcode(prog, { penMode: 'auto', placeMode: 'rawflip',
      bounds: { left: 300, right: 300, up: 300, down: 300 } });
    ok('auto-detects Z mode', r.resolvedPen === 'z', `got ${r.resolvedPen}`);
    ok('one drawn segment', r.draws === 1, `draws=${r.draws}`);
    ok('Y-flip on drawn geometry (Y20 → -20)',
       r.queries.includes('line?x0=0&y0=0&x1=10&y1=-20&cycles=1&lift=0'), JSON.stringify(r.queries));
    ok('pen-up-only trailing travel dropped (Frame model)',
       !r.queries.some((q) => q.startsWith('goto?x=50')));
  }

  // ============ [3] auto-fit scaling + centering ============
  console.log('[3] digest: auto-fit centers and shrinks to bounds');
  {
    // 400mm-wide drawing into a 200mm-wide area -> scale 0.5, centered at origin
    const prog = `G90\nG1 X0 Y0\nG1 X400 Y0`;
    const r = digestGcode(prog, { penMode: 'g01', placeMode: 'fit',
      bounds: { left: 100, right: 100, up: 100, down: 100 } });
    ok('scale = 0.5', Math.abs(r.scale - 0.5) < 1e-6, `scale=${r.scale}`);
    // endpoints map to x=-100 and x=+100 (centered, scaled), y=0
    ok('left endpoint -> x=-100', r.queries.some(q => q.includes('x0=-100') || q.includes('x=-100')),
       JSON.stringify(r.queries));
    ok('warns about scaling', r.warnings.some(w => w.includes('scaled')));
  }

  // ============ [4] bgcode: plain ASCII block (compression 0, encoding 0) ============
  console.log('[4] bgcode: uncompressed ASCII block');
  {
    const text = 'G21\nG90\nG1 X10 Y10\n';
    const data = new TextEncoder().encode(text);
    const buf = buildBgcode({ compression: 0, encoding: 0, data, uncompressed: data.length });
    const out = await decodeBgcode(buf);
    ok('round-trips ASCII gcode', out === text, JSON.stringify(out));
  }

  // ============ [5] bgcode: deflate compression ============
  console.log('[5] bgcode: deflate-compressed block');
  {
    const text = 'G1 X1 Y2\nG1 X3 Y4\nG1 X5 Y6\n';
    const raw = new TextEncoder().encode(text);
    const comp = new Uint8Array(deflateSync(Buffer.from(raw)));   // zlib-wrapped deflate
    const buf = buildBgcode({ compression: 1, encoding: 0, data: comp, uncompressed: raw.length });
    const out = await decodeBgcode(buf);
    ok('inflates deflate block', out === text, JSON.stringify(out));
  }

  // ============ [6] MeatPack decode (hand-built packed stream) ============
  console.log('[6] bgcode: MeatPack encoding');
  {
    // enable-packing command (FF FF 251), then "G1\n":
    //   (G,1) -> low=0xD high=0x1 -> 0x1D ; ('\n',_) -> low=0xC -> 0x0C (2nd dropped on \n)
    const data = new Uint8Array([0xFF, 0xFF, 251, 0x1D, 0x0C]);
    const buf = buildBgcode({ compression: 0, encoding: 1, data, uncompressed: data.length });
    const out = await decodeBgcode(buf);
    ok('decodes MeatPack "G1\\n"', out === 'G1\n', JSON.stringify(out));
  }

  // ============ [7] heatshrink decode (hand-computed bitstream) ============
  console.log('[7] bgcode: heatshrink(11,4) decompression');
  {
    // bitstream for "ABAB": lit A, lit B, backref(index=1,count=1) copying "AB".
    // 34 bits packed MSB-first, padded to 5 bytes:
    const data = new Uint8Array([0xA0, 0xD0, 0x80, 0x04, 0x40]);
    const buf = buildBgcode({ compression: 2, encoding: 0, data, uncompressed: 4 });
    const out = await decodeBgcode(buf);
    ok('heatshrink expands "ABAB"', out === 'ABAB', JSON.stringify(out));
  }

  console.log(`\n${fails ? `TESTS FAILED (${fails})` : 'ALL TESTS PASSED'}`);
  process.exit(fails ? 1 : 0);
}

main();
