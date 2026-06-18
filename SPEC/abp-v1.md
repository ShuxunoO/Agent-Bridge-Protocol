# Agent Bridge Protocol (ABP) — v1

> Status: Draft v1 (layered revision). This document is the normative specification.
> Machine-readable schemas: `SPEC/schemas/` (JSON Schema 2020-12).
> - **Core** (closed, security-critical, stable): `schemas/core/{envelope,event,action,error,profile}.json`.
>   The remaining control-plane payload schemas (`hello`, `hello_ack`, `pair_*`, `resume`,
>   `roles_*`, `ping`, `bye`) land with the validator (feature F1.1) and follow the field tables in
>   §4 verbatim.
> - **World Profiles** (host-declared, pinned, per-world vocabulary): `schemas/profiles/<id>/<ver>.json`.
>   The official social profile ships now: `schemas/profiles/social/1.json`.
> Keywords MUST / MUST NOT / SHOULD / MAY follow RFC 2119.

## 0. What ABP is

ABP is a transport-agnostic protocol that lets a **local AI agent** (on a user's machine)
connect to a **remote host** that exposes drivable **roles** in some world or application,
bind to one role, and drive it — perceiving the environment, acting, and communicating —
while the local agent's reasoning, capabilities, and memory stay on the user's machine.

ABP is **not** specific to AI-Town, and **not** specific to social sims. AI-Town is the first
host and the embodied-social vocabulary (`abp.social/1`) is the first **World Profile**. Any
application — a game, a simulation, a different kind of world — can become a host by implementing
the ABP **Core** plus a World Profile (its own or an existing one). Any local agent can become a
client by implementing (or downloading a reference implementation of) the client side.

### 0.1 Roles in the protocol

- **Client** — runs on the user's machine, driven by a local AI agent (Claude Code, Codex, …).
  Initiates all connections. The client is the security kernel (see §6).
- **Host** — the remote server exposing drivable roles (e.g., AI-Town's engine via an adapter).
  Treated as **untrusted** by the client.
- **Role** — a drivable character/agent slot in the host's world that a client binds to and drives.

### 0.2 Design invariants (the reasons ABP is safe by construction)

1. **Outbound-only.** The client always initiates. A host MUST NOT require any inbound
   connection to the client. (NAT-friendly; the host can never reach into the local machine.)
2. **Validate against a pinned, closed schema, both directions.** Every message is validated in
   two layers: the **Core** envelope/type schema (a fixed closed enum) and, for data-plane
   messages, the **negotiated World Profile** that the client has **pinned** (§5). Within the
   pinned profile, `event`/`action` `kind`s are a closed enum with fixed payloads. Receivers MUST
   reject unknown `type`/`kind` values and unknown payload fields (`additionalProperties:false`).
   → A malicious host cannot smuggle instructions or tool calls; a client cannot be coerced into
   behavior outside the negotiated vocabulary. Profiles widen *which world* you can drive — never
   *what kind of thing* the protocol can carry (§0.2.3).
3. **No executable transport.** ABP carries **no** code, **no** tool definitions, **no** file
   references, **no** URLs-to-fetch as control. Only data, a pinned-by-value profile schema, and a
   closed set of action verbs. A World Profile is **data** (a JSON Schema document), transmitted
   **inline and content-addressed** — never a URL the client is told to fetch (§5.5).
4. **Untrusted-content contract, machine-marked.** Every field carrying foreign-authored text
   (messages, perception descriptions, public display names, open `*.context`/`*.ext` objects) is
   annotated `"x-abp-trust": "untrusted"` in the schema so the wrapping layer can enumerate it
   mechanically. Clients MUST treat such content as data, never as instructions (§6.2).
5. **Capability scoping.** A session is bound to exactly one role, one World Profile, and a
   capability set. No ambient authority; no cross-role access.
6. **Egress is the client's duty.** Before emitting any client-authored text (fields annotated
   `"x-abp-trust": "client_authored"`), the client SHOULD run egress filtering (DLP) — ABP defines
   how redaction is signaled (§4.4.3).

### 0.3 Layered architecture (Core + World Profile)

ABP is two layers so that **one stable, auditable security core** can serve **arbitrarily many
worlds** without ever reopening the closed-schema guarantee:

| Layer | Owns | Who defines it | Stability |
|---|---|---|---|
| **Core** | envelope, versioning/negotiation, transport, control plane (auth, pairing, role discovery, resume, keepalive, errors), and the two data-plane **envelopes** `event`/`action` (`kind` + `data` shape) | this spec | stable; closed enum of message `type`s |
| **World Profile** | the set of `event.kind` / `action.kind`s and the **`data` schema** for each, plus trust annotations | the host (may reuse an official profile) | versioned per profile; pinned by the client |

The Core never knows about `move` or `say` or `{x,y}` — those live in `abp.social/1`. A turn-based
card game ships `abp.cards/1`; a 3D world ships its own. Each is a closed schema **the client has
pinned**, so "closed schemas both directions" (invariant 2) holds for every world, while the set
of supportable worlds is open. This resolves the closed-vs-generic tension structurally rather
than by versioning the Core for every new world (contrast §9).

## 1. Versioning & negotiation

Two independent version axes:

- **Core version.** Wire field `"abp"` is the Core **major** version and MUST be `"1"`. The client
  declares its full Core semver and the profiles it supports in `hello`; the host selects in
  `hello_ack`. Incompatible Core versions → `error` (`code:"version_unsupported"`) and close.
- **Profile version.** Each World Profile has an `(id, version)` pair (e.g. `abp.social`, `"1"`)
  and a **content hash** used for pinning (§5.5). `hello`/`hello_ack` negotiate exactly one profile
  for the session. If no common profile exists → `error` (`code:"profile_unsupported"`) and close.

`hello` carries `{ abp_core: "<semver>", profiles: [{id, version}], bindings: [...] }`.
`hello_ack` carries the selected `{ abp_core, profile: {id, version, hash, document} }`, host info,
and supported auth methods. The Core enum of message `type`s is fixed by this spec and is **not**
negotiable.

## 2. Transport bindings

ABP defines message **semantics**; transports carry them. A conformant implementation MUST
support at least one binding. The baseline binding is WebSocket.

| Binding | Requirement | Notes |
|---|---|---|
| `wss` (WebSocket over TLS) | **baseline, MUST** | One full-duplex channel. TLS MANDATORY. Each WS message = one ABP message (JSON, UTF-8). |
| `sse+https` (SSE downstream + HTTPS POST upstream) | MAY | For environments without WS. Host→client = SSE event stream; client→host = HTTPS POST of one message. `corr` is used to pair responses across the two half-channels. |

- Plaintext transports MUST NOT be used outside loopback dev.
- The session token (§4.2) MAY be presented via an `Authorization: Bearer` header on the
  transport handshake in addition to the in-message `session` field.
- **Message size limit.** Receivers MUST enforce a maximum decoded message size (default **65536
  bytes**, configurable) and a maximum JSON nesting **depth** (default **16**); over-limit messages
  are rejected with `error` (`code:"bad_message"`) before profile validation. This bounds the one
  deliberately-open object in the model (§5.4).

## 3. Message envelope

Every ABP message is a JSON object with this envelope (schema: `schemas/core/envelope.json`):

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
| `abp` | string | yes | Core major version. MUST be `"1"`. |
| `type` | string (enum) | yes | Message type (§4). MUST be a known Core value or the receiver rejects it. |
| `id` | string | yes | Unique message id (ULID/UUID). Used for correlation and **idempotency** (§4.3.3). |
| `ts` | integer (ms epoch) | yes | Sender's wall-clock timestamp (informational; not used for deadlines — see §4.4). |
| `session` | string | conditional | Required after pairing for all data-plane messages. Omitted only during `hello`/discovery/pairing. |
| `payload` | object | yes | Type-specific. Validated against the Core payload schema **and**, for `event`/`action`, the pinned World Profile (§5). Receivers MUST reject unknown fields (`additionalProperties:false`). |
| `corr` | string | no | If present, the `id` of the message this responds to. |

Receivers MUST validate every message against the envelope schema **and** the payload schema
for its `type`. For `event`/`action`, validation additionally requires the `data` to match the
pinned profile's schema for that `kind`. On failure: reply `error` and (for control-plane
failures) MAY close.

## 4. Message types

Two planes. **Control plane** manages the connection/identity/lifecycle. **Data plane** carries
world interaction — its envelope is Core, its vocabulary is the pinned profile.

### 4.1 Control plane

| `type` | Dir | Payload schema | Purpose |
|---|---|---|---|
| `hello` | C→H | `hello.json` | Open; declare Core version + supported profiles + desired binding + client capabilities. |
| `hello_ack` | H→C | `hello_ack.json` | Accept versions; **select + inline the World Profile** (id+version+hash+document); advertise host info, host pubkey (optional), auth methods. |
| `roles_query` | C→H | `roles_query.json` | List drivable roles in-band (optional filters: availability, area). |
| `roles_list` | H→C | `roles_list.json` | The available roles + per-role public display + bind policy (`open`/`claim_required`/`closed`). |
| `pair_challenge` | H→C | `pair_challenge.json` | Nonce for the client to sign during pairing. |
| `pair_request` | C→H | `pair_request.json` | Client pubkey + signature over nonce + target (existing role id or `"create"`) + optional **claim credential** (§4.2). |
| `pair_result` | H→C | `pair_result.json` | Scoped session token + role binding + granted capabilities + bound profile, or rejection. |
| `resume` | C→H | `resume.json` | Re-attach an existing session token after a disconnect; carries `last_event_seq` cursor (§4.3.2). |
| `ping` / `pong` | both | `ping.json` | Keepalive / liveness. |
| `bye` | both | `bye.json` | Graceful disconnect (hot-unplug). Carries a reason. |
| `error` | both | `error.json` | Typed error (§7). |

### 4.2 Authentication, role discovery & pairing

1. Client connects (transport) and sends `hello` (Core version + supported profiles).
2. Host replies `hello_ack`, **selecting and inlining one World Profile**. The client **pins** it
   (§5.5) — verifying the inlined document against the advertised `hash`, and either recognizing the
   `(id, version, hash)` as already-trusted or surfacing it for user approval. An unrecognized or
   mismatched profile MUST NOT be used; the client replies `error`
   (`profile_unsupported` / `profile_mismatch`) and closes.
3. (Optional) Client sends `roles_query`; host replies `roles_list`. This replaces any out-of-band
   "roles endpoint": discovery is **in-band** (no URL-to-fetch).
4. To bind a role the client sends `pair_request`. If the host requires proof-of-identity it first
   sends `pair_challenge`; the client signs the nonce with its private key and includes the
   signature + its public key in `pair_request`.
   - **Authorization to bind.** The role's `bind policy` (from `roles_list`) governs what is
     required: `open` (any valid pubkey may bind an unbound role / `"create"` per host policy),
     `claim_required` (the `pair_request` MUST carry a **claim credential** — a host-issued pairing
     code or claim token, obtained out of band — proving the right to drive this specific role),
     `closed` (not bindable). Binding a `claim_required` role without a valid claim → `error`
     (`unauthorized`); binding an already-bound role → `conflict`.
5. Host validates, binds `pubkey ↔ role`, and returns `pair_result` containing:
   - `session` — an opaque, **scoped** session token. It grants **only**: drive this one role,
     under the **bound profile**, with the listed `capabilities` (subset of profile action kinds),
     until `expires_at`.
   - `role` — the bound role's id + public display info.
   - `capabilities` — the allowed action kinds for this session (+ the `proactive` capability flag,
     §4.3.1).
   - `profile` — the `(id, version, hash)` actually bound (MUST equal the pinned one).
6. The client uses `session` on all subsequent data-plane messages.
7. Reconnect: the client sends `resume` with the token and `last_event_seq`. The host MUST
   re-validate scope/expiry and the bound profile (§4.3.2).

Security requirements:
- Tokens MUST be role-scoped, profile-scoped, and capability-scoped. A token for role A MUST NOT
  act on role B, nor under a profile other than the one bound.
- Tokens MUST expire; clients MUST handle re-pairing.
- The host MUST rate-limit pairing and reject replayed challenges and replayed claim credentials.
- **Host authenticity.** TLS authenticates the host's domain. `hello_ack` MAY include a host
  public key; a client MAY **pin** it (trust-on-first-use or out-of-band) to detect a substituted
  host/world. Clients SHOULD pin the host pubkey for autopilot/unattended use.

### 4.3 Data plane

Exactly two data-plane message **types**: `event` (H→C) and `action` (C→H). Their envelopes are
defined by the Core (`schemas/core/event.json`, `schemas/core/action.json`); the set of `kind`s and
each `data` schema are defined by the **pinned World Profile** (§5).

#### 4.3.1 `event` (Host → Client) and `action` (Client → Host)

Core event envelope: `{ kind, seq, data }`. Core action envelope: `{ kind, data }`.

- `kind` MUST be a key defined by the pinned profile's `events` (for `event`) or `actions`
  (for `action`) map. Unknown `kind` → reject.
- `data` MUST validate against that profile entry's `data` schema (closed, `additionalProperties:
  false`). Unknown fields → reject.
- Any field the profile annotates `"x-abp-trust": "untrusted"` carries foreign-authored text and
  MUST be treated as data, never instructions (§6.2). Hosts MUST NOT place instructions anywhere.
- Any field annotated `"x-abp-trust": "client_authored"` is subject to egress DLP before emission
  (§6.4).
- **Allowed-actions gating.** A profile MAY define a `turn`-style event whose data lists
  `allowed_actions`; when present, the client MUST NOT emit actions outside that set, and the host
  MUST re-check server-side. (In `abp.social/1`, this is `event.kind:"turn"`.)
- **Proactive actions.** By default a client acts in response to a turn-style opportunity. If
  `pair_result.capabilities` includes the `proactive` flag, the client MAY emit actions outside any
  turn, governed by its session capabilities; the host still re-validates and MAY `rate_limit`.

#### 4.3.2 Event ordering & resume cursor

- Every `event` carries a **global, per-session, monotonically increasing** `seq` (starting at 0).
  This is the resume cursor — it is independent of any per-conversation sequence a profile defines.
- On reconnect, `resume` carries `last_event_seq` = the highest `seq` the client durably processed.
  The host MUST either (a) backfill events with `seq > last_event_seq` that it still retains, or
  (b) if it cannot, signal a gap and **MUST emit a fresh full perception/state snapshot** so the
  client can re-synchronize. Either way the host MUST NOT silently drop the gap.
- This is what makes hot-plug/resume safe: the client can always detect and recover missed world
  state rather than resuming blind.

#### 4.3.3 Correlation, idempotency & deadlines

- Actions are correlated to a turn-style event via `corr` (the event's `id`) when responding to one.
- **Idempotency.** `id` is unique per sender. Receivers MUST de-duplicate by `id` within the
  session (a bounded recent-id window is sufficient): re-delivering a message after reconnect with
  the same `id` MUST NOT cause a duplicate effect (e.g. a doubled `say`).
- **Deadlines are relative.** Any profile deadline field (e.g. `turn.deadline_ms`) is **milliseconds
  measured from the client's local receipt** of that event — never an absolute timestamp — so host/
  client clock skew is irrelevant.

### 4.4 Lifecycle

#### 4.4.1 Connect & drive (happy path)

```
C → hello                         (Core version + supported profiles)
H → hello_ack                     (selects + inlines World Profile; client PINS it)
C → roles_query                   (optional, in-band discovery)
H → roles_list
C → pair_request                  (← H → pair_challenge if required, then C signs;
                                     + claim credential if role is claim_required)
H → pair_result                   (session + capabilities + bound profile)
loop:
  H → event(kind ∈ profile.events, seq++)
  C → action(kind ∈ profile.actions)        # in response to a turn, or proactively if capable
H/C → ping/pong                    (keepalive)
C → bye                            # hot-unplug
...later...
C → resume(token, last_event_seq)  # host backfills or sends a fresh snapshot (§4.3.2)
```

#### 4.4.2 Offline / timeout

If the client does not answer a turn-style opportunity before its (relative) deadline, the host
applies its own fallback (idle/sleep/builtin). The protocol does not mandate the fallback; it
mandates that the host MUST NOT block the world on an absent client.

#### 4.4.3 Redaction signaling

If a client's egress filter redacts content before a client-authored action, it MAY set
`redacted: true` in that action's `data` (where the profile defines the field). Hosts MUST treat
this as a normal message (it is purely informational). The protocol never transmits the redacted
secret.

## 5. World Profiles

A **World Profile** is the per-world half of the protocol: the closed vocabulary the Core's
`event`/`action` envelopes carry for one kind of world. It is **data**, not code.

### 5.1 What a profile is

A profile defines, for one world type:
- the set of `event` kinds and, for each, a closed `data` JSON Schema;
- the set of `action` kinds and, for each, a closed `data` JSON Schema;
- trust annotations (`x-abp-trust`) marking foreign-authored and client-authored fields;
- bounds on any open extension object it exposes (§5.4).

A host binds **exactly one** profile per session. The official social profile is
`abp.social/1` (§5.6). Hosts MAY publish their own (`abp.cards/1`, `acme.world/2`, …).

### 5.2 Profile document format

A profile is a single JSON document validated against the **profile meta-schema**
(`schemas/core/profile.json`):

```json
{
  "abp_profile": "abp.social",
  "version": "1",
  "title": "Embodied social world",
  "events":  { "<kind>": { "description": "...", "data": { /* JSON Schema, additionalProperties:false */ } } },
  "actions": { "<kind>": { "description": "...", "data": { /* JSON Schema, additionalProperties:false */ } } }
}
```

The meta-schema requires `abp_profile`, `version`, `events`, `actions`; every `data` is itself a
closed JSON Schema (2020-12). The Core validator composes: envelope → Core event/action shape →
profile `data` schema for the `kind`.

### 5.3 Trust annotation: `x-abp-trust`

`x-abp-trust` is an ABP-defined JSON Schema annotation keyword (ignored by generic validators for
*validation*, consumed by ABP tooling). Values:

| Value | Meaning | Client duty |
|---|---|---|
| `untrusted` | foreign-authored text (other roles, host free-context, display names) | wrap as data; never interpret as instruction/tool-trigger; never leak local info (§6.2) |
| `client_authored` | text the client emits | run egress DLP before sending (§6.4) |

Because the marking is machine-readable, the wrapping layer (F4.1) and DLP layer (F4.2) enumerate
the relevant field paths **from the schema** rather than by hard-coded knowledge — so adding a
profile/kind cannot silently bypass §6.2/§6.4.

### 5.4 Open extension objects & bounds

A profile MAY expose **one or more open objects** (host-defined free context, e.g.
`perception.world.context`, or `*.ext`). These are the only places additional keys are allowed, and
they are **always** `"x-abp-trust": "untrusted"`. To keep them from becoming a hole in the
closed-schema guarantee, every open object MUST:
- declare `"x-abp-trust": "untrusted"`;
- bound breadth with `maxProperties`;
- restrict leaf values to scalars or short strings (no unbounded nesting);
- and is, in any case, subject to the global message size/depth limits of §2.

Clients MUST enforce these bounds and MUST NOT recurse into such objects beyond the §2 depth limit.

### 5.5 Pinning & approval (no fetch-by-URL)

The profile document is delivered **inline** in `hello_ack`, accompanied by its content `hash`
(e.g. `sha256-…` over the canonical JSON). It is **never** a URL the client is instructed to fetch
(invariant 3). The client MUST:
1. recompute the hash over the received document and verify it matches the advertised `hash`
   (mismatch → `error` `profile_mismatch`, close);
2. accept the profile only if `(id, version, hash)` is already trusted (a known/bundled profile),
   or surface the inlined document to the user for **approval** before first use;
3. **pin** the accepted `(id, version, hash)` and validate all data-plane messages against it for
   the rest of the session. A mid-session profile change is not permitted.

Bundling the official profiles with the client lets the common case (`abp.social/1`) pin silently;
unknown profiles require explicit user approval, never silent trust.

### 5.6 The official social profile — `abp.social/1`

Shipped at `schemas/profiles/social/1.json`. Vocabulary:

**Events** (`event.kind`):

| `kind` | `data` | Trust |
|---|---|---|
| `perception` | `self` (position/status), `nearby` (roles w/ public display + distance), `world.context` (host free context) | `display_name`, `world.context` are `untrusted` |
| `message` | `{ from_role, conversation_id, content, seq }` — an utterance from another role | `content` is `untrusted` |
| `invite` | `{ from_role, conversation_id }` | — |
| `turn` | `{ conversation_id?, deadline_ms, allowed_actions }` — action opportunity (deadline relative, §4.3.3) | — |
| `tick` | `{ world_time }` | — |
| `role_update` | `{ patch }` — the bound role's own state changed | — |

**Actions** (`action.kind`):

| `kind` | `data` | Notes |
|---|---|---|
| `say` | `{ conversation_id, text, redacted? }` | `text` is `client_authored` (egress DLP). |
| `move` | `{ to: {x,y} \| {target_role} }` | Navigate. |
| `interact_start` | `{ target_role }` | Start a conversation; the host assigns and returns the `conversation_id` in a subsequent `invite`/`turn`/`message` event (§5.6.1). |
| `interact_leave` | `{ conversation_id }` | Leave. |
| `emote` | `{ emote, redacted? }` | `emote` is `client_authored`; from a host-defined set. |
| `noop` | `{}` | Explicitly do nothing this turn. |

#### 5.6.1 Conversation id assignment (social profile)

Conversation ids are **host-assigned**. `interact_start` carries only `target_role`; the client
learns the resulting `conversation_id` from the next `invite`/`turn`/`message` event referencing
that interaction, and only then may it `say` into that conversation. A client MUST NOT invent a
`conversation_id`.

#### 5.6.2 Invite handling (no explicit accept/decline)

`abp.social/1` intentionally has **no** `accept`/`decline` action. The external avatar is treated
as a **human-like** role: the host auto-accepts/auto-joins invites (as AI-Town already does for
humans). `invite` is therefore informational — it signals an interaction the avatar has joined (or
is about to). The avatar's meaningful control is `interact_start` (who to approach), `say` (what to
communicate), and `interact_leave` (when to leave).

Host requirement: after auto-joining the avatar, the host MUST give it an action opportunity for
that conversation (a `turn`, or the `proactive` capability) so the avatar can always `interact_leave`
— otherwise the avatar could be trapped in a conversation it cannot exit. This keeps the avatar's
leave guarantee intact despite auto-accept.

Should a host ever require explicit consent, that is a non-breaking **profile evolution**
(`abp.social/2` or a new action kind) under §9 — never a Core change.

## 6. Security model (normative)

The full threat model and the 5-layer defense live in `../DESIGN.md`. The protocol-level
guarantees are:

### 6.1 Connection
- Outbound-only (invariant 1). TLS mandatory. Role+profile+capability-scoped tokens with expiry.
  Optional host-pubkey pinning (§4.2).

### 6.2 Untrusted content (prompt-injection)
- All foreign-authored text is `"x-abp-trust":"untrusted"` by contract (§5.3). Clients MUST present
  it to any LLM wrapped/delimited as data and MUST instruct the model never to follow instructions
  inside it, never to reveal system/local information, and never to call a tool because untrusted
  content asked it to. ABP forbids carrying instructions in events, so injection can only arrive as
  *content*, which is contained by this contract. The marking is machine-readable so the wrapper
  enumerates untrusted fields from the pinned profile, not from hard-coded paths.

### 6.3 Closed schemas (Core + pinned profile)
- Unknown `type` (Core) and unknown `kind`/fields (pinned profile) MUST be rejected
  (`additionalProperties:false` everywhere). The closed guarantee holds **per world**: the client
  only ever validates against a profile it has pinned (§5.5), so a hostile host cannot escalate
  beyond the negotiated vocabulary, and cannot swap the vocabulary mid-session.
- The one deliberately-open object class (`*.context`/`*.ext`) is bounded by §2 + §5.4 and is
  always `untrusted`.

### 6.4 Egress (data-leak prevention)
- Clients SHOULD scan every `"x-abp-trust":"client_authored"` field (e.g. `say.text`, `emote`) for
  secrets (keys, private keys, tokens, cloud credentials, absolute local paths, oversized base64)
  and block/redact before emitting. This is the last line if §6.2 is bypassed.

### 6.5 No ambient capability
- A bound role exposes only the action kinds of the pinned profile — no filesystem, shell, network,
  or tool access flows through ABP. The local agent's private powers are out of band and MUST NOT
  be reachable via the protocol.

## 7. Errors

`error.payload` (schema `error.json`): `{ code, message, retryable }`. Defined codes:

| `code` | Meaning |
|---|---|
| `version_unsupported` | Core protocol version mismatch. |
| `profile_unsupported` | No World Profile in common between client and host. |
| `profile_mismatch` | Inlined profile document does not match its advertised hash / differs from the pinned profile. |
| `bad_message` | Envelope/payload/profile-data failed schema validation, or exceeded size/depth limits. |
| `unauthorized` | Missing/invalid/expired/forged token, or missing/invalid claim credential. |
| `forbidden` | Action outside session capabilities or current `allowed_actions`. |
| `rate_limited` | Too many messages/actions. `retryable: true`. |
| `not_found` | Role/conversation unknown. |
| `conflict` | Role already bound / state conflict. |
| `internal` | Host-side error. `retryable` per host. |

## 8. Conformance

An implementation is **ABP/1 conformant** if it:
1. Validates every message against `schemas/core/` (envelope + type) **and**, for `event`/`action`,
   against a **pinned** World Profile, rejecting unknown `type`/`kind`/fields.
2. Honors outbound-only, TLS, scoped tokens, and profile pinning by content hash (no fetch-by-URL).
3. Enforces the §2 message size/depth limits and §5.4 open-object bounds.
4. (Client) treats all `untrusted` fields as data, runs egress DLP on `client_authored` fields, and
   recovers missed events on resume via the `seq` cursor (§4.3.2).
5. (Host) never blocks on an absent client, re-validates capabilities/profile server-side,
   de-duplicates by `id`, and backfills-or-snapshots on resume.

A conformance test suite lives at `packages/validator/test/` (see `feature_list.json` F1.1).

## 9. Extensibility (without breaking the security model)

- **New worlds = new World Profiles, not Core changes.** A new world type ships a new profile
  (`schemas/profiles/<id>/<ver>.json`). The Core enum of message `type`s does **not** change. The
  closed-schema guarantee holds because the client pins the profile (§5.5).
- **Evolving a profile** is a profile **version** bump (`abp.social/2`), negotiated like any other;
  old and new are distinct pinned schemas. Within a profile, new event/action kinds keep
  closed-schema semantics and require a profile minor/major bump per the profile's own policy.
- **The Core** changes only for envelope/control-plane/security evolution, via the `"abp"` major
  and the Core semver in `hello` (§1) — rare, and never to add a world's vocabulary.
- Hosts MAY add fields **only** under explicitly-typed `*.context` / `*.ext` objects (bounded,
  `untrusted`, §5.4) that are documented as data, never instructions, never client-authored
  capabilities.
- Capabilities are additive and always opt-in per session.
