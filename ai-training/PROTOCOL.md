# PROTOCOL — what Claude does each round

Follow this exactly so every round is reproducible and the learning signal stays clean.

## 0. Read first (every single round)
- Read **`LEARNINGS.md`** in full. It is the point of this whole exercise — apply it.
- Read **`klee_principles.md`** — Klee's creative *method* (how to make a line live). The
  LeWitt instruction is the round's *rule*; the Klee principles are *how* you execute it.
- Skim the previous round's `reflection.md` and `ranking.json` to see what just won/lost.

## 1. Set the round brief → `spec.json`
**Every round is governed by a rule — a Sol LeWitt wall-drawing instruction** (see
`lewitt_instructions.csv`). LeWitt's whole practice is "one precise instruction, many
executions," which is exactly this loop: the instruction is the rule, the 16 designs are
the executions, the human's ranking says which execution best honours it.

**⛔ THE USER PICKS THE INSTRUCTION — Claude does NOT.** (Corrected 2026-07-01, after the user
got frustrated that Claude kept auto-advancing.) The earlier "go sequentially in CSV order, bring
the *next* row" rule is **retired.** Do not choose the next instruction, do not walk the CSV in
order, and do not end a round by proposing / queuing the next one. The user selects each
instruction from `lewitt_instructions.csv` (any order they like), Claude builds exactly that one,
then **STOPS and waits** for the user's next pick. Also: **actively vary the genre/style** each
round — don't get stuck iterating one visual family across many rounds (the located-figures
#237/#238/#274 streak was the kind of rut the user called out). When the user names an instruction,
confirm which row it is, agree the interpretation if there's any ambiguity, then build.

**Skip colour instructions.** Any instruction whose distinguishing element is colour (red/blue/
yellow lines, colour ink washes, "four colours in combinations", "bars/planes of colour", etc.)
is **skipped** — a monochrome pen plotter can't render it. This is a standing rule (user's call);
note each colour skip in the revision log, but don't stop to re-ask. Black/white/gray and "India
ink wash" tonal instructions are NOT colour — those are doable as tone.

**⚠️ THE USER DRIVES SELECTION; Claude executes.** Do NOT autonomously decide which instruction
comes next, and do NOT pre-plan a roadmap of upcoming rounds. When the user picks an instruction:
confirm the exact row (verbatim text), agree the interpretation / doability on a monochrome pen
plotter if there's ambiguity, build once you agree — then STOP. Colour instructions are still
auto-skippable if the user picks one by mistake (raise it), but never march ahead choosing the
next row yourself. If a pick needs a new generator, propose that and confirm.

Record the round's instruction (`id` + verbatim `instruction` + `year`) as its `rule`, and
add any extra hard limits in `restrictions`.

```json
{
  "round": 3,
  "title": "short name",
  "rule": {
    "lewittId": 46,
    "instruction": "Vertical lines, not straight, not touching, covering the wall evenly.",
    "year": 1970,
    "source": "github.com/maximalmargin/lewitt_instructions"
  },
  "restrictions": "Extra hard limits beyond the instruction, e.g. 'monochrome; one generator + at most one modifier; leave clear negative space'.",
  "allowedModules": ["sheets", "noisedHatches", "randomWalker", "..."],
  "maxLayers": 2,
  "bounds": { "left": 150, "right": 150, "up": 150, "down": 150 },
  "palette": ["#101216"],
  "createdAt": "YYYY-MM-DD"
}
```
Keep restrictions **simple and few** — the instruction already supplies the concept; extra
limits just isolate one variable so the ranking teaches something specific. A session is a
sequence of rounds; either explore one instruction deeply across rounds, or take a new
instruction each round.

## 2. Author 16 designs → `designs.json`
- Each design is a Studio layer-stack. Only the **allowed modules** for the round.
- Specify just the params you want to override — the harness merges each module's
  defaults underneath. Set `seed` on stochastic modules so the PNG is reproducible.
- Give each a short `title` and a one-line `intent` (what aesthetic idea it tests) — name the
  **Klee stance** in the intent (e.g. "individual gesture on structural ground", "straight-vs-
  circle adaptation"). The intent is how you later correlate "what I tried" with "what scored".
- Spread the 16 across the hypothesis space — don't ship 16 near-duplicates.
```json
{ "round": 3, "bounds": {…},
  "designs": [
    { "id": 1, "title": "tight rosette", "intent": "high petal count, centred",
      "layers": [ { "module": "spirograph", "params": { "R": 110, "r": 7, "d": 90 } } ] },
    …16 total… ] }
```
- Module/param reference: `console/src/lib/modules/*.ts` (each module's `sections` lists
  its field keys, ranges, and defaults). Image modules need a source image and are
  excluded from training unless a round explicitly provides one.

## 3. Render
```bash
cd console && npx tsx scripts/train-render.ts ../ai-training/sessions/<id>/round-NN
```
Check the harness output: any design reported with **0 paths** or an **unknown module**
warning is broken — fix it before handing the sheet over. Open `contact.png` and sanity-
check that all 16 actually drew something and sit inside the frame.

## 4. Hand off for scoring
Tell the human the contact sheet is ready. They fill `ranking.json`:
- `ranking`: array of design ids, **best first → worst last** (may omit ties/duds).
- `notes`: `{ "<id>": "why it works / fails" }` — optional but gold for learning.

## 5. Distill → `reflection.md` + `LEARNINGS.md`
After scoring:
- Write `reflection.md`: what the top quartile shared, what the bottom quartile shared,
  and at least one **transferable rule** (not "design 7 was nice" but "dense spirographs
  with r/R < 0.1 read as lace and ranked high").
- Promote durable, cross-round rules into `LEARNINGS.md` under the right heading. Keep it
  tight: principles, not a diary. If a new round contradicts an old rule, update the rule
  and note the round that revised it.

## Guardrails
- **Every round has a LeWitt instruction as its `rule`** (from `lewitt_instructions.csv`).
- **No Truchet.** Truchet / truchet-style tiling is excluded by user preference — don't use
  it as a design and don't pick instructions that essentially demand it.
- Never plot during training — rendering only.
- One variable per round where possible; resist piling on restrictions.
- Reproducibility: seeds on everything stochastic; never hand-edit a PNG.
