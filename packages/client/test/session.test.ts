import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/index.ts";

function mkSession(caps: string[], expiresAt = 2_000_000_000_000) {
  return new Session({
    token: "sess_tok",
    role: { id: "avatar-1", display_name: "Bo" },
    capabilities: caps,
    profile: { id: "abp.social", version: "1", hash: "sha256-AAAA" },
    expiresAt,
  });
}

test("can() enforces capability scope", () => {
  const s = mkSession(["say", "move", "noop"]);
  assert.equal(s.can("say"), true);
  assert.equal(s.can("move"), true);
  assert.equal(s.can("emote"), false);
});

test("assertCan throws for out-of-scope action", () => {
  const s = mkSession(["say"]);
  assert.doesNotThrow(() => s.assertCan("say"));
  assert.throws(() => s.assertCan("move"), /forbidden/);
});

test("proactive flag reflects the proactive capability", () => {
  assert.equal(mkSession(["say"]).proactive, false);
  assert.equal(mkSession(["say", "proactive"]).proactive, true);
});

test("isExpired compares against expires_at", () => {
  const s = mkSession(["say"], 1000);
  assert.equal(s.isExpired(999), false);
  assert.equal(s.isExpired(1000), true);
  assert.equal(s.isExpired(1001), true);
});

test("authHeader carries the bearer token", () => {
  assert.deepEqual(mkSession(["say"]).authHeader(), { Authorization: "Bearer sess_tok" });
});

test("capabilities are exposed read-only and reflect the grant", () => {
  const s = mkSession(["say", "noop"]);
  assert.deepEqual([...s.capabilities].sort(), ["noop", "say"]);
});
