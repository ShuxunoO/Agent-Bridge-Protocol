import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { loadBundledProfile, ProfileLoader, type JSONSchema } from "@agent-bridge/validator";
import { WssTransport, Keypair, pair, Driver, makeEnvelope, type AbpEvent } from "@agent-bridge/client";
import { AbpHost, type HostEvent } from "../src/index.ts";

const social = loadBundledProfile("social/1.json") as JSONSchema;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(p: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!p()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await sleep(15);
  }
}

function mkHost(onAction?: (role: string, kind: string, data: any, corr?: string) => void, roles: { id: string; display_name?: string }[] = [{ id: "avatar-1", display_name: "NPC" }]) {
  return new AbpHost({
    profile: { id: "abp.social", version: "1", document: social },
    roles: () => roles,
    onAction: (s, a, corr) => onAction?.(s.roleId, a.kind, a.data, corr),
  });
}

async function pairClient(port: number, target = "avatar-1") {
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  t.on("error", () => {});
  await t.connect();
  const { session, profile } = await pair(t, Keypair.generate(), new ProfileLoader(), { target });
  return { t, session, profile };
}

test("real client <-> real host: handshake, turn, and action delivery", { timeout: 10000 }, async () => {
  const got: any[] = [];
  const host = mkHost((role, kind, data, corr) => got.push({ role, kind, data, corr }));
  const port = await host.listen(0);
  const { t, session, profile } = await pairClient(port);
  try {
    assert.equal(session.role.id, "avatar-1");
    assert.equal(session.profile.id, "abp.social");
    const driver = new Driver(t, { session, profile, onTurn: (d) => ({ kind: "say", data: { conversation_id: String(d.conversation_id), text: "hi there" } }) });
    driver.start();
    host.emit("avatar-1", { kind: "turn", data: { conversation_id: "c", deadline_ms: 2000, allowed_actions: ["say", "noop"] } });
    await waitUntil(() => got.length > 0);
    assert.equal(got[0].role, "avatar-1");
    assert.equal(got[0].kind, "say");
    assert.equal(got[0].data.text, "hi there");
    assert.ok(got[0].corr, "say must correlate to the turn");
    driver.stop();
  } finally {
    t.close();
    host.close();
  }
});

test("resume backfills buffered events past the cursor", { timeout: 10000 }, async () => {
  const host = mkHost(undefined, [{ id: "avatar-2", display_name: "B" }]);
  const port = await host.listen(0);
  const { t, session, profile } = await pairClient(port, "avatar-2");
  const seen1: number[] = [];
  const d1 = new Driver(t, { session, profile });
  d1.on("event", (e: AbpEvent) => seen1.push(e.seq));
  d1.start();
  host.emit("avatar-2", { kind: "tick", data: { world_time: 1 } }); // seq 0
  host.emit("avatar-2", { kind: "tick", data: { world_time: 2 } }); // seq 1
  host.emit("avatar-2", { kind: "tick", data: { world_time: 3 } }); // seq 2
  await waitUntil(() => seen1.includes(2));
  d1.stop();
  t.close();
  await sleep(30); // host sees the socket close, unbinds the role (token still valid)

  // reconnect + resume from cursor 1 -> host backfills seq 2
  const t2 = new WssTransport(`ws://127.0.0.1:${port}`);
  t2.on("error", () => {});
  await t2.connect();
  const seen2: number[] = [];
  const d2 = new Driver(t2, { session, profile });
  d2.on("event", (e: AbpEvent) => seen2.push(e.seq));
  d2.start();
  t2.send(makeEnvelope("resume", { last_event_seq: 1 }, { session: session.token }));
  try {
    await waitUntil(() => seen2.includes(2));
    assert.ok(seen2.includes(2), "buffered event seq 2 must be backfilled on resume");
    // after re-attach the host can keep driving
    host.emit("avatar-2", { kind: "tick", data: { world_time: 4 } }); // seq 3
    await waitUntil(() => seen2.includes(3));
  } finally {
    d2.stop();
    t2.close();
    host.close();
  }
});

test("host rejects a forged pairing signature", { timeout: 10000 }, async () => {
  const host = mkHost(undefined, [{ id: "avatar-3" }]);
  const port = await host.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on("open", r));
  const replies: any[] = [];
  ws.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
  const send = (type: string, payload: unknown) => ws.send(JSON.stringify({ abp: "1", type, id: "x" + Math.random(), ts: 1, payload }));
  try {
    send("hello", { abp_core: "1.0.0", profiles: [{ id: "abp.social", version: "1" }], bindings: ["wss"] });
    await waitUntil(() => replies.some((m) => m.type === "hello_ack"));
    send("pair_request", { target: "avatar-3" });
    await waitUntil(() => replies.some((m) => m.type === "pair_challenge"));
    const nonce = replies.find((m) => m.type === "pair_challenge").payload.nonce;
    const kp = Keypair.generate();
    send("pair_request", { target: "avatar-3", pubkey: kp.publicKey, nonce, signature: kp.sign("not-the-nonce") });
    await waitUntil(() => replies.some((m) => m.type === "error"));
    const err = replies.find((m) => m.type === "error");
    assert.equal(err.payload.code, "unauthorized");
  } finally {
    ws.close();
    host.close();
  }
});

test("host enforces allowed_actions server-side (forbidden)", { timeout: 10000 }, async () => {
  const host = mkHost(undefined, [{ id: "avatar-4" }]);
  const port = await host.listen(0);
  const { t, session, profile } = await pairClient(port, "avatar-4");
  const errors: any[] = [];
  const driver = new Driver(t, { session, profile }); // manual mode
  driver.on("host_error", (p) => errors.push(p));
  driver.start();
  try {
    host.emit("avatar-4", { kind: "turn", data: { conversation_id: "c", deadline_ms: 5000, allowed_actions: ["noop"] } });
    await waitUntil(() => driver.currentTurnId !== null);
    // bypass the client-side allowed check by crafting the frame directly: say is NOT allowed this turn
    t.send(makeEnvelope("action", { kind: "say", data: { conversation_id: "c", text: "sneaky" } }, { session: session.token, corr: driver.currentTurnId! }));
    await waitUntil(() => errors.length > 0);
    assert.equal(errors[0].code, "forbidden");
  } finally {
    driver.stop();
    t.close();
    host.close();
  }
});

test("host rejects an unknown message type", { timeout: 10000 }, async () => {
  const host = mkHost();
  const port = await host.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on("open", r));
  const replies: any[] = [];
  ws.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
  try {
    ws.send(JSON.stringify({ abp: "1", type: "frobnicate", id: "x", ts: 1, payload: {} }));
    await waitUntil(() => replies.some((m) => m.type === "error"));
    assert.equal(replies.find((m) => m.type === "error").payload.code, "bad_message");
  } finally {
    ws.close();
    host.close();
  }
});
