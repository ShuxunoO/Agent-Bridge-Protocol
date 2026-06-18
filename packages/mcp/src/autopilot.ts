/**
 * Autopilot (F6.2): an autonomous loop that drives a (headless) local agent through the ABP
 * tool surface for N turns without a human. The agent's "brain" is injected — in production it
 * is a sandboxed headless Claude Code launched via isolation_mode:process with the restricted
 * allowlist; in tests it is a deterministic function. Either way the autopilot enforces the
 * defenses at the runtime choke point:
 *
 *  - L1 capability guard (F4.3): every tool the brain asks for is assertAllowed() before it runs;
 *    an out-of-allowlist tool (Bash, Read, a foreign MCP, …) is refused, never executed.
 *  - L3 egress DLP (F4.2): abp_say/abp_act go through the Driver's egress filter; a secret in a
 *    client-authored field is blocked (surfaced as a refusal), never sent.
 *  - L2 wrapping (F4.1) already happened upstream: events the brain sees are wrapped untrusted.
 */
import { CapabilityGuard, CapabilityError } from "@agent-bridge/client";
import { Connector, type BufferedEvent } from "./connector.ts";

/** A tool the brain wants to invoke (bare ABP tool name, e.g. "abp_say"). */
export type ToolCall = { tool: string; args?: Record<string, unknown> };

/** The agent brain: given the current event (wrapped untrusted), return the tool call(s) to make. */
export type AutopilotBrain = (ctx: { event: BufferedEvent }) => ToolCall[] | Promise<ToolCall[]>;

export type ActionRecord = { turnSeq: number; tool: string; ok: boolean; detail: string };

export type AutopilotOptions = {
  brain: AutopilotBrain;
  /** Capability guard (default: the standard avatar allowlist). */
  guard?: CapabilityGuard;
  /** Stop after this many turns handled (default 5). */
  maxTurns?: number;
  /** Event kinds that drive a decision (default ["turn"]). */
  waitKinds?: string[];
  /** Per-wait long-poll timeout in ms (default 5000); a timeout ends the run. */
  waitTimeoutMs?: number;
};

export class Autopilot {
  readonly #connector: Connector;
  readonly #brain: AutopilotBrain;
  readonly #guard: CapabilityGuard;
  readonly #maxTurns: number;
  readonly #waitKinds: string[];
  readonly #waitTimeoutMs: number;
  #stopped = false;
  readonly transcript: ActionRecord[] = [];

  constructor(connector: Connector, opts: AutopilotOptions) {
    this.#connector = connector;
    this.#brain = opts.brain;
    this.#guard = opts.guard ?? new CapabilityGuard();
    this.#maxTurns = opts.maxTurns ?? 5;
    this.#waitKinds = opts.waitKinds ?? ["turn"];
    this.#waitTimeoutMs = opts.waitTimeoutMs ?? 5000;
  }

  /** Run the autonomous loop until maxTurns, a wait timeout, or stop(). Returns the transcript. */
  async run(): Promise<ActionRecord[]> {
    let turns = 0;
    while (!this.#stopped && turns < this.#maxTurns) {
      const r = await this.#connector.waitForEvent({ kinds: this.#waitKinds, timeoutMs: this.#waitTimeoutMs });
      if ("timeout" in r) break;
      const event = r.event;
      const calls = await this.#brain({ event });
      for (const call of calls) this.#route(call, event.seq);
      turns++;
    }
    return this.transcript;
  }

  /** Route one brain tool call through the capability guard and the connector. */
  #route(call: ToolCall, turnSeq: number): void {
    // L1: refuse any out-of-allowlist tool at the runtime choke point.
    try {
      this.#guard.assertAllowed(call.tool);
    } catch (e) {
      if (e instanceof CapabilityError) {
        this.transcript.push({ turnSeq, tool: call.tool, ok: false, detail: `refused: ${e.message}` });
        return;
      }
      throw e;
    }
    const args = call.args ?? {};
    try {
      switch (call.tool) {
        case "abp_say":
          this.#connector.say(String(args.conversation_id ?? ""), String(args.text ?? "")); // L3 DLP inside
          break;
        case "abp_act":
          this.#connector.act(String(args.kind ?? "noop"), (args.data as Record<string, unknown>) ?? {});
          break;
        case "abp_perceive":
          this.#connector.perceive();
          break;
        case "abp_persona_memory":
          this.#connector.personaMemory(args.op as never, args.key as string | undefined, args.value);
          break;
        default:
          // abp_link / abp_wait_for_event are driven by the loop itself, not the brain.
          this.transcript.push({ turnSeq, tool: call.tool, ok: false, detail: "tool not drivable from the brain loop" });
          return;
      }
      this.transcript.push({ turnSeq, tool: call.tool, ok: true, detail: "ok" });
    } catch (e) {
      // e.g. egress DLP block, or a capability/turn violation from the driver.
      this.transcript.push({ turnSeq, tool: call.tool, ok: false, detail: `blocked: ${(e as Error).message}` });
    }
  }

  stop(): void {
    this.#stopped = true;
  }
}
