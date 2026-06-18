import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { statSync, rmSync } from "node:fs";
import { Keypair, verifySignature } from "../src/index.ts";

test("sign/verify round-trips a nonce", () => {
  const kp = Keypair.generate();
  const nonce = "challenge-nonce-123456";
  const sig = kp.sign(nonce);
  assert.equal(verifySignature(kp.publicKey, nonce, sig), true);
});

test("forged signature is rejected (tampered signature)", () => {
  const kp = Keypair.generate();
  const nonce = "challenge-nonce-123456";
  const sig = kp.sign(nonce);
  const tampered = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  assert.equal(verifySignature(kp.publicKey, nonce, tampered), false);
});

test("signature over a different nonce does not verify (replay/forgery)", () => {
  const kp = Keypair.generate();
  const sigOverOther = kp.sign("some-other-nonce-9999");
  assert.equal(verifySignature(kp.publicKey, "challenge-nonce-123456", sigOverOther), false);
});

test("a different key's signature does not verify (impersonation)", () => {
  const a = Keypair.generate();
  const b = Keypair.generate();
  const nonce = "challenge-nonce-123456";
  assert.equal(verifySignature(b.publicKey, nonce, a.sign(nonce)), false);
});

test("malformed public key / signature -> false, never throws", () => {
  assert.equal(verifySignature("not-a-key", "x", "y"), false);
});

test("fromPem preserves identity and signing", () => {
  const kp = Keypair.generate();
  const loaded = Keypair.fromPem(kp.privateKeyPem());
  assert.equal(loaded.publicKey, kp.publicKey);
  assert.equal(verifySignature(loaded.publicKey, "n12345678", loaded.sign("n12345678")), true);
});

test("loadOrCreate persists and reloads the same key (0600)", () => {
  const dir = join(tmpdir(), `abp-key-${randomUUID()}`);
  const path = join(dir, "client.pem");
  try {
    const created = Keypair.loadOrCreate(path);
    const reloaded = Keypair.loadOrCreate(path);
    assert.equal(reloaded.publicKey, created.publicKey);
    assert.equal((statSync(path).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
