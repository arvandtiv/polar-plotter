# LEARNINGS — Claude's accumulated eye for plotter art

> Read this in full at the start of **every** round (see `PROTOCOL.md`). These are durable,
> cross-round principles distilled from human rankings — apply them when authoring designs.
> Each entry should cite the round(s) that established or revised it.

## ⭐⭐ THE GOVERNING TASTE (R8, explicit)
**Organic · irregular · asymmetric · complex · hand-drawn.** The user, ranking the webs of #51:
"avoid such simple things, as well as geometric and symmetric" — and put EVERY clean symmetric
geometric design (corner webs, polygon string-art, grid meshes) at the bottom, the irregular +
hand-drawn ones at the top (#15, irregular + living line = "very interesting").
- **Prefer:** irregular/random point-sets, asymmetric arrangements, the living not-straight hand,
  dense/complex fields, the unexpected.
- **Avoid:** clean symmetry, tidy geometry, simple regular figures, the mechanical/CAD look.
- **Gold standard (R11):** dense + **coherent directional FLOW** + hand-drawn ("great balance of
  density and directional flow"). Flow fields > random scatter (chaos alone isn't enough — give it
  a current). **NEVER crisp** — the one jitter=0 design was explicitly rejected; always hand-draw.
  Keep strokes moderate length (long + straight reads mechanical).
- This **subsumes** earlier findings (fine/dense = complexity; hand-drawn = living line; genre
  fatigue = wanted richer). When a LeWitt instruction is inherently geometric/symmetric, execute it
  **through the organic lens** (hand-drawn, irregular, asymmetric) — a clean rendering is a known dud.
- **⛔ Clean geometric SHAPES are rejected — go WOBBLY or GRADIENT (R20, explicit).** The user
  rejected the full-circle/moire take on #138 outright: *"the geometric shapes are not good at all,
  exclude such relations and replace with wobbly or gradient-like feel."* It is not only symmetry
  (R13) — the **legibility of the geometric form itself** (a circle, a tidy arc, a moire lattice)
  reads cold/CAD, and per-line jitter does NOT rescue it. On ANY arc/circle/figure instruction,
  **dissolve the shape** into either: **(a) WOBBLY** — organic wandering lines that never resolve
  into a nameable shape (round-11 stroke-field flow, round-14 arc *scatter* — both hits); or
  **(b) GRADIENT** — tonal density ramps (round-15 #142, round-19 grays). Choose an organic/tonal
  *subject*; don't render a clean closed figure and hope jitter saves it. (This is why #138-as-scatter
  won in R14 but #138-as-circles lost in R20 — same instruction, shape legibility was the difference.)
  - **The recurring miss = TEXTURE WITHOUT FORM (R20/R21/R22).** Three organic misses in a row were
    all all-over even texture with no coherent subject: clean circles, fine-line fabric, scattered
    scribble-marks. The user wants a **readable FORM / gesture with a tonal GRADIENT (volume)**, made
    by a **CONTINUOUS** hand line, surrounded by negative space — an *object*, not wallpaper. A
    scribble specifically = ONE continuous looping/coiling line shading a form, never scattered marks.
  - **"Wobbly" means OPEN + loose, not a dense weave (R21).** After R20, "wobbly" via a dense fine-line
    fabric (`sheets`) was *also* rejected. The organic hits were sparse/open with breathing room —
    round-11 stroke FLOW, round-14 arc SCATTER. So wobbly/organic = **loose individual wandering
    lines/strokes with directional flow and NEGATIVE SPACE**, never a wall-to-wall mechanical texture.
    Keep organic work sparse and expressive; dense fine-line fill = mud + paper-rip + reads mechanical.
- **⚠️ Jitter roughens TEXTURE, not STRUCTURE (R13).** A globally symmetric *construction* (arcs
  from four corners/midpoints, radial families, mirror-across-axes layouts) still reads
  "symmetric / geometric" no matter how hand-drawn the individual strokes are — the user rejected
  grid+arcs (#130) as "lines still showing symmetric… not that valuable." To satisfy the organic
  lens you must break the **arrangement's** symmetry (irregular/asymmetric centres, uneven
  families, off-axis placement), not merely add per-line wobble. Same failure family as #88
  (grid-quantized flow): the *arrangement* is what reads geometric.
- **✅ Breaking the ARRANGEMENT rescues a low-value genre (R14, proven).** Same generator + same
  radial-arc genre as #130, but with the centres wandered off-axis, uneven families, and irregular
  spacing → flipped from "not valuable" to *"I like this way more than the original… very
  beautiful."* Corollaries: **(a) push the OFFSET hard** — the offset ladder ranked monotonically
  (gentle centreJitter=30 sank to 15th; wild=120 rose to 2nd); gentle asymmetry reads as
  still-symmetric. **(b) The concentric "echo"/topographic reading is praised** — keep families
  legible as echoes. **(c) Coherence ceiling** — dense+asymmetric wins, but maxing *every* lever
  at once (8 families + jitter 6 + big reach + max count-spread) tips into mud and gets "avoid";
  keep ~4 families, density high-not-maximal, hand energetic ~4–5 (jitter 6 was again "not sure").

## Standing constraints (not learned — given)
- Every round is governed by a **Sol LeWitt instruction** as its rule (`lewitt_instructions.csv`).
- Every execution takes a **Klee stance** (`klee_principles.md`) — the method behind the rule.
- **No Truchet** / truchet-style tiling — excluded by user preference.
- **⛔ BANNED tool: `sheets`** (R21) — displaced-column flowing curtains. Rejected outright ("avoid
  using this tool"). Don't use it.
- **⚠️🩸 PAPER-RIP LIMIT (physical, R15).** If the pen lays too many lines into ~the same tiny area,
  the paper gets wet and **rips**. So never let a field become a near-solid black patch — ESPECIALLY
  at edges/corners where density ramps or radial families concentrate. Cap density so adjacent lines
  always keep a **visible gap** (coarser spacing / a min-gap clamp on any ramp). "Dense" is good as
  *tone*, fatal as *ink-on-ink*. This is a MEDIA limit that overrides "denser is better": the
  coherence ceiling (R14) is also a physical ceiling. When a design would saturate a spot, back it off.

> As lessons accumulate below, phrase them in Klee's vocabulary (e.g. "asymmetric weight with a
> local imperative beat dead symmetry") so the method and the learnings reinforce each other.

## ⚠️ Span a range, with a NATURAL hand — the core lesson (R3→R4)
R3 (all straight, samey) got "boring and predictable." R4 spanned straight→wild and got an
engaged, enthusiastic ranking ("love the feel"). So:
- **Span a perceptual range every round.** 16 near-twins (varying only permutation/spacing) =
  boredom. A visible spread = engagement. Sameness *across* rounds is also a failure.
- **Give lines character — but keep it natural.** Hand-drawn / not-straight lines (Klee's living
  line #3/#4; LeWitt's own "lines, not straight") are welcomed. The R4 sweet spot is
  **`ruledLines` jitter ≈ 2–5 mm (cap ~6)** — a *careful human hand*. **Straight (j0) is still
  loved** when the round has range; **wild (j ≥ 8) reads as "too broken" and loses naturality.**
- At moderate jitter, **some seeds wander gracefully, some look noisy** — prefer gentle seeds;
  when unsure, lower the amplitude rather than hunt seeds.
- **The jitter ceiling is context-dependent (R10).** In *sparse/superimposed* layouts keep the
  hand gentle (≤~5; ≥8 looked "too broken"). In *dense* fields the user wants an **energetic** line
  — jitter **5–7 wins**, gentle ranks low. Bias dense + lively; push extremes (it differentiates).

## ⚠️ Vary the GENRE, not just params (R3/R6/R7)
The user has now said "everything feels similar" three times — root cause: rounds 1–7 are all the
**same visual family** (fill regions with ruled/hatched lines). Within-family variety (jitter, tonal
gradients, scatter) is not enough once a family is explored. **Prioritise instructions that change
the visual language entirely** — webs/networks, arcs/circles, geometric figures, scribbles, growth.
When the next CSV instruction is yet another line-fill, still execute it, but push its *one* novel
angle hard; and welcome the non-line-fill instructions as palate cleansers.

## Composition & negative space
- **Keep the structural division legible — leave it breathing room.** When a rule divides the
  field into parts (quadrants, bands…), the *parts must stay readable as parts*; don't let the
  line-fields merge into one uniform mass. The clear R1 winner left white between quadrants and
  "did not completely connect each quarterly space into each other." Negative space wins (Klee #7).

## Density & line economy
- **Coarse-to-medium beats fine for *full-field* superimposed line-fields.** R1: ~12–16 mm
  spacing ranked at the top; ≤ 8 mm read as **mud/"messy"** and sank. Density is tone (Klee #5),
  but past ~8 mm of *full-field* superimposition it becomes mush.
- **…but inside separated bands, fine lines are an asset.** R2: the winner used 5 mm lines inside
  bands with 50 mm gaps — crisp "ribbons" on white. The real lever is **gap/breathing between
  bands**, not line spacing. So: tight lines OK *iff* the regions that hold them are well spaced.

## Symmetry vs. chaos
- **Vary the individual within the structural rule.** A *different* scheme in each part reads
  alive; identical-everywhere reads dead. R1: rotating/shifted per-quadrant omissions (and
  orthogonal-vs-rest contrast) took the top spots; **uniform** omission across all parts was
  called "boring as hell" (Klee #11, individual-vs-structural).
- **Don't chase tidy balance.** "Boringly balanced" is a real failure mode — a symmetric density
  split (e.g. 2 dense + 2 sparse quadrants) read as *dull*, and messy when the dense halves were
  over-packed. Liveliness came from **directional variety, not density contrast** (refines Klee
  #8: asymmetry must create *tension*, not just an even two-and-two split).
- **Stagger, don't dislocate.** R2: phase-shifting overlaid sets so their crossings don't coincide
  reads as *interesting* ("the mis-alignment"), but **over-offsetting** one set leaves it lopsided
  and sinks to the bottom. Use small/medium offsets; a fully dislocated set looks accidental.

## ⭐ Fine + dense + even is a standing preference (R5 + R6)
Across two different genres the user pulls the same way: **closer-spaced, denser, evenly-distributed
wins; wide / sparse / dramatic loses.**
- R5 (#38 tonal grids): 10×10 fine grids swept the top 4; 6×6 big tiles the bottom 4.
- R6 (#46 vertical not-straight lines): the finest, most even gently-wavy fields won; the **widest,
  most flowing ("river") ones were omitted entirely.** ("Elegant wide flow" was my idea, not the
  user's taste.)
**Bias toward fine, even density; avoid wide/sparse + dramatic gestures.** (Within a tonal field,
cell count is the dominant lever; both crisp and soft hand work at fine grain.)

## Generator-specific notes
- **`ruledLines`** (R1): keep `spacing` ≥ ~10–12 mm when superimposing 3 directions in one region;
  per-region variety of which directions are present matters more than spacing tricks.
- **`ruledLines` bands** (R2): for banded layouts, separate bands with generous gaps and use fine
  in-band line spacing (5–8 mm) — bands then read as crisp ribbons. Carry diagonal bands with a
  −45° layer group. Keep set-to-set phase offsets small/medium.

## Modifiers (warp / mask / fill)
<!-- when a modifier elevates a design vs. when it muddies it -->

## Anti-patterns (what ranks low)
- Uniform repetition of the same scheme across every part → "boring" (R1: #14).
- Over-dense superimposition (spacing ≤ 8 mm) → "messy"/muddy (R1: #15, #16, #4).
- Tidy symmetric balance presented as "interesting" → "boringly balanced" (R1: #16).

---
### Revision log
- **Round 1 (2026-06-30)** — LeWitt #11. Established: legible-division + breathing room win;
  per-part variety beats uniformity; spacing ≤ 8 mm = mud; "boringly balanced" is a failure mode.
- **Round 2 (2026-06-30)** — LeWitt #16. Added: stagger overlaid sets but don't dislocate them;
  fine lines are fine *inside well-gapped bands* (refined the mud rule — gap is the real lever).
- **Round 3 (2026-06-30)** — LeWitt #17. Plateau: straight-line geometric pieces feel "boring/
  predictable." Added the `jitter` (not-straight) tool; mandated spanning a range each round.
- **Round 4 (2026-06-30)** — LeWitt #19. Confirmed range→engagement. Pinned the hand-drawn sweet
  spot: jitter ≈ 2–5 (cap ~6); straight still loved; wild (≥8) is "too broken."
- **Round 5 (2026-06-30)** — LeWitt #38 (→ tonal mosaic). Finer grids win decisively (10×10 top,
  6×6 bottom); cell count is the dominant lever for tonal fields. Genre break welcomed.
- **Round 6 (2026-06-30)** — LeWitt #46. Fine+gentle vertical fields won; widest/most-flowing
  omitted. Promoted "fine+dense+even" to a standing cross-round preference; span distinct
  sub-ideas (not a smooth param sweep) so a one-genre round still differentiates.
- **Round 7 (2026-06-30)** — LeWitt #47. Fine held (4th time); ordered gradient ≈ crisp scatter.
  Identified GENRE fatigue (rounds 1–7 all line-fills) — must vary the visual language, not params.
- **Round 8 (2026-06-30)** — LeWitt #51. THE governing taste reveal: organic/irregular/asymmetric/
  complex/hand-drawn wins; clean geometric symmetry explicitly rejected (#1–9 = "avoid"). Promoted
  to the top of this file; execute geometric instructions through the organic lens.
- **Round 9 (2026-06-30)** — LeWitt #56 (organic-ized). "Eye-pleasing, none rejectable" — organic
  lens is a safe floor. But within-round sameness again (5th time); combination-grid family
  (#11/17/19/47/56) is saturated. To differentiate, push EXTREMES not gentle steps.
- **Round 10 (2026-06-30)** — LeWitt #85. Dense + energetic hand (jitter 5–7) won; open/gentle
  sank; jitter ceiling is context-dependent; pushing extremes differentiates.
- **Round 11 (2026-06-30)** — LeWitt #86 (stroke fields). Big hit. Dense + directional FLOW +
  hand-drawn = gold standard; flow > random scatter; crisp explicitly rejected; long straight =
  mechanical. New `strokeField` generator. #87 skipped (= #56 + colour; user later confirmed skip).
- **Round 12 (2026-06-30)** — LeWitt #88. UNRANKED — "not worthy." Grid + 4-direction quantization
  of a flow = a stiff, inferior #86; don't quantize organic flow onto a grid. Also the moment the
  user asked to **review each instruction together before building** (I'd built #88 autonomously).
- **Round 13 (2026-07-01)** — LeWitt #130 (grid + arcs from four corners). Ranked but flagged
  "not that valuable" (a low-value round like #12). Key lesson: **jitter roughens texture, not
  structure** — arcs-from-corners still "showing symmetric" despite the hand-drawn wobble, because
  the *arrangement* is symmetric. Break the arrangement's symmetry, not just the line. Also: my
  predicted order (dense+wild-sweep heuristic) was ~orthogonal to the user's — the density/flow
  axis doesn't predict order on a genre the user is rejecting. **Radial "from corners/midpoints"
  is a low-value genre** → flag #138 (same family) before building.
- **Round 14 (2026-07-01)** — LeWitt #138 (circles/arcs from side midpoints), built ASYMMETRIC
  (new `arcs` levers: centreJitter/countJitter/radiusJitter). **Big win** — "I like this way more
  than the original… very beautiful," rescuing the #130 genre by breaking the *arrangement's*
  symmetry (proves the R13 lesson). Push offset hard (offset ladder ranked monotonically); the
  concentric "echo" is praised; but a coherence ceiling exists — maxing every lever (+corners +
  dense + jitter 6) = mud/"avoid". jitter 6 again "not sure" → energetic hand tops out ~4–5.
- **Round 15 (2026-07-01)** — LeWitt #142 (increasing not-straight lines → density ramp; new
  `ruledLines` `gradient` lever). "A success." Winner #10 = **coarse spacing + strong ramp**
  ("perfect balance of non-linear and exponential ratios") — the current reads without saturating.
  Partial ranking = keep/reject; rejects were the fine+steep ramps that **saturate the border**.
  Surfaced the **PAPER-RIP LIMIT** (see Standing constraints): over-inking a spot tears the paper —
  cap density, coarser at the packed end, never a solid patch. Coarse+strong beats fine+steep.
- **Round 16 (2026-07-01)** — LeWitt #237 ("location of a trapezoid"; new `locatedFigures`
  generator: figures + hand-drawn location web). New genre works — winner #13 "almost perfect."
  Decisive axis = **web density: the LOCATION WEB is the subject, draw it richly.** Explicit reject
  of "anything light" (#1/#11/#15/#4) — minimal figure-dominant layouts "look poor, don't represent
  anything." Also: **dense construction lines to the CORNERS read as rich/structural, NOT too
  symmetric** (I'd worried; wrong). For #238/#274: build dense, more figures, richer webs, energetic
  hand; drop the minimal end. (Reinforces dense>sparse — here via web richness, not spacing.)
- **Round 20 (2026-07-01)** — LeWitt #138 revisited as FULL OVERLAPPING CIRCLES / moire (new `arcs`
  `inset` lever). **REJECTED outright** ("very poor, avoid completely; geometric shapes are not good;
  replace with wobbly or gradient feel"). Big lesson (promoted up top): clean geometric SHAPES read
  cold even hand-jittered — dissolve into wobbly organic wandering OR tonal gradient. Explains R14
  (arc scatter) win vs R20 (circles) loss on the same instruction. (Chronology note: built after R19.)
- **Round 17 (2026-07-01)** — LeWitt #238 ("location of a parallelogram"; `locatedFigures` +
  parallelogram/shear/rotMax). **A HIT.** Best = #4 (bold diagonal shear + corner web), #15
  (UNIFIED diagonal flow — figures all lean one way → a current), #14 (dense woven). **Excluded the
  SCATTERED-orientation ones (#2 widest spread, #10 eight scattered)** → directional COHERENCE beats
  angle scatter = flow>scatter (R11) applied to figure orientation; keep orientation spread LOW when
  shearing. Also **#16 "balanced showcase" excluded** — the safe middle loses; commit to one strong
  idea (push extremes, R9/R10).
- **Skipped #154, #159, #160, #164 (2026-07-01, colour)** — all "a black outlined square with a
  **red** line" pieces (1973). Distinguishing element is colour → auto-skipped per the standing rule.
  Next buildable row is #237.
