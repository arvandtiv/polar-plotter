# v1.3 Build Schedule — pacing it within a daily token budget

The 27 roadmap "days" aren't all equal in token cost. This groups them into **sessions**
(one chat each) sized so a session fits comfortably in one sitting, and tells you which
to do when your budget is fresh vs. nearly spent.

## What burns tokens (so we can avoid it)
- **Reading big files repeatedly** — `console/src/components/App.tsx` (~1.6k lines) is
  the main hog. Pure-library days never need it.
- **Build/test iterations** — each `cmake`/`npm build`/`tsx` round-trips output.
- **Large writes & big pasted outputs.**

So: **pure-lib days are cheap, UI-wiring days are expensive.** We schedule accordingly.

## Session weights
- 🟢 **Light** — pure TS lib + a `tsx` test, no `App.tsx`. ~½ a normal day's budget.
  Two can share one session.
- 🟡 **Medium** — one focused file edit or a small component; one build. ~1 session.
- 🔴 **Heavy** — new React component wired into `App.tsx`, or a worker/canvas/firmware
  build. Do alone, with budget headroom.

## The session plan (~18 sessions)

| # | Roadmap day(s) | Wt | You get at the end |
|---|----------------|----|--------------------|
| S1 | Day 1 Frame + compile + run box | 🟡 | A square plots through the new pipeline |
| S2 | Days 2–3 geom toolkit + registry/box | 🟢🟢 | Tested geometry helpers + the module contract |
| S3 | Day 4 ParamPanel | 🔴 | Schema-driven controls render any module |
| S4 | Day 5 StudioTab | 🔴 | Pick → tweak → Run, end-to-end in the UI |
| S5 | Days 6–7 circle + square modules | 🟢🟢 | First two shapes as Frame generators |
| S6 | Days 8–9 wobbly + travel ordering | 🟢🟡 | Wobbly shape; pen-up travel minimised |
| S7 | Days 10–11 simplify + route digester | 🟢🟡 | Fewer jobs; G-code imports inherit optimization |
| S8 | Days 12–13 spirograph + orbital weave | 🟢🟢 | Two pattern generators |
| S9 | Days 14–15 moiré + pattern maker | 🟢🟢 | Two more generators |
| S10 | Day 16 layer model + Sequence UI | 🔴 | Non-destructive modifier stack exists |
| S11 | Day 17 Shape Mask (+ clipping lib) | 🟡 | Clip geometry to a shape |
| S12 | Day 18 Fill | 🟡 | Hatch/concentric on any closed path |
| S13 | Day 19 Warp / Ripple | 🟡 | Displace the layer below |
| S14 | Day 20 Text (opentype) | 🟡 | Text → plottable outlines |
| S15 | Day 21 Image → linework | 🔴 | Plot a photo as lines |
| S16 | Day 22 Halftone / squiggle | 🟡 | Two image styles |
| S17 | Days 23–24 preview + scrubber | 🟡🟢 | See the plot (and its order) before sending |
| S18 | Day 25 save/load documents | 🟢 | Persist & reload designs |
| — | Day 26 firmware `arc` *(optional)* | 🟡 | Arcs stream as one job (needs flash) |
| — | Day 27 G-code export *(optional)* | 🔴 | Send designs to other machines |

**Core feature-complete at S16; S17–S18 are polish; the two optional days come whenever.**

## Cadence options
- **Steady (recommended): 3 sessions/week** → core done in ~5–6 weeks, all of it in ~7.
- **Relaxed: 2/week** → ~9 weeks. **Sprint: daily** → ~3 weeks (watch budget on 🔴 days).
- Put 🔴 sessions (S3, S4, S10, S15) on days you start with a **full** budget. Pair the
  🟢 sessions when you're lower.

## Per-session playbook (keeps each chat lean)
1. **Open with the day number**, e.g. "Let's do S6 (Days 8–9)." I pull just that
   roadmap entry + the named files — no broad re-reading.
2. I **write pure libs straight from the design notes** (02–07) — these never touch
   `App.tsx`, so they stay 🟢.
3. **One commit per roadmap day**; tick the ROADMAP checkbox. If a session runs long, I
   **checkpoint-commit** and we resume next time — the checkboxes are our save state.
4. I run **targeted tests** (`npx tsx console/test/<x>.test.ts`), not full rebuilds,
   unless firmware changed.
5. If you're low mid-session, say **"wrap and commit"** — I'll land what's green and
   stop, rather than start something new.

## Tracking
`ROADMAP.md` checkboxes = source of truth for progress. This file = how we pace it.
