import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Raw 32-byte Ed25519 public key as base64url (the JWK `x` parameter). */
function rawPublicKey(pub: KeyObject): string {
  const jwk = pub.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 public key");
  return jwk.x;
}

/**
 * The client's identity keypair (Ed25519). The public key is sent in pair_request;
 * the private key signs the host's pairing challenge (§4.2). Private key never leaves
 * the machine; only the raw public key and per-nonce signatures are transmitted.
 */
export class Keypair {
  readonly #priv: KeyObject;
  /** Raw Ed25519 public key, base64url — the value sent as pair_request.pubkey. */
  readonly publicKey: string;

  private constructor(priv: KeyObject) {
    this.#priv = priv;
    this.publicKey = rawPublicKey(createPublicKey(priv));
  }

  /** Generate a fresh Ed25519 keypair. */
  static generate(): Keypair {
    const { privateKey } = generateKeyPairSync("ed25519");
    return new Keypair(privateKey);
  }

  /** Load a keypair from a PKCS#8 PEM private key. */
  static fromPem(pem: string): Keypair {
    return new Keypair(createPrivateKey(pem));
  }

  /** Load the keypair at `path`, or generate + persist one (PKCS#8 PEM, 0600). */
  static loadOrCreate(path: string): Keypair {
    if (existsSync(path)) return Keypair.fromPem(readFileSync(path, "utf8"));
    const kp = Keypair.generate();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, kp.privateKeyPem(), { mode: 0o600 });
    return kp;
  }

  /** Sign a message (the pairing nonce); returns a base64url Ed25519 signature. */
  sign(message: string | Buffer): string {
    const data = typeof message === "string" ? Buffer.from(message, "utf8") : message;
    return cryptoSign(null, data, this.#priv).toString("base64url");
  }

  /** Export the private key as PKCS#8 PEM (for persistence). */
  privateKeyPem(): string {
    return this.#priv.export({ format: "pem", type: "pkcs8" }) as string;
  }
}

/**
 * Verify an Ed25519 signature against a raw base64url public key. Used by hosts (and
 * tests) to validate pair_request signatures; returns false on any malformed input.
 */
export function verifySignature(publicKeyB64: string, message: string | Buffer, signatureB64: string): boolean {
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64 }, format: "jwk" });
    const data = typeof message === "string" ? Buffer.from(message, "utf8") : message;
    return cryptoVerify(null, data, pub, Buffer.from(signatureB64, "base64url"));
  } catch {
    return false;
  }
}
