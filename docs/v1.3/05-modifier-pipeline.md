# 05 — Modifier pipeline (`lib/pipeline.ts`)

*Reference: `reference/lineandform/core/rendering.js` (frame compositing + applying
modifier descriptors to lower layers), `modules/ripples.js` (descriptor style),
`modules/mask.js` (clipper boolean style). Clean-room re-implementation.*

## Concept
A document is an ordered **layer stack**. Layers evaluate **bottom → top**; each layer
sees the composite of everything beneath it as `ctx.lowerFrame`:

```ts
interface Layer { id:string; moduleKey:string; params:Record<string,any>; }

function evaluate(layers: Layer[], bounds): Frame {
  let lower: Frame | undefined;
  let acc: Frame = emptyFrame(bounds);
  for (const layer of layers) {
    const mod = registry.get(layer.moduleKey)!;
    const out = mod.generate(layer.params, { bounds, lowerFrame: acc });
    acc = (mod.kind === "modify") ? out : mergeFrames(acc, out);
  }
  return acc;
}
```

- A **make** ignores `lowerFrame` and contributes paths (`mergeFrames` appends).
- A **modify** consumes `lowerFrame` and **returns the replacement** frame (it may keep,
  drop, displace, mask, or fill what was below). Order matters — that's the feature.

The final frame goes to `compile` → `streamQueries`, same as everything else.

## Two modifier styles
1. **Transform-in-place** (Mask, Warp, Ripple, Fill): read `lowerFrame.paths`, return a
   new `paths` array. Simple and fully testable.
2. **Descriptor** (the reference's `rippleModifiers` + `rippleTargetScope`): return a
   recipe the evaluator applies. More flexible (scope = "directly below" vs "all below")
   but more machinery. **Start with style 1**; adopt style 2 only if we need scoping.

## The first modifiers (Days 17–19)
- **Shape Mask** — keep only `lowerFrame` geometry inside (or outside) a mask polygon.
  Uses `geom.booleanClip(lowerPaths, maskPath, "intersection" | "difference")`.
- **Fill** — for each closed path in `lowerFrame`, generate scanline hatch (angle +
  spacing fields) and/or concentric insets (`offsetPath`); append to the frame. This is
  the console-side twin of the firmware hatch/concentric fill, now available on *any*
  closed geometry (text, imports, generators), not just circle/square.
- **Warp / Ripple** — `resample` lower paths, then displace each point by a field
  (radial droplet rings or a sinusoidal "water" warp). Amplitude/strength/center fields.

## UI (Day 16)
`StudioTab` grows a **Sequence** list (mirrors the reference's drawing-order panel):
add layer (pick make/modify), reorder (drag or ↑/↓), remove, per-layer ParamPanel.
Selecting a layer shows its panel; the preview renders `evaluate(layers)`.

## Tests (`pipeline.test.ts`)
- Two makes compose (path counts add); swapping order is observable.
- A mask over a grid drops paths outside the mask; counts match expectation.
- Fill on a square produces N hatch lines for a given spacing.
- Warp with amplitude 0 is identity (no change to lower frame).
