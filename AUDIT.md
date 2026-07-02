# fable-audit — top-to-bottom performance audit (arcs vs straight lines)

*Branch `fable-audit` (from `main`, Pico 2 W firmware v1.1.0 line). 2026-07-02.*
*Goal: increase plotting performance by using the firmware's own arc drawing instead of
flattening everything to straight-line segments.*

---

## Executive summary

**The good news: the entire arc pipeline already exists, end-to-end.** The firmware has a
first-class arc primitive (`/api/arc` → `WCMD_ARC` → `do_draw_arc`, `main/main.c:813`) that
streams a chord-segmented arc through the same look-ahead path engine as lines — in **one
job**. The console has a conservative arc-fitter (`console/src/lib/arcfit.ts`) that detects
circular runs in any polyline and collapses them back into `arc` jobs, with tests.

**The bad news: it is switched OFF at every single entry point.** Every real plot today —
Studio art, MCP generator plots, most G-code — is flattened into per-segment `line?` jobs.

**Why that matters (the core mechanic):** the firmware's streaming look-ahead only flows
*within* one job. **Between jobs, motion comes to a complete standstill** (`path_end` →
`path_emit(true)` → `wait_reached`, `main/main.c:663-665`). A compiled circle of r=50 mm at
the 0.3 mm chord tolerance ≈ 64 chords = **64 line jobs = 64 full stop/start ramps**, plus
64 × (SSE log + job bookkeeping + 20 ms-granularity completion polling). As **one arc job**
it's a single continuous streamed sweep with one stop at the end. Arc adoption is therefore
not a marginal win — it changes both plot time and line quality (no dwell dots / ink pooling
at every vertex where the gondola briefly halts).

---

## 1 · How motion executes today (verified)

```
client → HTTP /api/line|arc|batch → wcmd queue (256) → web_draw_task (one job at a time)
  job → do_draw_line/do_draw_arc → path_begin → path_to×N → path_end
        path_to: sub-segments at LINE_SEG_MM=5, dedups identical step targets
        path_emit(interior): tmc5072_move_rate_matched (per-motor VMAX scaling)
                              + wait_both_near (2 ms poll, hand-off at LOOKAHEAD 2 mm)
        path_emit(last):     tmc5072_move_scaled_from + wait_reached (20 ms poll) → FULL STOP
```

- `plt_arc_segments` (`main/kinematics.h:115`) — adaptive chords: sagitta ≤ 0.3 mm
  (`CIRCLE_CHORD_ERR_MM`), clamped [32, 720] per full circle.
- `/api/batch` (`main/web_server.c:686`) already fixes the *HTTP* overhead (newline-separated
  ops, one TCP connection, ~80× fewer round-trips; MCP uses it with queue-headroom flow
  control). **Batch does NOT fix the per-job stop** — each batched `line` is still its own job.
- Host tests: kinematics, arcfit, compile, streamqueries, toolpath — all pass.

## 2 · The finding: three switches, all off

| # | Entry point | Where | Today | Effect |
|---|------------|-------|-------|--------|
| 1 | **MCP** `plot_generate` + `plot_script generate` | `plotter-mcp/index.js:783, 1047` — `expandGeneratorFitted(spec, bounds, {…})` | **no `arcTol`** | All generator art (circles, arcs, bullseye rings, spirograph, whirls…) flattens to 5 mm line jobs |
| 2 | **Studio UI** "◜ Arcs" toggle | `console/src/components/App.tsx:1355` — `useState(false)`, comment "(needs firmware flash)" | **default off**, not persisted | Studio plots line-only unless manually toggled every session; the comment is stale — `main` firmware **has** `/api/arc` |
| 3 | **G-code digester** | `console/src/lib/gcode.ts:266` — `hasArcs ? { arcTol } : {}` | arc-fit **only if source had G2/G3** | A G1-only file (most slicer/plotter exports tessellate arcs) never gets re-fitted, even though `fitArcs` reconstructs them within tolerance |

The pipeline plumbing (`runPipeline.compileFrame` → `compile(…, { arcTol })` →
`fitArcs` → `arc?cx=…&lift=0`) is complete and tested; the option simply is never passed.

## 3 · All findings, ranked by impact

**P1 — Arc capability unused (the ask).** Switches above. Fix = pass `arcTol` (0.3 =
`CIRCLE_CHORD_ERR_MM`) at the three entry points. Client-only change; zero firmware risk;
`fitArcs` is conservative (only genuine circular runs within tol, monotonic sweep — polygons
untouched), so worst case output is identical to today.

**P2 — Every polyline vertex is a full stop.** Even after arc adoption, non-circular curves
(wobbly/organic paths — most of the generative art) still compile to per-segment `line` jobs
= stop at every vertex. The firmware already has the right engine (`path_begin/path_to/
path_end`); what's missing is a **multi-point job**: `WCMD_PATH` accepting a point list
(e.g. `path?pts=x,y;x,y;…` via `/api/batch` body, capped to fit `wcmd_t`, or chained
`lift=0&flow=1` line jobs that skip the terminal `wait_reached` when the next job continues
pen-down). This is the single biggest remaining performance lever. Proposed follow-up, not
done in this audit.

**P3 — Per-job fixed overhead.** Each job: `web_log` (printf + SSE fan-out) + `emit_pos_event`
+ `move_to_xy` re-entry (SPI reads + a `wait_reached` cycle even when already at the start
point) + 20 ms completion-poll quantization. ~tens of ms × hundreds of jobs = seconds per
plot, all silent dwells with the pen down. Arc adoption (P1) and a path job (P2) shrink the
job count, which is the right fix; micro-optimizing the overhead itself is second-order.

**P4 — Correctness: `do_draw_arc` with `cycles>1` on a *partial* arc.** The retrace loop
re-sweeps forward from `a0` each cycle (`main/main.c:828-833`), so cycle 2 begins with a
straight chord from the arc's END back across to the first interior point. Full circles are
unaffected (end ≡ start); partial arcs draw a spurious chord. `do_draw_line` alternates
direction per cycle — the arc should too (sweep a0→a1, then a1→a0, …). Low severity (rare
path), one-line-ish fix.

**P5 — Studio "Arcs" toggle not persisted + stale label.** `useState(false)` resets every
reload and the "(needs firmware flash)" hint no longer matches `main`. Once P1 defaults are
flipped, this toggle becomes a safety escape hatch — persist it in localStorage like the
other prefs.

**P6 — Observations (no action urged now):**
- `TMC_SPI_HZ` = 2 MHz; TMC5072 tolerates ≥4 MHz — headroom if SPI ever bottlenecks (it
  doesn't today; motion is mechanically bound).
- `wait_reached` 20 ms poll is fine for job *ends*; do not tighten while P1/P2 reduce how
  often it runs.
- `fitArcs` is O(n²)-ish per path — fine client-side at current path sizes.
- `R_SENSE` 0.15 Ω still unverified (standing hardware caveat, unrelated to arcs).

## 4 · Recommended plan

**Phase 1 (client-only, ship first): ✅ DONE (this branch).**
1. ✅ MCP: `arcTol` passed in both `expandGeneratorFitted` call sites **and**
   `plot_polylines` (`compilePathsWithWarp`); env override `PLOTTER_ARC_TOL` (default 0.3,
   `0` = off).
2. ✅ Studio: `useArcs` defaults **on**, persisted in `localStorage('plotter.useArcs')`,
   stale "(needs firmware flash)" label replaced. Also fixed: the `draws` count now
   includes `arc?` jobs (a circles-only frame previously reported 0 draws with arcs on,
   disabling ▶ Run).
3. ✅ G-code: `hasArcs` gate dropped — always arc-fit (`fitArcs` is a no-op on
   non-circular runs).
4. ✅ Validated: tsc + arcfit/compile/digest/streamqueries/runpipeline/toolpath suites +
   console build all green; MCP `node --check` ok. Compiled-job diff through the real
   pipeline (bounds 300×300):

   | generator | jobs before | jobs after | of which arcs |
   |---|---|---|---|
   | circle r=50 | 37 | **3** | 1 |
   | spirograph | 257 | **53** | 38 |
   | wobbly | 62 | **10** | 7 |
   | arcs | 1104 | **96** | 48 |

   Geometry check: every source point of the r=50 circle lies at 0.0000 mm radial
   deviation from the fitted arc (tol 0.3). Each removed job = one removed full
   stop/start of the gondola.

   ⚠️ Remaining step for the user: one plot on the real machine (e.g. `circle r=50`
   from Studio) to confirm the deployed firmware build accepts `/api/arc` and the
   sweep looks clean.

**Phase 2 (firmware, the big one):** `WCMD_PATH` multi-point job (or a `flow` continuation
flag) so arbitrary polylines stream without per-vertex stops. Fixes P2; needs a flash + a
bench test with the look-ahead at corners.

**Phase 3 (tidy): ✅ DONE (this branch, needs flash).** P4 partial-arc cycles fix —
`do_draw_arc` now alternates sweep direction per cycle (there-and-back, like
`do_draw_line`) instead of drawing a chord back across the arc's mouth on each retrace.

## 5 · Post-audit field finding: two-motor desync wobble — FIXED (needs flash)

Reported after Phase 1 went live: a wobble appearing "closer to the end of the drawing" —
the two motors drift slightly out of sync (pre-dates the arc change). Root cause found in
`tmc5072_move_rate_matched`: the design premise (docs/motion_native_tmc5072.md §4 idea A,
"joints blend at full AMAX") was violated. The path's first segment scales the WHOLE ramp
(`A1/V1/AMAX/DMAX/D1`) per motor by that segment's distance ratio; interior joints then
only rewrote `VMAX`, leaving each motor's accelerations **frozen at the first segment's
ratios for the entire streamed path**. Short sub-segments are accel-dominated, so the two
motors tracked their per-joint velocity targets at different stale rates → the velocity
ratio drifted off the chord → wiggle, growing as the path direction rotates away from the
first segment's (= later in long paths; Phase 1's longer single-job arcs made it more
visible). Fix: restore the full-scale profile on the first rate-matched joint after any
scaled move, then modulate only `VMAX` (see motion doc §5.1). Firmware builds clean
(`build/main/polar_plotter.uf2`); **flash required** (BOOTSEL).

---
*Audit verified against: `main/main.c`, `main/kinematics.h`, `main/board_config.h`,
`main/web_server.c`, `components/tmc5072/tmc5072.c`, `console/src/lib/{compile,arcfit,
runPipeline,gcode}.ts`, `console/src/components/App.tsx`, `plotter-mcp/index.js`. Test
suites run: kinematics (host), arcfit, compile, streamqueries, toolpath — all passing.*
