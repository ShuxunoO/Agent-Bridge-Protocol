import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPersonaProfile, buildPersonaPrompt, LOCKED_PERSONA_PROMPT } from "../src/index.ts";

test("a valid curated profile loads", () => {
  const r = loadPersonaProfile({
    displayName: "Lucky",
    backstory: "A cheerful traveler who loves cheese and the history of science.",
    traits: ["curious", "patient", "brave"],
    goals: ["hear all the gossip", "make a new friend"],
    speakingStyle: "warm, articulate, a little nerdy",
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.profile.displayName, "Lucky");
    assert.equal(r.profile.traits?.length, 3);
  }
});

test("displayName is required", () => {
  const r = loadPersonaProfile({ backstory: "no name" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /displayName/.test(e)));
});

test("unknown fields are rejected (closed shape)", () => {
  const r = loadPersonaProfile({ displayName: "X", secretApiKey: "nope" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /unknown field "secretApiKey"/.test(e)));
});

test("oversize and wrong-typed fields are rejected", () => {
  const big = "a".repeat(5000);
  const r = loadPersonaProfile({ displayName: "X", backstory: big });
  assert.equal(r.ok, false);
  const r2 = loadPersonaProfile({ displayName: "X", traits: "should-be-array" });
  assert.equal(r2.ok, false);
  const r3 = loadPersonaProfile({ displayName: "X", traits: Array(40).fill("t") });
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.ok(r3.errors.some((e) => /traits exceeds/.test(e)));
});

test("a profile containing a secret-like value is rejected (curated only)", () => {
  const r = loadPersonaProfile({
    displayName: "Leaky",
    backstory: "my key is sk-AAAAAAAAAAAAAAAAAAAAAAAA do not share",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /secret-like/.test(e)));

  const r2 = loadPersonaProfile({ displayName: "Pathy", backstory: "I live at /Users/victim/.ssh/id_rsa" });
  assert.equal(r2.ok, false);
});

test("buildPersonaPrompt composes a loaded profile after the locked prompt", () => {
  const r = loadPersonaProfile({ displayName: "Lucky", traits: ["curious"] });
  assert.ok(r.ok);
  if (r.ok) {
    const prompt = buildPersonaPrompt(r.profile);
    assert.ok(prompt.startsWith(LOCKED_PERSONA_PROMPT));
    assert.match(prompt, /Name: Lucky/);
    assert.match(prompt, /Traits: curious/);
  }
});

test("non-object input is rejected", () => {
  assert.equal(loadPersonaProfile(null).ok, false);
  assert.equal(loadPersonaProfile("string").ok, false);
  assert.equal(loadPersonaProfile([]).ok, false);
});
