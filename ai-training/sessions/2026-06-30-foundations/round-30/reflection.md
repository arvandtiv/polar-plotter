# Round 30 — Splat (LeWitt #958, 2000) — a NICE round (positive)

## Outcome
Ranked, kept 8 of 16, best→worst: **13, 11, 14, 5, 1, 2, 3, 15.** User: *"This is nice round."*
First round on the new `branching` growth language — a successful escape from the flow-field rut.

**Rejected (8):** 4 long-tendrils, 6 curly, 7 whippy, 8 starfish, 9 flung-left, 10 flung-up,
12 splat+spray, 16 sparse-elegant.

## What won and why
- **Multi-mass asymmetric compositions swept the top:** #13 three-cluster, #11 two-splats,
  #14 constellation. Several irregular masses with open space between > one centred burst. This is
  the same lesson as R14 (break arrangement symmetry) and Klee #10 (stacked centres, off-centre
  balance). A single splat dead-centre reads too radial/symmetric.
- Next tier are the fuller single bursts (#5 dense-core, #1 classic, #2 explosive) + #3 off-centre
  and #15 raw-ink. Density + a filled core beat the open ones.

## What lost and why
- **Sparse again = out:** #4 long-tendrils, #8 starfish, #16 sparse-elegant — too much white,
  bare spokes. Confirms the standing "sparse floating gestures = worthless" rule.
- **Directional 'flung' throws (#9, #10) rejected:** the tropism throw streaks/piles to one side;
  it reads as a smear, not a splat. The `branching` sweet spot is radial/multi-mass, not directional.
- #12 splat+spray rejected despite being multi-mass — the tiny satellites read as scattered clutter
  (marks-field problem in disguise); the winning multi-mass pieces (#11/#13/#14) use masses of
  comparable weight, not a big blob + confetti.

## The two concrete asks (user note on #13) — ACTED ON
1. **"avoid the end of the edges being cut off"** — branches grew past the frame box and got clipped
   at the wall edge (a hard, mechanical-looking cut). Added an `edgeAvoid` param: near the frame
   boundary the growth heading is steered back inward, so the organic mass curls to stay inside the
   page instead of being sliced off. Designs should also leave a margin (size < wall).
2. **"add a more organic direction to affect the growth directions"** — the arms grew in straight
   radial spokes. Added a `flow` param: a smooth position-based curl field perturbs each branch's
   heading as it grows, so arms meander organically (a hint of the flow field folded into the
   growth) instead of shooting straight out from the hub.

Both default to 0 (backward-compatible); validated on the winning #13 config.

## Standing rule
⛔ Do not pick the next instruction. Round processed — now STOP and wait for the user's pick.
