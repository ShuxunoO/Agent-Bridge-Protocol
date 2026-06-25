import { ProfileLoader, PinnedProfile, type ApproveFn } from "@agent-bridge/validator";
import { WssTransport, Keypair, pair, Driver, wrapUntrusted, PersonaMemoryStore, parseInvite, makeEnvelope, type AbpEvent, type EventContext } from "@agent-bridge/client";

/** Label the origin of an event's untrusted content (best-effort, for the wrapper's `source` attr). */
function eventSource(ev: AbpEvent): string {
  const from = (ev.data as { from_role?: { id?: unknown } }).from_role?.id;
  return typeof from === "string" ? `role:${from}` : ev.kind;
}

/** An event as surfaced to the MCP agent (Core event + correlation id). */
export type BufferedEvent = { kind: string; seq: number; data: Record<string, unknown>; id: string; corr?: string };

export type LinkOptions = {
  /** Where to connect + which role to bind. Optional when `invite` is given (decoded from it). */
  url?: string;
  target?: string;
  claim?: string;
  /** A pasteable Invite token (§4.2.1). If set, url/target/claim are taken from it — one paste = link. */
  invite?: string;
  keypairPath?: string;
  approveProfile?: ApproveFn;
  profiles?: { id: string; version: string }[];
};

export type ConnectorOptions = {
  /** Directory for the persistent persona memory store (default: ~/.agent-bridge/persona-memory). */
  memoryDir?: string;
};

export type LinkResult = {
  role: { id: string; display_name?: string };
  capabilities: string[];
  profile: { id: string; version: string; hash: string };
};

export type WaitResult = { event: BufferedEvent } | { timeout: true };
export type SubmitResult = { ok: true; mode: "turn" | "proactive" };

type Waiter = { kinds: Set<string> | null; resolve: (r: WaitResult) => void; timer: ReturnType<typeof setTimeout> };

/**
 * The MCP-facing connector: wraps one ABP client session and exposes the agent-driving
 * verbs the MCP tools bind to. Events are buffered so wait_for_event can long-poll;
 * turns are surfaced as events and answered via say/act (manual mode — the agent decides).
 */
export class Connector {
  #transport?: WssTransport;
  #driver?: Driver;
  #profile?: PinnedProfile;
  #lastPerception: Record<string, unknown> | null = null;
  #queue: BufferedEvent[] = [];
  #waiters: Waiter[] = [];
  // Persistent, namespaced, hard-walled persona memory (F5.2). Created on link() with the bound
  // role's id as the namespace; a "default" namespace is used for any pre-link access.
  #memoryDir?: string;
  #memory?: PersonaMemoryStore;

  constructor(opts: ConnectorOptions = {}) {
    this.#memoryDir = opts.memoryDir;
  }

  get linked(): boolean {
    return this.#driver !== undefined;
  }

  #store(): PersonaMemoryStore {
    // link() sets the role-namespaced store; this lazy default covers pre-link access.
    if (!this.#memory) this.#memory = new PersonaMemoryStore("default", { dir: this.#memoryDir });
    return this.#memory;
  }

  /** Connect outbound, pair, and start the event loop (manual turn mode). */
  async link(opts: LinkOptions): Promise<LinkResult> {
    if (this.#driver) throw new Error("already linked; close() first");
    // An Invite token carries url/target/claim — one paste links the avatar (§4.2.1).
    let url = opts.url;
    let target = opts.target;
    let claim = opts.claim;
    if (opts.invite) {
      const inv = parseInvite(opts.invite);
      if (!inv) throw new Error("malformed invite token");
      url = inv.url;
      target = inv.target;
      claim = inv.claim;
    }
    if (!url || !target) throw new Error("link requires an `invite`, or both `url` and `target`");
    const transport = new WssTransport(url);
    transport.on("error", () => {}); // post-connect transport errors must not crash the process
    await transport.connect();
    const keypair = opts.keypairPath ? Keypair.loadOrCreate(opts.keypairPath) : Keypair.generate();
    const { session, profile } = await pair(transport, keypair, new ProfileLoader(), {
      target,
      claim,
      approveProfile: opts.approveProfile,
      profiles: opts.profiles,
    });
    const driver = new Driver(transport, { session, profile, noopOnTimeout: false });
    driver.on("event", (ev: AbpEvent, ctx: EventContext) => this.#onEvent(ev, ctx));
    driver.on("error", () => {}); // surfaced per-call; ignore async stragglers
    driver.start();
    this.#transport = transport;
    this.#driver = driver;
    this.#profile = profile;
    // Persona memory is namespaced by the bound role (hard-walled from other roles / main agent).
    this.#memory = new PersonaMemoryStore(session.role.id, { dir: this.#memoryDir });
    return { role: session.role, capabilities: [...session.capabilities], profile: session.profile };
  }

  #onEvent(ev: AbpEvent, ctx: EventContext): void {
    // L2: wrap the event's untrusted leaves as delimited data BEFORE the model can see it.
    // Paths come from the pinned profile (x-abp-trust:untrusted); control fields stay raw so
    // the agent can still act on ids/seq/conversation_id.
    const untrusted = this.#profile?.trust.events[ev.kind]?.untrusted ?? [];
    const data = untrusted.length ? wrapUntrusted(ev.data, untrusted, { source: eventSource(ev) }) : ev.data;
    const buffered: BufferedEvent = { kind: ev.kind, seq: ev.seq, data, id: ctx.id, corr: ctx.corr };
    if (ev.kind === "perception") this.#lastPerception = data;
    const i = this.#waiters.findIndex((w) => w.kinds === null || w.kinds.has(ev.kind));
    if (i >= 0) {
      const [w] = this.#waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve({ event: buffered });
    } else {
      this.#queue.push(buffered);
    }
  }

  /** Latest perception snapshot (or null). */
  perceive(): { perception: Record<string, unknown> | null } {
    this.#assertLinked();
    return { perception: this.#lastPerception };
  }

  /** Long-poll for the next event (optionally filtered by kind); resolves on event or timeout. */
  waitForEvent(opts: { kinds?: string[]; timeoutMs?: number } = {}): Promise<WaitResult> {
    this.#assertLinked();
    const kinds = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null;
    const timeoutMs = opts.timeoutMs ?? 30000;
    const i = this.#queue.findIndex((e) => kinds === null || kinds.has(e.kind));
    if (i >= 0) {
      const [event] = this.#queue.splice(i, 1);
      return Promise.resolve({ event });
    }
    return new Promise<WaitResult>((resolve) => {
      const timer = setTimeout(() => {
        const j = this.#waiters.findIndex((w) => w.timer === timer);
        if (j >= 0) this.#waiters.splice(j, 1);
        resolve({ timeout: true });
      }, timeoutMs);
      this.#waiters.push({ kinds, resolve, timer });
    });
  }

  /** Utterance into a conversation. (Egress DLP on `text` is added in F4.2.) */
  say(conversationId: string, text: string): SubmitResult {
    return this.#submit({ kind: "say", data: { conversation_id: conversationId, text } });
  }

  /** Submit an arbitrary action of the pinned profile (e.g. move, emote, interact_*). */
  act(kind: string, data: unknown = {}): SubmitResult {
    return this.#submit({ kind, data });
  }

  #submit(action: { kind: string; data: unknown }): SubmitResult {
    this.#assertLinked();
    const driver = this.#driver!;
    if (driver.currentTurnId) {
      driver.respond(action);
      return { ok: true, mode: "turn" };
    }
    driver.act(action); // throws unless the session has the proactive capability
    return { ok: true, mode: "proactive" };
  }

  /** Local persona memory: persistent, namespaced by the bound role, hard-walled (F5.2). Never sent to the host. */
  personaMemory(op: "get" | "set" | "delete" | "list", key?: string, value?: unknown): unknown {
    const store = this.#store();
    switch (op) {
      case "set":
        if (!key) throw new Error("key required");
        store.set(key, value ?? null);
        return { ok: true };
      case "get":
        return { value: key ? store.get(key) : null };
      case "delete":
        if (key) store.delete(key);
        return { ok: true };
      case "list":
        return { keys: store.list() };
    }
  }

  /** Send a graceful `bye` (hot-unplug) if the socket is open. Best-effort; never throws. */
  bye(reason = "client disconnect"): void {
    if (this.#transport?.isOpen) {
      try {
        this.#transport.send(makeEnvelope("bye", { reason }));
      } catch {
        // socket may race-close; teardown proceeds regardless
      }
    }
  }

  /** Tear down the session. */
  close(): void {
    for (const w of this.#waiters) {
      clearTimeout(w.timer);
      w.resolve({ timeout: true });
    }
    this.#waiters = [];
    this.#driver?.stop();
    this.#transport?.close();
    this.#driver = undefined;
    this.#transport = undefined;
    this.#profile = undefined;
    this.#memory = undefined; // a re-link rebinds memory to the new role's namespace
  }

  #assertLinked(): void {
    if (!this.#driver) throw new Error("not linked; call link() first");
  }
}
