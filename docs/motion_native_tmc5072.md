# Native TMC5072 motion: investigation & findings

*Investigation into the most efficient firmware setup for drawing shapes and
straight lines, leaning on what the TMC5072's dual integrated motion
controllers can do natively. Datasheet references are to `3119171.pdf`
(TMC5072, Rev 1.23, 2020-JUN-12).*

## 1. What the chip natively provides

- **Two fully independent ramp generators** (one per motor), each with its own
  sixPoint profile: `VSTART, A1, V1, AMAX, VMAX, DMAX, D1, VSTOP` plus
  `RAMPMODE` (positioning / +velocity / −velocity / hold) — §11, §6.2.
- **No cross-axis hardware**: there is no interpolation or contouring engine
  and no chip-level concept of "synchronized motion". Any coordination between
  the two axes must be constructed by the host by shaping the two profiles so
  their durations match.
- **On-the-fly retargeting is the intended use**, not a hack — §11.2.1:
  *"As target positions and ramp parameters may be changed any time during the
  motion, the motion controller will always use the optimum (fastest) way to
  reach the target, while sticking to the constraints set by the user."*
  Overshoot-and-return caused by a late retarget is flagged (`second_move`).
- **Live `VMAX` modulation in positioning mode is explicitly blessed** —
  §11.2.5 (joystick example): *"Modify VMAX at any time … you do not need to
  rewrite XTARGET, just modify VMAX."* `A1/AMAX` govern the transition between
  velocities; `DMAX/D1/VSTOP` only engage when stopping at the target.
- Ramp rules that bite: `VSTOP` and `D1` must never be 0 in positioning mode;
  `VSTOP ≥ VSTART`; a reversal jerk equals `VSTART+VSTOP` unless `TZEROWAIT`
  inserts a pause (§11.2.2).

## 2. Hard limits (no chip feature changes these)

1. **A single synchronized move is never a straight Cartesian line.** Two
   time-matched ramps draw a straight line in *belt-length space*; on a
   polargraph that maps to a curved XY path (the known "/" → ")" bow). The bow
   is kinematics, not tuning. Sub-segmentation in firmware is mathematically
   unavoidable for straight XY lines; the only lever is segment length vs
   acceptable deviation.
2. **Naive "independent profiles per axis" hurts.** The geometric-similarity
   scaling in `tmc5072_move_coordinated` is load-bearing: scaling the whole
   profile keeps the two axes' velocity *ratio* constant at every instant,
   which is what keeps each segment straight in belt space. Two profiles with
   equal total time but different shapes make the pen wander *within* every
   segment. Independence is only useful when exploited deliberately (below).

## 3. Findings in the existing firmware

- **F1 — arcs dead-stop at every chord.** `do_draw_circle`, wobbly and the
  Truchet strokes issue each chord as its own positioning move and wait for
  `position_reached` → a full stop per chord. The look-ahead streaming
  (`wait_both_near`) only flows *within* one `draw_line_mm` call. Biggest
  practical loss of speed and smoothness in the codebase.
- **F2 — streaming breaks the equal-time guarantee.**
  `tmc5072_move_coordinated` documents a standstill precondition (it reads
  `XACTUAL` as the segment start), but the streamer calls it mid-motion, so
  scale ratios are computed from a moving position. "Both finish together"
  silently degrades to "roughly together". Fix: compute deltas from the
  previous *commanded waypoint*, not `XACTUAL`.
- **F3 — every stop crawls.** `VSTOP=1` ends each stroke at ~zero velocity;
  `TZEROWAIT` is untuned. Thousands of hatch-line stops/reversals per plot pay
  this tax.
- The full-profile rescale per streamed segment is ~8 SPI writes and scales
  `AMAX` *down* for the short axis, making its joint transitions sluggish
  exactly when stiffness is wanted.

## 4. Brainstorm: exploiting the dual independent ramp generators

| Idea | What it is | Verdict |
|------|-----------|---------|
| **A. Rate-matched streaming** | Per streamed segment, write only `XTARGET` + a per-axis `VMAX = base_vmax · d_axis/d_long` (the joystick technique, §11.2.5). Each axis blends between successive per-segment velocities **at full `AMAX`**, independently, with no stop at joints. First segment from standstill and the final stop still use full geometric scaling so starts/stops stay synchronized. | **The prize.** Fewer SPI writes (4 vs ~10), no dead stops along polylines/arcs, full joint stiffness, fixes F1+F2. Implemented — see §5. |
| **B. SixPoint as soft-start** | Set `A1 < AMAX` below `V1` so strokes start gently — a poor-man's S-curve. On a hanging gondola this suppresses pendulum kick and ink blobs at stroke starts. (Current tuning is the opposite: `A1 = 2×AMAX`.) | Cheap experiment, real quality upside. Untested. |
| **C. Asymmetric decel** | `DMAX > AMAX` (+ healthy `VSTOP`, small `TZEROWAIT`): datasheet-endorsed ("deceleration values can be higher in many applications"). Trims dead time at every hatch-line stop/reversal. | Cheap tuning win. Untested. |
| **D. Anchor arcs** | Hold one motor, ramp the other through its own profile: the pen sweeps a hardware-perfect circular arc centred on the held motor's anchor (the coordinate lines of the machine's bipolar geometry). Zero segmentation, zero SPI during the move — the smoothest line this machine can produce. Radius = current belt length, so placement isn't free. | Not a general primitive, but a unique *artistic* vocabulary (arc fields, L/R moiré, a "native Truchet" variant). |
| **E. Mixed ramp modes per axis** | One axis velocity-mode while the other positions/holds — fully legal per-motor. | Enabler for D and calibration; no general drawing win. |
| **F. coolStep (§13)** | Load-adaptive current per axis. A pen gondola is a feather → could substantially cut the known motor-heating problem on multi-hour plots. | Separate investigation; needs stallGuard tuning, lost-step risk if greedy. |
| **G. `X_COMPARE` + INT pin** | Hardware position-compare interrupt instead of SPI polling for the look-ahead trigger. | Parked: the TMC5072-BOB header doesn't expose INT/PP. |

## 5. Implemented: rate-matched streaming (idea A + fixes F1, F2)

Architecture (`main/main.c` + `components/tmc5072`):

- **Driver**: `tmc5072_move_scaled_from(t0, t1, from0, from1)` — geometric
  full-profile scaling with deltas taken from given waypoints (F2 fix);
  `tmc5072_move_coordinated` is now a thin standstill wrapper around it.
  `tmc5072_move_rate_matched(t0, t1, from0, from1)` — writes per-axis `VMAX`
  (distance-ratio of `base_ramp.vmax`) + `XTARGET` only, and invalidates the
  cached ramp scale so the next scaled move rewrites a consistent profile.
- **Path streamer** (`path_begin / path_to / path_end`): one-deep waypoint
  buffer. The first segment of a path is emitted with full geometric scaling
  (exact equal-T from standstill), middle segments are rate-matched (chip
  blends per-axis velocities at joints, full `AMAX`), and the final segment —
  known only at `path_end()` — goes back to a scaled profile so both axes
  decelerate into the stop together. `path_to()` Cartesian-subdivides long
  spans (`LINE_SEG_MM`) exactly like `draw_line_mm` did.
- **Callers**: `draw_line_mm` is now `path_begin → path_to → path_end` (single
  lines keep stop-at-end semantics; hatch/border/grid unchanged in behaviour,
  better mid-line joints). `do_draw_circle` outline + concentric rings,
  `do_draw_wobbly`, and the Truchet stroke sink stream whole arcs/outlines as
  one path — no per-chord stops (F1 fix). Square outlines intentionally still
  stop at corners (sharp corners should stop).

Expected effect on paper: circles/arcs lose the per-chord stutter and plot
several times faster; streamed lines hold their path better mid-stroke
(full-stiffness joints); stroke endpoints stay synchronized.

### 5.1 Bug found & fixed (2026-07-02): stale scaled accels broke the "full AMAX" premise

Idea A's premise — joints blend "at full `AMAX`" — was violated by the original
implementation. The path's FIRST segment goes out via `move_scaled_from`, which scales
the **whole** profile (`A1/V1/AMAX/DMAX/D1/VSTOP`) per motor by that segment's distance
ratio; the interior `move_rate_matched` then only rewrote `VMAX`, so **each motor's
accelerations stayed frozen at the first segment's ratios for the entire streamed
path**. On short (≤`LINE_SEG_MM`) sub-segments motion is accel-dominated, so the two
motors tracked their changing per-joint `VMAX` at different, stale rates — the velocity
ratio drifted off the chord direction at every joint and the pen wiggled, visibly worse
the further the path direction rotated from the first segment's (= later in long
streamed paths: arc sweeps, borders, page-bottom lines). Symptom on paper: "the two
motors go slightly out of sync near the end of the drawing".

Fix (`tmc5072_move_rate_matched`): on the first rate-matched joint after any scaled
move, restore the full-scale profile (`set_ramp_scale(m, 1.0)`) before writing the
per-axis `VMAX`; `applied_scale = -1` marks "accels full, VMAX custom" so subsequent
joints keep the lean 4-write path. The final segment still returns to a scaled profile
(`move_scaled_from`) so both axes decelerate into the stop together.

### 5.2 Ideas B & C are now LIVE-TUNABLE (2026-07-02): the `ramp` shape command

The sixPoint shape is no longer hard-coded in `tmc5072_set_accel` — it derives from
tunable ratios (`tmc5072_set_ramp_shape`), exposed as serial **`ramp`**, HTTP
**`/api/ramp`** and MCP **`plot_set_ramp`**. Session-only (like `speed`/`accel`);
defaults reproduce the historical profile exactly (`a1r=2.0 v1=50000 dmaxr=1.0 d1r=2.8
vstop=10 tzw=0`). E-STOP clear / driver self-heal re-applies the live tuning.

`A1 = a1r×AMAX` (accel below `v1` — the launch), `DMAX = dmaxr×AMAX` (the stop),
`D1 = d1r×AMAX` (landing below `v1`). What each lever does to the LINE:

- **`a1r < 1` = soft launch** (idea B): the stock `a1r=2.0` kicks the gondola hardest at
  pen-down → pendulum swing → wavy first centimetres of every stroke. Lowering `a1r`
  with a LOW `v1` softens only the first instants, so the time cost is negligible.
- **low `v1`** shortens both the soft-launch zone AND the slow `D1` final approach
  (stock `v1=50000` ≈ 30 mm/s means a long crawl into every stop → ink pooling).
- **`dmaxr > 1` = brisker stops** (idea C, datasheet-endorsed): less dwell at stroke
  ends, slightly faster overall.
- **`tzw`** inserts a pause at zero crossing on pen-down reversals (`cycles` retraces)
  — kills the `VSTART+VSTOP` reversal jerk.

**Recipe to try first (crisper starts + ends, no speed loss):**
```
ramp 0.5 12000 1.4 2.0
```
Then A/B against stock (`ramp 2.0 50000 1.0 2.8`) on the same test: a row of short
strokes + one big circle. Second experiment: RAISE `accel` (e.g. `accel 700`–`800`) —
strokes are accel-dominated, so higher AMAX = more uniform speed = more uniform ink
width AND faster; back off if pendulum swing appears. The desync fix (§5.1) made
higher accel safe to explore.

### 5.3 Phase 2 (2026-07-03): flow-chained strokes — no stop at polyline vertices

The last big loss was BETWEEN jobs: every compiled `line` job ended in `path_end()` =
a full synchronized stop, so organic polylines (the bulk of the generative art)
stopped at every vertex. Now a `flow=1` flag on line/arc jobs keeps the ONE streamed
path open across consecutive jobs — the interior joints are ordinary rate-matched
hand-offs at full accel (§5.1), identical to within-job streaming. The client
compiler marks continuity per vertex (turn ≤ 45° flows; sharp corners keep their
crisp stop — that rule lives client-side where the geometry is known). Safety: any
other command type, a spatial discontinuity, pause/E-STOP, or a 250 ms dry queue
ends the stroke with a clean synchronized stop. Old firmware ignores the flag; old
clients simply never set it.

### 5.4 Phase 2.5 (2026-07-03): curvature-aware look-ahead + ratio-safe cruise cap

Field report after Phase 2: SMALL-radius curves plotted solid, LARGE ones showed tiny
periodic wobbles. Mechanism: small shapes never get fast; long gentle paths let the
ramp build speed — and in positioning mode the chip plans a STOP at every interior
waypoint. At cruise, its decel distance ≫ the fixed 2 mm hand-off, so every ~5 mm
segment became decel→retarget→re-accel, and since both motors decelerate at the same
ABSOLUTE rate from DIFFERENT velocities, the ratio (= path direction) distorted at
every joint. The old fixed look-ahead also acted as a hidden speed governor
(√(2·a·2 mm) ≈ 11 mm/s at stock DMAX).

Fix, two coupled parts per interior joint:
1. **Curvature-aware hand-off** (`plt_flow_lookahead_mm`, host-tested): release the
   next target D early, bounded by the rubber-band deviation D²/(8·r_local) ≤ the
   0.3 mm chord budget, with r_local ≈ seg/θ from the turn angle at the pending
   waypoint. Straights/gentle arcs → `FLOW_LOOKAHEAD_MAX_MM` (8 mm, bounded by the
   kinematic line-bow budget); tight turns → the old 2 mm.
2. **Ratio-safe cruise cap** (`tmc5072_move_rate_matched` vmax_cap): interior VMAX
   pairs are clamped so the ramp can still stop within the hand-off distance
   (v ≤ √(2·DMAX·la)) — both motors scaled by the SAME factor, ratio preserved. The
   ramp never enters its decel phase mid-segment → no sawtooth, no wobble; the pen
   also naturally slows into tight in-path corners.

Net: large shapes get BOTH solid lines and a higher clean cruise than the old
implicit ceiling (≈26 mm/s stock at la=8; scales with the `ramp` dmaxr knob — a
brisk-stop recipe raises the clean cruise further). Small shapes unchanged.

Not yet done: D anchor-arc primitive, F coolStep.
