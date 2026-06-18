import { test } from "node:test";
import assert from "node:assert/strict";
import { Connector } from "../src/index.ts";
import { drivableHost, startServer, perception, message, flush } from "./_host.ts";

const TIMEOUT = { timeout: 5000 };

async function linked(host = drivableHost()) {
  const { wss, port } = await startServer(host.onConn);
  const connector = new Connector();
  const result = await connector.link({ url: `ws://127.0.0.1:${port}`, target: "avatar-1" });
  const teardown = () => {
    connector.close();
    wss.close();
  };
  return { connector, host, result, teardown };
}

test("link binds a role and returns capabilities + profile", TIMEOUT, async () => {
  const { connector, result, teardown } = await linked();
  try {
    assert.equal(result.role.id, "avatar-1");
    assert.ok(result.capabilities.includes("say"));
    assert.equal(result.profile.id, "abp.social");
    assert.equal(connector.linked, true);
  } finally {
    teardown();
  }
});

test("perceive returns the latest perception snapshot", TIMEOUT, async () => {
  const { connector, host, teardown } = await linked();
  try {
    host.sendEvent("perception", 0, perception());
    await flush();
    const p = connector.perceive().perception as { self: { status: string } } | null;
    assert.equal(p?.self.status, "idle");
  } finally {
    teardown();
  }
});

test("wait_for_event returns a buffered event immediately", TIMEOUT, async () => {
  const { connector, host, teardown } = await linked();
  try {
    host.sendEvent("tick", 1, { world_time: 7 });
    await flush();
    const r = await connector.waitForEvent({ kinds: ["tick"] });
    assert.ok("event" in r);
    assert.equal((r as { event: { kind: string } }).event.kind, "tick");
  } finally {
    teardown();
  }
});

test("wait_for_event long-polls and resolves when a matching event arrives", TIMEOUT, async () => {
  const { connector, host, teardown } = await linked();
  try {
    const pending = connector.waitForEvent({ kinds: ["message"], timeoutMs: 2000 });
    host.sendEvent("message", 2, message("hello avatar"));
    const r = await pending;
    assert.ok("event" in r);
    const ev = (r as { event: { data: Record<string, unknown> } }).event;
    assert.equal(ev.data.content, "hello avatar");
  } finally {
    teardown();
  }
});

test("wait_for_event times out cleanly", TIMEOUT, async () => {
  const { connector, teardown } = await linked();
  try {
    const r = await connector.waitForEvent({ kinds: ["never"], timeoutMs: 40 });
    assert.deepEqual(r, { timeout: true });
  } finally {
    teardown();
  }
});

test("say correlates to an open turn", TIMEOUT, async () => {
  const host = drivableHost();
  const { connector, teardown } = await linked(host);
  try {
    host.sendEvent("turn", 3, { conversation_id: "c1", deadline_ms: 2000, allowed_actions: ["say", "noop"] });
    const r = await connector.waitForEvent({ kinds: ["turn"] });
    assert.ok("event" in r);
    const res = connector.say("c1", "hi from avatar");
    assert.equal(res.mode, "turn");
    await flush();
    const say = host.actions.find((a) => a.payload.kind === "say");
    assert.ok(say);
    assert.equal(say!.corr, "evt-3");
    assert.deepEqual(say!.payload.data, { conversation_id: "c1", text: "hi from avatar" });
  } finally {
    teardown();
  }
});

test("act submits a proactive action when no turn is open", TIMEOUT, async () => {
  const host = drivableHost();
  const { connector, teardown } = await linked(host);
  try {
    const res = connector.act("emote", { emote: "wave" });
    assert.equal(res.mode, "proactive");
    await flush();
    const emote = host.actions.find((a) => a.payload.kind === "emote");
    assert.ok(emote);
    assert.equal(emote!.corr, undefined);
  } finally {
    teardown();
  }
});

test("persona_memory set/get/list/delete (local only)", TIMEOUT, async () => {
  const { connector, teardown } = await linked();
  try {
    connector.personaMemory("set", "met:alice", { liked: true });
    assert.deepEqual(connector.personaMemory("get", "met:alice"), { value: { liked: true } });
    assert.deepEqual(connector.personaMemory("list"), { keys: ["met:alice"] });
    connector.personaMemory("delete", "met:alice");
    assert.deepEqual(connector.personaMemory("get", "met:alice"), { value: null });
  } finally {
    teardown();
  }
});

test("tools require a link first", async () => {
  const connector = new Connector();
  assert.throws(() => connector.perceive(), /not linked/);
});
