/**
 * The relay's rooms engine (abp.a2a/1). Pure membership + fan-out logic, decoupled from transport so
 * it is unit-testable: it is handed an `emit(agentId, event)` and turns each agent action into the
 * events delivered to room members. Topology: 1v1 = dm (a private 2-member room), 1vn = send into a
 * room (broadcast to other members), mvn = a group room many agents send into.
 */

export type RoomPolicy = "open" | "invite" | "closed";
export type RelayEvent = { kind: string; data: Record<string, unknown> };
/** Deliver an event to one agent's session (no-op if that agent is offline). */
export type Emit = (agentId: string, event: RelayEvent) => void;

const dmRoomId = (a: string, b: string) => `dm:${[a, b].sort().join("|")}`;

export class RelayRooms {
  readonly #emit: Emit;
  readonly #members = new Map<string, Set<string>>(); // room -> member agent ids
  readonly #policy = new Map<string, RoomPolicy>();
  readonly #names = new Map<string, string>(); // agentId -> display_name
  readonly #seq = new Map<string, number>(); // room -> next message seq

  constructor(emit: Emit) {
    this.#emit = emit;
  }

  setName(agentId: string, displayName?: string) {
    if (displayName) this.#names.set(agentId, displayName);
  }

  #ref(agentId: string) {
    const display_name = this.#names.get(agentId);
    return display_name ? { id: agentId, display_name } : { id: agentId };
  }

  #others(room: string, agentId: string): string[] {
    return [...(this.#members.get(room) ?? [])].filter((m) => m !== agentId);
  }

  #nextSeq(room: string): number {
    const n = this.#seq.get(room) ?? 0;
    this.#seq.set(room, n + 1);
    return n;
  }

  #sendRoster(room: string, toAgentId: string) {
    const members = [...(this.#members.get(room) ?? [])].map((m) => this.#ref(m));
    this.#emit(toAgentId, { kind: "roster", data: { room, members } });
  }

  #addMember(room: string, agentId: string) {
    let set = this.#members.get(room);
    if (!set) {
      set = new Set();
      this.#members.set(room, set);
    }
    if (set.has(agentId)) return false;
    set.add(agentId);
    return true;
  }

  /** Agent connected: record its display name. */
  online(agentId: string, displayName?: string) {
    this.setName(agentId, displayName);
  }

  /** Agent disconnected: drop it from every room and announce departure. */
  offline(agentId: string) {
    for (const [room, set] of this.#members) {
      if (set.delete(agentId)) {
        for (const m of set) this.#emit(m, { kind: "presence", data: { room, agent: this.#ref(agentId), status: "left" } });
      }
    }
    this.#names.delete(agentId);
  }

  /** Handle one agent action (the relay's onAction). Returns nothing; effects are emitted. */
  handle(agentId: string, kind: string, data: Record<string, unknown>) {
    switch (kind) {
      case "create_room": {
        const room = String(data.room);
        const policy = (data.policy as RoomPolicy) ?? "open";
        if (!this.#policy.has(room)) this.#policy.set(room, policy);
        this.#addMember(room, agentId);
        this.#sendRoster(room, agentId);
        return;
      }
      case "join": {
        const room = String(data.room);
        if ((this.#policy.get(room) ?? "open") === "closed") return; // not joinable
        const added = this.#addMember(room, agentId);
        // The joiner gets the current roster; existing members get a presence(joined).
        this.#sendRoster(room, agentId);
        if (added) for (const m of this.#others(room, agentId)) this.#emit(m, { kind: "presence", data: { room, agent: this.#ref(agentId), status: "joined" } });
        return;
      }
      case "leave": {
        const room = String(data.room);
        const set = this.#members.get(room);
        if (set?.delete(agentId)) {
          for (const m of set) this.#emit(m, { kind: "presence", data: { room, agent: this.#ref(agentId), status: "left" } });
        }
        return;
      }
      case "send": {
        const room = String(data.room);
        if (!this.#members.get(room)?.has(agentId)) return; // must be a member to send
        const seq = this.#nextSeq(room);
        const out: Record<string, unknown> = { room, from: this.#ref(agentId), content: String(data.content), seq };
        if (data.reply_to !== undefined) out.reply_to = data.reply_to;
        for (const m of this.#others(room, agentId)) this.#emit(m, { kind: "message", data: out });
        return;
      }
      case "dm": {
        const to = String(data.to);
        const room = dmRoomId(agentId, to);
        this.#addMember(room, agentId);
        this.#addMember(room, to);
        const seq = this.#nextSeq(room);
        this.#emit(to, { kind: "message", data: { room, from: this.#ref(agentId), content: String(data.content), seq, dm: true } });
        return;
      }
      case "roster": {
        this.#sendRoster(String(data.room), agentId);
        return;
      }
    }
  }
}
