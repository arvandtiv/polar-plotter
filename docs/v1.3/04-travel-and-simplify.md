# 04 — Toolpath optimization (`lib/toolpath.ts`)

*Nearest-neighbour travel ordering + RDP simplify (+ optional arc fitting) — pure TS.*

This is the highest-leverage win: it makes **every** Frame (shapes, generators, and
imported G-code) plot faster and stream fewer jobs, with no quality loss.

## A. Travel ordering (Day 9)
Goal: minimise total pen-up (travel) distance between paths.

```ts
optimizeOrder(frame: Frame): Frame
```
Greedy nearest-neighbour:
1. Start from the origin (or current pen position).
2. Repeatedly pick the unused path whose nearest endpoint (start **or** end) is closest
   to the current pen point; append it, **reversing** its points if its end was nearer.
3. Advance the pen point to that path's new end.

Greedy NN is O(n²) — fine for thousands of paths. (A 2-opt pass is a later nicety.)
Closed paths can also be "rotated" to start at the nearest vertex, but skip that until
needed. Output is a reordered/maybe-reversed Frame; geometry is unchanged.

**Metric to log:** sum of gaps (end[i] → start[i+1]) before vs after. Surface it in the
Studio summary ("travel −38%").

## B. Simplify (Day 10)
Two cheap passes, applied per path within a tolerance the user sets (default ~0.2 mm,
well under pen width):
- `filterCollinear(points, tol)` — drop a point if it lies within `tol` of the line
  through its neighbours.
- `simplifyRDP(points, tol)` — Ramer–Douglas–Peucker for curved runs.

Fewer points → fewer `line` sub-segments enqueued → less queue pressure and faster
streaming, since the firmware re-segments each `line` by `LINE_SEG_MM` anyway.

## C. Arc fitting (Day 26, optional, needs firmware `arc`)
Detect runs that fit a circular arc within tolerance (`fitCircle` from 3 points, then
verify deviation) and emit a single arc instead of many segments. Only worth it once
the firmware has an `arc`/G2-G3 primitive (`do_draw_arc`) so it streams as **one** job.
Until then, simplify (B) is the win.

## Wiring
`compile(frame)` becomes:
```
frame = optimizeOrder(frame)
for path in frame.paths:
   path.points = simplifyRDP(filterCollinear(path.points, tol), tol)
... emit pen/goto/line lift=0 ...
```
Then **Day 11** points the G-code digester at this same `compile`, so imports inherit
ordering + simplify for free.

## Tests (`toolpath.test.ts`)
- Three scattered segments: assert total travel after `optimizeOrder` ≤ naive, and that
  the set of segments is unchanged (just order/direction).
- A 100-point straight line simplifies to 2 points; a sampled circle stays within `tol`
  of the original (max deviation check).
- Determinism: same input → same output.
