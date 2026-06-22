/**
 * Generic ABP/1 Host SDK (F7.1). Any host app embeds this to expose drivable roles over ABP:
 * it accepts outbound clients (WSS baseline), runs the host half of pairing (challenge → verify
 * signature → mint a role+profile+capability-scoped token), advertises + inlines the World Profile
 * with its content hash, emits events with a monotonic per-session seq, validates + applies
 * incoming actions (capabilities + the open turn's allowed_actions + size), and backfills (or asks
 * the embedder to snapshot) on resume. It never blocks the world on an absent client.
 *
 * A host app's gateway is one embedder; the SDK itself is host-agnostic.
 */
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  ProfileLoader,
  AbpValidator,
  profileHash,
  MAX_MESSAGE_BYTES,
  ABP_CORE_VERSION,
  type PinnedProfile,
  type JSONSchema,
} from "@agent-bridge/validator";
import { verifyEd25519 } from "./verify.ts";

export type RolePublic = { id: string; display_name?: string; bind_policy?: "open" | "claim_required" | "closed" };
export type BindContext = { pubkey?: string; claim?: string };
export type BindDecision =
  | { ok: true; capabilities: string[] }
  | { ok: false; code: "unauthorized" | "conflict" | "not_found" | "forbidden"; message?: string };

export type HostEvent = { kind: string; data: Record<string, unknown> };

export type HostOptions = {
  /** The World Profile to advertise + inline (hash is computed). */
  profile: { id: string; version: string; document: JSONSchema };
  /** Drivable roles (for roles_list). */
  roles: () => RolePublic[];
  /** Authorize a bind + grant capabilities. Default: open roles get all profile action kinds + proactive. */
  bind?: (roleId: string, ctx: BindContext) => BindDecision;
  /** Require a signed challenge before binding (default true). */
  requireSignature?: boolean;
  /** Session token lifetime (default 1h). */
  tokenTtlMs?: number;
  /** The event kind that carries allowed_actions (default "turn"). */
  turnKind?: string;
  onBind?: (session: HostSession) => void;
  onAction?: (session: HostSession, action: HostEvent, corr?: string) => void;
  onResume?: (session: HostSession, lastEventSeq: number) => void;
  onBye?: (session: HostSession, reason: string) => void;
};

const newId = () => randomBytes(12).toString("base64url");

/** A bound, scoped session. The embedder emits events to it via host.emit(roleId, …). */
export class HostSession {
  readonly token: string;
  readonly roleId: string;
  readonly capabilities: Set<string>;
  readonly profile: { id: string; version: string; hash: string };
  expiresAt: number;
  ws: WebSocket;
  seq = 0;
  /** Recent serialized event frames for resume backfill (bounded ring). */
  readonly buffer: { seq: number; frame: string }[] = [];
  bufferMax = 256;
  currentTurnId?: string;
  currentAllowed?: Set<string> | null;

  constructor(token: string, roleId: string, caps: string[], profile: { id: string; version: string; hash: string }, expiresAt: number, ws: WebSocket) {
    this.token = token;
    this.roleId = roleId;
    this.capabilities = new Set(caps);
    this.profile = profile;
    this.expiresAt = expiresAt;
    this.ws = ws;
  }
  get proactive(): boolean {
    return this.capabilities.has("proactive");
  }
  isExpired(now: number): boolean {
    return now >= this.expiresAt;
  }
}

export class AbpHost {
  readonly #opts: HostOptions;
  readonly #pinned: PinnedProfile;
  readonly #hash: string;
  readonly #validator: AbpValidator;
  readonly #turnKind: string;
  readonly #ttl: number;
  readonly #requireSig: boolean;
  #wss?: WebSocketServer;
  readonly #byToken = new Map<string, HostSession>();
  readonly #byRole = new Map<string, HostSession>();

  constructor(opts: HostOptions) {
    this.#opts = opts;
    const loader = new ProfileLoader();
    const hash = profileHash(opts.profile.document);
    const pinned = loader.pin({ id: opts.profile.id, version: opts.profile.version, hash, document: opts.profile.document }, { approve: () => true });
    if (!pinned.ok) throw new Error(`host profile invalid: ${pinned.errors.join("; ")}`);
    this.#pinned = pinned.profile;
    this.#hash = hash;
    this.#validator = new AbpValidator(this.#pinned);
    this.#turnKind = opts.turnKind ?? "turn";
    this.#ttl = opts.tokenTtlMs ?? 3_600_000;
    this.#requireSig = opts.requireSignature ?? true;
  }

  /** Start listening on a port (0 = ephemeral). Resolves with the bound port. */
  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve) => {
      const wss: WebSocketServer = new WebSocketServer({ host, port }, () => resolve((wss.address() as { port: number }).port));
      wss.on("connection", (ws) => this.#onConn(ws));
      this.#wss = wss;
    });
  }

  /** Session bound to a role, if any. */
  sessionForRole(roleId: string): HostSession | undefined {
    return this.#byRole.get(roleId);
  }

  /**
   * Emit an event to the client driving `roleId`. Assigns the monotonic seq, buffers it for
   * resume, and (for a turn-kind event) records the open turn's allowed_actions. Returns the seq,
   * or undefined if no client is currently bound (the world must not block — §4.4.2).
   */
  emit(roleId: string, event: HostEvent): number | undefined {
    const s = this.#byRole.get(roleId);
    if (!s || s.ws.readyState !== WebSocket.OPEN) return undefined;
    const seq = s.seq++;
    const id = newId();
    const frame = JSON.stringify({ abp: "1", type: "event", id, ts: Date.now(), session: s.token, payload: { kind: event.kind, seq, data: event.data } });
    if (event.kind === this.#turnKind) {
      s.currentTurnId = id;
      const aa = (event.data as { allowed_actions?: unknown }).allowed_actions;
      s.currentAllowed = Array.isArray(aa) ? new Set(aa as string[]) : null;
    }
    s.buffer.push({ seq, frame });
    if (s.buffer.length > s.bufferMax) s.buffer.shift();
    s.ws.send(frame);
    return seq;
  }

  close(): void {
    for (const s of this.#byToken.values()) {
      try {
        s.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.#byToken.clear();
    this.#byRole.clear();
    this.#wss?.close();
    this.#wss = undefined;
  }

  // --- connection handling ---

  #onConn(ws: WebSocket): void {
    let nonce: string | undefined;
    let session: HostSession | undefined;
    const send = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
      ws.send(JSON.stringify({ abp: "1", type, id: newId(), ts: Date.now(), ...extra, payload }));
    const fail = (code: string, message: string) => send("error", { code, message, retryable: code === "rate_limited" });

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return fail("bad_message", "binary frame; ABP frames are UTF-8 JSON");
      if (raw.byteLength > MAX_MESSAGE_BYTES) return fail("bad_message", `frame exceeds ${MAX_MESSAGE_BYTES} bytes`);
      let msg: { type?: string; id?: string; corr?: string; session?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return fail("bad_message", "frame is not valid JSON");
      }
      const v = this.#validator.validateMessage(msg);
      if (!v.ok) return fail(v.code, v.errors.join("; "));
      const payload = msg.payload ?? {};

      switch (msg.type) {
        case "hello":
          return void send("hello_ack", {
            abp_core: ABP_CORE_VERSION,
            profile: { id: this.#opts.profile.id, version: this.#opts.profile.version, hash: this.#hash, document: this.#opts.profile.document },
            auth_methods: ["signature"],
          });

        case "roles_query":
          return void send("roles_list", {
            roles: this.#opts.roles().map((r) => ({ id: r.id, display_name: r.display_name, bind_policy: r.bind_policy ?? "open" })),
          });

        case "pair_request": {
          const target = String(payload.target ?? "");
          const pubkey = payload.pubkey as string | undefined;
          const claim = payload.claim as string | undefined;
          const signature = payload.signature as string | undefined;
          const sentNonce = payload.nonce as string | undefined;
          if (this.#requireSig && !signature) {
            nonce = newId();
            return void send("pair_challenge", { nonce });
          }
          if (this.#requireSig) {
            if (!pubkey || !signature || !sentNonce || sentNonce !== nonce || !verifyEd25519(pubkey, sentNonce, signature)) {
              return fail("unauthorized", "invalid or missing pairing signature");
            }
          }
          const decision = this.#bind(target, { pubkey, claim });
          if (!decision.ok) return fail(decision.code, decision.message ?? decision.code);
          if (this.#byRole.has(target)) return fail("conflict", `role ${target} already bound`);
          const role = this.#opts.roles().find((r) => r.id === target);
          const token = newId() + newId();
          session = new HostSession(token, target, decision.capabilities, { id: this.#opts.profile.id, version: this.#opts.profile.version, hash: this.#hash }, Date.now() + this.#ttl, ws);
          this.#byToken.set(token, session);
          this.#byRole.set(target, session);
          send("pair_result", {
            session: token,
            role: { id: target, display_name: role?.display_name },
            capabilities: decision.capabilities,
            profile: { id: this.#opts.profile.id, version: this.#opts.profile.version, hash: this.#hash },
            expires_at: session.expiresAt,
          });
          this.#opts.onBind?.(session);
          return;
        }

        case "resume": {
          const token = msg.session!;
          const existing = this.#byToken.get(token);
          if (!existing || existing.isExpired(Date.now())) return fail("unauthorized", "unknown or expired session");
          existing.ws = ws;
          this.#byRole.set(existing.roleId, existing);
          session = existing;
          const cursor = typeof payload.last_event_seq === "number" ? payload.last_event_seq : -1;
          const earliest = existing.buffer.length ? existing.buffer[0].seq : existing.seq;
          if (cursor + 1 < earliest) {
            // gap beyond what we retain → ask the embedder to emit a fresh snapshot (§4.3.2)
            this.#opts.onResume?.(existing, cursor);
          } else {
            for (const b of existing.buffer) if (b.seq > cursor) ws.send(b.frame);
          }
          return;
        }

        case "ping":
          return void send("pong", {});

        case "bye":
          if (session) this.#opts.onBye?.(session, String(payload.reason ?? ""));
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;

        case "action": {
          if (!session || msg.session !== session.token) return fail("unauthorized", "action without a bound session");
          const kind = String(payload.kind ?? "");
          if (!session.capabilities.has(kind)) return fail("forbidden", `capability "${kind}" not granted`);
          if (session.currentAllowed && !session.currentAllowed.has(kind)) {
            return fail("forbidden", `action "${kind}" not in the open turn's allowed_actions`);
          }
          if (!session.currentAllowed && !session.proactive) {
            return fail("forbidden", "no open turn and the session lacks the proactive capability");
          }
          // settle the turn this action answers
          if (msg.corr && msg.corr === session.currentTurnId) {
            session.currentTurnId = undefined;
            session.currentAllowed = undefined;
          }
          this.#opts.onAction?.(session, { kind, data: (payload.data as Record<string, unknown>) ?? {} }, msg.corr);
          return;
        }

        default:
          return fail("bad_message", `unexpected control type "${msg.type}"`);
      }
    });

    ws.on("close", () => {
      // detach the role binding so the world stops routing to a dead socket (token stays valid for resume)
      if (session && this.#byRole.get(session.roleId) === session && session.ws === ws) {
        this.#byRole.delete(session.roleId);
      }
    });
    ws.on("error", () => {});
  }

  #bind(roleId: string, ctx: BindContext): BindDecision {
    const role = this.#opts.roles().find((r) => r.id === roleId);
    if (!role) return { ok: false, code: "not_found", message: `role ${roleId} not found` };
    if (role.bind_policy === "closed") return { ok: false, code: "forbidden", message: "role is not bindable" };
    if (this.#opts.bind) return this.#opts.bind(roleId, ctx);
    if ((role.bind_policy ?? "open") === "claim_required" && !ctx.claim) {
      return { ok: false, code: "unauthorized", message: "claim credential required" };
    }
    // default: grant all profile action kinds + proactive
    return { ok: true, capabilities: [...this.#pinned.actionKinds, "proactive"] };
  }
}
