/**
 * Avatar runtime controller (F6.3): a config toggle between user-in-the-loop (the agent drives
 * via the MCP tools directly) and autopilot (an autonomous loop drives an injected brain), plus a
 * hot-unplug kill switch that stops the loop, sends a graceful `bye`, and tears down the session.
 * Decoupled and hot-pluggable per the project goal: kill() releases everything cleanly.
 *
 * Events: "mode"(AvatarMode), "killed"(reason).
 */
import { EventEmitter } from "node:events";
import { Connector } from "./connector.ts";
import { Autopilot, type AutopilotOptions } from "./autopilot.ts";

export type AvatarMode = "in_the_loop" | "autopilot";
export type AvatarConfig = { mode?: AvatarMode };

export class AvatarController extends EventEmitter {
  readonly #connector: Connector;
  #mode: AvatarMode;
  #autopilot?: Autopilot;
  #killed = false;

  constructor(connector: Connector, config: AvatarConfig = {}) {
    super();
    this.#connector = connector;
    this.#mode = config.mode ?? "in_the_loop";
  }

  get mode(): AvatarMode {
    return this.#mode;
  }
  get connector(): Connector {
    return this.#connector;
  }
  get running(): boolean {
    return this.#autopilot !== undefined;
  }
  get killed(): boolean {
    return this.#killed;
  }

  /** Switch mode. Switching away from autopilot stops a running loop. */
  setMode(mode: AvatarMode): void {
    if (this.#killed) throw new Error("avatar killed");
    if (mode === this.#mode) return;
    this.#mode = mode;
    if (mode === "in_the_loop") this.#stopAutopilot();
    this.emit("mode", mode);
  }

  /** Start the autopilot loop (only valid in autopilot mode). Returns its run promise. */
  startAutopilot(opts: AutopilotOptions): Promise<unknown> {
    if (this.#killed) throw new Error("avatar killed");
    if (this.#mode !== "autopilot") throw new Error('setMode("autopilot") before startAutopilot()');
    if (this.#autopilot) throw new Error("autopilot already running");
    const ap = new Autopilot(this.#connector, opts);
    this.#autopilot = ap;
    return ap.run().finally(() => {
      if (this.#autopilot === ap) this.#autopilot = undefined;
    });
  }

  #stopAutopilot(): void {
    this.#autopilot?.stop();
    this.#autopilot = undefined;
  }

  /** Hot-unplug: stop the loop, send a graceful `bye`, tear down. Idempotent. */
  kill(reason = "hot-unplug"): void {
    if (this.#killed) return;
    this.#killed = true;
    this.#stopAutopilot();
    this.#connector.bye(reason);
    this.#connector.close();
    this.emit("killed", reason);
  }
}
