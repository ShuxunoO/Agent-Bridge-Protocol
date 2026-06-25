import { test } from "node:test";
import assert from "node:assert/strict";
import { signInvite, decodeInvite, verifyInvite, type InvitePayload } from "../src/invite.ts";

const SECRET = "host-secret-do-not-share";
const PROFILE = { id: "abp.social", version: "1" };
const future = () => Date.now() + 60_000;

function payload(over: Partial<InvitePayload> = {}): InvitePayload {
  return {
    v: 1,
    url: "wss://town.example/abp",
    profile: PROFILE,
    role: "a:1",
    exp: future(),
    jti: "jti-123",
    ...over,
  };
}

test("happy path: sign -> verify ok, and the client can decode url/role without the secret", () => {
  const token = signInvite(payload(), SECRET);
  assert.ok(token.startsWith("abp1."));
  // Host verifies.
  const v = verifyInvite(token, SECRET, { expectedRole: "a:1", expectedProfile: PROFILE });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.payload.role, "a:1");
  // Client decodes (no secret) to learn where to connect.
  const d = decodeInvite(token);
  assert.ok(d);
  assert.equal(d!.payload.url, "wss://town.example/abp");
  assert.equal(d!.payload.role, "a:1");
});

test("reject: tampered payload (signature no longer matches)", () => {
  const token = signInvite(payload({ role: "a:1" }), SECRET);
  const [p, body, sig] = token.split(".");
  // Forge the payload to claim a different role, keep the old signature.
  const forgedBody = Buffer.from(
    JSON.stringify(payload({ role: "a:9" })),
    "utf8",
  ).toString("base64url").replace(/=+$/, "");
  const forged = `${p}.${forgedBody}.${sig}`;
  const v = verifyInvite(forged, SECRET);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, "bad_signature");
});

test("reject: tampered signature", () => {
  const token = signInvite(payload(), SECRET);
  const [p, body] = token.split(".");
  const v = verifyInvite(`${p}.${body}.AAAAAAAAAAAAAAAAAAAAAAAA`, SECRET);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, "bad_signature");
});

test("reject: wrong secret", () => {
  const token = signInvite(payload(), SECRET);
  const v = verifyInvite(token, "different-secret");
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, "bad_signature");
});

test("reject: expired", () => {
  const token = signInvite(payload({ exp: Date.now() - 1 }), SECRET);
  const v = verifyInvite(token, SECRET);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, "expired");
});

test("reject: role mismatch (binding a different role than the invite authorizes)", () => {
  const token = signInvite(payload({ role: "a:1" }), SECRET);
  const v = verifyInvite(token, SECRET, { expectedRole: "a:3" });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, "role_mismatch");
});

test("accept: wildcard role binds any target", () => {
  const token = signInvite(payload({ role: "*" }), SECRET);
  const v = verifyInvite(token, SECRET, { expectedRole: "a:7" });
  assert.equal(v.ok, true);
});

test("reject: profile mismatch", () => {
  const token = signInvite(payload(), SECRET);
  const v = verifyInvite(token, SECRET, { expectedProfile: { id: "abp.social", version: "2" } });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, "profile_mismatch");
});

test("reject: malformed tokens (no throw, returns malformed)", () => {
  for (const bad of ["", "nope", "abp1.only-two", "xxx.aaa.bbb", "abp1..", "abp1.!!!.zzz"]) {
    const v = verifyInvite(bad, SECRET);
    assert.equal(v.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    if (!v.ok) assert.ok(v.code === "malformed" || v.code === "bad_signature");
    assert.equal(decodeInvite(bad), null);
  }
});
