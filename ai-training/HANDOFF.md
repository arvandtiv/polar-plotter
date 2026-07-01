# HANDOFF — continue the AI-training loop (for the next agent)

Read this first, then `README.md` → `PROTOCOL.md` → `LEARNINGS.md`. This file is the live
state + the hard-won process rules. Everything lives on the **`ai-training` git branch**.

---

## ⏭️ Immediate next action
1. **⛔ WAIT FOR THE USER TO PICK THE NEXT INSTRUCTION.** (New process — see rule 1 below.) Do not
   choose it, do not walk the CSV in order. Two rounds are built & awaiting the user's ranking:
   - **Round 19 (#365)** — four-part progressively-darker-gray square via different line methods
     (user's pick; a genre change). `contact.png` ready → user fills `round-19/ranking.json`.
   - **Round 18 (#274)** — irregular clustered located-figures knot. `round-18/ranking.json` still open.
   When either is scored, **process it** (reflection.md, LEARNINGS, commit) — then STOP and wait.
2. Round **17 (#238) DONE** — a HIT; directional coherence beats scatter; balanced middle loses.
   (#274 ended the located-figures streak the user called a rut — keep genres varied now.)

> ⚠️ **When plotting (not just rendering) any density-ramp / dense design, apply the paper-rip limit:**
> the `ruledLines` `gradient` packs lines at the exact edge — with fine spacing that saturates and
> would tear paper. Consider a min-gap clamp on the ramp before any such design is physically drawn.

---

## 🚦 The PROCESS RULES (the user corrected me on these — do not violate)
1. **⛔ THE USER PICKS THE INSTRUCTION — Claude does NOT.** (Corrected 2026-07-01.) The user names
   the next LeWitt instruction (from `lewitt_instructions.csv`, any order they like). Build exactly
   that one, then **STOP and wait** for their next pick. Do **not** auto-advance in CSV order, do
   **not** choose the next instruction, and do **not** end a round by proposing/queuing the next one.
   (This retired the old "sequential, in CSV order, bring the next row" rule — that behavior is what
   frustrated the user.)
2. **Actively VARY the genre/style each round.** Don't get stuck iterating one visual family across
   rounds (the located-figures #237/#238/#274 streak was the rut the user called out). Each new pick
   should feel like a fresh visual language.
3. **Confirm + agree before building.** When the user names a pick, confirm the exact row (verbatim
   text) and agree the interpretation / doability if there's any ambiguity — then build. Never decide
   interpretation alone. Don't pre-plan a roadmap.
4. **Skip colour instructions automatically** (user's standing rule) — anything whose distinguishing
   element is colour (coloured lines, colour ink washes, "four colours in combinations", "bars/
   planes of colour"). If the user picks one, raise it. **Black / white / gray / "India ink wash"
   are NOT colour** — those are doable as tone.
5. When an instruction needs a capability we lack, **propose a new generator and confirm** before
   adding it.

## 🎨 The GOVERNING TASTE (what wins — see top of LEARNINGS.md)
**Organic · irregular · asymmetric · complex · dense · directional-flow · hand-drawn.**
- **Never crisp** — always some `jitter`. A jitter=0 design was explicitly rejected.
- **Never clean/geometric/symmetric** — execute geometric instructions *through the organic lens*
  (hand-drawn, irregular, asymmetric). Clean symmetric renderings are known duds (#51 round 8).
- **Gold standard:** dense + coherent **directional flow** + hand-drawn (round 11 stroke fields).
  Flow beats random scatter. Fine/dense beats sparse. Energetic hand (jitter 5–7) in dense fields;
  gentler (2–5) in sparse ones.
- Don't quantize free organic flow onto a grid / to 4 directions (round 12 #88 = "not worthy").

---

## 📍 State of the sequence
Done, in CSV order: **#11, #16, #17, #19, #38, #46, #47, #51, #56, #85, #86, #88, #130, #138, #142, #237, #238.**
- Rounds **1–11** scored + reflection + learnings.
- Round **12 (#88)** — UNRANKED, user said "not worthy" (grid-quantized flow). `reflection.md`
  records it as a dud.
- Round **13 (#130)** — ranked but "not that valuable" (low-value round). Lesson: jitter roughens
  texture not structure; radial-from-corners still reads symmetric. Processed.
- Round **14 (#138)** — asymmetric take (broke the arrangement). BIG WIN — "more than the original…
  very beautiful." Proves breaking arrangement-symmetry rescues a low-value genre. Processed.
- Round **15 (#142)** — density ramp (new `ruledLines` gradient). "A success"; winner = coarse+strong
  (#10). Surfaced the PAPER-RIP media limit (over-inking tears paper). Partial ranking = keep/reject.
- Round **16 (#237)** — located figures + web (new `locatedFigures`). Winner #13 "almost perfect."
  The WEB is the subject — draw it richly; avoid light/minimal. Dense corner-webs read structural.
- Round **17 (#238)** — sheared parallelograms + dense web. A HIT (#4/#15/#14). Directional
  COHERENCE beats scattered orientation (flow>scatter); the "balanced" middle loses.
- **Skipped (colour):** **#87** (= #56 + colour), **#95** (vertical not-straight lines "using four
  colours in all combinations"), **#154 / #159 / #160 / #164** (all "black outlined square with a
  **red** line", 1973).

**Next non-colour rows after #130:** #138 (circles/arcs from midpoints — DOABLE with `arcs`),
#142 (grid + not-straight lines — DOABLE, on-taste), then #154/#159/#160/#164 are **colour (red)
→ skip**, #237/#238/#274 (locations of geometric figures — DOABLE), #305 (100 random points),
#365 (four grays — tonal, DOABLE)… Review each with the user as you reach it; don't pre-build.

---

## 🛠️ Generators built for training (in `console/src/lib/modules/`)
All are pure, registered, and host-rendered. All support a `jitter` (hand-drawn / not-straight) param.
- **`ruledLines`** — straight/parallel lines filling a rect in any mix of the 4 LeWitt directions
  (│ ─ ╱ ╲), superimposed; `jitter` makes them not-straight. The workhorse for line-fill grids.
- **`connectDots`** — architectural points (corners/midpoints/centre/perimeter/grid/random) joined
  pairwise → complete-graph webs.
- **`strokeField`** — many short strokes on a jittered grid (even coverage), oriented random /
  **flow-field** / aligned. The stroke-field genre; flow fields are the taste's favourite.
- **`arcs`** — concentric arcs swung from centres (corners/midpoints/centre), clipped to frame.
  Symmetry-breaking levers added R14: `centreJitter` / `countJitter` / `radiusJitter`.
- **`ruledLines` `gradient`** (added R15) — a density ramp: packs verticals right + horizontals top
  (top-right accumulation). ⚠️ fine spacing + steep gradient saturates the edge → paper-rip; keep coarse.
- **`locatedFigures`** (added R16, extended R17/R18) — figures placed + a hand-drawn location web
  to the nearest architectural anchors; density-capped so no corner saturates. Figure types:
  `trapezoid` (R16), `parallelogram` + `shear`/`rotMax` (R17), `irregular` angular polygon (R18);
  `cluster` param (R18) groups figures into an asymmetric knot with open space. #237/#238/#274 genre.
(The stock Studio generators — spirograph, wobbly, etc. — still exist but training uses these.)

## ⚙️ How to run a round (mechanics)
1. Author the 16 designs as a `designs.json` (Studio layer-stacks). For repetitive designs, write a
   tiny Node builder script in scratch and run it → `designs.json`. Format:
   `{ round, rule:{lewittId,instruction,year}, bounds:{left,right,up,down}, designs:[ {id,title,
   intent, layers:[ {module, params}, ... ], groups?:[...] } ] }`. Each layer's params are merged
   over the module defaults, so only specify overrides. Put a **Klee stance** in each `intent`.
2. Render (no plotting):
   ```
   cd console && npx tsx scripts/train-render.ts ../ai-training/sessions/<id>/round-NN
   ```
   → writes `png/01..16.png`, a labeled `contact.png`, and a `ranking.json` template.
   **Check the harness output** for "0 paths" / unknown-module warnings, and eyeball `contact.png`.
3. Use ASCII-only text in titles (the canvas font tofu-boxes `╱╲é` etc.).
4. New generator? Add it under `console/src/lib/modules/`, import it in `modules/index.ts`,
   `npx tsc --noEmit` + `npx tsx test/registry.test.ts`, then `npm run build` before committing.
   `scripts/` is excluded from the app tsconfig (it's a tsx util).

## 📁 Layout
```
ai-training/
  HANDOFF.md            ← this file
  README.md             what the loop is
  PROTOCOL.md           the per-round steps (incl. the process rules above)
  LEARNINGS.md          ⭐ the accumulated taste — READ IN FULL each round; governing rule at top
  klee_principles.md    Klee's method (the "how"; cite a stance in each design's intent)
  lewitt_instructions.csv   the 74 instructions (the rules; go in order)
  sessions/2026-06-30-foundations/
    session.json
    round-01 .. round-13/   spec.json, designs.json, png/, contact.png, ranking.json, reflection.md
console/scripts/train-render.ts   the render harness (reuses the console pipeline + @napi-rs/canvas)
console/src/lib/modules/          ruledLines, connectDots, strokeField, arcs (+ stock modules)
```

## Commit hygiene
Commit after each round (build) and after each processing (reflection + LEARNINGS). Branch:
`ai-training`. End commit messages with the Co-Authored-By line. Nothing has been pushed.
