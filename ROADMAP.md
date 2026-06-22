# Heavy-infrastructure roadmap (cross-repo)

Forward plan for the three heavy / future items deferred after M0–M3. **Cross-repo**: each item
spans `agent-bridge` (protocol + SDK) and `ai-town` (the host adapter). This is the design-of-record;
the structured trackers (`agent-bridge/feature_list.json`, `ai-town/avatar-bridge/feature_list.json`)
carry the status. Status legend: 📋 planned · 🚧 in progress · ✅ done.

**Global ordering rule (harness principle 1 + the four-step evaluation method):** do **H1's load
test first**. Don't build sharding, a 7×24 loop, or OS sandboxing speculatively — measure where the
real bottleneck is, then build only that. Profiler/eval numbers gate every optimization below.

**Invariants that NONE of these may weaken** (re-assert in every PR):
- Protocol-first: no divergence from `SPEC/abp-v1.md`. Any wire change = spec + schema first, version
  bump per §9. Backpressure/queueing/isolation are host- or client-*internal* and need **no** Core change.
- Closed schemas stay the security boundary; the host never blocks the world on an absent/slow client (§4.4.2).
- The 5 security layers (L0 auth, L1 capability allowlist, L2 untrusted-content, L3 egress DLP, L4
  memory isolation) hold under scale, over long horizons, and inside the sandbox.

---

## H1 — Scale: sharding, backpressure, horizontal scale, load test
**Repos:** agent-bridge (`@agent-bridge/host`) + ai-town (gateway, ConvexEngineAdapter, engine).
**Builds on:** `F9.1` (todo), the proven per-role routing (`host #byRole`, gateway `#pendingByRole`,
M2's isolation test).
**Target / definition of done:** a repeatable load test sustains **N concurrent driven avatars**
(first milestone N=25, stretch N=100) in one world with median request→action latency under a stated
budget, **zero dropped/duplicated events**, graceful backpressure on slow clients, and a documented
ceiling (where it falls over and why).

**Approach**
1. **Load harness first** (`agent-bridge` or `ai-town/gateway`): spawn N **scripted** clients (NOT
   real Claudes — deterministic + free) each driving a role; measure latency, throughput, dropped
   events, RSS, engine tick time vs N. Emit a CSV/summary. This is the gate for everything else.
2. **Per-session outbound backpressure** (host): bound each session's outbound queue; on a slow
   client apply an explicit policy (drop-oldest-non-turn / coalesce perception / disconnect). Today
   `emit()` is fire-and-forget over `ws` with a 256-frame resume ring.
3. **Shard only if the harness says so:** stateless gateway processes each owning a role subset, all
   over one Convex deployment (the shared writer). Likely the ceiling is the **single engine loop**,
   not the gateway — so "scale" may mean *more worlds*, not more agents per world. Document it.

**Verification (rules-based > e2e):** the load harness is the eval set; assert invariants
programmatically (event count in == out per role, monotone seq per session, no dup messageUuid).
Track numbers across runs (regression). No LLM-judge.

**注意事项明细 (considerations checklist)**
- [ ] **`ws.bufferedAmount` blowup**: a slow/stalled client makes the host buffer unbounded → OOM.
      Cap per-session outbound bytes; pick a drop/coalesce policy and `log()` what was dropped
      (no silent truncation).
- [ ] **Resume ring vs backpressure window**: the 256-frame ring (`HostSession.bufferMax`) must cover
      the largest disconnect/backpressure gap, or `resume` silently loses events. Size it from the
      measured gap, or force a re-`perception` on resume instead of replaying.
- [ ] **The real ceiling is the engine loop, not the network**: ai-town processes inputs serially per
      tick (`stepDuration` ~250ms after U2). Many external agents → input backlog + longer ticks →
      the `restartDeadWorlds` cron may flap the world. **Measure tick duration vs agent count** before
      anything else.
- [ ] **`pendingActionRequests` query cost**: ConvexEngineAdapter subscribes once and the query
      `collect()`s ALL pending rows (world-wide), re-running on every change → O(pending) per change,
      chatty at scale. Paginate, or shard the subscription per agent/cursor.
- [ ] **Per-session seq stays monotonic & isolated** under concurrency — never share a seq counter
      across roles; the M2 isolation test must keep passing at N.
- [ ] **Fairness / starvation**: one greedy or slow avatar must not starve others (round-robin the
      engine's external-request draining; cap per-agent in-flight).
- [ ] **Ollama is the builtin-agent ceiling**: N builtin agents calling one Ollama → serialization +
      latency. Load tests must use **scripted peers**, not LLM peers; document builtin-agent limits separately.
- [ ] **Backpressure must not block the world** (§4.4.2): if a client can't keep up, degrade *that*
      avatar (fallback/noop), never stall the engine.
- [ ] **Horizontal gateways share one deployment**: gateways are stateless routers → easy to scale;
      Convex/engine is the single writer per world → the actual limit. State this explicitly.
- [ ] **No Core protocol change** for flow control if avoidable; if an explicit `pause`/credit message
      is truly needed, that's a spec change + version bump (§9), not an ad-hoc field.

---

## H2 — 7×24 autopilot: long-running unattended real-agent avatars
**Repos:** agent-bridge (`@agent-bridge/mcp` autopilot, `@agent-bridge/client` daemon) + ai-town
(world longevity). **Builds on:** `F6.1` daemon (reconnect+resume), `F6.2` autopilot loop, `F6.3`
config + hot-unplug kill switch — all ✅. **Gap = the production real-Claude long-running brain.**
**Target / definition of done:** a real-agent avatar runs **unattended for ≥24h**, surviving
disconnects, model errors, and idle periods, within a **hard cost cap**, with an immediate kill
switch and full transcripts — verified by a long-run soak.

**Approach**
- **Brain lifecycle:** the autopilot `brain` today is a `(event) => ToolCall[]` injected fn. For
  7×24, choose: (a) **per-turn** `claude -p` invocations (stateless, resilient, but pricier + no
  working memory → lean on local persona memory), or (b) a **persistent** session fed events
  (cheaper per turn, but context grows → needs compaction). Default to (a) + persona memory; revisit
  with cost data.
- **Idle backoff:** only invoke the model on a real `turn`/`message`; block cheaply on
  `wait_for_event` otherwise. Never poll the model per tick.
- **Supervisor:** restart-on-crash with backoff, respects the kill switch, rotates transcripts,
  exports per-turn cost / reconnect / dropped-event counters.

**Verification (e2e soak + rules-based guards):** a multi-hour run (can compress with a fast mock
host that fires frequent turns) asserting: process survives K induced disconnects, cost stays under
the cap, no duplicate `say` after reconnect, kill switch stops within X ms and the world keeps ticking.

**注意事项明细 (considerations checklist)**
- [ ] **Cost is the #1 risk**: enforce *layered* caps — per-turn (`--max-budget-usd`), per-day global,
      and idle backoff so an idle avatar costs ~\$0. A hard global kill on budget breach.
- [ ] **Context growth (option b)**: "compaction alone is not sufficient" — pair compaction with
      external state (persona memory) or prefer per-turn invocations. Decide explicitly, don't drift.
- [ ] **Resume gap = stale world model**: after a long disconnect the resume cursor may exceed the
      256-frame ring → lost events. Force a fresh `perceive` on reconnect; don't trust replayed state blindly.
- [ ] **Idempotency on retry**: a `say` sent but un-acked before a reconnect must not double-post.
      Dedup on ai-town's `messageUuid` + ABP `corr`; add a soak assertion for zero dup messages.
- [ ] **Model refusal / empty tool-call / error → `noop` and continue**, never crash or hot-loop;
      bound retries with backoff.
- [ ] **Kill switch must be immediate AND safe**: hot-unplug (F6.3) stops the brain *and* the host
      falls back (builtin or frozen avatar) without blocking the world mid-turn (§4.4.2). Test kill *during* an open turn.
- [ ] **Security holds over the long tail**: more turns = more injection attempts; run the F4.4
      injection eval set **continuously**, not once. Watch for persona drift across hours.
- [ ] **Observability is mandatory** for a 7×24 thing: transcripts, per-turn cost, reconnect count,
      dropped events, current world model — or it's undebuggable.
- [ ] **Outward-facing safety**: the avatar acts in a shared world; confirm it can take no
      irreversible/outward action (only the 6 tools; `say` through L3 DLP; memory local). Document the residual.
- [ ] **Interaction with H1**: 7×24 × many avatars multiplies cost and engine load — gate the fleet
      size on H1's numbers.

---

## H3 — OS-level process isolation (harden `isolation_mode: process`)
**Repos:** agent-bridge (`@agent-bridge/client` `isolation.ts`). **Builds on:** `F4.3` ✅ — which
already ships `isolation.ts` (spawn child with a **scrubbed env**) + the L1 capability allowlist.
**Gap = a real OS sandbox**, not just env-scrub: today it's `spawn()` with cleaned env; there is no
fs-scoping, no egress allowlist, no seccomp/seatbelt.
**Target / definition of done:** the avatar agent runs in an OS sandbox where, **even with a fully
jailbroken model**, it cannot read the user's fs/secrets, run arbitrary processes, or reach the
network beyond {the ABP host URL, the model API}. Verified by escape attempts that are *refused*.
**Framing:** defense-in-depth. L1 (tool allowlist) stays the primary control; this raises residual-risk
coverage for a compromised model. It protects the **user's machine from the avatar agent** — a
different direction from the host treating client input as untrusted (keep the two directions distinct).

**Approach**
- One reference backend per platform: macOS `sandbox-exec`/seatbelt profile, Linux
  `bwrap`/`nsjail`, or a container (most portable, heaviest). Pick **one** reference, document others.
- **Egress allowlist** is the hard part: the agent needs the model API + the ABP host and *nothing
  else*. Use a netns + tiny allowlisting proxy, or container network policy. A blanket "no network"
  breaks it.
- **fs view**: read-only minimal rootfs; the only writable path is the per-role persona-memory dir,
  remapped inside the sandbox (still namespaced per role, still never sent to the host).

**Verification (rules-based):** from inside the sandbox, attempt `cat ~/.ssh/id_*`, spawn a shell,
`curl` an arbitrary host → assert each is **denied**; run the F4.4 injection eval set inside the
sandbox; assert persona memory still works at its remapped path.

**注意事项明细 (considerations checklist)**
- [ ] **The egress paradox**: must allow exactly {model API, ABP host wss} and deny all other network.
      This is the crux; blanket no-network breaks the agent. Document per-platform how (proxy/netns/container).
- [ ] **Secret scrubbing ≠ key starvation**: the *runtime* still needs `ANTHROPIC_API_KEY`, but the
      model's *tool space* must not read env (that's L1: deny Bash/Read). OS isolation adds: the process
      can't see `~/.ssh`, `~/.aws`, etc. Scope the fs view; don't accidentally remove the key the runtime needs.
- [ ] **Persona-memory path remap**: it writes `~/.agent-bridge/persona-memory/<role>.json`; under the
      sandbox that path must be a writable bind inside the jail, still per-role isolated (L4 intact).
- [ ] **What exactly is sandboxed?** Decide: the whole avatar agent process (cleanest) vs just the MCP
      connector. stdio (MCP) must cross the boundary either way — wire it explicitly.
- [ ] **Platform portability**: macOS `sandbox-exec` is deprecated-but-works; Linux bwrap/nsjail;
      containers most portable. One reference impl, the rest documented + feature-detected.
- [ ] **Per-avatar process cost** multiplies under H1's fleet — sandbox overhead × N. Gate on H1.
- [ ] **Don't conflate the two threat directions**: host-side untrusted-client handling (L0/L2) is
      unchanged; this protects the *user's host machine* from the avatar agent. Keep them separate in docs/tests.
- [ ] **It's belt-and-suspenders, not a replacement for L1**: ship it as opt-in hardening; the
      DESIGN §4 residual-risk note already frames in-agent L1 as the default.

---

## Suggested sequence
1. **H1 load harness** (cheap, gates everything) → backpressure → (shard only if measured).
2. **H2** per-turn 7×24 loop + cost caps + soak (fleet size gated on H1).
3. **H3** sandbox hardening (gated on H1 since it multiplies per-avatar cost).

Each lands incrementally (one feature per session, commit, update the feature_list, soak/test before
flipping to ✅) — same discipline as M0–M3.
