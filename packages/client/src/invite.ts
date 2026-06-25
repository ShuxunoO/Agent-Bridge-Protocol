import { decodeInvite } from "@agent-bridge/validator";

/** The link args carried inside an Invite token (§4.2.1). */
export type ParsedInvite = {
  url: string;
  target: string;
  claim: string;
  profile: { id: string; version: string };
};

/**
 * Decode an Invite token (`abp1.…`) into the args needed to link: where to connect (`url`), which
 * role to bind (`target`), and the `claim` to present (the token itself). Returns null if malformed.
 * The client does NOT verify the signature — it only reads where to go; the host's bind verification
 * is authoritative. So one pasted invite = a complete `abp_link`.
 */
export function parseInvite(token: string): ParsedInvite | null {
  const d = decodeInvite(token);
  if (!d) return null;
  return { url: d.payload.url, target: d.payload.role, claim: token, profile: d.payload.profile };
}
