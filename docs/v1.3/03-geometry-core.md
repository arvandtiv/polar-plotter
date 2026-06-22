# 03 — Geometry core (`lib/geom.ts`)

*A pure TS geometry toolkit: resample, bbox, fit-to-page, affine transforms,
segment clip, and (later) boolean ops — implemented here, no dependency.*

This is the shared toolkit every generator, modifier, and the compiler call. Keep it
dependency-free (like `kinematics.h`) except for the clipping lib (added at Day 17).

## v1 surface (Day 2)
```ts
resample(points: Pt[], spacingMm: number): Pt[]      // even arc-length resampling
polylineLength(points: Pt[]): number
bbox(paths: Path[]): { x0;y0;x1;y1 } | null
fitToBounds(frame, bounds, mode): Frame              // scale<=1 + centre + (digester reuses this)
translate/rotate/scale(points, ...): Pt[]            // affine on points
sampleBezier(p0,p1,p2,p3, n): Pt[]                   // cubic, n samples
seededRandom(seed: number): () => number             // deterministic RNG (mulberry32)
```

Notes:
- `fitToBounds` is the same math the G-code digester already does for placement —
  factor it here and have the digester import it (removes duplication).
- `resample` underpins modifiers (warp/ripple need evenly spaced points) and simplify.
- `seededRandom`: generators must be deterministic for a given seed so previews match
  plots and tests are stable. Mulberry32 is tiny and good enough.

## v2 surface (added as days need it)
```ts
simplifyRDP(points, tol): Pt[]            // Day 10
filterCollinear(points, tol): Pt[]        // Day 10
booleanClip(subject, clip, op): Path[]    // Day 17 — wraps the clipping lib
offsetPath(path, deltaMm): Path[]         // (optional) inset for concentric fill
fitArcs(points, tol): Segment[]           // Day 26 — line/arc segmentation
```

## Clipping library (Day 17)
The reference bundles a `clipper.js`. For us, prefer a maintained npm dep:
`polygon-clipping` (MIT) for boolean ops, or `js-angusj-clipper` if we need offsetting.
Wrap it behind `booleanClip`/`offsetPath` so modules never touch the lib directly and
we can swap it.

## Tests (`geom.test.ts`)
- `bbox` of a known point cloud.
- `fitToBounds` centres and never enlarges (scale ≤ 1); aspect preserved.
- `resample` keeps first/last points and yields ~uniform spacing.
- `seededRandom(42)` reproduces a fixed sequence.
- (Day 10) `simplifyRDP` collapses a straight run to 2 points; keeps a corner.
