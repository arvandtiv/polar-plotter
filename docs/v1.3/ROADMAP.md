# v1.3 Roadmap — one session ("day") at a time

Each **Day** is a self-contained work session that ends green: it builds, `npx tsc`
is clean, its unit test passes, and it could merge on its own. Days are in dependency
order — don't skip ahead. Check the box when done.

Conventions per day: **Goal · Build · Test · Done-when**. "Test" means a host test
(`npx tsx console/test/<x>.test.ts`) and/or a manual check; firmware days add a build.

Branch: cut `v1.3` from `v1.2` before Day 1.

---

## Phase 0 — Foundations (the Frame pipeline)
*Prove the whole pipeline end-to-end with the simplest possible generator before
building anything fancy.*

- [x] **Day 1 — Frame + compile + run one box** ✅ (S1, branch `v1.3-s1`)
  - Goal: a hardcoded rectangle Frame draws on the real plotter through the new path.
  - Build: `lib/frame.ts` (types + `frameBounds`, `clonePath`); `lib/compile.ts`
    (`compile(frame): string[]` → `pen up`, `goto`, `pen down`, `line …&lift=0` per
    segment, `pen up`). Add a temporary "Run test frame" button in the Autonomous tab
    that compiles a 100×100 box and feeds `streamQueries`.
  - Test: `compile.test.ts` — box → expected query list (mirror `digest.test.ts` style).
  - Done-when: button plots a clean square with one pen-down per side run; tsc clean.

- [x] **Day 2 — Geometry toolkit v1** ✅ (S2, branch `v1.3-s1`)
  - Goal: the shared helpers every later day needs. (See `03-geometry-core.md`.)
  - Build: `lib/geom.ts` — `resample`, `bbox`, `fitToBounds`, `translate/rotate/scale`
    (affine), `sampleBezier`, `seededRandom`, `polylineLength`.
  - Test: `geom.test.ts` — bbox of known points, fitToBounds keeps aspect & centres,
    resample preserves endpoints, seededRandom is deterministic.
  - Done-when: all pure, no DOM import; tests pass.

- [x] **Day 3 — Registry + first real generator (Box/Grid)** ✅ (S2, branch `v1.3-s1`)
  - Goal: the module contract exists and one generator uses it. (See `02-fields-and-registry.md`.)
  - Build: `lib/registry.ts` (types + `register`/`defaultsOf`); `lib/modules/box.ts`
    registering a `make` module with `sections/fields` + `generate`.
  - Test: `registry.test.ts` — `defaultsOf` folds field defaults; `box.generate`
    returns a Frame whose bbox matches params.
  - Done-when: registry holds the module; generate is pure & tested.

---

## Phase 1 — Schema-driven UI + port existing shapes
*Replace hand-wired controls with auto-panels and make today's shapes modules.*

- [x] **Day 4 — `ParamPanel` component** ✅ (S3, branch `v1.3-s1`)
  - Goal: render any module's `sections` and own its values.
  - Build: `components/ParamPanel.tsx` (range/select/color/toggle/number → controls,
    reusing existing `FieldInline`/`FillPicker` styling); localStorage per-module values.
  - Test: manual — pick Box, sliders update a live JSON readout.
  - Done-when: changing a field updates values; reset restores `field.default`.

- [x] **Day 5 — `StudioTab` shell** ✅ (S4, branch `v1.3-s1`)
  - Goal: picker (Make list from registry) + ParamPanel + "Run" (compile→stream) +
    parse summary. Reuse `streamQueries` and the run/abort UI from `GcodeTab`.
  - Build: `components/StudioTab.tsx`; add a "Studio" card to the Autonomous tab.
  - Done-when: pick Box → tweak → Run → plots; STOP/abort halts it.

- [~] **Day 6–8 — Port circle, square, line/polygon, wobbly as modules**
  *(circle + square ✅ S5; wobbly ✅ S6, branch `v1.3-s1`; line/polygon → later)*
  - Goal: today's primitives become Frame generators (one per day). Keep the old
    firmware primitives too; these are the *console-side* generators that compile to
    `line` runs, gaining travel-optimised continuous draw for free.
  - Build: `lib/modules/{circle,square,wobbly}.ts` mirroring firmware math
    (`kinematics.h` arc segmentation → `geom.resample`/`sampleBezier`).
  - Test: per-module `generate` bbox/closure tests.
  - Done-when: Studio can draw each; output matches the firmware primitive visually.

---

## Phase 2 — Smarter toolpaths (measurable win)
*Cut air-time and point count for everything that flows through compile.*

- [x] **Day 9 — Nearest-neighbour travel ordering** ✅ (S6, branch `v1.3-s1`)
  - Goal: reorder Frame paths (and allow reversing) to minimise pen-up travel.
  - Build: `lib/toolpath.ts` `optimizeOrder(frame): Frame`; wire into `compile`.
    (See `04-travel-and-simplify.md`.)
  - Test: `toolpath.test.ts` — scattered segments → total pen-up distance drops vs
    naive order; endpoints preserved; deterministic.
  - Done-when: a multi-path Frame plots with visibly less hopping; metric logged.

- [x] **Day 10 — RDP simplify + collinear filter** ✅ (S7, branch `v1.3-s1`)
  - Goal: drop redundant points (fewer firmware jobs) within a deviation tolerance.
  - Build: `simplifyRDP(points, tol)`, `filterCollinear`; apply in `compile` with a
    user tolerance field.
  - Test: straight run collapses to 2 points; a curve stays within tolerance.
  - Done-when: job count for a sample drops materially with no visible quality loss.

- [x] **Day 11 — Route the G-code digester through compile** ✅ (S7, branch `v1.3-s1`)
  - Goal: replace the digester's bespoke emit loop with `compile(frameFromGcode)`,
    so it gains ordering + simplify. (`lib/gcode.ts` produces a Frame now.)
  - Test: update `digest.test.ts` to assert on the compiled queries; behaviour parity
    plus fewer travels.
  - Done-when: existing digester tests pass; air-time improved.

---

## Phase 3 — The "Make" library (one generator per day)
*Now generators are cheap: each is one pure file + its fields.*

- [x] **Day 12 — Spirograph** ✅ (S8, branch `v1.3-s1`) (ref: `modules/spirograph-*.js`)
- [x] **Day 13 — Orbital weave / harmonograph** ✅ (S8, branch `v1.3-s1`) (ref: `modules/orbital-weave.js`)
- [x] **Day 14 — Moiré curtain / line patterns** ✅ (S9, branch `v1.3-s1`)
- [x] **Day 15 — Pattern maker (shape cascade)** ✅ (S9, branch `v1.3-s1`)
  - Each day: `lib/modules/<name>.ts` + `sections/fields` + `<name>.test.ts` (bbox /
    point-count / determinism) + appears in the Make picker. Done-when it plots.

---

## Phase 4 — Modifier stack ("Modify")
*Non-destructive layers; modifiers read the frame beneath.* (See `05-modifier-pipeline.md`.)

- [x] **Day 16 — Layer model + pipeline eval** ✅ (S10, branch `v1.3-s1`)
  - Build: `lib/pipeline.ts` — `Layer[]` evaluated bottom→top, passing `lowerFrame`;
    `StudioTab` gains a Sequence list (add/remove/reorder).
  - Test: `pipeline.test.ts` — two makes compose; order affects output.
- [x] **Day 17 — Shape Mask** ✅ (S11, branch `v1.3-s1`) — polyline-vs-region clip (no lib dep needed for open strokes)
- [x] **Day 18 — Fill** ✅ (S12, branch `v1.3-s1`) — scanline hatch + concentric on any closed path below
- [ ] **Day 19 — Warp/Ripple** (displace `lowerFrame` points by a field) (ref: `modules/ripples.js`)
  - Each modifier: `kind:"modify"`, reads `ctx.lowerFrame`, returns a new Frame; tested pure.

---

## Phase 5 — Text & image
- [ ] **Day 20 — Text generator** — add `opentype.js` (upstream, MIT); string+font→paths.
- [ ] **Day 21 — Image → linework** — threshold/edge → flowlines (canvas in worker).
- [ ] **Day 22 — Image → halftone / squiggle** — density-driven dots/waves.
  - Each: a module; image days use an OffscreenCanvas, output a Frame like any other.

---

## Phase 6 — Preview, polish, optional firmware
- [ ] **Day 23 — Live Frame preview** — render the active Frame to the existing canvas
  before sending. (See `07-preview-progress.md`.)
- [ ] **Day 24 — Drawing-order scrubber** — `buildProgressPaths(frame, pct)` reveals the
  toolpath by arc length; a slider scrubs it.
- [ ] **Day 25 — Save/load documents** — serialize `Layer[]` + params to localStorage /
  JSON file (extends the papers/matrices preset pattern).
- [ ] **Day 26 *(optional firmware)* — `arc` primitive** — add `do_draw_arc` + `/api/arc`
  so fitted arcs (Day 10) stream as one job instead of many `line`s. Isolated; flag-gated.
- [ ] **Day 27 *(optional)* — Frame → G-code export** — profiles (GRBL/Mach4/generic),
  pen Z / M3-M5, for sending our designs to other machines. (ref: `core/gcode-*.js`.)

---

## Definition of done for v1.3
- Studio tab: pick a generator → auto panel → live preview → optimised plot.
- A modifier stack (mask/fill/warp) composes layers non-destructively.
- Text + at least one image generator.
- Travel-optimised, simplified toolpaths for shapes **and** imported G-code.
- All pure modules host-tested; `tsc` + `npm run build` clean; firmware unchanged
  except the optional, isolated `arc`/export adds.

## Tracking
Keep this file the source of truth — tick boxes as days land, and link each day's
commit. One day ≈ one commit; one phase ≈ one PR into `v1.3`.
