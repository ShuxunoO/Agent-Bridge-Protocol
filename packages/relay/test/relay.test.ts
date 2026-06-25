// A2A relay e2e: real @agent-bridge/client sessions interconnect through a relay (abp.a2a/1).
// Proves 1v1 (dm), 1vn/mvn (rooms + fan-out), presence/roster, and isolation — all over real wss.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WssTransport, Keypair, pair, Driver, type AbpEvent } from "@agent-bridge/client";
import { ProfileLoader } from "@agent-bridge/validator";
import { Relay } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(p: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!p()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await sleep(15);
  }
}

type Agent = {
  id: string;
  events: AbpEvent[];
  proactive: boolean;
  act: (kind: string, data: unknown) => void;
  stop: () => void;
};

async function connectAgent(port: number, id: string): Promise<Agent> {
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  t.on("error", () => {});
  await t.connect();
  const { session, profile } = await pair(t, Keypair.generate(), new ProfileLoader(), {
    target: id,
    profiles: [{ id: "abp.a2a", version: "1" }],
  });
  const events: AbpEvent[] = [];
  const driver = new Driver(t, { session, profile, noopOnTimeout: false });
  driver.on("event", (ev: AbpEvent) => events.push(ev));
  driver.on("error", () => {});
  driver.start();
  return {
    id,
    events,
    proactive: session.proactive,
    act: (kind, data) => driver.act({ kind, data }),
    stop: () => {
      driver.stop();
      t.close();
    },
  };
}

const msgs = (a: Agent) => a.events.filter((e) => e.kind === "message").map((e) => e.data as any);
const presence = (a: Agent) => a.events.filter((e) => e.kind === "presence").map((e) => e.data as any);

test("mvn group: a room fans each send out to the other members, not the sender", { timeout: 12000 }, async () => {
  const relay = new Relay();
  const port = await relay.listen(0);
  const a = await connectAgent(port, "agent-a");
  const b = await connectAgent(port, "agent-b");
  const c = await connectAgent(port, "agent-c");
  try {
    assert.equal(a.proactive, true, "relay must grant the proactive capability");
    a.act("join", { room: "lobby" });
    b.act("join", { room: "lobby" });
    c.act("join", { room: "lobby" });
    await sleep(150);

    a.act("send", { room: "lobby", content: "hello everyone" });
    await waitFor(() => msgs(b).length >= 1 && msgs(c).length >= 1);
    // b and c receive a's message; a does not receive its own.
    assert.equal(msgs(b)[0].content, "hello everyone");
    assert.equal(msgs(b)[0].from.id, "agent-a");
    assert.equal(msgs(b)[0].room, "lobby");
    assert.equal(msgs(c)[0].content, "hello everyone");
    assert.equal(msgs(a).length, 0, "sender must not receive its own message");

    // mvn: b also sends; a and c receive it.
    b.act("send", { room: "lobby", content: "hi from b" });
    await waitFor(() => msgs(a).length >= 1 && msgs(c).length >= 2);
    assert.equal(msgs(a)[0].content, "hi from b");
    assert.equal(msgs(a)[0].from.id, "agent-b");
  } finally {
    a.stop();
    b.stop();
    c.stop();
    relay.close();
  }
});

test("1v1 dm: only the addressed peer receives it (with dm:true)", { timeout: 12000 }, async () => {
  const relay = new Relay();
  const port = await relay.listen(0);
  const a = await connectAgent(port, "agent-a");
  const b = await connectAgent(port, "agent-b");
  const c = await connectAgent(port, "agent-c");
  try {
    a.act("dm", { to: "agent-b", content: "psst, just you" });
    await waitFor(() => msgs(b).length >= 1);
    assert.equal(msgs(b)[0].content, "psst, just you");
    assert.equal(msgs(b)[0].from.id, "agent-a");
    assert.equal(msgs(b)[0].dm, true);
    await sleep(100);
    assert.equal(msgs(c).length, 0, "a third agent must not see a 1v1 dm");
    assert.equal(msgs(a).length, 0);
  } finally {
    a.stop();
    b.stop();
    c.stop();
    relay.close();
  }
});

test("presence + roster: joining announces to members and the joiner gets the roster", { timeout: 12000 }, async () => {
  const relay = new Relay();
  const port = await relay.listen(0);
  const a = await connectAgent(port, "agent-a");
  const b = await connectAgent(port, "agent-b");
  try {
    a.act("join", { room: "team" });
    await sleep(100);
    b.act("join", { room: "team" });
    // a (already in the room) should get a presence(joined, agent-b).
    await waitFor(() => presence(a).some((p) => p.status === "joined" && p.agent.id === "agent-b"));
    // b (the joiner) should get a roster listing both members.
    await waitFor(() => b.events.some((e) => e.kind === "roster"));
    const roster = b.events.find((e) => e.kind === "roster")!.data as any;
    assert.deepEqual(
      roster.members.map((m: any) => m.id).sort(),
      ["agent-a", "agent-b"],
    );

    // leave announces a presence(left).
    b.act("leave", { room: "team" });
    await waitFor(() => presence(a).some((p) => p.status === "left" && p.agent.id === "agent-b"));
  } finally {
    a.stop();
    b.stop();
    relay.close();
  }
});

test("isolation: a room send is not delivered to a non-member", { timeout: 12000 }, async () => {
  const relay = new Relay();
  const port = await relay.listen(0);
  const a = await connectAgent(port, "agent-a");
  const b = await connectAgent(port, "agent-b");
  const outsider = await connectAgent(port, "agent-out");
  try {
    a.act("join", { room: "private" });
    b.act("join", { room: "private" });
    await sleep(150);
    a.act("send", { room: "private", content: "members only" });
    await waitFor(() => msgs(b).length >= 1);
    await sleep(150);
    assert.equal(msgs(outsider).length, 0, "a non-member must not receive room messages");
  } finally {
    a.stop();
    b.stop();
    outsider.stop();
    relay.close();
  }
});
