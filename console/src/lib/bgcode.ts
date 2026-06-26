// Prusa binary G-code (.bgcode) decoder — extracts the ASCII G-code back out of a
// binary-gcode container so the rest of the pipeline (lib/gcode.ts) can treat it
// exactly like a pasted .gcode file.
//
// Spec: prusa3d/libbgcode doc/specifications.md (little-endian throughout):
//   File header: magic "GCDE" (4) + version u32 + checksum_type u16   (10 bytes)
//   Block: type u16, compression u16, uncompressed_size u32,
//          [compressed_size u32 IF compression != 0], <params>, <data>, [crc32 u32]
//   Block types: 0 FileMeta, 1 GCode, 2 SlicerMeta, 3 PrinterMeta, 4 PrintMeta, 5 Thumbnail
//   Compression: 0 none, 1 deflate, 2 heatshrink(11,4), 3 heatshrink(12,4)
//   GCode encoding param (u16): 0 none, 1 MeatPack, 2 MeatPack+comments
//   Checksum: 0 none, 1 CRC32
// Only GCode blocks (type 1) are decoded; everything else is skipped.

const BLOCK_GCODE = 1;
const BLOCK_THUMBNAIL = 5;

// ---- heatshrink decoder (Atomic Object format) -------------------
// Token stream, MSB-first bits: a 1 tag = 8-bit literal; a 0 tag = backref of
// (window_bits index)+1 and (lookahead_bits count)+1, copied from the output so
// far (self-overlapping). `expected` (the block's uncompressed_size) bounds the
// output so trailing zero-padding can't synthesise a spurious final backref.
function heatshrinkDecode(data: Uint8Array, windowBits: number, lookaheadBits: number, expected: number): Uint8Array {
  const out: number[] = [];
  const totalBits = data.length * 8;
  let bitPos = 0;
  const getBit = (): number => {
    if (bitPos >= totalBits) return -1;
    const bit = (data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  const getBits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = getBit();
      if (b < 0) return -1;
      v = (v << 1) | b;
    }
    return v;
  };
  while (out.length < expected) {
    const tag = getBit();
    if (tag < 0) break;
    if (tag === 1) {
      const b = getBits(8);
      if (b < 0) break;
      out.push(b);
    } else {
      const index = getBits(windowBits);
      const count = getBits(lookaheadBits);
      if (index < 0 || count < 0) break;
      const realIndex = index + 1;
      const realCount = count + 1;
      for (let i = 0; i < realCount && out.length < expected; i++) {
        out.push(out[out.length - realIndex]);
      }
    }
  }
  return Uint8Array.from(out);
}

// ---- MeatPack decoder (faithful port of libbgcode meatpack.cpp unbinarize) ----
function meatpackDecode(src: Uint8Array): string {
  let unbinarizing = false;
  let nospace = false;
  let cmdActive = false;
  let cmdCount = 0;
  let fullCharQueue = 0;
  let charBuf = 0;
  const out: number[] = [];

  const getChar = (c: number): number => {
    if (c <= 9) return 48 + c;          // '0'..'9'
    if (c === 0xA) return 46;           // '.'
    if (c === 0xB) return nospace ? 69 : 32; // 'E' (no-space mode) or ' '
    if (c === 0xC) return 10;           // '\n'
    if (c === 0xD) return 71;           // 'G'
    if (c === 0xE) return 88;           // 'X'
    return 0;
  };
  const handleCommand = (c: number) => {
    if (c === 251) unbinarizing = true;        // EnablePacking
    else if (c === 250) unbinarizing = false;  // DisablePacking
    else if (c === 247) nospace = true;        // EnableNoSpaces
    else if (c === 246) nospace = false;       // DisableNoSpaces
    else if (c === 249) unbinarizing = false;  // ResetAll
    // 248 QueryConfig: no-op
  };
  const handleRx = (c: number) => {
    if (!unbinarizing) { out.push(c); return; }
    if (fullCharQueue > 0) {
      out.push(c);
      if (charBuf > 0) { out.push(charBuf); charBuf = 0; }
      fullCharQueue--;
      return;
    }
    const lowFull  = (c & 0x0F) === 0x0F;   // lower nibble == 0b1111 → next byte is literal
    const highFull = (c & 0xF0) === 0xF0;   // upper nibble == 0b1111 → next byte is literal
    const b0 = lowFull  ? 0 : getChar(c & 0x0F);
    const b1 = highFull ? 0 : getChar((c >> 4) & 0x0F);
    if (lowFull) {
      fullCharQueue++;
      if (highFull) fullCharQueue++;
      else charBuf = b1;
    } else {
      out.push(b0);
      if (b0 !== 10) {              // newline never carries a second char
        if (highFull) fullCharQueue++;
        else out.push(b1);
      }
    }
  };

  for (const c of src) {
    if (c === 0xFF) {
      if (cmdCount > 0) { cmdActive = true; cmdCount = 0; }
      else cmdCount++;
    } else if (cmdActive) {
      handleCommand(c);
      cmdActive = false;
    } else {
      if (cmdCount > 0) { handleRx(0xFF); cmdCount = 0; }
      handleRx(c);
    }
  }
  return String.fromCharCode(...out);
}

// ---- deflate via the browser's native DecompressionStream -----------
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('this browser lacks DecompressionStream — deflate-compressed .bgcode unsupported');
  // bgcode's deflate is zlib-wrapped; fall back to raw if the header check fails.
  for (const fmt of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new DecompressionStream(fmt);
      const blob = new Blob([data as BlobPart]);
      const buf = await new Response(blob.stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(buf);
    } catch { /* try next format */ }
  }
  throw new Error('deflate decompression failed');
}

async function decompress(data: Uint8Array, compression: number, uncompressed: number): Promise<Uint8Array> {
  switch (compression) {
    case 0: return data;
    case 1: return inflate(data);
    case 2: return heatshrinkDecode(data, 11, 4, uncompressed);
    case 3: return heatshrinkDecode(data, 12, 4, uncompressed);
    default: throw new Error(`unknown bgcode compression type ${compression}`);
  }
}

function decodeGcodeData(raw: Uint8Array, encoding: number): string {
  switch (encoding) {
    case 0: return new TextDecoder().decode(raw);            // plain ASCII
    case 1: case 2: return meatpackDecode(raw);              // MeatPack (+comments)
    default: throw new Error(`unknown gcode encoding type ${encoding}`);
  }
}

/** Decode a .bgcode file (ArrayBuffer) into its ASCII G-code text. Throws on a
 *  malformed container or unsupported compression/encoding. */
export async function decodeBgcode(buf: ArrayBuffer): Promise<string> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (buf.byteLength < 10 ||
      u8[0] !== 0x47 || u8[1] !== 0x43 || u8[2] !== 0x44 || u8[3] !== 0x45) // "GCDE"
    throw new Error('not a binary G-code file (missing GCDE magic)');

  // version = dv.getUint32(4, true) — unused
  const checksumType = dv.getUint16(8, true);
  const crcBytes = checksumType === 1 ? 4 : 0;
  let pos = 10;
  let text = '';

  while (pos + 8 <= buf.byteLength) {
    const type = dv.getUint16(pos, true);
    const compression = dv.getUint16(pos + 2, true);
    const uncompressed = dv.getUint32(pos + 4, true);
    pos += 8;
    let dataSize = uncompressed;
    if (compression !== 0) { dataSize = dv.getUint32(pos, true); pos += 4; }

    // Block parameters (fixed-size, uncompressed). GCode + metadata = 2-byte
    // encoding; thumbnail = 6 bytes (format/width/height); others none.
    let encoding = 0;
    if (type === BLOCK_THUMBNAIL) {
      pos += 6;
    } else {
      encoding = dv.getUint16(pos, true);
      pos += 2;
    }

    const data = u8.subarray(pos, pos + dataSize);
    pos += dataSize + crcBytes;

    if (type === BLOCK_GCODE) {
      const raw = await decompress(data, compression, uncompressed);
      text += decodeGcodeData(raw, encoding);
    }
  }

  if (!text) throw new Error('no G-code blocks found in file');
  return text;
}
