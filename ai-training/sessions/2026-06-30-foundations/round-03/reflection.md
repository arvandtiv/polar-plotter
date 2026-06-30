# Round 3 reflection — LeWitt #17 (four parts, a different line direction in each)

**Ranking:** flat 1→16 (no differentiation).
**Note (on ALL 16):** *"exactly the same feel as the rest of the designs, it is a bit boring and
predictable."*
**Scored:** 2026-06-30

## The real signal — a plateau, not a per-design verdict
The flat ranking + identical note is meta-feedback about the **whole direction**, not design 7
vs 8. Rounds 1–3 (#11, #16, #17) were all **perfectly straight ruled-line fields** in
quadrants/bands. They share one austere, mechanical "feel," and my 16 executions per round varied
only by **permutation and spacing** — the *least* perceptually salient axes. Result: predictable,
and now boring.

## Root cause
1. **No line character.** `ruledLines` draws machine-straight lines. Every piece is a CAD hatch.
   The Klee principles I'm supposed to apply are about the **living, not-straight line** (#3, #4) —
   I've been ignoring the single biggest lever for life.
2. **Timid variety.** Varying which of four directions sits in which quadrant is a weak axis; the
   eye reads "another grid of lines." The executions weren't *different enough*.

## What to change (→ LEARNINGS, acted on in round 4)
1. **Add line character — "not straight" / hand-drawn lines.** This is faithful (LeWitt drafters
   drew by hand; his later instructions explicitly say "lines, not straight" — e.g. #46, #88, #95),
   it is exactly what Klee's living line calls for, and it directly answers "boring and predictable."
2. **Vary the most salient axis, boldly.** Make *line quality itself* a variable across the 16
   (machine-straight → lightly hand-drawn → clearly not-straight), so a round visibly spans a range
   instead of 16 near-twins. Let the ranking tell us how much "life" the user wants.
3. **Treat sameness across rounds as a failure mode**, not just within a round.
