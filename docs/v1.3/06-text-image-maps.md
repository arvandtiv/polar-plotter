# 06 — Text, image, (stretch) maps

*Reference: `reference/lineandform/modules/index.js` shows `text` (via `opentype.js`),
`image-linework`, `halftone`, `squiggle-draw`, and the `geospatial`/`ink-layers` map
stack. We re-implement as our own Frame generators; we use the same OSS libs upstream.*

All of these are just generators that output a **Frame** — once Phase 0–2 exist they
plug in with no special casing.

## Text (Day 20)
- Dep: `opentype.js` (MIT) from npm. Load a bundled font (or user upload).
- `generate({ text, fontSize, letterSpacing, align })`:
  `font.getPath(text, x, y, sizePx)` → walk path commands → polylines (`geom.sample
  Bezier` for Q/C, flatten). Convert px→mm by the font's unitsPerEm. Return closed
  paths per glyph contour.
- Pairs beautifully with the **Fill** modifier (outline + hatch) and **Mask**.

## Image → linework (Day 21)
- Load to an `OffscreenCanvas`; read pixels in a worker (keep the UI responsive).
- Simplest first pass: threshold → contour trace (marching squares) → `simplifyRDP` →
  Frame. Later: flow-field / edge-tangent hatching for a sketch look.
- Fields: threshold, invert, line spacing, min feature size, max dimension (downscale).

## Image → halftone / squiggle (Day 22)
- Sample brightness on a grid; map darkness → dot radius (halftone) or → wave amplitude
  along scan rows (squiggle). Output dots-as-tiny-circles or one continuous wavy path.
- Continuous squiggle is plotter-friendly (one long stroke = minimal pen lifts).

## Maps (stretch — not scheduled)
- Reference uses Leaflet + contour ink-layers. For us this is a big feature; capture it
  as a future generator that fetches vector tiles / contour GeoJSON → Frame, styled by
  named layers (`core/ink-layers.js` is the model). Defer past v1.3 unless wanted.

## Common rules
- Every module stays **pure** where possible; image modules isolate the canvas/worker
  read, then hand a plain `Frame` to the same optimize→compile path.
- Heavy work (image, large text) runs off the main thread; show a "processing…" state
  like the `.bgcode` decode.
