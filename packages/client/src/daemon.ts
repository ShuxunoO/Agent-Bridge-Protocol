/**
 * Connection daemon (F6.1): keeps the outbound link up. On an unexpected drop it reconnects
 * with exponential backoff, re-attaches the driver, and sends `resume{last_event_seq}` so the
 * host backfills or snapshots (SPEC §4.3.2) — the client never silently misses world state.
 * This is the persistence layer the autopilot (F6.2) runs on; a hot-unplug stop() is clean.
 *
 * Events: "connected"({lastEventSeq}), "reconnecting"({attempt,delay}), "reconnected"({lastEventSeq}),
 * "event"(AbpEvent, ctx), "error"(err), "giveup"(), "stopped"().
 */
import { EventEmitter } from "node:events";
import { ProfileLoader, type PinnedProfile } from "@agent-bridge/validator";
import { WssTransport } from "./transport.ts";
import { Keypair } from "./keypair.ts";
import { pair, sendResume, type PairOptions } from "./pairing.ts";
import { Driver, type DriverOptions, type AbpEvent, type EventContext } from "./driver.ts";
import { Session } from "./session.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type DaemonOptions = {
  url: string;
  keypair: Keypair;
  pairing: PairOptions;
  loader?: ProfileLoader;
  /** Driver options except session/profile (e.g. onTurn, egress, rateLimit). */
  driver?: Omit<DriverOptions, "session" | "profile">;
  /** Backoff schedule in ms; the last value repeats. Default [200, 1000, 5000]. */
  backoffMs?: number[];
  /** Give up after this many consecutive failed reconnect attempts. Default: unlimited. */
  maxReconnects?: number;
};

export class ConnectionDaemon extends EventEmitter {
  readonly #opts: DaemonOptions;
  readonly #loader: ProfileLoader;
  #transport?: WssTransport;
  #driver?: Driver;
  #session?: Session;
  #profile?: PinnedProfile;
  #lastEventSeq = -1;
  #stopped = false;

  constructor(opts: DaemonOptions) {
    super();
    this.#opts = opts;
    this.#loader = opts.loader ?? new ProfileLoader();
  }

  /** Highest event seq processed — the resume cursor carried on reconnect. */
  get lastEventSeq(): number {
    return this.#lastEventSeq;
  }
  get connected(): boolean {
    return this.#driver !== undefined;
  }
  /** The bound session (after the first successful pair). */
  get session(): Session | undefined {
    return this.#session;
  }

  /** Connect, pair, and begin driving. Throws if the first connect/pair fails. */
  async start(): Promise<void> {
    this.#stopped = false;
    const transport = new WssTransport(this.#opts.url);
    transport.on("error", () => {}); // post-connect errors must not crash; reconnect handles drops
    await transport.connect();
    const { session, profile } = await pair(transport, this.#opts.keypair, this.#loader, this.#opts.pairing);
    this.#session = session;
    this.#profile = profile;
    this.#attach(transport, "connected");
  }

  #attach(transport: WssTransport, event: "connected" | "reconnected"): void {
    this.#transport = transport;
    const driver = new Driver(transport, { session: this.#session!, profile: this.#profile!, ...this.#opts.driver });
    driver.on("event", (ev: AbpEvent, ctx: EventContext) => {
      this.#lastEventSeq = driver.lastEventSeq;
      this.emit("event", ev, ctx);
    });
    driver.on("error", (e: unknown) => this.emit("error", e));
    driver.start(); // swaps the transport validator to the pinned-profile AbpValidator
    this.#driver = driver;
    transport.on("close", this.#onClose);
    this.emit(event, { lastEventSeq: this.#lastEventSeq });
  }

  readonly #onClose = (): void => {
    if (this.#stopped) return;
    this.#driver?.stop();
    this.#driver = undefined;
    void this.#reconnect();
  };

  async #reconnect(): Promise<void> {
    const backoff = this.#opts.backoffMs ?? [200, 1000, 5000];
    for (let attempt = 0; !this.#stopped; attempt++) {
      const ms = backoff[Math.min(attempt, backoff.length - 1)];
      this.emit("reconnecting", { attempt, delay: ms });
      await delay(ms);
      if (this.#stopped) return;
      try {
        const transport = new WssTransport(this.#opts.url);
        transport.on("error", () => {});
        await transport.connect();
        // Re-attach with the EXISTING session/profile (resume, not re-pair), then send the cursor.
        this.#attach(transport, "reconnected");
        sendResume(transport, this.#session!, this.#lastEventSeq);
        return;
      } catch (e) {
        this.emit("error", e);
        if (this.#opts.maxReconnects !== undefined && attempt + 1 >= this.#opts.maxReconnects) {
          this.emit("giveup");
          return;
        }
      }
    }
  }

  /** Hot-unplug: stop reconnecting, stop driving, close the transport. */
  stop(): void {
    this.#stopped = true;
    this.#transport?.off("close", this.#onClose);
    this.#driver?.stop();
    this.#driver = undefined;
    this.#transport?.close();
    this.#transport = undefined;
    this.emit("stopped");
  }
}
