import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ABP Invite credentials (SPEC §4.2.1). A standard, self-describing format for the opaque `claim`
 * carried in pair_request, so a host can mint ONE pasteable credential and any ABP client can redeem
 * it with no other config. Token form: `abp1.<b64url(payload)>.<b64url(sig)>`, where sig is an
 * HMAC-SHA-256 over the exact `b64url(payload)` signing input keyed by a host secret. The issuing
 * host both mints and verifies (symmetric — no key distribution). This is NOT a wire change: the
 * whole token is just a `claim` string the host validates at bind.
 */

export const INVITE_PREFIX = "abp1";

/** The signed contents of an Invite. */
export type InvitePayload = {
  v: 1;
  /** Host transport URL the client should connect to (wss://…; ws:// loopback only). */
  url: string;
  /** World profile the invite is bound to; the client pins it as usual (§5.5). */
  profile: { id: string; version: string };
  /** Role id this invite authorizes binding. `"*"` = any free role (host policy permitting). */
  role: string;
  /** Optional least-privilege subset of action kinds to grant. */
  caps?: string[];
  /** Expiry (epoch ms). Required — an Invite MUST expire. */
  exp: number;
  /** Unique credential id — single/limited use + replay rejection. */
  jti: string;
};

export type InviteVerifyOk = { ok: true; payload: InvitePayload };
export type InviteVerifyError = {
  ok: false;
  code: "malformed" | "bad_signature" | "expired" | "role_mismatch" | "profile_mismatch";
  message: string;
};
export type InviteVerifyResult = InviteVerifyOk | InviteVerifyError;

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToString(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}
function mac(signingInput: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(signingInput, "utf8").digest();
}

/** Mint an Invite token: sign the payload with the host secret. Used by the host's mintInvite. */
export function signInvite(payload: InvitePayload, secret: string): string {
  const signingInput = `${INVITE_PREFIX}.${b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"))}`;
  const sig = b64urlEncode(mac(signingInput, secret));
  return `${signingInput}.${sig}`;
}

/**
 * Parse the token WITHOUT verifying the signature (the client side: it just needs url/role/profile
 * to connect; only the host's bind verification is authoritative). Returns null if malformed.
 */
export function decodeInvite(token: string): { payload: InvitePayload; signingInput: string; sig: string } | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== INVITE_PREFIX) return null;
  const [, payloadB64, sig] = parts;
  let payload: InvitePayload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.url !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.jti !== "string" ||
    !payload.profile ||
    typeof payload.profile.id !== "string" ||
    typeof payload.profile.version !== "string"
  ) {
    return null;
  }
  return { payload, signingInput: `${INVITE_PREFIX}.${payloadB64}`, sig };
}

/**
 * Verify an Invite at bind time (host side). Checks MAC, expiry, and (optionally) that the role and
 * profile match what is being bound. Stateless: single-use (jti) + revocation are enforced by the
 * caller (see @agent-bridge/host inviteClaimVerifier). Never throws.
 */
export function verifyInvite(
  token: string,
  secret: string,
  opts: { now?: number; expectedRole?: string; expectedProfile?: { id: string; version: string } } = {},
): InviteVerifyResult {
  const decoded = decodeInvite(token);
  if (!decoded) return { ok: false, code: "malformed", message: "not a well-formed abp1 invite" };
  const { payload, signingInput, sig } = decoded;

  const expected = mac(signingInput, secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, code: "bad_signature", message: "signature not decodable" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, code: "bad_signature", message: "invite signature mismatch (forged or tampered)" };
  }

  const now = opts.now ?? Date.now();
  if (payload.exp <= now) {
    return { ok: false, code: "expired", message: `invite expired at ${payload.exp}` };
  }
  if (opts.expectedRole !== undefined && payload.role !== "*" && payload.role !== opts.expectedRole) {
    return { ok: false, code: "role_mismatch", message: `invite is for role ${payload.role}, not ${opts.expectedRole}` };
  }
  if (
    opts.expectedProfile &&
    (payload.profile.id !== opts.expectedProfile.id || payload.profile.version !== opts.expectedProfile.version)
  ) {
    return { ok: false, code: "profile_mismatch", message: `invite profile ${payload.profile.id}/${payload.profile.version} mismatch` };
  }
  return { ok: true, payload };
}
