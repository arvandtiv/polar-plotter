# Bug: G-code / large streams stop part-way — multi-root investigation

**Date:** 2026-06-23 · **Branch:** `v1.2` · **Status:** ✅ fixed — **FLASH REQUIRED** for the batch-body fix.

---

## Bug 3 (2026-06-24): stream stops at ~70% — body truncation + silent error bypass

**Symptom:** After the batch-body fix (Bug 2), streaming 28,674-move gcode stops at firmware
job #20,348 with ~8,443 ops silently missing.  The plotter executes those 20,348 jobs and
stops.

**Two root causes found (both console-only, no flash required):**

### 3a — firmware error response treated as {accepted:0, rejected:0}

When the firmware returns `{status:"error","msg":"..."}` (e.g. for a future body-truncation
error), `Number(d.accepted) || 0` converts `undefined → NaN → 0`.  `streamQueries` sees
`{accepted:0, rejected:0}` instead of a retryable `'error'`, advances `i += n`, and silently
skips all `n` ops.

**Fix (`console/src/hooks/usePlotter.ts`):**
```ts
// BEFORE:
return { accepted: Number(d.accepted) || 0, rejected: Number(d.rejected) || 0 };

// AFTER:
if (d.status !== 'ok') return 'error';  // firmware error → retry, not silent skip
return { accepted: Number(d.accepted) || 0, rejected: Number(d.rejected) || 0 };
```

### 3b — partial batch (accepted + rejected < n) silently skips unprocessed ops

If the firmware processes fewer ops than the console believes it sent (e.g. because a recv
timeout truncated the HTTP body), the firmware returns `{accepted:K, rejected:J}` where
`K+J < n`.  The old code did `i += n` (advance past all n, including the missing `n - K - J`
that were never queued), silently dropping them.

**Fix (`console/src/hooks/usePlotter.ts`):**
```ts
// BEFORE:
i += n;  // advance by n regardless

// AFTER:
const actual = res.accepted + res.rejected;
if (actual < n) {
    i += actual;  // advance only past confirmed ops; rest retry next iteration
    h.pushLog('warn', `partial batch: sent ${n}, fw confirmed ${actual} — ${n - actual} retrying`);
} else {
    i += n;
}
```

**Firmware safety net (`main/web_server.c`):** Added recv-truncation detection in
`handle_batch`: if `n < clen` after the recv loop, returns `{status:"error","msg":"body
truncated"}` so the console's `sendBatch` retries the whole batch.  Also: reduced `xQueueSend`
timeout 200 ms → 50 ms (shorter HTTP-task blocking if queue briefly fills) and increased
`listen()` backlog 5 → 10.  **Requires a firmware flash.**

---

## Bug 2 (2026-06-24): `/api/batch` body never read — stream silently sends nothing

**Symptom:** After the bounds fix, streaming a large G-code file shows job numbers increasing
in the console progress bar, but nothing appears in the firmware job queue and the plotter
does not move.

**Root cause:** `http_server_task` null-terminates the request line
(`*eol = '\0'`, where `eol` points to the `\r` of the first `\r\n`) before calling
`handle_batch(client_sock, req_buf, total)`.  Inside `handle_batch`, both
`strstr(req, "\r\n\r\n")` and `strstr(req, "Content-Length:")` use `req_buf` as a C string —
which now terminates at the null, so they never see the headers or the body.
As a result `clen = 0`, `n = 0`, `s_batch_body = ""`, and the parse loop finds no lines.
The response is `{"accepted":0,"rejected":0}` — not an error, so the console's
`streamQueries` counts the batch as sent and advances `i += n` without putting anything
in the firmware draw queue.

**Fix (`main/web_server.c`):** pass the headers portion (starting at `eol + 1`,
the `\n` immediately after the null-terminated request line) with the correct byte count:

```c
// BEFORE (body invisible — req_buf string terminates at *eol):
handle_batch(client_sock, req_buf, total);

// AFTER (headers + body fully visible):
int hdr_off = (int)(eol + 1 - req_buf);
handle_batch(client_sock, eol + 1, total - hdr_off);
```

`hdr_content_length` and `strstr("\r\n\r\n")` now scan the unmodified headers and the
partial body already in `req_buf`; the `recv()` loop in `handle_batch` then reads the
remainder.  **Requires a firmware flash.**

---

## Bug 1 (2026-06-23): stray `bounds` job — RESOLVED (console-only fix)

**Date:** 2026-06-23 · **Status:** ✅ fixed (console-only) — no flash required for this fix.

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
