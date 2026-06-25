import { test } from "node:test";
import assert from "node:assert/strict";
import { WssTransport, Keypair, pair, parseInvite, PairingError } from "@agent-bridge/client";
import { ProfileLoader, loadBundledProfile, type JSONSchema } from "@agent-bridge/validator";
import { AbpHost } from "../src/index.ts";

const social = loadBundledProfile("social/1.json") as JSONSchema;
const SECRET = "test-host-invite-secret";

function mkHost(roles: { id: string; bind_policy?: "open" | "claim_required" | "closed" }[]) {
  return new AbpHost({
    profile: { id: "abp.social", version: "1", document: social },
    roles: () => roles,
    inviteSecret: SECRET,
  });
}
async function connect(port: number): Promise<WssTransport> {
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  t.on("error", () => {});
  await t.connect();
  return t;
}
const caps = (session: { capabilities: Iterable<string> }) => [...session.capabilities].sort();

test("mint -> parseInvite -> pair: one invite connects + binds a claim_required role", { timeout: 10000 }, async () => {
  const host = mkHost([{ id: "avatar-1", bind_policy: "claim_required" }]);
  const port = await host.listen(0);
  try {
    const token = host.mintInvite("avatar-1", { url: `ws://127.0.0.1:${port}` });
    const inv = parseInvite(token);
    assert.ok(inv, "invite should parse");
    assert.equal(inv!.target, "avatar-1");
    assert.equal(inv!.url, `ws://127.0.0.1:${port}`);
    const t = await connect(port);
    const { session } = await pair(t, Keypair.generate(), new ProfileLoader(), { target: inv!.target, claim: inv!.claim });
    assert.equal(session.role.id, "avatar-1");
    assert.ok(caps(session).length > 0, "should be granted capabilities");
    t.close();
  } finally {
    host.close();
  }
});

test("a claim_required role rejects binding WITHOUT an invite", { timeout: 10000 }, async () => {
  const host = mkHost([{ id: "avatar-1", bind_policy: "claim_required" }]);
  const port = await host.listen(0);
  try {
    const t = await connect(port);
    await assert.rejects(
      pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-1" }),
      (e: unknown) => e instanceof PairingError && /unauthorized|claim/i.test(String((e as PairingError).message)),
    );
    t.close();
  } finally {
    host.close();
  }
});

test("single-use: the same invite (jti) cannot be redeemed twice", { timeout: 10000 }, async () => {
  const host = mkHost([{ id: "avatar-1", bind_policy: "claim_required" }]);
  const port = await host.listen(0);
  try {
    const token = host.mintInvite("avatar-1", { url: `ws://127.0.0.1:${port}` });
    const inv = parseInvite(token)!;
    const t1 = await connect(port);
    await pair(t1, Keypair.generate(), new ProfileLoader(), { target: inv.target, claim: inv.claim });
    t1.close(); // releases the role binding so the 2nd attempt fails on the invite, not on `conflict`
    await new Promise((r) => setTimeout(r, 50));
    const t2 = await connect(port);
    await assert.rejects(
      pair(t2, Keypair.generate(), new ProfileLoader(), { target: inv.target, claim: inv.claim }),
      (e: unknown) => e instanceof PairingError && /unauthorized|used/i.test(String((e as PairingError).message)),
    );
    t2.close();
  } finally {
    host.close();
  }
});

test("least-privilege: caps in the invite are intersected with the role's grant", { timeout: 10000 }, async () => {
  const host = mkHost([{ id: "avatar-1", bind_policy: "claim_required" }]);
  const port = await host.listen(0);
  try {
    const token = host.mintInvite("avatar-1", { url: `ws://127.0.0.1:${port}`, caps: ["say"] });
    const inv = parseInvite(token)!;
    const t = await connect(port);
    const { session } = await pair(t, Keypair.generate(), new ProfileLoader(), { target: inv.target, claim: inv.claim });
    assert.deepEqual(caps(session), ["say"]);
    t.close();
  } finally {
    host.close();
  }
});

test("reject: expired invite", { timeout: 10000 }, async () => {
  const host = mkHost([{ id: "avatar-1", bind_policy: "claim_required" }]);
  const port = await host.listen(0);
  try {
    const token = host.mintInvite("avatar-1", { url: `ws://127.0.0.1:${port}`, ttlMs: -1 });
    const inv = parseInvite(token)!;
    const t = await connect(port);
    await assert.rejects(
      pair(t, Keypair.generate(), new ProfileLoader(), { target: inv.target, claim: inv.claim }),
      (e: unknown) => e instanceof PairingError && /unauthorized|expired/i.test(String((e as PairingError).message)),
    );
    t.close();
  } finally {
    host.close();
  }
});

test("reject: tampered invite token", { timeout: 10000 }, async () => {
  const host = mkHost([{ id: "avatar-1", bind_policy: "claim_required" }]);
  const port = await host.listen(0);
  try {
    const token = host.mintInvite("avatar-1", { url: `ws://127.0.0.1:${port}` });
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    const inv = parseInvite(tampered)!;
    const t = await connect(port);
    await assert.rejects(
      pair(t, Keypair.generate(), new ProfileLoader(), { target: inv.target, claim: inv.claim }),
      (e: unknown) => e instanceof PairingError,
    );
    t.close();
  } finally {
    host.close();
  }
});

test("regression: an open role still binds with no claim", { timeout: 10000 }, async () => {
  const host = mkHost([{ id: "avatar-1" }]); // open
  const port = await host.listen(0);
  try {
    const t = await connect(port);
    const { session } = await pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-1" });
    assert.equal(session.role.id, "avatar-1");
    t.close();
  } finally {
    host.close();
  }
});
