# Bug: G-code / large streams stop part-way (stray `bounds` job) — RESOLVED

**Date:** 2026-06-23 · **Branch:** `v1.2` · **Status:** ✅ fixed (console-only) — flash not required for this fix.

## Symptom (as reported)
- A large exported design (`design (2).gcode`, ~28.9k lines → ~21.8k ops) is run through
  the Console → Autonomous → **G-code** uploader.
- The artwork plots correctly then **terminates ~¼ of the way through**, even though the
  job counter keeps advancing.
- The console job log around the stall shows draw jobs completing, then a job labelled
  **`bounds`**:
  ```
  ✓ #10145 —
  ✓ #10146 —
  ✓ #10147 bounds
  ```
- The exported gcode itself is clean.

## Verification the gcode is fine
Running the file through the digester locally (`digestGcode`, default Auto-fit, a typical
work area) yields **21,773 in-bounds ops, no NaN/Infinity**, scaled to 56% to fit. So the
digester is faithful — the fault is at execution, not in the geometry.

## Root cause
The console's **status-poll connect-seed** auto-pushed `/api/bounds` to the firmware:

```ts
// usePlotter.ts, status poll (BEFORE)
if (!boundsSeeded.current) {
  boundsSeeded.current = true;
  const p = papersRef.current[0];               // the default paper
  const b = p ? {left:p.left,…} : DEFAULTS.bounds;
  setBoundsState(b);
  apiGet(ip, boundsToQuery(b)).catch(() => {}); // <-- pushes /api/bounds to the firmware
}
```

`boundsToQuery` → `bounds?xn…` → `WCMD_BOUNDS`, a normal queued job. It's meant to fire
once on connect, but it fires whenever `boundsSeeded.current` is reset and a poll then
succeeds. That ref is reset at the top of the poll effect (`boundsSeeded.current = false`),
so it re-arms if the poll effect re-runs or the component re-mounts — e.g.:
- a **reconnect** / late first-successful poll (the early polls failed while the board was
  saturated by the big stream), or
- a **dev-server HMR reload** mid-run (editing console code while a plot is running).

When the seed fires **mid-plot**, the pushed `bounds` lands in the draw queue as a job
(the `#10147 bounds` in the log). The firmware applies it, **changing the work area**; from
that point `clamp_xy()` pins every subsequent `goto`/`line` to the new (smaller/shifted)
boundary, so the rest of the design collapses onto the edge → "stops ~¼ in" while the
queue keeps draining.

This is unrelated to (and was masked by) two earlier, separately-fixed issues:
1. silent dropping of jobs on transient network failure (`streamQueries` now retries), and
2. one HTTP connection per op (now batched via `/api/batch`).
Both are real improvements but were not *this* bug.

## The fix
Make the connect-seed **read-only**: adopt the firmware's *current* bounds (reported in
`/api/status`) instead of pushing the default paper. The console then never injects an
`/api/bounds` job on its own.

```ts
// usePlotter.ts, status poll (AFTER)
if (!boundsSeeded.current && s.bounds) {
  boundsSeeded.current = true;
  const fb = s.bounds;   // firmware sends xn=-left, xp=right, yn=-down, yp=up
  setBoundsState({ left:-fb.xn, right:fb.xp, up:fb.yp, down:-fb.yn, shape: fb.ellipse?'ellipse':'rect' });
}
```

User-initiated bounds changes (the **Work area** card and **paper** dropdown →
`commitBounds` / `applyPaper`) still push `/api/bounds` — those are explicit and won't
happen mid-plot. No firmware change; no flash needed for this fix.

## How to verify
1. `cd console && npm install && npm run dev` (Astro 6 / Tailwind 4).
2. Connect; confirm the console's Work-area values now match the firmware's (adopted,
   not forced to the default paper).
3. Run the same `design (2).gcode` through the G-code uploader. Watch the job log — there
   should be **no `bounds` job** in the stream, and the artwork should complete fully.
4. (Optional) Force a reconnect mid-run (toggle WiFi / re-enter IP) — still no stray
   `bounds`.

## If it recurs / where to look next
- Grep for any other automatic `boundsToQuery` / `/api/bounds` send:
  `git grep -n "boundsToQuery\|/api/bounds"` — only `commitBounds` and `applyPaper`
  (both user-initiated) should remain.
- Any *other* control-plane command injected mid-stream would cause the same class of
  failure. The motion-affecting ones to audit: `bounds`, `matrix` (`setmatrix`), `speed`,
  `accel`, `cur`, `sethome`, `home`. None should be auto-sent during a run. The matrix
  seed (`matrixSeeded`) is already read-only.
- Firmware side: `clamp_xy()` (main.c) silently projects out-of-bounds targets onto the
  boundary — that's correct behaviour, but it's *why* a bad mid-run bounds change looks
  like "the plot stopped" rather than erroring. If you want louder feedback, have
  out-of-bounds targets during a streamed job log a warning instead of silently clamping.

## Related code
- `console/src/hooks/usePlotter.ts` — status poll (seed), `streamQueries`, `sendBatch`.
- `console/src/lib/gcode.ts` — digester (Frame → queries).
- `main/web_server.c` — `handle_bounds`, `handle_batch`, `enqueue`, `/api/status`.
- `main/main.c` — draw task, `clamp_xy`, `WCMD_BOUNDS` handling.
