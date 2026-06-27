# Process-halt bug — handoff doc

**Created:** 2026-06-27 (session handoff before restart)
**Project:** `~/Documents/polar_plotter` (branch `main`; release line also on `v1.2`)
**Symptom reported by user:** *Complex/long jobs sent as Scripts stop in the middle of the
process. Short scripts are fine. Been troubleshooting for a while.* User asked: "what goes
wrong — can we change the pipeline Script → job queue → draw?"

---

## 0. FIRST THING WHEN YOU RESUME — restore file access

This doc was written because mid-session the **whole project became unreadable**:
`/Users/babi/Documents/` → "Operation not permitted" on every file, and `git status`
failed with "Unable to read current working directory". Home (`~/`) and the scratchpad
were still fine. This is the macOS **TCC / Full Disk Access** restriction noted in
`CLAUDE.md` (project lives under the protected `~/Documents` folder).

**Fix before doing anything else (either one):**
- System Settings → Privacy & Security → **Full Disk Access** → enable the terminal app →
  **fully quit & reopen it** (and Claude Code), OR
- move the project out of `~/Documents`.

**Verify unblocked:** `ls /Users/babi/Documents/polar_plotter/main` should list files, and
`wc -l /Users/babi/Documents/polar_plotter/README.md` should return a number (not EPERM).
Until then, Read/Edit on project files will fail and no verified fix can be written.

---

## 1. The pipeline under suspicion

```
Script tab (App.tsx ScriptTab)
   → parseJsonScript()           parse + validate each line
   → streamQueries()             flow-controlled sender   ← PRIME SUSPECT
       → sendBatch() / sendRaw()  HTTP to firmware
   → firmware /api/batch,/api/*  enqueue onto g_draw_queue
       → web_draw_task (main.c)   single task that owns the motors, drains the queue
```

Key files / functions to re-read **first** (line numbers approximate, confirm on resume):
- `console/src/hooks/usePlotter.ts`
  - `streamQueries()`  ~ line 427–506  (the runner + flow control)
  - `getPending()`     (returns firmware `pending`, or `null` on failure — READ THIS, I
    didn't fully read it this session)
  - `sendRaw()`        ~ 1172
  - `sendAndWait()`    ~ 1184  (polls `done >= id`, 180 s deadline — used by grid barrier)
  - `sendBatch()`      ~ 1205
- `console/src/components/App.tsx` — `ScriptTab` runner (~903–1110), grid vs non-grid paths
- `main/web_server.c` — `enqueue()` (~234), `resp_enqueue()` (~249), `handle_batch`/batch
  build (~684–765), `/api/status` JSON (look for `pending`,`qcap`,`done`,`drv_ok`,`estop`,
  `aborting`,`peak`,`rejected`)
- `main/main.c` — `web_draw_task` (~1460+): the pause/E-STOP/fault **hold loop** (~1467),
  `move_to_xy`→`wait_reached` (~543), `DRAW_QUEUE_DEPTH` (`xQueueCreate`, ~914)

---

## 2. Diagnosis (hypotheses, from code read earlier this session — CONFIRM against live code)

`streamQueries` bases its **entire** flow-control decision on one number, `pending`, read
from `/api/status`:

```js
const CAP = 256, HIGH = 220, BATCH = 64;
const MAX_NET_FAILS = 60;
while (i < items.length && !isCancelled()) {
  const pend = await getPending();
  if (pend === null || pend >= HIGH) {     // ← wait branch
    if (pend !== null && !warned) { log "board busy"; warned = true; }
    await sleep(400);
    continue;                              // does NOT send, does NOT increment netFails
  }
  ... send batch sized ≤ (HIGH - pend) ...
}
```

Three independent ways a LONG script halts mid-way while SHORT ones don't:

**(1) `getPending() === null` → silent infinite wait.**
The `pend === null` branch sleeps 400 ms and loops **without** touching `netFails`, so it
never gives up. The firmware has a **single httpd worker** shared between draw POSTs and
`/api/status`. Under sustained batch streaming it saturates → status polls time out →
`getPending` returns `null` → runner parks forever in the 400 ms loop with no error. Short
scripts finish before congestion; long ones stall. **Best match for "stops in the middle,
no error."**

**(2) Runner is blind to firmware-side stops.**
If the board stops draining for ANY reason — latched driver fault (over-temp / coil short),
E-STOP, or a move that never reports `position_reached` and blocks `web_draw_task` — then
`pending` stays ≥ HIGH and the runner waits at the watermark forever, showing only "board
busy." `streamQueries` never inspects `drv_ok`, `estop`, `aborting`, or whether `done` is
advancing.

**(3) Possible queue-capacity mismatch.**
Runner reserves room against `HIGH=220`/`CAP=256`. If firmware `DRAW_QUEUE_DEPTH` <
advertised `qcap`, the console over-commits and a long stream gets rejected/refused partway.
**Confirm `DRAW_QUEUE_DEPTH` == reported `qcap`.**

(Secondary: partial-batch path `if (actual < n) i += actual;` — if `sendBatch` ever returns
ok with `accepted+rejected==0`, `i += 0` → spin. `sendBatch` is supposed to return `'error'`
on non-ok status to avoid this; verify the `accepted+rejected==0 && status==ok` case can't
happen.)

---

## 3. Proposed pipeline change (keep Script→queue→draw, make the runner progress-aware)

1. **Progress watchdog (core fix).** Track the firmware `done` cursor. If `pending > 0` but
   `done` hasn't advanced for ~8–10 s, STOP and surface a real error ("board stopped making
   progress — fault / E-STOP / hang") instead of waiting forever. Catches (1) and (2).
2. **Treat repeated `getPending() === null` as transient** — route it through the existing
   `onTransient()` / `netFails` backoff so a wedged status endpoint eventually aborts with a
   message instead of hanging.
3. **Read health flags in the wait branch** — if `/api/status` reports `!drv_ok`, `estop`,
   or `aborting`, bail immediately with the cause.
4. **Confirm/align `DRAW_QUEUE_DEPTH` vs `qcap`** and set `HIGH`/`CAP` to the true depth.
5. **Add a targeted log on stall** so the *next* halt tells you WHY (fault vs null-status vs
   queue-full vs no-progress), turning future repros into one-line diagnoses.

Most likely root cause: **(1) + (2) together** — status-poll starvation under load with no
watchdog and no fault-awareness. Confirm by reproducing a long script and watching, at the
moment it halts, whether `/api/status` still responds and what `pending`/`done`/`drv_ok`/
`estop` report.

---

## 4. Resume checklist

- [ ] Restore Full Disk Access (§0); verify with `ls`/`wc -l` on a project file.
- [ ] Re-read `streamQueries`, `getPending`, `sendBatch`, `/api/status` fields,
      `web_draw_task` hold loop, `DRAW_QUEUE_DEPTH` — confirm which of (1)/(2)/(3) bites.
- [ ] (If hardware handy) reproduce a long script; at the halt, curl `/api/status` and note
      `pending`,`done`,`drv_ok`,`estop`,`aborting`. Does status still answer?
- [ ] Implement: progress watchdog + null-status→transient + health-flag bail + queue-depth
      check + stall reason log.
- [ ] `cd console && npx tsc --noEmit` (and the digest host test if touched).
- [ ] Commit on `main`; if it should ship to the stable line, cherry-pick onto `v1.2` and
      cut a patch tag (last release was **v1.2.1** — see GitHub releases) + update notes.

## 4b. RESOLUTION (2026-06-27, implemented)

Re-read the live code. Root cause confirmed as **silent network/board stall**, not a
queue-depth bug (`DRAW_QUEUE_DEPTH 256` == console `CAP 256`; firmware jobs are bounded by
`MOVE_TIMEOUT_MS` so the draw task can't infinitely hang). Four concrete defects:

1. **Console `fetch` had NO timeout** (`lib/api.ts`). A stalled-but-not-reset TCP link made a
   request hang forever → `streamQueries` parked at `await getPending()` with no error/log.
   **THE silent halt.** → Added `fetchT()` (AbortController): status 6 s, GET 8 s, batch 12 s.
2. **Firmware API responses had no send timeout.** Accept loop set `SO_RCVTIMEO` but not
   `SO_SNDTIMEO` on API sockets (SSE socket already did). A blocked `send()` froze the
   single-threaded server permanently → feeds defect 1. → Added `SO_SNDTIMEO` 4 s
   (`web_server.c`, in the accept loop next to RCVTIMEO).
3. **`streamQueries` null-status branch spun 400 ms forever** without touching `netFails`.
   → Now routes null status through `onTransient()` backoff → aborts with a real error.
4. **Stuck moves invisible over WiFi.** `wait_reached` timeout logged via `ESP_LOGW`
   (serial only). → Added a `web_log()` so timeouts show in the SSE console.

Plus the **progress watchdog + heartbeat** (`streamQueries`, new optional `getHealth`
handler = one `/api/status` poll driving flow-control AND health):
- Heartbeat every 5 s: `streaming i/N · queue P/256 · done D · pen (x,y)` — leaves a trail.
- Bails with a specific reason on E-STOP / driver-fault / aborting.
- No-motion watchdog: fingerprint = `done|current|x|y`; if `pending>0` and the fingerprint
  is frozen for **20 s**, HALT with a diagnostic line. (x/y in the fingerprint avoids false
  trips during a long single job — a live plot always moves the pen.)

Wired `getHealth` through `usePlotter` → Script / Studio / Gcode call sites.

**Files:** `console/src/lib/api.ts`, `console/src/hooks/usePlotter.ts`,
`console/src/components/App.tsx`, `main/web_server.c`, `main/main.c`.
**Verified:** `npx tsc --noEmit` clean; `npx tsx test/digest.test.ts` all pass. Firmware
not yet flashed (needs `cmake --build build` + UF2 to Pico in BOOTSEL).

**How to test the next big job:** rebuild console (`npm run dev`/build) and flash firmware.
Run a long Script. The log now streams a heartbeat; at any halt it prints WHY (lost contact
/ E-STOP / driver fault / no-progress-for-Ns / move timeout). That one line is the diagnosis.

## 5. Repo state at handoff
- On branch `main`. Last commits: `4538491` (circle distortion + grid pen-down fix),
  `bf0de4a` (AGENT_GUIDE cell constraint), `d2d303e` (script pre-flight check).
- `v1.2` branch updated + tagged **v1.2.1** with a GitHub release (the three fixes above
  cherry-picked).
- Firmware change pending a flash: `main/kinematics.h` min arc segments 8→32 (build was
  stale as of Jun 24 — needs `cmake --build build --parallel` then UF2 to Pico in BOOTSEL).
- No work-in-progress edits for THIS bug yet — analysis only (file access was blocked).
