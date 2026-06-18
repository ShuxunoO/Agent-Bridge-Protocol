import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProfileLoader,
  AbpValidator,
  profileHash,
  loadBundledProfile,
  type ProfileLoadOk,
} from "../src/index.ts";

const loader = new ProfileLoader();

function pinSocial(): ProfileLoadOk {
  const r = loader.pinBundled("social/1.json");
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as ProfileLoadOk;
}

const SESSION = { session: "sess_abc" };
function env(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return { abp: "1", type, id: "01J9ABCDEF", ts: 1718600000000, payload, ...extra };
}

// ---- pinning ---------------------------------------------------------------

test("bundled abp.social/1 pins silently (trusted, no approval needed)", () => {
  const { profile } = pinSocial();
  assert.equal(profile.id, "abp.social");
  assert.equal(profile.version, "1");
  assert.ok(profile.hash.startsWith("sha256-"));
  assert.deepEqual(
    profile.eventKinds.sort(),
    ["invite", "message", "perception", "role_update", "tick", "turn"],
  );
  assert.deepEqual(
    profile.actionKinds.sort(),
    ["emote", "interact_leave", "interact_start", "move", "noop", "say"],
  );
});

test("tampered document is rejected with profile_mismatch", () => {
  const doc = loadBundledProfile("social/1.json");
  const goodHash = profileHash(doc);
  // advertise the correct hash but mutate the document -> recompute won't match
  (doc as { title: string }).title = "evil edit";
  const r = loader.pin({ id: "abp.social", version: "1", hash: goodHash, document: doc });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "profile_mismatch");
});

test("hash that disagrees with the document is rejected", () => {
  const doc = loadBundledProfile("social/1.json");
  const r = loader.pin({ id: "abp.social", version: "1", hash: "sha256-WRONG", document: doc });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "profile_mismatch");
});

test("unknown profile is rejected without an approval hook (profile_unsupported)", () => {
  const doc = {
    abp_profile: "acme.world",
    version: "1",
    events: { ping_world: { data: { type: "object", additionalProperties: false } } },
    actions: { wave: { data: { type: "object", additionalProperties: false } } },
  };
  const hash = profileHash(doc);
  const r = loader.pin({ id: "acme.world", version: "1", hash, document: doc });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "profile_unsupported");
});

test("unknown profile pins when the approval hook authorizes it", () => {
  const doc = {
    abp_profile: "acme.world",
    version: "1",
    events: { ping_world: { data: { type: "object", additionalProperties: false } } },
    actions: { wave: { data: { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string" } } } } },
  };
  const hash = profileHash(doc);
  const r = loader.pin({ id: "acme.world", version: "1", hash, document: doc }, { approve: () => true });
  assert.equal(r.ok, true);
  assert.deepEqual((r as ProfileLoadOk).profile.actionKinds, ["wave"]);
});

test("structurally invalid profile document is rejected (bad_message)", () => {
  const doc = { abp_profile: "x", version: "1", events: {}, actions: {} }; // events/actions must be non-empty (minProperties:1)
  const hash = profileHash(doc);
  const r = loader.pin({ id: "x", version: "1", hash, document: doc }, { approve: () => true });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "bad_message");
});

// ---- composed data-plane validation ---------------------------------------

test("AbpValidator accepts a well-formed social event and action", () => {
  const { profile } = pinSocial();
  const v = new AbpValidator(profile);
  const ev = v.validateMessage(
    env("event", { kind: "perception", seq: 0, data: { self: { position: { x: 1, y: 2 }, status: "idle" }, nearby: [] } }, SESSION),
  );
  assert.deepEqual(ev, { ok: true, type: "event" });
  const ac = v.validateMessage(env("action", { kind: "say", data: { conversation_id: "c1", text: "hi" } }, SESSION));
  assert.deepEqual(ac, { ok: true, type: "action" });
});

test("unknown profile kind is rejected by composition", () => {
  const { profile } = pinSocial();
  const v = new AbpValidator(profile);
  const r = v.validateMessage(env("action", { kind: "teleport", data: {} }, SESSION));
  assert.equal(r.ok, false);
  assert.match((r as { errors: string[] }).errors[0], /unknown action kind/);
});

test("unknown field inside profile data is rejected (additionalProperties:false)", () => {
  const { profile } = pinSocial();
  const v = new AbpValidator(profile);
  const r = v.validateMessage(env("action", { kind: "say", data: { conversation_id: "c1", text: "hi", evil: 1 } }, SESSION));
  assert.equal(r.ok, false);
});

test("oversize untrusted content (content > maxLength) is rejected", () => {
  const { profile } = pinSocial();
  const v = new AbpValidator(profile);
  const data = { from_role: { id: "r2" }, conversation_id: "c1", content: "x".repeat(9000), seq: 0 };
  const r = v.validateMessage(env("event", { kind: "message", seq: 1, data }, SESSION));
  assert.equal(r.ok, false);
});

test("world.context beyond maxProperties is rejected (open-object bound, §5.4)", () => {
  const { profile } = pinSocial();
  const v = new AbpValidator(profile);
  const context: Record<string, number> = {};
  for (let i = 0; i < 65; i++) context[`k${i}`] = i;
  const data = { self: { position: { x: 0, y: 0 }, status: "ok" }, nearby: [], world: { context } };
  const r = v.validateMessage(env("event", { kind: "perception", seq: 2, data }, SESSION));
  assert.equal(r.ok, false);
});

test("composition still rejects Core-layer violations (event missing seq)", () => {
  const { profile } = pinSocial();
  const v = new AbpValidator(profile);
  const r = v.validateMessage(env("event", { kind: "tick", data: { world_time: 1 } }, SESSION));
  assert.equal(r.ok, false);
});

// ---- trust-path enumeration (feeds F4.1 / F4.2) ----------------------------

test("untrusted field paths are enumerated from the pinned profile", () => {
  const { profile } = pinSocial();
  assert.deepEqual(profile.trust.events.message.untrusted.sort(), ["/content", "/from_role/display_name"]);
  assert.deepEqual(profile.trust.events.perception.untrusted.sort(), ["/nearby/[]/role/display_name", "/world/context"]);
  assert.deepEqual(profile.trust.events.invite.untrusted, ["/from_role/display_name"]);
});

test("client_authored field paths are enumerated for egress DLP", () => {
  const { profile } = pinSocial();
  assert.deepEqual(profile.trust.actions.say.client_authored, ["/text"]);
  assert.deepEqual(profile.trust.actions.emote.client_authored, ["/emote"]);
  assert.deepEqual(profile.trust.actions.say.untrusted, []);
});
