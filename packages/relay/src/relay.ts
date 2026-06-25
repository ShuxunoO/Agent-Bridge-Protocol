/**
 * The A2A relay (rendezvous). A generic ABP host serving abp.a2a/1: any agent connects OUTBOUND,
 * self-registers its identity (a role), and exchanges messages through rooms. Reuses the Core
 * handshake/auth/resume unchanged; agents are granted the `proactive` capability so they send
 * whenever they like (no turns). Connection can be gated on an invite (§4.2.1) via requireInvite.
 */
import { AbpHost } from "@agent-bridge/host";
import { loadBundledProfile, type JSONSchema } from "@agent-bridge/validator";
import { RelayRooms } from "./rooms.ts";

export type RelayOptions = {
  /** Secret for minting/verifying connection invites; enables mintInvite. */
  inviteSecret?: string;
  /** Require an invite to connect (self-registered agents become claim_required). Needs inviteSecret. */
  requireInvite?: boolean;
};

export class Relay {
  readonly #host: AbpHost;
  readonly #rooms: RelayRooms;
  readonly #online = new Set<string>();

  constructor(opts: RelayOptions = {}) {
    const document = loadBundledProfile("a2a/1.json") as JSONSchema;
    // emit closure resolves #host lazily (it's assigned just below, before any emit fires).
    this.#rooms = new RelayRooms((agentId, ev) => this.#host.emit(agentId, ev));
    this.#host = new AbpHost({
      profile: { id: "abp.a2a", version: "1", document },
      // Online agents (for roles_list / discovery). New agents self-register at bind.
      roles: () => [...this.#online].map((id) => ({ id })),
      allowSelfRegister: true,
      selfRegisterPolicy: opts.requireInvite ? "claim_required" : "open",
      inviteSecret: opts.inviteSecret,
      onBind: (s) => {
        this.#online.add(s.roleId);
        this.#rooms.online(s.roleId);
      },
      onBye: (s) => this.#drop(s.roleId),
      onAction: (s, a) => this.#rooms.handle(s.roleId, a.kind, a.data),
    });
  }

  #drop(agentId: string) {
    this.#rooms.offline(agentId);
    this.#online.delete(agentId);
  }

  /** Start the relay (WSS). Resolves with the bound port. */
  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return this.#host.listen(port, host);
  }
  close(): void {
    this.#host.close();
  }

  /** Online agent ids (discovery). */
  agents(): string[] {
    return [...this.#online];
  }

  /** Mint a connection invite authorizing an agent id to connect (requires inviteSecret). */
  mintInvite(agentId: string, opts: { url: string; ttlMs?: number; caps?: string[] }): string {
    return this.#host.mintInvite(agentId, opts);
  }
}
