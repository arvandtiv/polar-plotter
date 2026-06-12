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

Not yet done: B and C tuning constants, D anchor-arc primitive, F coolStep.
