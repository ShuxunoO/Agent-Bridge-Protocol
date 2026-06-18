import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { WssTransport, type InvalidFrame } from "../src/index.ts";

const TIMEOUT = { timeout: 3000 };

function validHello() {
  return {
    abp: "1",
    type: "hello",
    id: "01J9HELLO",
    ts: 1718600000000,
    payload: { abp_core: "1.0.0", profiles: [{ id: "abp.social", version: "1" }], bindings: ["wss"] },
  };
}

/** Start a loopback ws server; `onConn` wires each connection. Returns the server + port. */
function startServer(onConn: (ws: WebSocket) => void): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, port });
    });
    wss.on("connection", onConn);
  });
}

test("valid message round-trips through the transport (loopback e2e)", TIMEOUT, async () => {
  const { wss, port } = await startServer((ws) => ws.on("message", (d) => ws.send(d.toString())));
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  try {
    await t.connect();
    const received = once(t, "message");
    t.send(validHello());
    const [msg, type] = await received;
    assert.equal(type, "hello");
    assert.deepEqual(msg, validHello());
  } finally {
    t.close();
    wss.close();
  }
});

test("invalid inbound frame is rejected, not delivered as a message", TIMEOUT, async () => {
  // Server pushes a structurally-invalid message (unknown type) on connect.
  const bad = JSON.stringify({ abp: "1", type: "teleport", id: "x", ts: 1, payload: {} });
  const { wss, port } = await startServer((ws) => ws.send(bad));
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  let gotMessage = false;
  t.on("message", () => {
    gotMessage = true;
  });
  // Register before connect: the server pushes immediately, so "invalid" may fire on open.
  const invalidP = once(t, "invalid");
  try {
    await t.connect();
    const [info] = (await invalidP) as [InvalidFrame];
    assert.equal(gotMessage, false);
    assert.equal(info.reason, "bad_message");
  } finally {
    t.close();
    wss.close();
  }
});

test("oversize inbound frame is rejected", TIMEOUT, async () => {
  const huge = JSON.stringify({ abp: "1", type: "bye", id: "x", ts: 1, payload: { reason: "x".repeat(70000) } });
  const { wss, port } = await startServer((ws) => ws.send(huge));
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  const invalidP = once(t, "invalid");
  try {
    await t.connect();
    const [info] = (await invalidP) as [InvalidFrame];
    assert.match(info.errors[0], /exceeds/);
  } finally {
    t.close();
    wss.close();
  }
});

test("non-JSON inbound frame is rejected", TIMEOUT, async () => {
  const { wss, port } = await startServer((ws) => ws.send("{not json"));
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  const invalidP = once(t, "invalid");
  try {
    await t.connect();
    const [info] = (await invalidP) as [InvalidFrame];
    assert.match(info.errors[0], /not valid JSON/);
  } finally {
    t.close();
    wss.close();
  }
});

test("binary inbound frame is rejected", TIMEOUT, async () => {
  const { wss, port } = await startServer((ws) => ws.send(Buffer.from([1, 2, 3, 4])));
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  const invalidP = once(t, "invalid");
  try {
    await t.connect();
    const [info] = (await invalidP) as [InvalidFrame];
    assert.match(info.errors[0], /binary/);
  } finally {
    t.close();
    wss.close();
  }
});

test("send() refuses an invalid outbound message", TIMEOUT, async () => {
  const { wss, port } = await startServer(() => {});
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  try {
    await t.connect();
    assert.throws(() => t.send({ abp: "1", type: "nope", id: "x", ts: 1, payload: {} }), /invalid ABP message/);
  } finally {
    t.close();
    wss.close();
  }
});

test("send() before open throws", () => {
  const t = new WssTransport("ws://127.0.0.1:1");
  assert.throws(() => t.send(validHello()), /not open/);
});

// ---- TLS posture (§2) ------------------------------------------------------

test("plaintext ws:// to a non-loopback host is refused at construction", () => {
  assert.throws(() => new WssTransport("ws://example.com:8080"), /loopback/);
});

test("unsupported scheme is refused", () => {
  assert.throws(() => new WssTransport("http://127.0.0.1:8080"), /scheme/);
});

test("wss:// to a remote host is accepted (construction)", () => {
  assert.doesNotThrow(() => new WssTransport("wss://host.example.com/abp"));
});
