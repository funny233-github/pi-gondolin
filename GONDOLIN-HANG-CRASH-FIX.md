# Gondolin pi-extension: Hang & Crash Diagnosis and Fix

**Project:** `pi-gondolin` (`/workspace`) — a pi extension that runs `read`/`write`/`edit`/`bash` tools inside a Gondolin micro-VM.

**Reported symptoms (chronological):**
1. `pi exiting due to uncaughtException: ClientDestroyedError` (`UND_ERR_DESTROYED`) while a `pnpm install` was running (~150 s in — **no** exit, **no** timeout reached).
2. After guarding that error: no more crash, but pi **hung** ("卡住") when a tool call had a **timeout** and ran `pnpm install` (timeout 300 s).
3. After the process-group fix: no crash, no hang (confirmed by the reporter).

**Purpose:** document the diagnosis, the extension-level fix, the evidence (and where evidence is *missing*), and upstream context useful for filing gondolin issues. The author decides whether/when to file.

---

## 1. Environment model

- The pi **process and this extension run on the host** (Arch Linux). The `process` tool runs on the host.
- `read`/`write`/`edit`/`bash` tools run inside an **Alpine Linux micro-VM** mounted at `/workspace`.
- Guest HTTP/TLS egress is mediated by a **host-side Gondolin egress proxy** that replays guest requests via `fetch` on undici `Agent`/`Pool`/`Dispatcher` objects.
- A tool-call **timeout** aborts the host-side await of the tool call but does **not** by itself terminate the guest process.

---

## 2. Failure modes (kept distinct)

Earlier analysis conflated these; they are separate. Note that **A1 and A2 share the same error string but have very different meanings.**

### Bug A — `ClientDestroyedError` / `UND_ERR_DESTROYED`

Root cause in gondolin source: `dist/src/http/utils.js` `closeSharedDispatchers` / `evictSharedDispatcher` call `entry.dispatcher.close()` inside a `try/catch` that only catches **synchronous** throws. The promise returned by `close()` is **not** `.catch()`-ed, so any rejection is left unhandled and rides up through pi's `uncaughtException` handler.

**Two candidate rejection sources — only one actually fires.** When a dispatcher is torn down with work in flight, two promises could reject:
- **(L1) the `dispatcher.close()` promise.** Not `.catch()`-ed → becomes `unhandledRejection`. **This is the crash source.**
- **(L2) the in-flight `fetch()`** (`qemu/http.js:925`, `await fetcher(...)`). **This one *is* handled** — every call site wraps it: `:470` inside `handleHttpDataWithWriter` (outer `catch` at `:730`), `:609` (async-IIFE `catch` at `:620`), `:692` (`catch` at `:701`), each turning the error into a 502/400 guest response. So L2 does **not** reach `unhandledRejection`.

  *Consequence for the fix:* §7 recommendation 1 is therefore **sufficient** for the crash — but it has to cover every `close()`.

**Where `close()` is called (all without `.catch()`):** only two functions, reached from several sites:
- `closeSharedDispatchers` — `http/utils.js:336` (teardown; called from `qemu/net.js:213`, `:270`).
- `evictSharedDispatcher` — `http/utils.js:350`, called from `pruneSharedDispatchers` (`:362`), `evictSharedDispatchersIfNeeded` (`:370`), `resetTaintState` (`qemu/http.js:35`, run in *every* request's `finally`), and two fetch-failure catches (`qemu/http.js:936`, `:1072`).

  So the minimal upstream change is **2 lines** (add `.catch()` inside those two functions), not 7.

**Extra finding — collateral eviction.** `qemu/http.js:936` (and `:1072`) evict the origin's dispatcher *on fetch failure*. By the time a failure surfaces, `getCheckedDispatcher` may already have installed a **fresh replacement** under the same origin key — so the failure handler closes the *healthy* new dispatcher too, amplifying the outage. Worth mentioning upstream alongside the missing `.catch()`.

There are two distinct paths that reach this call:

- **A1 — teardown eviction.** On VM shutdown, `closeSharedDispatchers()` closes every cached dispatcher. This is expected and **benign** (the VM is going away).
- **A2 — runtime idle-TTL eviction (the one that actually bit us).** `getCheckedDispatcher()` (`http/utils.js:373`) calls `pruneSharedDispatchers()` (`:356`) **at the start of every egress request — before the cache lookup (call site `:377`)** — and that prune evicts any dispatcher whose `lastUsedAt` is older than `DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS` (**30 s**, hard-coded at `:134`). Critically, **`lastUsedAt` is refreshed only at *dispatch* time** (cache hit `:381`, new dispatcher `:398`) — it does **not** track in-flight or queued requests. So a slow request (>30 s, e.g. a large/slow tarball download, or a burst that queues past the 16-connection limit) makes its dispatcher look "idle"; the next request to *any* origin triggers the prune, `close()` destroys that dispatcher, and requests on it fail with `ClientDestroyedError`. This is a **real runtime failure**, not a benign teardown, and it explains symptom (1): a crash at ~150 s with no exit and no timeout.

  *Verified from source (not inferred):*
  ```
  grep -nE "pruneSharedDispatchers|lastUsedAt|getCheckedDispatcher|IDLE_TTL_MS" \
    node_modules/@earendil-works/gondolin/dist/src/http/utils.js
  # 134: const DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS = 30 * 1000;
  # 356: function pruneSharedDispatchers(backend, now = Date.now()) {
  # 360:   if (now - entry.lastUsedAt <= DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS) continue;
  # 373: export function getCheckedDispatcher(backend, info) {
  # 377:   pruneSharedDispatchers(backend);
  # 381:   cached.lastUsedAt = Date.now();
  # 398:   lastUsedAt: Date.now(),
  ```

  *Caveat:* A2 is the *best-supported* explanation of the ~150 s crash, not a reproduced one. To turn it into a repro, capture the guard's live warning mid-command (see §9).

Relevant eviction call sites / constants (`dist/src/qemu/http.js`, `dist/src/http/utils.js`):
`resetTaintState` (~line 35), fetch-failure eviction (~936, ~1072), LRU `evictSharedDispatchersIfNeeded`, `pruneSharedDispatchers`.
`DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN = 16` (`:132`), `DEFAULT_SHARED_UPSTREAM_MAX_ORIGINS = 512` (`:133`), `DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS = 30 * 1000` (`:134`). **These are not configurable** in gondolin 0.12.0 — verified: the three constants are referenced only inside `http/utils.js` (definitions plus uses at `:360`, `:366`, `:394`), and **no `.d.ts` exposes any `idleTtl` / `maxOrigins` / `sharedUpstream` option** (nothing threads through `VM.create`). So "just raise the TTL" is not available without patching gondolin.

### Bug B — timeout orphans the guest process → hang

- A tool-call **timeout** aborts the host-side await, but the guest process keeps running, **orphaned**.
- **Confirmed empirically:** a `sleep 90` launched under a 4 s-timeout tool call was still alive (pid present) after the tool call returned.
- Consequences: the orphaned process keeps holding egress-proxy connections and consuming guest CPU/locks, and no exit code is ever produced for the tool call.

### What is *not* established

The causal claim that "orphaned processes **saturate the shared dispatcher**, which freezes subsequent guest HTTP" is a **plausible inference, not measured**. We never captured: how many orphaned processes existed, the connection-pool occupancy, or whether requests were "queued" vs "failing". Note also that `pnpm install`'s own default network concurrency is already ~16 and can fill `CONNECTIONS_PER_ORIGIN = 16` by itself, so orphan accumulation is **not required** to explain pool pressure. Treat the hang mechanism as a hypothesis; the fix was validated by outcome (no crash, no hang), not by isolating this mechanism.

### Why 150 s vs 300 s

- The **~150 s crash** is best explained by **A2** (runtime idle-TTL eviction cutting a slow/queued request), which is independent of any timeout.
- The **300 s hang** is best explained by **B** (timeout orphaning the still-running `pnpm install`), which is independent of the 30 s TTL.
- Alternative explanations that were *not* ruled out: a network hiccup triggering the fetch-failure eviction path; the reporter misremembering the ~150 s timing; leftover processes from earlier tests advancing the pressure. The document deliberately does not assert a single unified causal chain.

---

## 3. Investigation (what was ruled out)

- **Egress network is healthy:** a hard-bounded `node fetch` from the guest reached github (404) and npm (200) in <15 s. The connection is not dead.
- **Normal completion is fine:** plain commands (`sleep`, etc.) complete and return normally; a 400 s `sleep` ran to completion without crash.
- **Timeout terminates the tool call, not the guest:** `sleep 30` with a 10 s timeout returned at 10 s and left the guest `sleep` orphaned.
- **`ExecProcess` does not expose the guest pid host-side** (`session` is private; only `then()` / `output()` are exposed), so cleanup must be driven from inside the guest.

---

## 4. Fix (extension-level, in `/workspace/index.ts`)

Placed in `createGondolinBashOps().exec` — the only durable, reinstall-safe location (gondolin is a dependency; patching `node_modules` is not durable, and "tuning the TTL" is not possible because the constant is hard-coded).

### 4a. Bug A guard (`5c13ca2`, logging added in `60a49c7`)

- An `unhandledRejection` handler is installed at module load (before `export default`).
- It ignores **only** `UND_ERR_DESTROYED` (by `code` set and by case-insensitive message pattern `/UND_ERR_DESTROYED|client is destroyed/i`) and **re-throws everything else**, preserving pi's default crash behavior for real bugs.
- **Caveat / cost (intentional):** this guard also swallows the **A2 runtime** rejection, which *does* correspond to a real request failure (a guest request was cut). To avoid silently masking it, the guard now `console.warn`s each swallow. It is still only a *symptom* fix for A2 — the underlying request may have failed and been retried by `pnpm` (extra retries, extra latency, extra bandwidth).
- **The guard cannot tell A1 from A2.** Both surface as `UND_ERR_DESTROYED`, so both are swallowed; `isIgnoredRejection()` keys only on the error code/message and has no notion of *where* the rejection came from. "Re-throws everything else" refers to *other* error codes only. The only way to tell them apart is the `console.warn`: fired **at exit/teardown** ⇒ A1 (benign); fired **mid-command** ⇒ A2 (a real request was cut).
- A **proper** fix for A2 would be upstream (see §6): make the idle-TTL prune aware of in-flight/queued requests, and/or `.catch()` the `close()` promise.

### 4b. Process-group kill on timeout/cancel (`ea196ce`, `9599e60`)

Each exec now:
1. Runs the command under **`setsid`** so it becomes a **process-group leader** (PID == PGID).
2. Writes that PGID to a per-exec temp file (`/tmp/gondolin-exec-<hostpid>-<ts>-<rand>.pgid`) as the guest shell's first action. (The prefix is the **host** process pid; uniqueness comes from host-pid + timestamp + random.)
3. On **timeout or signal abort**, runs `kill -9 -<pgid>` in the guest to tear down the **whole process tree** (bash + pnpm + descendants), then `ac.abort()` as a host-side fallback.
4. **Grace poll** (`9599e60`): if the pgid file is not written yet (pathological very-short timeout), retry reading it for up to 500 ms (every 20 ms) before falling back to abort.
5. **Cleanup** (`60a49c7`): the pgid file is removed from the guest in `finally` (via `vm.exec(['/bin/rm','-f', ...])`, since it is a guest path and `fs.unlinkSync` would target the host). Note the `finally` runs on the **host-side** promise, so it still executes after a guest group-kill — cleanup is not skipped on the timeout path.

**Why this is correct:**
- `kill -9 -<pgid>` targets the process **group**, so grandchildren are killed too (unlike signaling only the direct child).
- Normal (non-timeout) execution is unaffected: output still flows through the pipe, `echo $$` is redirected to the temp file, completion returns the real exit code, and the agent still sees `timeout:<n>` / `aborted`.
- **Caveat (pgid reuse):** a process group id could in principle be recycled after the group dies, so `kill -9 -<pgid>` is not *absolutely* guaranteed to hit only our group. In practice this requires PID-counter wrap-around inside the kill window and is effectively negligible in a short-lived VM — but the claim "cannot kill unrelated processes" would be too strong; the scoping is probabilistic, not a hard guarantee. (A cgroup-based kill would be the airtight version, if the guest supported it.)

**Verified in-guest:** `setsid bash -lc 'echo $$ > FILE; sleep 60'` wrote PGID=784; `kill -9 -784` killed both the bash leader (784) and its child (786), with no survivors.

**Outcome (reported):** no crash, no hang.

---

## 5. Guardrails for the future

If "command silently fails" or "pi hangs without crashing" reappears, check in this order:
1. Did the guard log an `ignored undici destruction rejection`? (→ possible A2 runtime eviction.)
2. Is `IDLE_TTL_MS = 30 s` too short for the workload's slowest single request? (hard-coded; would need an upstream change).
3. Are `/tmp/gondolin-exec-*.pgid` files accumulating in the guest? (should now be cleaned up per exec).

---

## 6. Upstream context (for issue filing)

**Bug A** — no dedicated gondolin issue found; the behavior is documented in **undici** upstream:
- **undici #393** — `destroy(err)` semantics: pending requests fail with `ClientDestroyedError` (the mechanism behind `dispatcher-base.js`).
- **undici #4806** (closed, fixed by #4807) — same `ClientDestroyedError` from `close()`, though a narrower `clientTtl` drain-race.
- **undici #3848** — uncaught exception not interceptable in userland.
- **undici #5740 / #5677** — spurious `ClientDestroyedError` with `AbortSignal.timeout()` / GOAWAY.

gondolin 0.12.0 depends on undici `^6.21.0` (installed 6.28.0). Some upstream fixes may already be present, but they do **not** cover gondolin's own "call `close()` on a mid-flight dispatcher and do not `.catch()`" path, nor the TTL-prune-doesn't-track-in-flight behavior. **Upgrading undici alone will not fix A2.**

**Bug B** — the same bug *class* is documented elsewhere:
- **argoproj/argo-cd #28394** — "Exec timeout only kills the direct child, not its process group" (timeout signals only the direct child; grandchildren survive). Process-group kill is the standard remedy.
- **gondolin #67** — "VM times out on long streaming LLM API calls" (closest gondolin issue; network streaming, not process orphaning).
- Related: **gondolin #88** (orphaned VM after host crash), **#112** (auto-pause idle VMs), **#130** (write-tool `MAX_ARG_STRLEN` — a different example bug).

---

## 7. Recommended upstream fixes (gondolin)

1. **Bug A (teardown + runtime):** add `.catch()` (or a no-op handler) inside the **two** functions that call `dispatcher.close()` — `closeSharedDispatchers` (`http/utils.js:336`) and `evictSharedDispatcher` (`:350`). That one change covers all 7 call sites (§2). No other `.catch()` is needed for the crash: the in-flight `fetch` (L2) is already caught at its call sites.
   Also worth fixing alongside it: the fetch-failure eviction (`qemu/http.js:936`, `:1072`) can close a freshly-installed healthy dispatcher (collateral eviction, §2).
2. **Bug A2 (the real one):** make `pruneSharedDispatchers` track **in-flight/queued** requests (e.g. only evict when the dispatcher has no active requests), and/or expose `IDLE_TTL_MS` as an option. A 30 s idle TTL that ignores in-flight state will cut slow requests.
   *Caveat on scope:* this is not a one-liner — undici's `Dispatcher`/`Agent` does not directly expose "how many requests are in flight", so gondolin would have to wrap its own counter around `dispatch()`, or rely on a lower-level client-state API. Worth flagging in the issue so it isn't dismissed as trivial.
3. **Bug B:** make `vm.exec()` timeout/abort terminate the **process group** (e.g. run under `setsid` and `kill -9 -<pgid>`), not just signal the direct child.

---

## 8. Commits (branch `master`)

| Commit | Content |
| --- | --- |
| `5c13ca2` | Guard against benign undici `UND_ERR_DESTROYED` unhandled rejection. |
| `ea196ce` | Bash exec: kill guest process group on timeout/cancel (`setsid` + `kill -9 -<pgid>`). |
| `9599e60` | Grace-poll pgid file in `killGroup` to cover the short-timeout startup race. |
| `60a49c7` | Log ignored undici rejections (so runtime A2 isn't masked) + clean up the pgid file. |

---

## 9. Apply & verify

```
npm run install   # copies index.ts -> ~/.pi/agent/extensions/gondolin/
# then restart pi
```

- Run a long `pnpm install` with a timeout. After it times out, confirm **no orphaned guest process** remains (`ps -eo pid,args | grep '[p]npm'` should be empty), and that pi neither crashes nor hangs.
- Watch the pi output for `[pi-gondolin] ignored undici destruction rejection:` — if it fires **during** a command (not at exit), that's a signature of Bug A2 (runtime idle-TTL eviction) and worth capturing for an upstream report.
- **Mitigation (lowers A2 probability without patching):** run pnpm with lower network concurrency to stay well under the 16-connection-per-origin cap, e.g. `pnpm install --network-concurrency=8`. Fewer queued requests ⇒ fewer requests caught mid-flight when a dispatcher is TTL-evicted. It does not remove A2 (a single >30 s request can still be cut); it only lowers the odds.

---

## 10. Honesty summary

- **Confirmed:** timeout orphans the guest process; `setsid` + group kill terminates it; the TTL prune keys off `lastUsedAt` (dispatch time) and ignores in-flight state; `IDLE_TTL_MS`/`MAX_ORIGINS` are hard-coded; the original crash was a runtime event (not exit/teardown); the crash source is the **`close()` promise rejection (L1)** — the in-flight `fetch` (L2) is already caught at all three call sites; `close()` is called in exactly **two** functions (`http/utils.js:336`, `:350`) reachable from 7 sites.
- **Inferred (not measured):** that orphaned processes saturate the dispatcher and cause the hang; that the ~150 s crash was specifically A2 rather than a fetch-failure eviction or a misremembered time.
- **Not addressed by this fix:** the A2 *runtime request failure* itself — the guard hides its symptom; the underlying guest request may still be cut. That needs an upstream fix.
