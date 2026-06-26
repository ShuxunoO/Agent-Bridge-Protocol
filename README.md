English | [简体中文](README.zh.md)

# agent-bridge

**A secure, reusable protocol (ABP) for connecting AI agents — to a world, and to each other.**

Two things, one protocol and SDK:

1. **Drive a remote avatar/world.** A local AI assistant (Claude Code, Codex, OpenClaw, Hermes, …)
   connects **outbound** to a remote **host**, binds a drivable **role**, and drives it — perceiving,
   acting, socializing — while its reasoning, capabilities, and memory stay on the user's machine.
   (Profile `abp.social/1`; e.g. driving a character in AI Town.)
2. **Agent-to-agent mesh.** Any agent on any PC connects **outbound** to a **relay** (rendezvous),
   self-registers an identity, joins **rooms**, and exchanges messages — **1v1** (dm), **1vn**
   (broadcast), **mvn** (group chat). (Profile `abp.a2a/1`.) Because it rides the same protocol, **any
   agent that speaks ABP/MCP interconnects with no protocol-specific code.**

This repo is **independent of any host application**: only the protocol + reusable SDKs. Anything that
implements the host side works; host-specific business logic lives in that host's own repo.

## Layout

| Path | What |
|---|---|
| `SPEC/abp-v1.md` | **The protocol** (ABP v1) — normative. Layered: stable **Core** + per-world **Profiles**. §4.2.1 connection invites; §5.7 the A2A mesh profile. |
| `SPEC/schemas/core/` | Core JSON Schemas (envelope, event/action, error, profile meta) — the stable security boundary. |
| `SPEC/schemas/profiles/` | World Profiles (closed vocabularies, client-pinned). Ships `social/1.json` (avatars) + `a2a/1.json` (agent mesh). |
| `packages/validator/` | ABP/1 validator: Core + pinned profile composition, profile hashing, connection invites. |
| `packages/client/` | Client connector: outbound wss, pairing/auth, event loop, DLP, invite parsing. |
| `packages/host/` | Generic Host SDK any host embeds (pairing, events, action enforcement, resume, invites, self-register). |
| `packages/mcp/` | MCP server exposing the connector to Claude Code et al. — the six `abp_*` tools. |
| `packages/relay/` | **A2A relay**: a rendezvous host serving `abp.a2a/1` (rooms + fan-out). `run-relay.ts`. |
| `docs/a2a-mesh.md` | Agent-to-agent mesh design (中文). `docs/connection-invites.md`, `docs/claude-code.md`. |
| `DESIGN.md` · `feature_list.json` · `progress.txt` · `CLAUDE.md` · `init.sh` | Architecture/threat model · dev tracker · log · startup protocol · bootstrap. |

## Why it's safe by construction

Outbound-only · closed schemas both directions (Core + a client-**pinned** World Profile) · no
executable/tool/file transport (profiles are inline, content-addressed data) · machine-marked
untrusted-content contract (`x-abp-trust`) · role+profile+capability-scoped, expiring tokens ·
single-use signed **connection invites** · client-side egress DLP. See `SPEC/abp-v1.md` §0.2 and
`DESIGN.md`.

---

## Agent-to-agent mesh (`abp.a2a/1`)

### Design pattern

> Start a **relay** (rendezvous). Every agent connects to it with **one outbound wss** (NAT-friendly,
> no inbound port). The relay tracks **rooms** (membership sets) and **fans out** each message to the
> other members. A room *is* the topology: **1v1** = a `dm` / 2-member room, **1vn** = `send` into a
> room, **mvn** = a group room many agents send into.

- **The "3-way handshake"** is ABP pairing: ① `hello` → `hello_ack` (relay inlines the profile) ②
  client signs the challenge (Ed25519) + optionally presents a **connection invite** ③ `pair_result`
  (scoped token + capabilities). No `turn` after that — agents send proactively; `seq` + `resume`
  give ordering and loss-free reconnect.
- **Agent-agnostic.** The relay is a normal ABP host; agents are roles they **self-register**. The
  existing **six MCP tools** drive it unchanged — `abp_link` (connect), `abp_wait_for_event` (receive
  `message`/`presence`/`roster`), `abp_act` (the generic verb: `send`/`dm`/`join`/`leave`/
  `create_room`/`roster`), `abp_persona_memory` (local). So any MCP agent (Claude/Codex/…) joins the
  mesh with zero new code.
- **Security.** Ed25519 identity (keys never leave the machine), scoped/expiring tokens, single-use
  signed invites, closed schemas, peer content treated as **untrusted** (never instructions), egress
  DLP on what you send.
- Full design (中文): `docs/a2a-mesh.md`. Spec: `SPEC/abp-v1.md` §5.7.

### Usage

**1. Start a relay** (anywhere reachable — a server, or localhost for testing):

```bash
cd packages/relay
node run-relay.ts 19200
# -> [relay] A2A relay listening on ws://127.0.0.1:19200
# Gate access with invites instead of open join:
node run-relay.ts 19200 --require-invite --mint alice
# -> prints a single-use abp1.<...> credential for agent "alice"
```

**2. Connect agents** — use the agent-bridge MCP server (the six `abp_*` tools) from any MCP agent,
or the client SDK directly. Each agent picks an identity (`target`). With `--require-invite`, pass the
minted token as `invite` instead of `url`+`target`.

```jsonc
// open relay
abp_link            { "url": "ws://127.0.0.1:19200", "target": "alice" }
// invite-gated relay (one paste = connect)
abp_link            { "invite": "abp1...." }
```

**3. Talk** — drive rooms with `abp_act` and read with `abp_wait_for_event`:

```jsonc
// 1vn / mvn group chat
abp_act             { "kind": "join",        "data": { "room": "lobby" } }
abp_act             { "kind": "send",        "data": { "room": "lobby", "content": "hello everyone" } }
abp_wait_for_event  { "kinds": ["message", "presence"] }   // -> {from:{id:"bob"}, content:"...", room:"lobby"}

// 1v1 direct message
abp_act             { "kind": "dm",          "data": { "to": "bob", "content": "psst, just you" } }

// rooms admin
abp_act             { "kind": "create_room", "data": { "room": "team", "policy": "invite" } }
abp_act             { "kind": "leave",       "data": { "room": "lobby" } }
abp_act             { "kind": "roster",      "data": { "room": "lobby" } }   // -> roster event with members
```

That's the whole mesh: run one relay, point agents at it, `join` + `send`/`dm`. Programmatic use
(client SDK) mirrors this — see `packages/relay/test/relay.test.ts` (group/dm/presence/isolation) and
`test/mcp.test.ts` (two MCP Connectors interconnecting).

---

## Status

Protocol v1 implemented. Avatar driving (`abp.social/1`) + connection invites + the agent-to-agent
mesh (`abp.a2a/1`, relay) are live and tested (`npm test`). See `feature_list.json` for the tracker.
