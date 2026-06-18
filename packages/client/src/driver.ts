import { EventEmitter } from "node:events";
import { AbpValidator, type PinnedProfile } from "@agent-bridge/validator";
import { WssTransport } from "./transport.ts";
import { Session } from "./session.ts";
import { makeEnvelope } from "./envelope.ts";

/** A data-plane event payload (Core shape; `data` is profile-defined). */
export type AbpEvent = { kind: string; seq: number; data: Record<string, unknown> };

/** Correlation context for an inbound event. */
export type EventContext = { id: string; seq: number; corr?: string };

/** An action to submit. `data` defaults to {}. */
export type ActionInput = { kind: string; data?: unknown };

/** A turn handler's decision: an action to take, or null/undefined to do nothing (noop). */
export type TurnDecision = ActionInput | null | undefined;

export type TurnHandler = (turn: Record<string, unknown>, ctx: EventContext) => TurnDecision | Promise<TurnDecision>;
export type EventHandler = (event: AbpEvent, ctx: EventContext) => void | Promise<void>;

export type DriverOptions = {
  session: Session;
  profile: PinnedProfile;
  /** Called for a turn-style event; its returned action is submitted (corr = turn id). */
  onTurn?: TurnHandler;
  /** Called for every non-turn event. */
  onEvent?: EventHandler;
  /** Which event kind is the action opportunity (default "turn"). */
  turnKind?: string;
  /** Send an explicit noop when a turn deadline elapses (default true). */
  noopOnTimeout?: boolean;
};

/**
 * The client event loop (§4.3, §4.4). After pairing it swaps the transport
 * validator to an AbpValidator bound to the pinned profile (composed data-plane
 * validation), dispatches inbound events by kind, tracks the global event `seq`
 * (resume cursor), and submits capability- and turn-scoped actions correlated to
 * their turn. Turn deadlines are relative to receipt; on timeout it emits
 * "turn_timeout" and (by default) submits a noop.
 *
 * Events: "event"(AbpEvent, ctx), "<kind>"(data, ctx), "turn_timeout"(ctx),
 * "host_error"(payload), "bye"(payload), "invalid"(info), "error"(err).
 */
export class Driver extends EventEmitter {
  readonly #t: WssTransport;
  readonly #session: Session;
  readonly #profile: PinnedProfile;
  readonly #onTurn?: TurnHandler;
  readonly #onEvent?: EventHandler;
  readonly #turnKind: string;
  readonly #noopOnTimeout: boolean;
  #lastSeq = -1;
  #started = false;

  readonly #onMessage = (msg: { type: string; id: string; corr?: string; payload: Record<string, unknown> }) => this.#dispatch(msg);
  readonly #onInvalid = (info: unknown) => this.emit("invalid", info);

  constructor(transport: WssTransport, opts: DriverOptions) {
    super();
    this.#t = transport;
    this.#session = opts.session;
    this.#profile = opts.profile;
    this.#onTurn = opts.onTurn;
    this.#onEvent = opts.onEvent;
    this.#turnKind = opts.turnKind ?? "turn";
    this.#noopOnTimeout = opts.noopOnTimeout ?? true;
  }

  /** Swap in composed validation and begin dispatching inbound messages. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const abp = new AbpValidator(this.#profile);
    this.#t.setValidate((m) => abp.validateMessage(m));
    this.#t.on("message", this.#onMessage);
    this.#t.on("invalid", this.#onInvalid);
  }

  /** Stop dispatching (the transport stays open). */
  stop(): void {
    this.#t.off("message", this.#onMessage);
    this.#t.off("invalid", this.#onInvalid);
    this.#started = false;
  }

  /** Highest event seq processed — the resume cursor (§4.3.2). -1 before any event. */
  get lastEventSeq(): number {
    return this.#lastSeq;
  }

  /** Submit a proactive action (outside a turn). Requires the `proactive` capability. */
  act(action: ActionInput): void {
    if (!this.#session.proactive) {
      throw new Error('forbidden: session lacks the "proactive" capability');
    }
    this.#sendAction(action, undefined, null);
  }

  #dispatch(msg: { type: string; id: string; corr?: string; payload: Record<string, unknown> }): void {
    if (msg.type === "event") {
      const ev = msg.payload as unknown as AbpEvent;
      const ctx: EventContext = { id: msg.id, seq: ev.seq, corr: msg.corr };
      if (ev.seq > this.#lastSeq) this.#lastSeq = ev.seq;
      this.emit("event", ev, ctx);
      this.emit(ev.kind, ev.data, ctx);
      if (ev.kind === this.#turnKind) {
        this.#handleTurn(ev, ctx);
      } else if (this.#onEvent) {
        Promise.resolve(this.#onEvent(ev, ctx)).catch((e) => this.emit("error", e));
      }
      return;
    }
    if (msg.type === "error") {
      this.emit("host_error", msg.payload);
      return;
    }
    if (msg.type === "bye") {
      this.emit("bye", msg.payload);
      return;
    }
    this.emit("control", msg);
  }

  #handleTurn(ev: AbpEvent, ctx: EventContext): void {
    const data = ev.data;
    const deadline = typeof data.deadline_ms === "number" ? data.deadline_ms : 0;
    const allowed = Array.isArray(data.allowed_actions) ? new Set(data.allowed_actions as string[]) : null;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const sendDecision = (action: ActionInput | null): void => {
      try {
        if (action) this.#sendAction(action, ctx.id, allowed);
        else if (this.#canSend("noop", allowed)) this.#sendAction({ kind: "noop", data: {} }, ctx.id, allowed);
      } catch (e) {
        this.emit("error", e);
      }
    };
    const timer = setTimeout(() => {
      if (!settle()) return;
      this.emit("turn_timeout", ctx);
      if (this.#noopOnTimeout) sendDecision(null);
    }, deadline);

    if (!this.#onTurn) return; // no handler -> rely on the timeout path

    Promise.resolve(this.#onTurn(data, ctx))
      .then((decision) => {
        if (settle()) sendDecision(decision ?? null);
      })
      .catch((e) => {
        if (settle()) this.emit("error", e);
      });
  }

  #canSend(kind: string, allowed: Set<string> | null): boolean {
    return this.#session.can(kind) && (allowed ? allowed.has(kind) : true);
  }

  #sendAction(action: ActionInput, corr: string | undefined, allowed: Set<string> | null): void {
    this.#session.assertCan(action.kind);
    if (allowed && !allowed.has(action.kind)) {
      throw new Error(`forbidden: action "${action.kind}" is not in this turn's allowed_actions`);
    }
    this.#t.send(makeEnvelope("action", { kind: action.kind, data: action.data ?? {} }, { session: this.#session.token, corr }));
  }
}
