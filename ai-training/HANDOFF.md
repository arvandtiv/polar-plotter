# HANDOFF — continue the AI-training loop (for the next agent)

Read this first, then `README.md` → `PROTOCOL.md` → `LEARNINGS.md`. This file is the live
state + the hard-won process rules. Everything lives on the **`ai-training` git branch**.

---

## ⏭️ Immediate next action
1. **Round 13 (#130) is built and awaiting the user's ranking** — it is NOT scored yet.
   Ask the user to open `sessions/2026-06-30-foundations/round-13/contact.png` and fill
   `round-13/ranking.json`. When they have, **process it** (write `round-13/reflection.md`,
   fold lessons into `LEARNINGS.md`, commit).
2. Then the next instruction is **#138 "Circles and arcs from the midpoints of four sides"**
   (the `arcs` generator already covers it). **Do NOT build it yet** — bring the verbatim text
   to the user and review together first (see the process rules below).

---

## 🚦 The PROCESS RULES (the user corrected me on these — do not violate)
1. **Review EVERY instruction WITH the user before building.** Bring the next CSV row's verbatim
   text, discuss doability on a monochrome pen plotter + how to interpret it, and **only build
   once they agree.** Never decide interpretation/doability alone.
2. **Do NOT pre-plan a roadmap / "sessions todo."** One instruction at a time. Don't end messages
   with "next I'll do X, Y, Z."
3. **Skip colour instructions automatically** (user's standing rule) — anything whose distinguishing
   element is colour (coloured lines, colour ink washes, "four colours in combinations", "bars/
   planes of colour"). Note each skip in the LEARNINGS revision log; don't stop to re-ask.
   **Black / white / gray / "India ink wash" are NOT colour** — those are doable as tone.
4. **Sequential, in CSV order** (`lewitt_instructions.csv`, top → bottom). Round N = Nth row.
   Never cherry-pick for taste. (Skipping colour rows is the only allowed skip.)
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
Done, in CSV order: **#11, #16, #17, #19, #38, #46, #47, #51, #56, #85, #86, #88, #130.**
- Rounds **1–11** scored + reflection + learnings.
- Round **12 (#88)** — UNRANKED, user said "not worthy" (grid-quantized flow). `reflection.md`
  records it as a dud.
- Round **13 (#130)** — built, **awaiting score**.
- **Skipped (colour):** **#87** (= #56 + colour), **#95** (vertical not-straight lines "using four
  colours in all combinations").

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
