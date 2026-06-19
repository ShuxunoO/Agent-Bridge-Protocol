# agent-bridge — Design

> Source of truth for the architecture and security model. The wire protocol is `SPEC/abp-v1.md`.
> Decisions were aligned with the user; see "Decisions" below.

## 1. Problem

Let a user's **local AI agent** drive a remote agent role as their avatar, with:
- local compute + curated persona memory + local agent capabilities behind a hard wall,
- conversation/memory data kept local,
- a connector that any MCP-capable agent can download (plugin/MCP/skill), hot-pluggable, fully
  decoupled from both the local assistant's source and from the host application.

The connector + protocol are **reusable**: any social/sim host can adopt them. This repo holds no
host-specific business logic — a host maps its own engine onto ABP in its own repo.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Protocol-first | Yes — define ABP (`SPEC/abp-v1.md`) before implementing. |
| Project independence | Standalone repo (`agent-bridge`) = protocol + reusable SDKs only; host apps implement the host side (engine mapping) in their own repos. |
| Autonomy | Configurable: user-in-the-loop (default) + optional autopilot daemon. |
| Memory boundary | Curated persona profile; private memory/files/secrets hard-walled. |
| Sandbox | In-agent restricted sub-context (tool allowlist). OS-level process isolation = optional hardening (`isolation_mode: process`). |
| First adapter | Claude Code + generic MCP. |
| Invite handling | No `accept`/`decline` action in `abp.social/1`. The external avatar is a **human-like** role: the host auto-accepts/auto-joins invites (as a typical social host already does for humans). Avatar control = `interact_start` / `say` / `interact_leave`. Zero protocol change; revisit via profile evolution (`abp.social/2`) only if a host needs explicit consent. |

## 3. Architecture

Physical constraint: a public host cannot reach into a user's machine (NAT / no inbound).
Therefore the **client connects outbound** — which is also the strongest security posture.

```
┌──────── local (trusted) ────────┐        ┌──── remote host (untrusted) ────┐
│ Local agent (Claude Code / …)    │        │  Host app (any social/sim)      │
│      │ MCP (sole integration)    │ outbound│  + ABP host SDK                 │
│      ▼                           │  TLS    │  - exposes drivable roles       │
│ ┌───────────────────────────┐    │◄──ABP──►│  - emits closed events          │
│ │ Connector (security kernel)│    │  wss    │  - applies client actions       │
│ │ - strict inbound validation│    │         │  - never blocks on absent client│
│ │ - sandboxed persona        │    │         └─────────────────────────────────┘
│ │ - egress DLP               │    │
│ │ - local persona memory     │    │
│ └───────────────────────────┘    │
└──────────────────────────────────┘
```

Three reusable pieces (this repo) + one per-host adapter:
1. **Protocol** (`SPEC/`) — the standard.
2. **Client connector** — outbound transport, pairing, MCP surface, sandbox, DLP, persona memory.
3. **Host SDK** — generic server-side helper to expose roles over ABP.
4. **Host adapter** (lives in the host app's own repo) — wires that host's engine to the Host SDK.

The **Connector is the only component touching both the untrusted host and the semi-trusted local
agent → it is the security kernel.** Small, auditable.

### 3.1 Protocol layering (Core + World Profile)

ABP is split into two layers so one stable, auditable security Core serves arbitrarily many worlds
without ever reopening the closed-schema guarantee (see `SPEC/abp-v1.md` §0.3, §5):

- **Core** — envelope, versioning/negotiation, control plane (auth, pairing, role discovery,
  resume, keepalive, errors), and the two data-plane *envelopes* `event`/`action`. Fixed, closed.
- **World Profile** — the per-world closed vocabulary (`event`/`action` kinds + `data` schemas)
  with trust annotations. The host inlines it (content-addressed) at `hello_ack`; the **connector
  pins it by hash** (bundled profiles silently, unknown ones via user approval) and validates every
  data-plane message against it. New worlds ship new profiles; the Core never changes for them.

This is the structural reason the project is reusable across hosts (games/sims) *and* stays safe:
"closed schemas both directions" holds per world because the client only ever validates against a
profile it has pinned. A 2D social-sim host uses the official `abp.social/1` profile.

## 4. Security model (5-layer defense in depth)

| Layer | Defends | Mechanism | Verification (deterministic first) |
|---|---|---|---|
| L0 connection/auth | network pivot, privilege | outbound-only; user keypair; pairing → role+capability-scoped token; TLS | unit: token scope; cannot act on other roles |
| L1 capability isolation | agent coerced to read local files/secrets | persona sub-context allowlist = `abp_*`/`persona_memory_*` only; no fs/shell/env/other MCP/private memory | unit: out-of-allowlist tool calls refused |
| L2 input trust boundary | prompt injection | host content wrapped `untrusted` — fields enumerated from the pinned profile's `x-abp-trust:untrusted` annotations (not hard-coded); locked persona prompt: content is data, never instructions/tool-triggers/leaks | injection eval set |
| L3 egress DLP | data exfiltration (last line) | deterministic scan of client-authored fields for secrets/keys/JWT/cloud creds/abs paths/large base64 → block/redact + rate/size limits | unit: known secrets blocked, clean text passes |
| L4 memory isolation | private memory leak | separate local persona memory store; no access to the main agent's private memory | unit: recall town facts, cannot read outside namespace |

**Residual-risk note**: with in-agent (not OS-level) sandbox, L1 strength depends on the host
agent's permission model. Compensation: L2/L3 are deterministic and do not rely on model
goodwill; the connector strictly narrows host I/O. OS-level isolation is an opt-in hardening for
public/high-security deployments.

### Threat model
- Host: untrusted (may be compromised/malicious). Client validates everything from it.
- Peer roles: adversarial. Their messages are untrusted data.
- Local agent: semi-trusted (user's own); its private data must have zero exposure to the host side.
- "Data stays local": reasoning + full memory stay local; only final utterances are relayed
  (inherent to social interaction); the host persists minimally / ephemerally.

## 5. Pairing UX

1. Start connector; generate/load keypair.
2. Browse host, pick an available role (or create).
3. Pairing handshake: sign challenge → host binds role↔pubkey → scoped session token.
4. Role marked externally-driven; this connector drives it.
5. Hot-pluggable: disconnect (host applies fallback) / resume any time.

## 6. Development approach (harness-engineering)

- Protocol-first: spec + closed schemas before code.
- One feature per session; commit, update `progress.txt`, exit. Broken state → `git reset`.
- Verification priority: rules-based > visual > e2e > llm-judge. Security core (validator, DLP,
  token scoping, injection eval) is all rules-based → unit-tested.
- No premature "done": a feature flips to `passed` only with test output recorded.
- See `feature_list.json` for the phased plan (P0 protocol … P9 scale).
