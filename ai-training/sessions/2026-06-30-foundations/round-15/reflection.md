# Round 15 reflection — LeWitt #142 (increasing not-straight lines → density ramp)

**User ranking (PARTIAL — listed = keepers, unlisted = avoid):** 10, 5, 14, 2, 7, 3, 16
**Unlisted / "to be avoided":** 1, 4, 6, 8, 9, 11, 12, 13, 15 (mostly the border-saturating ones).
**User note (on #10, the winner):** *"perfect balance of non linear and exponential ratios, overall
this was also a success. In general I listed all the ones I did and the others that should be
avoided I did not list — especially dense next to the border. What happens is if the pen draws too
many lines in the same area (0.01mm) the paper can get wet and rip. Please note that."*
**Scored:** 2026-07-01

## Headline — a success, and a HARDWARE constraint surfaced
The density-ramp reading of #142 landed ("also a success"). But the ranking is really a keep/reject
split, and the reject criterion is partly **physical**: the steep+fine ramps pile lines on top of
each other at the border, and **over-inking a tiny area wets the paper until it tears.** This is not
an aesthetic note — it's a media limit that governs every future round.

## ⚠️ The paper-rip constraint (cross-cutting, → LEARNINGS + memory)
Too many lines in ~the same spot = the pen over-saturates the paper → it gets wet and **rips**.
- Never let a field become a near-solid black band, ESPECIALLY at an edge/corner where a ramp or
  radial family concentrates. "Dense" as *tone* is good; "dense" as *ink-on-ink* destroys the paper.
- On the `ruledLines` gradient specifically: the power-law packs lines at the exact edge (o=omin).
  With fine spacing that becomes a solid strip → avoid. **Keep a real minimum gap between adjacent
  lines even at the packed end** (coarser base spacing, or a min-gap clamp on the ramp).
- This reframes the R14 "coherence ceiling" as ALSO a physical ceiling: over-density is bad both to
  the eye (mud) and to the medium (rip).

## What won — coarse ramp reads best
- **#10 (winner): coarse spacing (22 mm) + strong ramp (0.8).** "Perfect balance of non-linear and
  exponential ratios." Coarse lines keep the packed corner **legible and printable** — the ramp
  reads as a *current*, not a solid. Big open negative space bottom-left (Klee #7) helped.
- The other keepers (5, 14, 2, 7, 3, 16) are medium/strong ramps at medium spacing (12–15). The
  common thread: the ramp is **visible but never saturates**. Even #7 (steep 0.9) survived because
  its 11 mm base kept the corner just short of solid.
- The rejects (8, 9, 11, 12, 15) are the fine-spacing (8–11) + steep-ramp combos → solid border →
  paper-rip risk. #1 (near-even) and #13 likely too tame / no clear win.

## Transferable rules (→ LEARNINGS)
1. **PAPER-RIP LIMIT (physical):** never concentrate lines into a near-solid patch, above all at
   edges/corners where ramps and radial families pile up — the pen over-wets the paper and it tears.
   Cap density so adjacent lines always keep a visible gap. Dense = tone, not ink-on-ink.
2. **On a density ramp, bias COARSER at the packed end.** The reading the user loves is a legible
   *current* (coarse strong ramp #10), not a saturated corner. Coarse+strong beats fine+steep.
3. **Partial rankings mean keep/reject** — unlisted designs are rejects, not un-scored; the split
   itself is signal (here: reject the border-saturating ones).
