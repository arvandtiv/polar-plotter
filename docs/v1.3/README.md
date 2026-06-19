# v1.3 — "Studio" — design & build plan

v1.3 turns the plotter console from a fixed set of hand-wired shapes into a small
**generative design studio**: pluggable generators, auto-built parameter panels, a
non-destructive modifier stack, smarter toolpaths, and live preview — all compiling
down to the **same** firmware `goto`/`line`/`pen` queue we already ship.

The ideas come from studying a reference app (see `reference/NOTICE.md`); the
implementation is **clean-room and our own** (React/TS console + Pico C firmware).

## The one idea that ties it all together: the **Frame**

Today each feature is imperative and bespoke: a circle is C code, the G-code digester
emits queries directly, the Draw tab hand-codes every control. v1.3 introduces a single
declarative intermediate representation:

```
Generator(params) ─▶ Frame ─▶ optimize ─▶ compile ─▶ goto/line/pen queries ─▶ streamQueries() ─▶ firmware
                       ▲
            Modifier(params, lowerFrame)
```

A **Frame** is just page size + a list of polylines in mm. *Everything* becomes
"produce a Frame, optimize it, compile it to the queue we already have." That single
pipeline replaces today's N special cases and is what makes generators, modifiers,
G-code, text, and images all interoperate.

We are **not** rewriting the firmware draw model. The compile step targets the existing
`pen?`, `goto?`, `line?…&lift=0` API (the continuous-draw + pause-pen-restore work from
v1.2). v1.3 is almost entirely a **console** evolution, with a couple of small,
optional firmware adds (an `arc`/G2-G3 primitive, an export profile) clearly flagged.

## Documents

| Doc | What it covers |
|-----|----------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The Frame IR, the registry, the field schema, the compile pipeline — the target design |
| [ROADMAP.md](ROADMAP.md) | The build plan, **one day (session) at a time**, in dependency order with acceptance tests |
| [02-fields-and-registry.md](02-fields-and-registry.md) | Declarative param schema → auto-generated panels; pluggable generator registry |
| [03-geometry-core.md](03-geometry-core.md) | Shared geometry toolkit (resample, bbox, fit, bezier, RNG, boolean ops) |
| [04-travel-and-simplify.md](04-travel-and-simplify.md) | Nearest-neighbour travel ordering + RDP simplify + optional arc fitting |
| [05-modifier-pipeline.md](05-modifier-pipeline.md) | The layer stack / `lowerFrame` model: mask, fill, warp, ripple |
| [06-text-image-maps.md](06-text-image-maps.md) | opentype text, image→linework/halftone, (stretch) maps |
| [07-preview-progress.md](07-preview-progress.md) | Live Frame preview + the drawing-order scrubber |

## Principles

1. **One step at a time.** Every roadmap day ends with something that builds, passes
   tests, and could merge — no half-features across sessions.
2. **Clean-room.** Learn the technique from `reference/`, write our own code. Never
   copy files. Pull real OSS libs (opentype.js, a clipping lib) from upstream.
3. **Pure & host-testable.** Generators, geometry, and the compiler are pure TS with
   `npx tsx` tests — same discipline as `kinematics_test` and `digest.test.ts`.
4. **Reuse, don't replace.** Compile to the existing query API and `streamQueries`.
   The firmware barely changes.
5. **Default-safe.** Every new param has a sane default; nothing changes plotted
   output until the user opts in.

## Branching

These docs land on `v1.2` (current dev branch). When Phase 0 implementation starts,
cut a **`v1.3`** branch from the latest dev tip. Each roadmap day is a small commit;
each phase can be a PR. `main` stays the frozen release line.
