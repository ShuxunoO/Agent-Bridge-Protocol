import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileLoader, AbpValidator, type ProfileLoadOk } from "../src/index.ts";

const loader = new ProfileLoader();
function pinA2A(): ProfileLoadOk {
  const r = loader.pinBundled("a2a/1.json");
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as ProfileLoadOk;
}

const SESSION = { session: "sess_a2a" };
function env(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return { abp: "1", type, id: "01J9A2A001", ts: 1718600000000, payload, ...extra };
}

test("bundled abp.a2a/1 pins silently with the expected vocabulary", () => {
  const { profile } = pinA2A();
  assert.equal(profile.id, "abp.a2a");
  assert.equal(profile.version, "1");
  assert.ok(profile.hash.startsWith("sha256-"));
  assert.deepEqual(profile.eventKinds.sort(), ["invite", "message", "presence", "roster"]);
  assert.deepEqual(profile.actionKinds.sort(), ["create_room", "dm", "join", "leave", "roster", "send"]);
});

test("accepts a well-formed message event and the send / dm / join actions", () => {
  const { profile } = pinA2A();
  const v = new AbpValidator(profile);
  const msg = v.validateMessage(
    env("event", { kind: "message", seq: 3, data: { room: "lobby", from: { id: "agent-b", display_name: "Bee" }, content: "hello", seq: 7 } }, SESSION),
  );
  assert.equal(msg.ok, true, JSON.stringify(msg));
  assert.equal(v.validateMessage(env("action", { kind: "send", data: { room: "lobby", content: "hi all" } }, SESSION)).ok, true);
  assert.equal(v.validateMessage(env("action", { kind: "dm", data: { to: "agent-b", content: "psst" } }, SESSION)).ok, true);
  assert.equal(v.validateMessage(env("action", { kind: "join", data: { room: "lobby" } }, SESSION)).ok, true);
  assert.equal(v.validateMessage(env("action", { kind: "create_room", data: { room: "team", policy: "invite" } }, SESSION)).ok, true);
});

test("rejects an unknown action kind", () => {
  const { profile } = pinA2A();
  const r = new AbpValidator(profile).validateMessage(env("action", { kind: "kick", data: { room: "lobby" } }, SESSION));
  assert.equal(r.ok, false);
});

test("rejects an unknown field inside send (additionalProperties:false)", () => {
  const { profile } = pinA2A();
  const r = new AbpValidator(profile).validateMessage(
    env("action", { kind: "send", data: { room: "lobby", content: "hi", broadcast: true } }, SESSION),
  );
  assert.equal(r.ok, false);
});

test("rejects oversize message content (> maxLength)", () => {
  const { profile } = pinA2A();
  const big = "x".repeat(8193);
  const r = new AbpValidator(profile).validateMessage(
    env("event", { kind: "message", seq: 1, data: { room: "lobby", from: { id: "a" }, content: big, seq: 1 } }, SESSION),
  );
  assert.equal(r.ok, false);
});

test("rejects a bad enum (create_room.policy)", () => {
  const { profile } = pinA2A();
  const r = new AbpValidator(profile).validateMessage(
    env("action", { kind: "create_room", data: { room: "team", policy: "secret" } }, SESSION),
  );
  assert.equal(r.ok, false);
});

test("trust annotations: peer content/names are untrusted; outbound content is DLP-scoped", () => {
  const { profile } = pinA2A();
  // Incoming message: the peer's content + display_name must be marked untrusted (L2 wrapping).
  assert.ok(profile.trust.events.message.untrusted.includes("/content"));
  assert.ok(profile.trust.events.message.untrusted.includes("/from/display_name"));
  // Outgoing send: our own content is client_authored (L3 egress DLP runs on it).
  assert.ok(profile.trust.actions.send.client_authored.includes("/content"));
  assert.ok(profile.trust.actions.dm.client_authored.includes("/content"));
});
