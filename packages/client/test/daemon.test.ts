import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { loadBundledProfile, profileHash } from "@agent-bridge/validator";
import { ConnectionDaemon, Keypair } from "../src/index.ts";

const ALL_CAPS = ["say", "move", "interact_start", "interact_leave", "emote", "noop", "proactive"];

/** A mock ABP host that pairs, auto-streams ticks, handles resume, and can drop the live socket. */
function resumableHost() {
  const doc = loadBundledProfile("social/1.json");
  const hash = profileHash(doc);
  let conns = 0;
  let evtSeq = 0;
  let resumeSeen: number | undefined;
  let current: WebSocket | undefined;
  let idc = 0;

  const streamEvent = (ws: WebSocket, kind: string, data: unknown) => {
    const seq = evtSeq++;
    ws.send(JSON.stringify({ abp: "1", type: "event", id: `evt-${seq}`, ts: 1, session: "tok", payload: { kind, seq, data } }));
  };
  const send = (ws: WebSocket, type: string, payload: unknown) =>
    ws.send(JSON.stringify({ abp: "1", type, id: `h${idc++}`, ts: 1, payload }));

  const onConn = (ws: WebSocket) => {
    conns++;
    current = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "hello") {
        send(ws, "hello_ack", { abp_core: "1.0.0", profile: { id: "abp.social", version: "1", hash, document: doc }, auth_methods: ["signature"] });
      } else if (m.type === "pair_request") {
        send(ws, "pair_result", { session: "tok", role: { id: "avatar-1", display_name: "NPC" }, capabilities: ALL_CAPS, profile: { id: "abp.social", version: "1", hash }, expires_at: 2_000_000_000_000 });
        setTimeout(() => {
          streamEvent(ws, "tick", { world_time: 1 });
          streamEvent(ws, "tick", { world_time: 2 });
          streamEvent(ws, "tick", { world_time: 3 });
        }, 10);
      } else if (m.type === "resume") {
        resumeSeen = m.payload.last_event_seq;
        setTimeout(() => streamEvent(ws, "tick", { world_time: 4 }), 10); // event seq continues past the cursor
      }
    });
  };

  return {
    onConn,
    drop: () => current?.close(),
    get resumeSeen() {
      return resumeSeen;
    },
    get conns() {
      return conns;
    },
  };
}

function startServer(onConn: (ws: WebSocket) => void): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => resolve({ wss, port: (wss.address() as AddressInfo).port }));
    wss.on("connection", onConn);
  });
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("daemon reconnects after a drop and resumes with the correct cursor", { timeout: 10000 }, async () => {
  const host = resumableHost();
  const { wss, port } = await startServer(host.onConn);
  const daemon = new ConnectionDaemon({
    url: `ws://127.0.0.1:${port}`,
    keypair: Keypair.generate(),
    pairing: { target: "avatar-1" },
    backoffMs: [40],
  });
  daemon.on("error", () => {}); // expected transient errors on drop
  const reconnected = new Promise((res) => daemon.once("reconnected", res));
  try {
    await daemon.start();
    await waitUntil(() => daemon.lastEventSeq === 2); // got ticks seq 0,1,2
    host.drop(); // force the socket closed
    await reconnected;
    await waitUntil(() => daemon.lastEventSeq === 3); // resumed and got the next event
    assert.equal(host.resumeSeen, 2, "resume must carry the last processed seq");
    assert.ok(host.conns >= 2, "daemon must have reconnected (>=2 connections)");
  } finally {
    daemon.stop();
    wss.close();
  }
});

test("stop() is a clean hot-unplug: no reconnect afterward", { timeout: 10000 }, async () => {
  const host = resumableHost();
  const { wss, port } = await startServer(host.onConn);
  const daemon = new ConnectionDaemon({ url: `ws://127.0.0.1:${port}`, keypair: Keypair.generate(), pairing: { target: "avatar-1" }, backoffMs: [40] });
  daemon.on("error", () => {});
  try {
    await daemon.start();
    await waitUntil(() => daemon.connected);
    const before = host.conns;
    let reconnectedAfterStop = false;
    daemon.on("reconnecting", () => {
      reconnectedAfterStop = true;
    });
    daemon.stop();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(daemon.connected, false);
    assert.equal(reconnectedAfterStop, false);
    assert.equal(host.conns, before, "no new connection after stop()");
  } finally {
    wss.close();
  }
});
