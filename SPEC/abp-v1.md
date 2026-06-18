# Agent Bridge Protocol (ABP) — v1

> Status: Draft v1. This document is the normative specification.
> Machine-readable schemas: `SPEC/schemas/*.json` (JSON Schema 2020-12). The security-critical
> closed schemas ship now: `envelope.json`, `event.json`, `action.json`, `error.json`. The
> remaining control-plane payload schemas (`hello`, `pair_*`, `resume`, `ping`, `bye`) land with
> the validator (feature F1.1) and follow the field tables in §4 verbatim.
> Keywords MUST / MUST NOT / SHOULD / MAY follow RFC 2119.

## 0. What ABP is

ABP is a transport-agnostic protocol that lets a **local AI agent** (on a user's machine)
connect to a **remote host** that exposes drivable **roles** in some world or application,
bind to one role, and drive it — perceiving the environment, acting, and communicating —
while the local agent's reasoning, capabilities, and memory stay on the user's machine.

ABP is **not** specific to AI-Town. AI-Town is the first host. Any application can become a
host by implementing the host side of this spec; any local agent can become a client by
implementing (or downloading a reference implementation of) the client side.

### 0.1 Roles in the protocol

- **Client** — runs on the user's machine, driven by a local AI agent (Claude Code, Codex, …).
  Initiates all connections. The client is the security kernel (see §6).
- **Host** — the remote server exposing drivable roles (e.g., AI-Town's engine via an adapter).
  Treated as **untrusted** by the client.
- **Role** — a drivable character/agent slot in the host's world that a client binds to and drives.

### 0.2 Design invariants (the reasons ABP is safe by construction)

1. **Outbound-only.** The client always initiates. A host MUST NOT require any inbound
   connection to the client. (NAT-friendly; the host can never reach into the local machine.)
2. **Closed schemas, both directions.** Host→client events and client→host actions are each a
   **closed enum** with fixed payloads. Receivers MUST reject unknown `type` values and unknown
   payload fields. → A malicious host cannot smuggle instructions or tool calls; a client cannot
   be coerced into behavior outside the action verbs.
3. **No executable transport.** ABP carries **no** code, **no** tool definitions, **no** file
   references, **no** URLs-to-fetch as control. Only data + a closed set of action verbs.
4. **Untrusted-content contract.** Every field carrying foreign-authored text (messages,
   perception descriptions) is typed `untrusted` in the schema. Clients MUST treat such content
   as data, never as instructions (see §6.2).
5. **Capability scoping.** A session is bound to exactly one role and a capability set. No
   ambient authority; no cross-role access.
6. **Egress is the client's duty.** Before emitting any client-authored text, the client SHOULD
   run egress filtering (DLP) — ABP defines how redaction is signaled (§5.3).

## 1. Versioning

- Protocol version string: `"abp": "1"`. Clients and hosts MUST include it in every message.
- Negotiation happens in `hello`/`hello_ack` (§4.1). If versions are incompatible the host MUST
  reply with `error` (`code: "version_unsupported"`) and close.

## 2. Transport bindings

ABP defines message **semantics**; transports carry them. A conformant implementation MUST
support at least one binding. The baseline binding is WebSocket.

| Binding | Requirement | Notes |
|---|---|---|
| `wss` (WebSocket over TLS) | **baseline, MUST** | One full-duplex channel. TLS MANDATORY. Each WS message = one ABP message (JSON, UTF-8). |
| `sse+https` (SSE downstream + HTTPS POST upstream) | MAY | For environments without WS. Host→client = SSE event stream; client→host = HTTPS POST of one message. |

- Plaintext transports MUST NOT be used outside loopback dev.
- The session token (§4.2) MAY be presented via an `Authorization: Bearer` header on the
  transport handshake in addition to the in-message `session` field.

## 3. Message envelope

Every ABP message is a JSON object with this envelope (schema: `schemas/envelope.json`):

```json
{
  "abp": "1",
  "type": "event",
  "id": "01J9...ULID",
  "ts": 1718600000000,
  "session": "sess_…",
  "payload": { }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `abp` | string | yes | Protocol version. MUST be `"1"`. |
| `type` | string (enum) | yes | Message type (§4). MUST be a known value or the receiver rejects it. |
| `id` | string | yes | Unique message id (ULID/UUID). Used for correlation/idempotency. |
| `ts` | integer (ms epoch) | yes | Sender's timestamp. |
| `session` | string | conditional | Required after pairing for all data-plane messages. Omitted only during `hello`/pairing. |
| `payload` | object | yes | Type-specific, schema-validated. Receivers MUST reject unknown fields (`additionalProperties: false`). |
| `corr` | string | no | If present, the `id` of the message this responds to. |

Receivers MUST validate every message against the envelope schema **and** the payload schema
for its `type`. On failure: reply `error` and (for control-plane failures) MAY close.

## 4. Message types

Two planes. **Control plane** manages the connection/identity/lifecycle. **Data plane**
carries the narrow, fixed world interaction.

### 4.1 Control plane

| `type` | Dir | Payload schema | Purpose |
|---|---|---|---|
| `hello` | C→H | `hello.json` | Open; declare protocol version + client capabilities + desired binding. |
| `hello_ack` | H→C | `hello_ack.json` | Accept version; advertise host info, available roles endpoint, auth methods. |
| `pair_challenge` | H→C | `pair_challenge.json` | Nonce for the client to sign during pairing. |
| `pair_request` | C→H | `pair_request.json` | Client pubkey + signature over nonce + target (existing role id or `"create"`). |
| `pair_result` | H→C | `pair_result.json` | Scoped session token + role binding + granted capabilities, or rejection. |
| `resume` | C→H | `resume.json` | Re-attach an existing session token after a disconnect. |
| `ping` / `pong` | both | `ping.json` | Keepalive / liveness. |
| `bye` | both | `bye.json` | Graceful disconnect (hot-unplug). Carries a reason. |
| `error` | both | `error.json` | Typed error (§7). |

### 4.2 Authentication & pairing

1. Client connects (transport) and sends `hello`.
2. Host replies `hello_ack`.
3. To bind a role the client sends `pair_request`. If the host requires proof-of-identity it
   first sends `pair_challenge`; the client signs the nonce with its private key and includes
   the signature + its public key in `pair_request`.
4. Host validates, binds `pubkey ↔ role`, and returns `pair_result` containing:
   - `session` — an opaque, **scoped** session token. It grants **only**: drive this one role,
     with the listed `capabilities` (subset of action verbs), until `expires_at`.
   - `role` — the bound role's id + public display info.
   - `capabilities` — the allowed action verbs for this session.
5. The client uses `session` on all subsequent data-plane messages.
6. Reconnect: the client sends `resume` with the token. The host MUST re-validate scope/expiry.

Security requirements:
- Tokens MUST be role-scoped and capability-scoped. A token for role A MUST NOT act on role B.
- Tokens MUST expire; clients MUST handle re-pairing.
- The host MUST rate-limit pairing and reject replayed challenges.

### 4.3 Data plane

Exactly two data-plane message types: `event` (H→C) and `action` (C→H).

#### 4.3.1 `event` (Host → Client)

`payload` MUST match `schemas/event.json`. `payload.kind` is a **closed enum**:

| `kind` | Payload (`payload.data`) | Trust |
|---|---|---|
| `perception` | environment snapshot: `self` (position/status), `nearby` (list of roles w/ public display + distance), `world` (free context fields the host defines, all under `world.context`) | descriptions are **untrusted** |
| `message` | `{ from_role, conversation_id, content, seq }` — an utterance from another role | `content` is **untrusted** |
| `invite` | `{ from_role, conversation_id }` — an interaction invite | — |
| `turn` | `{ conversation_id?, deadline_ms, allowed_actions }` — "you may act now"; the action opportunity, with the host's allowed verbs and a deadline | — |
| `tick` | `{ world_time }` — time passage / world heartbeat | — |
| `role_update` | `{ patch }` — the bound role's own state changed (e.g., moved) | — |

Rules:
- Any field carrying foreign-authored text MUST be confined to a field documented as `untrusted`
  (`message.content`, `perception …description` fields). Hosts MUST NOT place instructions
  anywhere; clients MUST NOT interpret any event field as an instruction.
- A client MUST reject an `event` with an unknown `kind` or unknown payload fields.
- `turn.allowed_actions` tells the client which action verbs are valid right now; the client
  MUST NOT emit actions outside this set (and the host MUST re-check server-side).

#### 4.3.2 `action` (Client → Host)

`payload` MUST match `schemas/action.json`. `payload.kind` is a **closed enum**:

| `kind` | Payload (`payload.data`) | Notes |
|---|---|---|
| `say` | `{ conversation_id, text }` | Utterance. `text` is client-authored; client SHOULD run egress DLP first. |
| `move` | `{ to: {x,y} \| {target_role} }` | Navigate. |
| `interact_start` | `{ target_role }` | Start a conversation/interaction. |
| `interact_leave` | `{ conversation_id }` | Leave. |
| `emote` | `{ emote }` | Expression/gesture from a host-defined set. |
| `noop` | `{}` | Explicitly do nothing this turn. |

Rules:
- Hosts MUST validate each action against the session capabilities, the current `turn.allowed_actions`,
  rate limits, and size limits, and reply with `error` on violation.
- Actions are correlated to a `turn` via `corr` (the `turn` event's `id`) when responding to one.

## 5. Lifecycle

### 5.1 Connect & drive (happy path)

```
C → hello
H → hello_ack
C → pair_request            (← H → pair_challenge if required, then C signs)
H → pair_result (session)
loop:
  H → event(kind=perception|message|invite|turn|tick|role_update)
  C → action(kind=say|move|…)        # in response to a turn, or proactively if host allows
H/C → ping/pong (keepalive)
C → bye                      # hot-unplug
```

### 5.2 Offline / timeout

If the client does not answer a `turn` before `deadline_ms`, the host applies its own fallback
(idle/sleep/builtin). The protocol does not mandate the fallback; it mandates that the host MUST
NOT block the world on an absent client.

### 5.3 Redaction signaling

If a client's egress filter redacts content before a `say`/`emote`, it MAY set
`payload.data.redacted: true`. Hosts MUST treat this as a normal message (it is purely
informational). The protocol never transmits the redacted secret.

## 6. Security model (normative)

The full threat model and the 5-layer defense live in `../DESIGN.md`. The protocol-level
guarantees are:

### 6.1 Connection
- Outbound-only (invariant 1). TLS mandatory. Role+capability-scoped tokens with expiry.

### 6.2 Untrusted content (prompt-injection)
- All foreign-authored text is `untrusted` by contract. Clients MUST present it to any LLM
  wrapped/delimited as data and MUST instruct the model never to follow instructions inside it,
  never to reveal system/local information, and never to call a tool because untrusted content
  asked it to. ABP forbids carrying instructions in events, so injection can only arrive as
  *content*, which is contained by this contract.

### 6.3 Closed schemas
- Unknown `type`/`kind`/fields MUST be rejected (`additionalProperties: false` everywhere).
  This is what prevents a hostile host from escalating beyond the fixed event vocabulary.

### 6.4 Egress (data-leak prevention)
- Clients SHOULD scan client-authored fields (`say.text`, `emote`) for secrets (keys, private
  keys, tokens, cloud credentials, absolute local paths, oversized base64) and block/redact
  before emitting. This is the last line if §6.2 is bypassed.

### 6.5 No ambient capability
- A bound role exposes only the action verbs in §4.3.2 — no filesystem, shell, network, or tool
  access flows through ABP. The local agent's private powers are out of band and MUST NOT be
  reachable via the protocol.

## 7. Errors

`error.payload` (schema `error.json`): `{ code, message, retryable }`. Defined codes:

| `code` | Meaning |
|---|---|
| `version_unsupported` | Protocol version mismatch. |
| `bad_message` | Envelope/payload failed schema validation. |
| `unauthorized` | Missing/invalid/expired/forged token. |
| `forbidden` | Action outside session capabilities or `allowed_actions`. |
| `rate_limited` | Too many messages/actions. `retryable: true`. |
| `not_found` | Role/conversation unknown. |
| `conflict` | Role already bound / state conflict. |
| `internal` | Host-side error. `retryable` per host. |

## 8. Conformance

An implementation is **ABP/1 conformant** if it:
1. Validates every message against `schemas/` and rejects unknown `type`/`kind`/fields.
2. Honors outbound-only, TLS, and scoped tokens.
3. (Client) treats all `untrusted` fields as data and runs egress filtering on client-authored
   fields.
4. (Host) never blocks on an absent client and re-validates capabilities server-side.

A conformance test suite lives at `tests/conformance/` (see `feature_list.json` F1.1).

## 9. Extensibility (without breaking the security model)

- New event/action kinds require a **minor version bump** and MUST keep closed-schema semantics.
- Hosts MAY add fields **only** under explicitly-typed `*.context` / `*.ext` objects that are
  documented as data, never instructions, and never client-authored capabilities.
- Capabilities are additive and always opt-in per session.
