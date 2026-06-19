import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Verify an Ed25519 signature against a raw base64url public key (the wire format the client
 * sends in pair_request.pubkey). Returns false on any malformed input. Reimplemented here so the
 * host package does not depend on the client package.
 */
export function verifyEd25519(publicKeyB64: string, message: string | Buffer, signatureB64: string): boolean {
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64 }, format: "jwk" });
    const data = typeof message === "string" ? Buffer.from(message, "utf8") : message;
    return cryptoVerify(null, data, pub, Buffer.from(signatureB64, "base64url"));
  } catch {
    return false;
  }
}
