import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadBundledProfile, profileHash } from "@agent-bridge/validator";
import { Connector, AvatarController } from "../src/index.ts";

const ALL_CAPS = ["say", "move", "interact_start", "interact_leave", "emote", "noop", "proactive"];
const tmpMem = () => mkdtempSync(join(tmpdir(), "abp-mem-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mock host that pairs and records every inbound message type (so we can see `bye`). */
function recordingHost() {
  const doc = loadBundledProfile("social/1.json");
  const hash = profileHash(doc);
  const messages: { type: string; payload: Record<string, unknown> }[] = [];
  let idc = 0;
  const onConn = (ws: WebSocket) => {
    const send = (type: string, payload: unknown) => ws.send(JSON.stringify({ abp: "1", type, id: `h${idc++}`, ts: 1, payload }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      messages.push({ type: m.type, payload: m.payload });
      if (m.type === "hello") send("hello_ack", { abp_core: "1.0.0", profile: { id: "abp.social", version: "1", hash, document: doc }, auth_methods: ["signature"] });
      else if (m.type === "pair_request") send("pair_result", { session: "tok", role: { id: "avatar-1" }, capabilities: ALL_CAPS, profile: { id: "abp.social", version: "1", hash }, expires_at: 2_000_000_000_000 });
    });
  };
  return { onConn, messages };
}

function startServer(onConn: (ws: WebSocket) => void): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => resolve({ wss, port: (wss.address() as AddressInfo).port }));
    wss.on("connection", onConn);
  });
}

test("config toggles between in_the_loop and autopilot", () => {
  const ctrl = new AvatarController(new Connector({ memoryDir: tmpMem() }));
  assert.equal(ctrl.mode, "in_the_loop");
  const seen: string[] = [];
  ctrl.on("mode", (m) => seen.push(m));
  ctrl.setMode("autopilot");
  assert.equal(ctrl.mode, "autopilot");
  ctrl.setMode("in_the_loop");
  assert.equal(ctrl.mode, "in_the_loop");
  assert.deepEqual(seen, ["autopilot", "in_the_loop"]);
  // starting autopilot in the wrong mode is refused
  assert.throws(() => ctrl.startAutopilot({ brain: () => [], maxTurns: 1 }), /setMode\("autopilot"\)/);
});

test("kill switch sends bye, tears down, and is idempotent", { timeout: 10000 }, async () => {
  const host = recordingHost();
  const { wss, port } = await startServer(host.onConn);
  const connector = new Connector({ memoryDir: tmpMem() });
  await connector.link({ url: `ws://127.0.0.1:${port}`, target: "avatar-1" });
  const ctrl = new AvatarController(connector);
  const killed: string[] = [];
  ctrl.on("killed", (r) => killed.push(r));
  try {
    assert.equal(connector.linked, true);
    ctrl.kill("done for now");
    await sleep(60); // let the bye frame flush to the host
    assert.equal(connector.linked, false);
    const bye = host.messages.find((m) => m.type === "bye");
    assert.ok(bye, "host must have received a bye");
    assert.equal(bye!.payload.reason, "done for now");
    // idempotent + post-kill guards
    ctrl.kill();
    assert.deepEqual(killed, ["done for now"]); // only one killed event
    assert.throws(() => ctrl.setMode("autopilot"), /killed/);
    assert.throws(() => connector.perceive(), /not linked/);
  } finally {
    wss.close();
  }
});

test("kill while autopilot is running stops the loop", { timeout: 10000 }, async () => {
  const host = recordingHost();
  const { wss, port } = await startServer(host.onConn);
  const connector = new Connector({ memoryDir: tmpMem() });
  await connector.link({ url: `ws://127.0.0.1:${port}`, target: "avatar-1" });
  const ctrl = new AvatarController(connector, { mode: "autopilot" });
  try {
    // brain never gets a turn (host sends none); the loop is waiting in waitForEvent
    const run = ctrl.startAutopilot({ brain: () => [], maxTurns: 5, waitTimeoutMs: 3000 });
    assert.equal(ctrl.running, true);
    await sleep(30);
    ctrl.kill();
    await run; // close() resolves the pending waiter, so the loop returns promptly
    assert.equal(ctrl.running, false);
    assert.equal(connector.linked, false);
  } finally {
    wss.close();
  }
});
