/** The role+profile+capability-scoped session granted by pair_result (§4.2). */
export type SessionData = {
  token: string;
  role: { id: string; display_name?: string };
  capabilities: string[];
  profile: { id: string; version: string; hash: string };
  /** Absolute expiry (ms epoch) from pair_result.expires_at. */
  expiresAt: number;
};

/** The `proactive` capability flag (act outside a turn), §4.3.1. */
export const PROACTIVE = "proactive";

/**
 * A scoped session. Enforces the client side of token scoping: capability checks
 * before emitting actions, and expiry detection so the client re-pairs. Host
 * re-validates everything server-side regardless (§4.2).
 */
export class Session {
  readonly token: string;
  readonly role: { id: string; display_name?: string };
  readonly capabilities: readonly string[];
  readonly profile: { id: string; version: string; hash: string };
  readonly expiresAt: number;
  readonly #caps: Set<string>;

  constructor(data: SessionData) {
    this.token = data.token;
    this.role = data.role;
    this.capabilities = [...data.capabilities];
    this.profile = data.profile;
    this.expiresAt = data.expiresAt;
    this.#caps = new Set(data.capabilities);
  }

  /** True once the token has expired. */
  isExpired(now: number = Date.now()): boolean {
    return now >= this.expiresAt;
  }

  /** Whether this session may emit the given action kind (capability scope). */
  can(actionKind: string): boolean {
    return this.#caps.has(actionKind);
  }

  /** Whether the session may act outside a turn (§4.3.1). */
  get proactive(): boolean {
    return this.#caps.has(PROACTIVE);
  }

  /** Throw unless the action kind is in scope. */
  assertCan(actionKind: string): void {
    if (!this.can(actionKind)) {
      throw new Error(`forbidden: action "${actionKind}" is not in this session's capabilities [${this.capabilities.join(", ")}]`);
    }
  }

  /** Authorization header carrying the session token (§2). */
  authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }
}
