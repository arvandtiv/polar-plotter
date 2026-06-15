# HTTP RST-on-every-request — Polar Plotter (Pico 2W) — RESOLVED

**Date opened:** 2026-06-14 · **Resolved:** 2026-06-14 (commit `34065af`)
**Branch:** `pico2`
**Status:** ✅ **FIXED & confirmed working on hardware.** The web console, status polling, MCP, and the SSE log stream all work over WiFi.

> ⚠️ The original title ("TCP PCB exhaustion") was a **misdiagnosis**. The real
> root cause was **netconn-pool starvation** (`MEMP_NUM_NETCONN=4`). The
> PCB/TIME_WAIT changes made along the way were harmless safety margins, not the
> cure. The full (partly wrong) investigation is kept below for posterity — read
> the "Real Root Cause" section first; treat everything under "Investigation
> Timeline" as history.

---

## Real Root Cause (the one that was actually true)

With `LWIP_SOCKET=1`, **every `socket()` consumes one lwIP *netconn***, and the
default pool is `MEMP_NUM_NETCONN = 4`. The firmware permanently holds **three**:

```
1 netconn — HTTP listen socket
1 netconn — UDP listener
1 netconn — pattern listener
──────────
1 netconn — left over
```

The browser's SSE `EventSource` grabs that last one. From then on the **next
`accept()` has no netconn to allocate, so lwIP sends RST at the accept layer —
before any request handler runs.** That's why *every* endpoint failed, including
the static page, even on a fresh boot with plenty of free TCP PCBs. The earlier
"PCB exhaustion after ~6 s of polling" theory never fit that symptom (failure was
immediate and total once SSE connected, not gradual).

A secondary annoyance — intermittent **70–110 ms ping latency** — was the CYW43
default power-save mode (PM2) sleeping between beacons, unrelated to TCP.

## The Fix (commit `34065af`)

```c
/* lwipopts.h */
#define MEMP_NUM_NETCONN   16   /* was default 4 — the actual fix */

/* main/main.c, in wifi_init_sta() */
cyw43_wifi_pm(&cyw43_state, CYW43_NONE_PM);   /* kill the ~100 ms PM jitter */
```

A boot build-marker was also added so the running firmware can be positively
identified (this matters — several earlier "still broken" rounds were actually
**stale firmware that was never successfully flashed**):

```
[build] <date> <time>  (netconn=16 tcp_pcb=16 msl=500ms)
```

## Current lwIP config (`lwipopts.h`, all confirmed good)

| Option | Value | Why |
|---|---|---|
| `MEMP_NUM_NETCONN` | **16** | the fix — one per concurrent socket |
| `MEMP_NUM_TCP_PCB` | **16** | poll + SSE + draw headroom (`7f41ded`) |
| `TCP_MSL` | **500 ms** | TIME_WAIT = 1 s, safety margin vs the 2 s poll |
| `MEMP_NUM_TCP_SEG` | 32 | |
| `PBUF_POOL_SIZE` | 24 | |
| `LWIP_NETCONN` | 0 | (sequential netconn API off; sockets layer used) |

`web_server.c` uses a plain `close()` per request (the `shutdown`/drain
experiments from the broken rounds were reverted — they *caused* RSTs).

---

## SSE log stream — current behaviour

The log stream is already about as robust as it sensibly gets:
- **Server heartbeat:** `sse_task` sends `: hb\n\n` every 2 s when idle
  (`web_server.c:76`), so the socket never goes silent through NAT/idle timeouts.
- **Client auto-reconnect:** the browser `EventSource` reconnects automatically
  if the stream drops.
- **Single-slot by design:** `s_sse_fd_q` is a depth-1 queue (`xQueueOverwrite`),
  so a new browser tab/reload takes over the one SSE slot and the previous fd is
  dropped. Occasional reconnects you see are usually this (a reload/refocus), not
  a fault.

No outstanding fix is needed here. If a *grand* improvement is ever wanted, the
only real lever would be supporting more than one concurrent SSE client — but
that costs a netconn per client and complicates the single-owner `sse_task`, so
it's not worth it for a single-operator machine.

---

## Investigation Timeline (history — contains superseded/wrong conclusions)

| Commit | Attempt | Result |
|---|---|---|
| `a2d5d9d` | `MEMP_NUM_TCP_PCB=32`, `TCP_MSL=2000` **+ shutdown/drain in web_server.c** | **Broke everything** — the shutdown/drain `close()`-with-unread-data caused RST; also blamed (incorrectly) on FreeRTOS heap |
| `f29128b` | Reverted lwipopts; **kept** shutdown/drain | Still RST — 50 ms drain too short on loaded WiFi → `close()` with pending data → RST |
| `c7126eb` | Reverted everything to known-good `980b64c` | Still RST — root cause (netconn) never touched |
| `346a885` | `TCP_MSL=500`, `MEMP_NUM_TCP_PCB=10` | Helpful margin, **not the cure** (PCB theory was wrong) |
| `7f41ded` | `MEMP_NUM_TCP_PCB` 10→16 | More headroom for MCP polling |
| `faa9471` | docs: empirical re-diagnosis | Noted PCB theory didn't fit the evidence |
| **`34065af`** | **`MEMP_NUM_NETCONN=16` + `CYW43_NONE_PM`** | ✅ **Actual fix** |

**Lessons:**
1. With `LWIP_SOCKET=1`, size `MEMP_NUM_NETCONN` to your socket count — it's a
   separate, easily-forgotten pool from `MEMP_NUM_TCP_PCB`.
2. "RST immediately on *every* endpoint, including static, with free PCBs" points
   at the **accept/netconn layer**, not TIME_WAIT exhaustion (which degrades
   gradually).
3. Always confirm the firmware actually flashed — the build-marker print exists
   for exactly this reason; several "still broken" rounds were stale binaries.
4. Never `close()` a socket with unread RX data on lwIP — it sends RST.

---

## Flash / verify reference

```bash
# BOOTSEL mode: hold BOOTSEL, tap RESET, release BOOTSEL — Pico 2 has only BOOTSEL.
picotool load -fx build/main/polar_plotter.uf2
# Power-cycle to boot. Confirm the [build] marker timestamp on the serial log
# matches your build, then: curl -s http://<ip>/api/status  → JSON.
```

### Relevant files
| File | Role |
|---|---|
| `lwipopts.h` | lwIP config — `MEMP_NUM_NETCONN`, `MEMP_NUM_TCP_PCB`, `TCP_MSL` |
| `main/web_server.c` | HTTP accept loop + `sse_task` (SSE heartbeat at `:76`) |
| `main/main.c` | `wifi_init_sta()` (power-save off), boot build-marker |
| `FreeRTOSConfig.h` | `configTOTAL_HEAP_SIZE=128KB` |
