# Hosting the Console on a Raspberry Pi (public access via Cloudflare)

Goal: serve the web console from an always-on Raspberry Pi and reach it over the public
internet (Cloudflare Tunnel), so you can drive the plotter without your personal computer
running — including **large jobs (60–200 shapes)** that take a long time to plot.

This doc explains *what runs where*, the one architectural gotcha that bites if you skip
it, how to size the Pi for big jobs, and the recommended stack. It's a plan + explainer;
the "headless job driver" piece is **not built yet** (see §6).

> TL;DR — Serving the console is trivial (it's a static site). The thing that needs real
> thought is **who drives a long job once your PC/browser is closed.** For unattended big
> jobs you want the **Pi** to drive them, not a remote browser tab. Recommended board:
> **Raspberry Pi 4 (2 GB)**.

---

## 1. What the console actually is

The console (`console/`) is a **pure static Astro site** — no SSR adapter, `astro build`
emits plain HTML/CSS/JS. **All plotter communication happens client-side:** the JavaScript
running *in your browser* calls the Pico's HTTP API (`/api/*`) and SSE stream (`/events`).

Consequences:
- **At runtime the Pi just serves static files** — no Node needed to *serve* (only to
  *build*; build on your PC and copy `dist/` over).
- The browser, wherever it runs, is what talks to the plotter — which leads straight to
  the gotcha below.

---

## 2. The gotcha: the browser talks to the Pico's LAN IP

Because the console is client-side, its requests go from *your browser* to the Pico's
**local** address (e.g. `http://192.168.1.71/api/...`). If you tunnel only the static site
through Cloudflare, the UI loads from anywhere but **can't reach the plotter** — your
remote browser can't see `192.168.x.x`.

**Fix: a reverse proxy on the Pi.** Run a small proxy (Caddy is easiest) that:
- serves the static console at `/`, and
- proxies `/api/*` and `/events` → the Pico's LAN IP.

Then point Cloudflare Tunnel at the Pi, and in the console header **leave the IP field
blank** — the code already falls back to same-origin relative URLs
(`api.ts`: `const base = ip ? http://${ip} : ''`). One hostname, everything routes:

```
your browser ──Cloudflare──▶ Pi (Caddy) ──┬─ /            → static console
                                           ├─ /api/*       → http://<pico-ip>/api/*
                                           └─ /events      → http://<pico-ip>/events  (SSE)
```

Only the **Pi** needs to see the Pico on the LAN — so put the Pi on **Ethernet** next to
your router. Disable proxy buffering for SSE (Caddy `flush_interval -1`) so the live
log/position stream flows.

---

## 3. The real question for big jobs: who *drives* the job?

A 60–200 shape job has three phases with very different costs:

| Phase | Cost | Runs where today |
|-------|------|------------------|
| **Generate + compile** — expand the shapes into tens of thousands of `goto`/`line` ops, RDP-simplify, optimize | **CPU burst** (seconds; *minutes* if `fit_in_bounds` reseeds a lot) | the **browser** (Script/Studio tab) **or** Node (MCP `plot_script`) |
| **Stream to the Pico** — flow-controlled `/api/batch`, ~64 ops/batch, paced against the 256-deep queue | **light** — mostly *waiting* on the slow motors | same place as generation |
| **Plot** | wall-clock (minutes → hours); the motors are the bottleneck | the Pico |

Two facts fall out:

1. **Memory is a non-issue.** Even ~50,000 query strings is only a few MB of text.
2. **Streaming isn't heavy — it's *long*.** The driver mostly sleeps ~400 ms between status
   polls for the whole plot. The real requirement is **a driver process that stays alive
   for the entire plot without a browser tab open.**

### Why "browser-drives" is fragile for unattended jobs
If you start a job from the web console, the **browser tab is the driver** (it runs
generation *and* the flow-controlled streaming — `streamQueries` in `usePlotter.ts`). Close
your PC and kick off a 200-shape job from your phone over Cloudflare, and **your phone**
is now driving a multi-hour plot. Phone sleeps / tab backgrounds / signal drops → the job
stalls. (The fetch-timeout + progress watchdog we added will tell you *why* it stopped, but
it still stops.)

### The robust model: the Pi drives, the browser monitors
For true "set it and forget it," the driver must run **on the Pi**, not the remote browser:

- **Run the Node side on the Pi** — the MCP server already does server-side,
  flow-controlled `plot_script`; or
- **A small headless job-runner service** (not built yet, §6): the console POSTs a script
  to it, the Pi expands + streams it (reusing the shared `core.js` pipeline), and the
  browser just **monitors** over SSE — disconnect-safe.

Either way, generation + streaming happen on the Pi and survive your PC/phone sleeping.

---

## 4. Sizing the Pi

Runtime footprint of the always-on serving stack:

| Component | RAM | CPU |
|-----------|-----|-----|
| Static file serving | negligible | ~0 |
| Caddy (proxy + TLS) | ~15–30 MB | trivial |
| `cloudflared` (tunnel) | ~30–60 MB | light |
| *(optional)* headless driver / MCP (Node) | ~50–80 MB idle, spikes during generation | light → **bursty** |
| **Total** | **< 200 MB** serving; more if generating on-device | low, except generation |

The board choice depends on **where generation runs**:

| Setup | Board |
|-------|-------|
| **Browser drives** (Pi only serves static + proxies) | **Pi Zero 2 W (512 MB)** is enough — the load is on your viewing device, not the Pi. |
| **Pi drives headlessly** (robust for closing your PC) | **Pi 4 (2 GB) — recommended.** Generation (and especially the `fit_in_bounds` reseed loop) runs on the Pi; **2 GB is the floor** because a big frame passes through several intermediate copies in the pipeline. Pi 5 if you want it snappy. |

Other boards: Pi 3 / 3A+ work too if you already own one; Pi 5 (2–4 GB) is overkill but
great if the Pi will do more.

### Job-specific tips (any board)
- **`fit_in_bounds` is the expensive knob.** A cell that never fits burns `max_seeds` full
  generations. Keep `max_seeds` modest (e.g. 200–500) on a Pi, or pre-validate seeds.
- Big jobs are fine on the 256-deep firmware queue — the flow control + fetch-timeout +
  watchdog already handle pacing and stalls.
- Build the static site **on your PC** and copy `dist/` to the Pi, so the Pi never needs
  the heavier `npm install` / `astro build` step.

---

## 5. Security — do not skip

Exposing the plotter to the public internet means **anyone who finds the URL can drive
your motors.** Put **Cloudflare Access** (Zero Trust, free tier) in front of the tunnel so
it requires your email/PIN to reach it. The hardware E-STOP is a last resort; auth-gating
is the right first line of defence.

---

## 6. Suggested stack & status

**OS:** Raspberry Pi OS Lite (headless). **Services (systemd):** Caddy (serve + reverse
proxy) and `cloudflared` (tunnel). Optionally the Node driver (MCP or the headless runner).

```
[ Raspberry Pi 4, Ethernet to router ]
  Caddy        → serves console dist/ at / ; proxies /api/* and /events → <pico-ip>
  cloudflared  → Cloudflare Tunnel + Access (auth)
  (optional) Node driver → runs big jobs server-side, browser just monitors
```

**Status of the pieces:**
- ✅ Static console — already builds to `dist/` (`npm run build`).
- ✅ Same-origin support — leave the console IP blank for a reverse-proxy setup.
- ✅ Server-side job running exists today via the **MCP server** (`plotter-mcp`,
  `plot_script`) — but it's driven by an MCP client (Claude), not the web console.
- ⏳ **Not built yet:** a small headless **job-runner service** the *web console* can hand a
  script to, so big jobs run on the Pi independent of any browser, with progress streamed
  back for monitoring. This is the piece that makes "close my computer and let a 200-shape
  job finish" fully robust.
- ⏳ **Not written yet:** the concrete `deploy/pi/` config (Caddyfile, `cloudflared` config,
  systemd units, first-boot README).

When ready, the next step is to build `deploy/pi/` + the headless runner. See also
[`OVERVIEW.md`](OVERVIEW.md) for how the Frame pipeline and draw queue fit together.
