import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreValidator, MAX_MESSAGE_BYTES } from "../src/index.ts";

const v = new CoreValidator();

/** Build a Core envelope around a payload. */
function env(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return { abp: "1", type, id: "01J9ABCDEF", ts: 1718600000000, payload, ...extra };
}

const SESSION = { session: "sess_abc" };

// ---- valid messages pass --------------------------------------------------

test("valid hello passes", () => {
  const r = v.validateMessage(
    env("hello", { abp_core: "1.0.0", profiles: [{ id: "abp.social", version: "1" }], bindings: ["wss"] }),
  );
  assert.deepEqual(r, { ok: true, type: "hello" });
});

test("valid hello_ack with inlined profile passes", () => {
  const r = v.validateMessage(
    env("hello_ack", {
      abp_core: "1.0.0",
      profile: { id: "abp.social", version: "1", hash: "sha256-AAAA", document: { abp_profile: "abp.social" } },
      auth_methods: ["signature", "claim"],
    }),
  );
  assert.equal(r.ok, true);
});

test("valid roles_list passes (with untrusted display_name)", () => {
  const r = v.validateMessage(
    env("roles_list", { roles: [{ id: "r1", display_name: "Alice", bind_policy: "open", available: true }] }),
  );
  assert.equal(r.ok, true);
});

test("valid pair_result passes", () => {
  const r = v.validateMessage(
    env("pair_result", {
      session: "sess_abc",
      role: { id: "r1" },
      capabilities: ["say", "move", "proactive"],
      profile: { id: "abp.social", version: "1", hash: "sha256-AAAA" },
      expires_at: 1718600000000,
    }),
  );
  assert.equal(r.ok, true);
});

test("valid event (data-plane) with session passes at Core layer", () => {
  const r = v.validateMessage(
    env("event", { kind: "perception", seq: 0, data: { self: { position: { x: 1, y: 2 }, status: "idle" }, nearby: [] } }, SESSION),
  );
  assert.deepEqual(r, { ok: true, type: "event" });
});

test("valid action (data-plane) with session passes at Core layer", () => {
  const r = v.validateMessage(
    env("action", { kind: "say", data: { conversation_id: "c1", text: "hi" } }, SESSION),
  );
  assert.equal(r.ok, true);
});

test("ping and pong share schema and pass", () => {
  assert.equal(v.validateMessage(env("ping", { nonce: "n1" })).ok, true);
  assert.equal(v.validateMessage(env("pong", { nonce: "n1" })).ok, true);
});

test("valid error passes; valid resume with session passes", () => {
  assert.equal(v.validateMessage(env("error", { code: "rate_limited", message: "slow down", retryable: true })).ok, true);
  assert.equal(v.validateMessage(env("resume", { last_event_seq: 42 }, SESSION)).ok, true);
});

// ---- closed-schema rejections ---------------------------------------------

test("unknown message type is rejected", () => {
  const r = v.validateMessage(env("teleport", {}));
  assert.equal(r.ok, false);
});

test("unknown envelope field is rejected (additionalProperties:false)", () => {
  const r = v.validateMessage({ ...env("ping", {}), spoof: true });
  assert.equal(r.ok, false);
});

test("unknown payload field is rejected", () => {
  const r = v.validateMessage(
    env("hello", { abp_core: "1", profiles: [{ id: "x", version: "1" }], bindings: ["wss"], extra: 1 }),
  );
  assert.equal(r.ok, false);
});

test("wrong protocol version is rejected", () => {
  const r = v.validateMessage({ ...env("ping", {}), abp: "2" });
  assert.equal(r.ok, false);
});

test("bad enum value (auth_methods) is rejected", () => {
  const r = v.validateMessage(
    env("hello_ack", {
      abp_core: "1",
      profile: { id: "a", version: "1", hash: "sha256-AAAA", document: {} },
      auth_methods: ["telepathy"],
    }),
  );
  assert.equal(r.ok, false);
});

// ---- data-plane requires session ------------------------------------------

test("event without session is rejected", () => {
  const r = v.validateMessage(env("event", { kind: "tick", seq: 1, data: { world_time: 5 } }));
  assert.equal(r.ok, false);
});

test("action without session is rejected", () => {
  const r = v.validateMessage(env("action", { kind: "noop", data: {} }));
  assert.equal(r.ok, false);
});

test("resume without session is rejected", () => {
  const r = v.validateMessage(env("resume", { last_event_seq: 1 }));
  assert.equal(r.ok, false);
});

// ---- Core data-plane envelope shape ---------------------------------------

test("event missing seq is rejected (Core requires it)", () => {
  const r = v.validateMessage(env("event", { kind: "tick", data: { world_time: 5 } }, SESSION));
  assert.equal(r.ok, false);
});

test("action missing data is rejected", () => {
  const r = v.validateMessage(env("action", { kind: "noop" }, SESSION));
  assert.equal(r.ok, false);
});

test("bye requires reason", () => {
  assert.equal(v.validateMessage(env("bye", {})).ok, false);
  assert.equal(v.validateMessage(env("bye", { reason: "done" })).ok, true);
});

// ---- envelope structural -----------------------------------------------

test("non-object message is rejected", () => {
  assert.equal(v.validateMessage(42).ok, false);
  assert.equal(v.validateMessage(null).ok, false);
  assert.equal(v.validateMessage([]).ok, false);
});

test("missing required envelope field (id) is rejected", () => {
  const m = env("ping", {});
  delete (m as Record<string, unknown>).id;
  assert.equal(v.validateMessage(m).ok, false);
});

// ---- transport limits (§2) -------------------------------------------------

test("oversize encoded message is rejected before parsing", () => {
  const big = "x".repeat(MAX_MESSAGE_BYTES + 1);
  const r = v.validateEncoded(JSON.stringify(env("bye", { reason: big })));
  assert.equal(r.ok, false);
  assert.match((r as { errors: string[] }).errors[0], /size .* exceeds/);
});

test("non-JSON encoded message is rejected", () => {
  const r = v.validateEncoded("{not json");
  assert.equal(r.ok, false);
});

test("excessive nesting depth is rejected", () => {
  let nested: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) nested = { a: nested };
  const r = v.validateMessage(env("ping", { deep: nested }));
  assert.equal(r.ok, false);
  assert.match((r as { errors: string[] }).errors[0], /depth/);
});

test("valid encoded round-trip passes", () => {
  const r = v.validateEncoded(JSON.stringify(env("ping", { nonce: "n" })));
  assert.deepEqual(r, { ok: true, type: "ping" });
});
