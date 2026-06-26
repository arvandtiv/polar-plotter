# The Studio — how it's built, and how to expose it to the MCP

This explains the v1.3 "Studio" end-to-end (so anyone can extend it), then lays out a
concrete plan to make the same generators/modifiers available to the **MCP server** so
Claude can drive them autonomously.

---

## Part 1 — How the Studio is put together

### The one idea: a `Frame`
Everything in the Studio is built around one tiny, framework-agnostic data type — a
**Frame**: page size + a list of polylines in millimetres, in the plotter's logical
coordinates (origin centre, +x right, +y down).

```ts
// console/src/lib/frame.ts
interface Pt   { x:number; y:number }
interface Path { points:Pt[]; closed?:boolean; cycles?:number; stroke?:string }
interface Frame{ widthMm:number; heightMm:number; paths:Path[]; meta?:{title?,anchor?} }
```

Every feature is just: **produce a Frame → optimise it → compile it to the firmware's
existing queue.** That single pipeline is what lets shapes, patterns, text, images,
imported G-code, and modifiers all interoperate.

```
generate(params, ctx) ─▶ Frame ─▶ simplify+optimise ─▶ compile ─▶ pen/goto/line/arc ─▶ firmware
                          ▲
                  modify(params, {lowerFrame})
```

### The pieces (all under `console/src/lib/`)

| File | Role |
|------|------|
| `frame.ts` | the Frame/Path/Pt types + helpers (`frameBounds`, `rectPath`, …) |
| `registry.ts` | the **module contract**: `Module = { key,label,kind:'make'|'modify',sections,generate }`; `Field` schema; `register`/`listModules`/`defaultsOf` |
| `modules/*.ts` | the generators & modifiers (box, circle, square, wobbly, spirograph, orbital-weave, moiré, pattern-maker, text, image-linework/halftone/squiggle/surface; mask, fill, warp). Each is a pure object that `register()`s itself on import. `modules/index.ts` imports them all. |
| `geom.ts` | pure geometry toolkit: `resample`, `bounds`, `fitToBounds`, affine (`rotate/scale/translate`), `sampleBezier`, `seededRandom`, `simplifyRDP`, `filterCollinear`, `clipSegmentToRect` |
| `clip.ts` | `clipPolylineToPolygon` (mask uses it) |
| `arcfit.ts` | `fitArcs` — collapse circular runs into arc primitives |
| `strokefont.ts` | built-in single-stroke vector font (no dependency) for Text |
| `image.ts` | **browser-only** `loadImageToGray` (canvas) + pure `sampleGray`/`imageFit` |
| `pipeline.ts` | `evaluate(layers, bounds, image?)` — runs the layer stack bottom→top, passing each layer the composite beneath it as `ctx.lowerFrame` |
| `toolpath.ts` | `simplifyFrame`, `optimizeOrder` (nearest-neighbour travel), `buildProgressPaths` (scrubber) |
| `compile.ts` | `compile(frame, {arcTol?})` → the firmware query strings (`pen?`, `goto?`, `line?…&lift=0`, `arc?…`) |

### The module contract (the heart of it)
Make and Modify share one shape. The **fields are data**, so the UI is generated, not
hand-written:

```ts
registry.set('spirograph', {
  key:'spirograph', label:'Spirograph', kind:'make', group:'Lines & Patterns',
  sections:[{ title:'Gears', fields:[
    { key:'R', type:'range', min:10, max:200, step:1, unit:'mm', default:80 }, … ]}],
  generate(params, ctx){ /* pure → returns a Frame */ },
});
```
- A **make** ignores `ctx.lowerFrame` and contributes paths.
- A **modify** reads `ctx.lowerFrame` and returns a transformed Frame (mask clips it,
  fill hatches its closed paths, warp displaces its points).
- `generate` is **pure and synchronous** → host-testable with `npx tsx`, no DOM. (Image
  modules are still pure; the *image bytes* arrive via `ctx.image`, decoded by the UI.)

### Execution
1. `evaluate(layers, bounds, image)` → one composite Frame.
2. `optimizeOrder(simplifyFrame(frame))` → fewer points, minimal pen-up travel.
3. `compile(...)` → an array of query strings.
4. `streamQueries(queries, handlers)` (in `usePlotter.ts`) paces them against the board's
   live queue depth, **batches** via `/api/batch` (≈80× fewer connections), and **retries**
   transient network failures instead of dropping jobs.

The firmware is unchanged by all of this except two small additive endpoints used by the
pipeline: `arc` (`do_draw_arc` / `/api/arc`) and `/api/batch`.

### The UI (`console/src/components/App.tsx`)
- A header **Console ▏ Studio** switch.
- `StudioPage` — full-page 2-pane: **left** = live `FramePreview` (renders the Frame in
  plotter coords) + drawing-order scrubber + Run/Abort + machine STOP/PAUSE/CLEAR; **right**
  = Documents (save/load/export/import), source image, the layer **Sequence** + Add, and
  the selected layer's auto-generated `ParamPanel`.
- `ParamPanel.tsx` turns a module's `sections/fields` into native controls.
- Per-module values + the layer stack + named documents persist in `localStorage`.

Design notes & the build history live in [`docs/v1.3/`](v1.3/README.md).

---

## Part 2 — Exposing the Studio to the MCP

**Yes — it's very doable, and the architecture was (accidentally) built for it.** The
generators, modifiers, geometry, optimiser, and compiler are **pure TS with no DOM and no
React**. The only things tied to the browser/UI are `image.ts:loadImageToGray` (canvas)
and `App.tsx` (the panels). So the same `generate → optimise → compile` can run inside the
Node MCP server and stream straight to the firmware.

### What's reusable as-is vs. needs work
| Capability | MCP reusability |
|---|---|
| box, circle, square, wobbly, spirograph, orbital-weave, moiré, pattern-maker | ✅ pure — runs in Node directly |
| text | ✅ pure (built-in stroke font, no font file) |
| mask, fill, warp (modifiers) | ✅ pure |
| `geom`, `toolpath`, `compile`, `pipeline`, `registry`, `arcfit`, `clip` | ✅ pure |
| `streamQueries` | ✅ pure (takes handlers) — just lives in `usePlotter.ts` today |
| image-linework / halftone / squiggle / depth-map | ⚠️ need `ctx.image` (a grayscale grid). In Node that means decoding with a lib like `sharp`/`jimp` instead of canvas — a small adapter, separate from the generators |

### Recommended approach
1. **Extract a shared core.** Move the pure files (`frame, registry, geom, clip, arcfit,
   strokefont, pipeline, toolpath, compile, modules/*`) and `streamQueries` into a shared
   location both sides import — e.g. `packages/plotter-core/` built to JS, or keep them in
   `console/src/lib` and add a tiny build (`tsc`/`esbuild`) that emits a JS bundle the MCP
   imports. (The MCP is ESM Node with no build today; one `npm run build:core` step is
   enough.) This avoids duplicating logic.
2. **Add MCP tools** (in `plotter-mcp/index.js`):
   - `plot_studio_modules` → returns `listModules()` with each module's `sections/fields`
     and `defaultsOf`. **This is the powerful bit**: the registry self-describes, so Claude
     can discover every generator and its exact parameters/ranges and choose them
     intelligently — no hardcoding.
   - `plot_studio_make({ module, params })` → `generate` → `optimizeOrder(simplifyFrame())`
     → `compile` → stream.
   - `plot_studio_stack({ layers:[{module,params}, …] })` → `evaluate` the whole layer
     stack (generators + modifiers) → optimise → compile → stream. This gives Claude the
     full compositional power (e.g. Pattern-Maker → Fill → Warp → Mask).
3. **Stream efficiently from the MCP.** Reuse `streamQueries` with MCP-side handlers:
   `sendBatch` = `POST /api/batch`, `getPending` = `GET /api/status .pending`,
   `isCancelled` = a flag set by `plot_abort`. (The MCP already polls status in
   `drawAndWait`; this is the same plumbing.)
4. **Images later.** Add a Node `loadImageToGray` (sharp/jimp → Float32Array grid) behind
   the same `GrayImage` shape; then the image generators light up for the MCP too. The MCP
   tool would take an image path or base64.

### Effort / sequencing
- **Phase A (geometric + text + modifiers):** shared-core build + the three tools above.
  Medium; no firmware change (uses existing `/api/batch`, `arc`). This already covers most
  of the Studio.
- **Phase B (images):** Node image decoder adapter + image params on the tools.
- **Phase C (nice-to-have):** let `plot_script` accept Studio layer-stacks, and/or a tool
  that imports/optimises a `.gcode`/`.bgcode` server-side (the digester is pure too).

### Why it's worth it
The console Studio is for a human at a screen; the MCP version lets **Claude compose
generators + modifiers, optimise the toolpath, and plot autonomously** — same engine, two
front-ends. And because the registry is self-describing, new generators added for the
console appear in the MCP automatically (once the shared core is wired).

> Status: this document is a plan + explainer. None of the MCP tools are implemented yet —
> the Studio currently lives only in the console. Ask to build Phase A when ready.
