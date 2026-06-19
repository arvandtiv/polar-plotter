# 07 — Live preview + drawing-order scrubber

*Reference: `reference/lineandform/core/geometry.js` (`slicePathByUnits`,
`buildProgressPaths`, `countVisiblePaths`) drives the "Drawing Order 100%" scrubber;
`core/rendering.js` for how a frame is drawn. Clean-room.*

## Live Frame preview (Day 23)
Render the *evaluated* Frame to a canvas **before** sending, so the user tweaks against
what will actually plot. Reuse the existing `PlotterCanvas` (it already draws bounds +
pen). Add a `frame?: Frame` prop and draw each path as a polyline in plotter coords.

- Same coordinate mapping the canvas already uses for the pen dot.
- Color: pen-down strokes solid; show travel hops faint/dashed (optional) by drawing
  the gaps between consecutive optimized paths — this visualizes the Day-9 ordering win.
- Recompute on param change (debounced); generators are fast and pure so this is cheap.
  Image/heavy modules cache their last Frame and only re-run on relevant fields.

## Drawing-order scrubber (Day 24)
Reveal the toolpath progressively by arc length:

```ts
buildProgressPaths(frame: Frame, pct: number): Frame
// total = sum of path lengths; cut at pct*total using slicePathByUnits,
// returning whole paths up to the cut plus a partial last path.
```

A slider (0–100%) scrubs it; the preview shows only the revealed portion. Great for
"where will the pen be at 40%?" and for spotting a bad travel order. This is purely a
preview aid — it does **not** change what gets streamed.

## Why it matters
- Confidence before committing a multi-hour plot.
- Makes the optimize step (§04) legible — you can *see* travel drop and ordering change.
- Cheap: all pure geometry over the Frame we already computed.

## Tests
- `buildProgressPaths(frame, 0)` → empty; `(frame, 1)` → same total length as input.
- `(frame, 0.5)` → revealed length ≈ 50% of total (within one segment).
