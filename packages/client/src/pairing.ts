import { ProfileLoader, type PinnedProfile, type ApproveFn } from "@agent-bridge/validator";
import { WssTransport } from "./transport.ts";
import { Keypair } from "./keypair.ts";
import { Session } from "./session.ts";
import { makeEnvelope } from "./envelope.ts";

/** A typed pairing failure carrying an ABP error code. */
export class PairingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PairingError";
    this.code = code;
  }
}

type InboundMessage = { type: string; id: string; payload: Record<string, unknown>; corr?: string };

/** Resolve with the next validated inbound message matching `match`; reject on error/invalid/timeout. */
function waitFor(transport: WssTransport, match: (m: InboundMessage) => boolean, timeoutMs: number): Promise<InboundMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (msg: InboundMessage) => {
      if (match(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const onInvalid = (info: { reason: string; errors: string[] }) => {
      cleanup();
      reject(new PairingError("bad_message", `invalid inbound frame during pairing: ${info.errors.join("; ")}`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new PairingError("internal", "timed out waiting for host reply during pairing"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      transport.off("message", onMessage);
      transport.off("invalid", onInvalid);
      transport.off("error", onError);
    }
    transport.on("message", onMessage);
    transport.on("invalid", onInvalid);
    transport.on("error", onError);
  });
}

export type PairOptions = {
  /** Role id to bind, or the literal "create". */
  target: string;
  /** Profiles the client supports (default: abp.social/1). */
  profiles?: { id: string; version: string }[];
  /** Claim credential for a claim_required role (§4.2). */
  claim?: string;
  /** Approval hook for an unknown (non-bundled) profile (§5.5). */
  approveProfile?: ApproveFn;
  /** Core semver advertised in hello (default "1.0.0"). */
  abpCore?: string;
  /** Desired bindings (default ["wss"]). */
  bindings?: string[];
  /** Per-step reply timeout in ms (default 5000). */
  timeoutMs?: number;
};

export type PairResult = { session: Session; profile: PinnedProfile };

/**
 * Drive the client side of the ABP handshake over an open transport (§4.2, §5.1):
 * hello -> hello_ack (pin the inlined profile by hash) -> pair_request
 * (-> pair_challenge -> sign nonce -> pair_request w/ signature) -> pair_result.
 * Returns the scoped Session and the pinned World Profile.
 */
export async function pair(
  transport: WssTransport,
  keypair: Keypair,
  loader: ProfileLoader,
  opts: PairOptions,
): Promise<PairResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const profiles = opts.profiles ?? [{ id: "abp.social", version: "1" }];

  // 1. hello -> hello_ack
  transport.send(makeEnvelope("hello", { abp_core: opts.abpCore ?? "1.0.0", profiles, bindings: opts.bindings ?? ["wss"] }));
  const ack = await waitFor(transport, (m) => m.type === "hello_ack" || m.type === "error", timeoutMs);
  if (ack.type === "error") throw new PairingError(String(ack.payload.code), String(ack.payload.message));

  // 2. pin the inlined World Profile by content hash (§5.5)
  const pinned = loader.pin(ack.payload.profile as never, { approve: opts.approveProfile });
  if (!pinned.ok) throw new PairingError(pinned.code, pinned.errors.join("; "));
  const profile = pinned.profile;

  // 3. pair_request (initial); host may answer with a challenge
  const base: Record<string, unknown> = { target: opts.target, pubkey: keypair.publicKey };
  if (opts.claim !== undefined) base.claim = opts.claim;
  transport.send(makeEnvelope("pair_request", { ...base }));

  let reply = await waitFor(transport, (m) => ["pair_challenge", "pair_result", "error"].includes(m.type), timeoutMs);

  if (reply.type === "pair_challenge") {
    const nonce = String(reply.payload.nonce);
    const signature = keypair.sign(nonce);
    transport.send(makeEnvelope("pair_request", { ...base, nonce, signature }));
    reply = await waitFor(transport, (m) => ["pair_result", "error"].includes(m.type), timeoutMs);
  }

  if (reply.type === "error") throw new PairingError(String(reply.payload.code), String(reply.payload.message));

  // 4. build the scoped session; the bound profile MUST equal the pinned one (§4.2)
  const pr = reply.payload as {
    session: string;
    role: { id: string; display_name?: string };
    capabilities: string[];
    profile: { id: string; version: string; hash: string };
    expires_at: number;
  };
  if (pr.profile.id !== profile.id || pr.profile.version !== profile.version || pr.profile.hash !== profile.hash) {
    throw new PairingError("profile_mismatch", "pair_result.profile does not equal the pinned profile");
  }
  const session = new Session({
    token: pr.session,
    role: pr.role,
    capabilities: pr.capabilities,
    profile: pr.profile,
    expiresAt: pr.expires_at,
  });
  return { session, profile };
}

/**
 * Re-attach a session after a disconnect (§4.3.2): send `resume` carrying the token
 * in the envelope and the highest durably-processed event seq as the cursor.
 */
export function sendResume(transport: WssTransport, session: Session, lastEventSeq?: number): void {
  const payload = lastEventSeq === undefined ? {} : { last_event_seq: lastEventSeq };
  transport.send(makeEnvelope("resume", payload, { session: session.token }));
}
