import { ProfileLoader, type ApproveFn } from "@agent-bridge/validator";
import { WssTransport, Keypair, pair, Driver, type AbpEvent, type EventContext } from "@agent-bridge/client";

/** An event as surfaced to the MCP agent (Core event + correlation id). */
export type BufferedEvent = { kind: string; seq: number; data: Record<string, unknown>; id: string; corr?: string };

export type LinkOptions = {
  url: string;
  target: string;
  claim?: string;
  keypairPath?: string;
  approveProfile?: ApproveFn;
  profiles?: { id: string; version: string }[];
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
  #lastPerception: Record<string, unknown> | null = null;
  #queue: BufferedEvent[] = [];
  #waiters: Waiter[] = [];
  // Placeholder local store for F3.1; F5.2 replaces it with a persistent, namespaced, hard-walled store.
  #memory = new Map<string, unknown>();

  get linked(): boolean {
    return this.#driver !== undefined;
  }

  /** Connect outbound, pair, and start the event loop (manual turn mode). */
  async link(opts: LinkOptions): Promise<LinkResult> {
    if (this.#driver) throw new Error("already linked; close() first");
    const transport = new WssTransport(opts.url);
    transport.on("error", () => {}); // post-connect transport errors must not crash the process
    await transport.connect();
    const keypair = opts.keypairPath ? Keypair.loadOrCreate(opts.keypairPath) : Keypair.generate();
    const { session, profile } = await pair(transport, keypair, new ProfileLoader(), {
      target: opts.target,
      claim: opts.claim,
      approveProfile: opts.approveProfile,
      profiles: opts.profiles,
    });
    const driver = new Driver(transport, { session, profile, noopOnTimeout: false });
    driver.on("event", (ev: AbpEvent, ctx: EventContext) => this.#onEvent(ev, ctx));
    driver.on("error", () => {}); // surfaced per-call; ignore async stragglers
    driver.start();
    this.#transport = transport;
    this.#driver = driver;
    return { role: session.role, capabilities: [...session.capabilities], profile: session.profile };
  }

  #onEvent(ev: AbpEvent, ctx: EventContext): void {
    const buffered: BufferedEvent = { kind: ev.kind, seq: ev.seq, data: ev.data, id: ctx.id, corr: ctx.corr };
    if (ev.kind === "perception") this.#lastPerception = ev.data;
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

  /** Local persona memory (placeholder; F5.2 = persistent, namespaced, hard-walled store). */
  personaMemory(op: "get" | "set" | "delete" | "list", key?: string, value?: unknown): unknown {
    switch (op) {
      case "set":
        if (!key) throw new Error("key required");
        this.#memory.set(key, value ?? null);
        return { ok: true };
      case "get":
        return { value: key ? (this.#memory.get(key) ?? null) : null };
      case "delete":
        if (key) this.#memory.delete(key);
        return { ok: true };
      case "list":
        return { keys: [...this.#memory.keys()] };
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
  }

  #assertLinked(): void {
    if (!this.#driver) throw new Error("not linked; call link() first");
  }
}
