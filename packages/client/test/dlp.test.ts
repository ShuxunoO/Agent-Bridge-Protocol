import { test } from "node:test";
import assert from "node:assert/strict";
import { EgressFilter, RateLimiter, applyEgress } from "../src/index.ts";

const filter = new EgressFilter();

const SECRETS: Array<[string, string]> = [
  ["private_key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END"],
  ["aws_access_key_id", "key is AKIAIOSFODNN7EXAMPLE here"],
  ["openai_key", "token sk-abcdefghijklmnopqrstuvwxyz0123"],
  ["github_token", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
  ["slack_token", "xoxb-123456789012-abcdefABCDEF"],
  ["google_api_key", `AIza${"B".repeat(35)}`],
  ["jwt", "eyJhbGciOiJIUzI1NiInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w"],
  ["bearer_token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
  ["home_path", "see /Users/shuxun/secrets/key.pem for details"],
];

for (const [type, text] of SECRETS) {
  test(`detects ${type}`, () => {
    const findings = filter.inspect(text);
    assert.ok(findings.some((f) => f.type === type), `expected a ${type} finding in: ${text}`);
  });
}

test("clean prose produces no findings", () => {
  assert.deepEqual(filter.inspect("Hi Mira, nice to meet you at the fountain this afternoon."), []);
  assert.deepEqual(filter.inspect("I moved north and waved at the merchant."), []);
});

test("large base64 blob is flagged", () => {
  const blob = "A".repeat(600);
  assert.ok(filter.inspect(`data: ${blob}`).some((f) => f.type === "large_base64"));
});

test("oversize is flagged when maxLength set", () => {
  const f = new EgressFilter({ maxLength: 10 });
  assert.ok(f.inspect("this is longer than ten").some((x) => x.type === "oversize"));
  assert.deepEqual(f.inspect("short"), []);
});

test("redact replaces the secret span and preserves surrounding text", () => {
  const text = "my key is sk-abcdefghijklmnopqrstuvwxyz0123 ok";
  const out = filter.redact(text, filter.inspect(text));
  assert.match(out, /\[REDACTED:openai_key\]/);
  assert.doesNotMatch(out, /sk-abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(out, /^my key is .* ok$/);
});

test("applyEgress block mode flags an offending client-authored field", () => {
  const r = applyEgress(new EgressFilter({ mode: "block" }), ["/text"], { conversation_id: "c1", text: "here: ghp_0123456789abcdefghijklmnopqrstuvwxyz" });
  assert.equal(r.blocked, true);
  assert.ok(r.findings.some((f) => f.type === "github_token"));
});

test("applyEgress redact mode rewrites the field, leaves clean fields alone", () => {
  const r = applyEgress(new EgressFilter({ mode: "redact" }), ["/text"], { conversation_id: "c1", text: "psst AKIAIOSFODNN7EXAMPLE" });
  assert.equal(r.blocked, false);
  assert.equal(r.redacted, true);
  assert.match(r.data.text as string, /\[REDACTED:aws_access_key_id\]/);
});

test("applyEgress passes clean data unchanged", () => {
  const data = { conversation_id: "c1", text: "hello there" };
  const r = applyEgress(filter, ["/text"], data);
  assert.equal(r.blocked, false);
  assert.equal(r.redacted, false);
  assert.equal(r.data, data);
});

test("RateLimiter enforces a window budget", () => {
  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.allow(0), true);
  assert.equal(rl.allow(100), true);
  assert.equal(rl.allow(200), false); // 3rd within window
  assert.equal(rl.allow(1300), true); // window slid past the first two
});
