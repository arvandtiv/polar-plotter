# TCP PCB Exhaustion Bug — Polar Plotter (Pico 2W)

**Date:** 2026-06-14  
**Branch:** `pico2`  
**Status as of writing:** Fix applied in commit `346a885`, UF2 built but **not yet confirmed on hardware**. The fix is unverified — the user has not flashed and tested this build.

---

## Context

Firmware: Raspberry Pi Pico 2W (RP2350), pico-sdk, FreeRTOS (ARM_CM33_NTZ port).  
Networking: CYW43439 WiFi via `cyw43_arch_freertos`, lwIP BSD sockets (`LWIP_SOCKET=1`).  
HTTP server: hand-rolled TCP accept loop in `main/web_server.c`.  
Web console: Astro 4 + React 18 in `console/` — polls `/api/status` every 2 s and holds one long-lived SSE connection to `/events`.

---

## The Bug

### Symptoms

- HTTP requests from the console return `curl: (56) Recv failure: Connection reset by peer` — connection is established (TCP handshake succeeds) but RST is sent as soon as data arrives.
- Ping works but with very high latency: **60–100 ms** on a LAN that normally shows **3–5 ms**.
- The failure starts within **5–10 seconds** of the console page being open.
- First few requests after a cold Pico boot succeed; the system degrades quickly.

### What the user reported

> "the connection drops out as soon as I send a job from console"

> "can you test the ip connection I think you are spiriling out into a bad territory everything was fine now all broken"

> "this commit had non of these issues happening just fyi: `980b64c`"

Commit `980b64c` was a console-only change (no firmware); the firmware was last changed in `3998afd`.

---

## Root Cause

### lwIP TCP PCB pool exhaustion

lwIP manages TCP connections using a fixed pool of `tcp_pcb` structs.

**Key defaults (no overrides in `lwipopts.h` at the time):**

| lwIP option | Default value |
|---|---|
| `MEMP_NUM_TCP_PCB` | **5** |
| `TCP_MSL` | **60 000 ms** (1 minute) |
| TIME_WAIT duration | `2 × TCP_MSL` = **120 seconds** |

When a short-lived HTTP connection closes, lwIP keeps the PCB allocated in `TIME_WAIT` state for 120 seconds (the standard RFC 793 guard against old duplicate packets). With only 5 PCBs total:

```
1 PCB  — listen socket (permanent, never freed)
1 PCB  — SSE /events connection (long-lived, browser holds it open)
─────────────────────────────────────────────
3 PCBs — available for HTTP API requests
```

The console polls `/api/status` every **2 seconds**. Each poll creates a new connection, serves one response, then closes — leaving the PCB in TIME_WAIT for 120 s.

After **3 polls = 6 seconds**, all 3 remaining PCBs are in TIME_WAIT. From that point:

- Any new TCP connection arrives, lwIP tries to allocate a PCB, fails, sends **RST**.
- The TIME_WAIT slots don't recover because new polls keep them renewed (or the 120-s timer simply hasn't run yet).
- The CYW43 WiFi task (priority 4) and lwIP TCPIP_THREAD (priority 4) are starved by the hard-looping application tasks (all priority 5), adding the observed **high ping latency** on top.

### Why the high-latency ping?

Once PCBs are exhausted, `accept()` in `http_server_task` returns immediately with `-1` for every pending (rejected) connection, causing a tight loop at priority 5 that starves the CYW43 WiFi task (priority 4) and lwIP thread (priority 4). This manifests as 60–100 ms ICMP round-trip instead of the normal 3–5 ms.

---

## Fix Attempts — Timeline of Commits

### Commit `a2d5d9d` — **BROKE EVERYTHING**

**Hypothesis at the time:** Increase `MEMP_NUM_TCP_PCB` to 32 and reduce `TCP_MSL` to 2000 ms. Also added active-close (shutdown/drain) to `web_server.c` to push TIME_WAIT to the client side.

**What changed:**

```diff
--- a/lwipopts.h
+++ b/lwipopts.h
+#define MEMP_NUM_TCP_PCB               32
+#define TCP_MSL                        2000   /* TIME_WAIT = 2×MSL = 4 s (was 2 min) */
```

(web_server.c also received the shutdown/drain change — see commit `f29128b` which shows it explicitly.)

**Result:** 30× ping latency increase (3 ms → 80–120 ms). HTTP RST on every request. **Worse than before.**

**Why it failed:** The commit message blamed FreeRTOS heap exhaustion from 32 large PCBs. That analysis was incorrect — `MEMP_NUM_TCP_PCB` is a static BSS allocation in lwIP, not a FreeRTOS heap allocation. The actual culprit was the **shutdown/drain logic added to `web_server.c`** (see next commit), which was bundled in the same attempt. With `shutdown(SHUT_WR)` followed by a 50 ms drain `recv()`, the server sent FIN + received a few bytes but then called `close()` with unread data still in the receive buffer, causing lwIP to send RST instead of the expected graceful close.

---

### Commit `f29128b` — **Still broken**

**Hypothesis:** Revert only `lwipopts.h`; keep the shutdown/drain in `web_server.c` to avoid TIME_WAIT on the server side.

**What changed:**

```diff
--- a/lwipopts.h
+++ b/lwipopts.h
-#define MEMP_NUM_TCP_PCB               32
-#define TCP_MSL                        2000
```

```diff
--- a/main/web_server.c
+++ b/main/web_server.c
@@ -711,6 +711,15 @@ static void http_server_task(void *arg)
         if (!found)
             send_response(client_sock, 404, ...);
+
+        /* Active close: send FIN first, wait briefly for client's FIN */
+        shutdown(client_sock, SHUT_WR);
+        struct timeval drain_tv = { .tv_sec = 0, .tv_usec = 50000 }; /* 50 ms */
+        setsockopt(client_sock, SOL_SOCKET, SO_RCVTIMEO, &drain_tv, sizeof(drain_tv));
+        char drain[8];
+        recv(client_sock, drain, sizeof(drain), 0);
         close(client_sock);
     }
 }
```

**Result:** HTTP still RST on every request.

**Why it failed:** The active-close sequence is theoretically correct (server sends FIN → TIME_WAIT moves to client), but the 50 ms drain window is too short in practice on a loaded WiFi stack. The `recv()` call times out and returns `-1` or `0`, then `close()` is called while there is still unread data in the TCP receive buffer (HTTP request data that was read by the app but not consumed from the kernel buffer). lwIP interprets a `close()` on a socket with pending receive data as an abortive close → **RST**.

---

### Commit `c7126eb` — **Reverted to known-good, still broken**

**Hypothesis:** Both the lwipopts.h changes and the shutdown/drain were wrong. Revert everything to `980b64c` firmware state.

**What changed:**

```diff
--- a/main/web_server.c
+++ b/main/web_server.c
-        shutdown(client_sock, SHUT_WR);
-        struct timeval drain_tv = { ... };
-        setsockopt(...);
-        char drain[8];
-        recv(client_sock, drain, sizeof(drain), 0);
         close(client_sock);
```

**Result:** Still RST. Ping still 60–100 ms.

**Why it was still broken:** The root cause (TIME_WAIT PCB exhaustion) was never addressed. Reverting to `980b64c` firmware code restores the same defaults that caused the original bug. The console was still open in the browser, still polling every 2 seconds, still filling PCBs with 120-second TIME_WAIT entries. The firmware was correct but the lwIP defaults are wrong for this workload.

---

### Commit `346a885` — **Current proposed fix (UNVERIFIED)**

**Correct diagnosis:** PCB exhaustion from default `TCP_MSL=60000 ms`. MEMP pools are in **static BSS** — not FreeRTOS heap — so both `TCP_MSL` and `MEMP_NUM_TCP_PCB` can be changed freely without affecting heap.

**What changed:**

```diff
--- a/lwipopts.h
+++ b/lwipopts.h
+/* Short TIME_WAIT so status-poll connections don't exhaust the PCB pool.
+ * Default MSL=60 s → TIME_WAIT=120 s is far too long for a LAN server with 5 PCBs. */
+#define TCP_MSL                         500    /* ms; TIME_WAIT = 2×MSL = 1 s */
+#define MEMP_NUM_TCP_PCB                10     /* listen + SSE + 8 for concurrent requests */
```

No changes to `web_server.c` — the plain `close()` is fine as long as we drain the request before closing (which `http_server_task` already does in its recv loop).

**Why this should work:**

```
PCB budget with fix:
  1  — listen socket
  1  — SSE /events (long-lived)
  1  — active HTTP request being served
  1  — most recent poll in TIME_WAIT (expires in 1 s)
─────
  4  — peak usage, well within the 10-slot pool

Poll rate = 1 per 2 s
TIME_WAIT = 1 s (< poll interval)
→ at most 1 PCB ever in TIME_WAIT at once
```

**Build:** `build/main/polar_plotter.uf2` built **2026-06-14 18:39** — ready to flash.

---

## Flash Instructions

```bash
# Put Pico in BOOTSEL mode: hold BOOTSEL, tap RESET, release BOOTSEL
picotool load -fx build/main/polar_plotter.uf2
# Press RESET to boot
```

## Verification Steps

After flashing:

1. Open serial monitor: `idf.py monitor` or `minicom` / `screen`
2. Wait for `WiFi up: http://192.168.1.71/`
3. Immediately run: `curl -s http://192.168.1.71/api/status` — should return JSON
4. Open the React console at `http://localhost:4321` with IP set to `192.168.1.71`
5. Let it run for 30 seconds with status polling active
6. Run curl again — should still return JSON (not RST)
7. Send a draw command from the console — connection should not drop

If step 6 still fails (RST after 30 s of polling), check `MEMP_NUM_TCP_PCB` is actually being picked up by the build (clean build: `rm -rf build && cmake -B build ... && cmake --build build`).

---

## Key Facts for Debugging

### Memory layout

- **FreeRTOS heap** (`configTOTAL_HEAP_SIZE = 128 KB`): task stacks, TCBs, FreeRTOS queues/semaphores/stream buffers. Already ~97 KB consumed by existing tasks.
- **lwIP MEMP pools**: **statically allocated in BSS** when `MEMP_MEM_MALLOC=0` (default). Changing `MEMP_NUM_TCP_PCB` does NOT affect FreeRTOS heap.
- **lwIP MEM heap** (`MEM_SIZE = 20 KB`): also static BSS. Used for pbuf payload data.

### Task priorities

| Task | Priority |
|---|---|
| Application tasks (main, web_draw, http, sse, udp, pattern) | 5 |
| CYW43 WiFi task (pico-sdk internal) | 4 |
| `TCPIP_THREAD` (lwIP) | 4 |
| Timer task | 7 (max-1) |
| Idle | 0 |

WiFi and lwIP run at **lower priority** than application tasks. Any tight-spinning application task at priority 5 will starve them, causing high ping latency and TCP failures. This is the secondary symptom of PCB exhaustion (tight accept-loop spin → WiFi starvation → high ping).

### Relevant files

| File | Role |
|---|---|
| `lwipopts.h` | lwIP compile-time configuration — where `TCP_MSL` and `MEMP_NUM_TCP_PCB` live |
| `main/web_server.c` | Hand-rolled HTTP server; `http_server_task` is the accept loop; `sse_task` owns the SSE connection |
| `FreeRTOSConfig.h` | `configTOTAL_HEAP_SIZE=128KB`, `configMINIMAL_STACK_SIZE=256 words` |
| `main/board_config.h` | Pin map, TMC5072 tuning, WiFi credentials |

### lwIP defaults to know

```
MEMP_NUM_TCP_PCB   = 5        (pool of TCP PCB structs)
TCP_MSL            = 60000    (ms; TIME_WAIT = 2×MSL = 120 s)
MEMP_NUM_TCP_SEG   = 16       (TCP segment pool)
PBUF_POOL_SIZE     = 16       (packet buffer pool)
```

Our `lwipopts.h` overrides `MEMP_NUM_TCP_SEG=32` and `PBUF_POOL_SIZE=24` but did NOT override `MEMP_NUM_TCP_PCB` or `TCP_MSL` until commit `346a885`.

---

## Alternative Approaches (not tried)

If `346a885` still doesn't work after flashing, consider:

1. **HTTP/1.1 keep-alive** — Instead of `Connection: close` on every response, support persistent connections. The browser reuses one TCP connection for multiple status polls → only 1 active PCB, 0 TIME_WAIT from polls. Requires adding a keep-alive loop in `http_server_task` and proper `Content-Length` headers (already present).

2. **Reduce poll frequency in the console** — Change the 2-second poll in `usePlotter.ts` to 5 or 10 seconds. Gives TIME_WAIT entries time to expire even at default MSL.

3. **SO_LINGER with timeout=0 (RST close)** — `setsockopt(sock, SOL_SOCKET, SO_LINGER, {1, 0})` before `close()` sends RST immediately, skipping TIME_WAIT entirely. Brutal but effective for local LAN. Tried indirectly (the shutdown/drain approach) but the explicit `SO_LINGER(0)` was never tested cleanly.

4. **Increase MEMP_NUM_TCP_PCB without changing TCP_MSL** — At 120-second TIME_WAIT and 2-second polling, you'd need `MEMP_NUM_TCP_PCB ≥ 1 (listen) + 1 (SSE) + 60 (TIME_WAIT slots) = 62`. Static BSS is fine but 62 × ~400 B = ~25 KB extra BSS — feasible on RP2350 (520 KB SRAM).
