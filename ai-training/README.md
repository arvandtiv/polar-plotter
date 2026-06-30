# ai-training — teaching Claude an eye for plotter art

A human-feedback loop to tune Claude's aesthetic judgement when generating designs for
this polar plotter. No model weights are touched — "training" here means **accumulating a
persistent, versioned body of learned preferences** (`LEARNINGS.md`) that Claude reads at
the start of every round, plus the full record of every session so the signal is auditable.

## The loop

```
       ┌────────────────────────────────────────────────────────────┐
       │ 1. Claude reads LEARNINGS.md + sets a round brief (spec)    │
       │ 2. Claude authors 16 designs (Studio layer-stacks) →        │
       │    designs.json                                             │
       │ 3. Harness renders them to PNGs — NO plotting               │
       │    (contact.png + png/01..16.png)                           │
       │ 4. Human ranks them most→least interesting → ranking.json   │
       │ 5. Claude distills the ranking → reflection.md → folds the  │
       │    durable lessons into LEARNINGS.md                        │
       └───────────────────────────── repeat with a new brief ──────┘
```

The "tools" a round is allowed to use are the Studio module registry (generators +
modifiers in `console/src/lib/modules/`). A "design" is a layer-stack evaluated through
the exact same pipeline the Studio and firmware use, so anything that scores well here
plots for real with no translation.

## Rules — Sol LeWitt instructions

Every round is governed by a **rule**: one of Sol LeWitt's wall-drawing instructions
(`lewitt_instructions.csv`, 74 instructions, 1969–2008, from
[github.com/maximalmargin/lewitt_instructions](https://github.com/maximalmargin/lewitt_instructions)).
The instruction is the concept; the 16 designs are competing executions of it; the ranking
teaches which execution best honours the rule. **Truchet patterns are excluded** (user
preference) — see `PROTOCOL.md`.

## Method — Paul Klee's notebook

The rule says *what*; **`klee_principles.md`** says *how*. It distils Paul Klee's Bauhaus
form-theory (*Beiträge zur bildnerischen Formlehre*, 1921–22) into actionable design
stances — the living line, equilibrium-not-symmetry, structural-vs-individual (prime-number)
rhythm, fixed-vs-loose articulation, the straight-vs-circle encounter, growth. Each round,
every execution should consciously take a Klee stance (named in its `intent`). Source +
Klee's image corpus: `../klee/project_resources/`.

## Layout

```
ai-training/
  README.md           ← this file
  PROTOCOL.md         ← the exact step-by-step Claude follows each round
  LEARNINGS.md        ← the accumulated aesthetic principles (read first, every round)
  sessions/
    <session-id>/
      session.json    ← session goal + metadata
      round-01/
        spec.json     ← the round brief: restrictions, allowed modules, bounds, palette
        designs.json  ← the 16 designs (layer-stacks + param overrides + intent)
        png/01..16.png
        contact.png   ← labeled 4×4 sheet — the thing the human scores from
        ranking.json  ← human fills: ordered best→worst + per-design notes
        reflection.md ← Claude's post-scoring distillation for this round
      round-02/ …
```

## Rendering

```bash
cd console
npx tsx scripts/train-render.ts ../ai-training/sessions/<id>/round-01
```

Reuses `console/src/lib/{pipeline,registry,modules}` to evaluate each design to a Frame,
then rasterizes with `@napi-rs/canvas`. Offline — the firmware is never involved.
