import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { ProfileLoader, loadBundledProfile, profileHash, type PinnedProfile } from "@agent-bridge/validator";
import {
  WssTransport,
  Keypair,
  Session,
  pair,
  Driver,
  type TurnHandler,
  type EventHandler,
} from "../src/index.ts";

const TIMEOUT = { timeout: 5000 };
const ALL_CAPS = ["say", "move", "interact_start", "interact_leave", "emote", "noop", "proactive"];

/** A host that completes pairing, then lets the test push events and inspect received actions. */
function drivableHost() {
  const doc = loadBundledProfile("social/1.json");
  const hash = profileHash(doc);
  const actions: { payload: { kind: string; data: Record<string, unknown> }; corr?: string }[] = [];
  let sock: WebSocket | undefined;
  let idc = 0;
  const onConn = (ws: WebSocket) => {
    sock = ws;
    const send = (type: string, payload: unknown) => ws.send(JSON.stringify({ abp: "1", type, id: `h${idc++}`, ts: 1, payload }));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "hello") send("hello_ack", { abp_core: "1.0.0", profile: { id: "abp.social", version: "1", hash, document: doc }, auth_methods: ["signature"] });
      else if (m.type === "pair_request") send("pair_result", { session: "sess_tok", role: { id: "avatar-1" }, capabilities: ALL_CAPS, profile: { id: "abp.social", version: "1", hash }, expires_at: 2_000_000_000_000 });
      else if (m.type === "action") actions.push(m);
    });
  };
  const sendEvent = (kind: string, seq: number, dataObj: unknown) =>
    sock!.send(JSON.stringify({ abp: "1", type: "event", id: `evt-${seq}`, ts: 1, session: "sess_tok", payload: { kind, seq, data: dataObj } }));
  return { onConn, actions, sendEvent };
}

function startServer(onConn: (ws: WebSocket) => void): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => resolve({ wss, port: (wss.address() as AddressInfo).port }));
    wss.on("connection", onConn);
  });
}

type ExtraOpts = { onTurn?: TurnHandler; onEvent?: EventHandler; turnKind?: string; noopOnTimeout?: boolean };

type Setup = {
  wss: WebSocketServer;
  t: WssTransport;
  driver: Driver;
  host: ReturnType<typeof drivableHost>;
  session: Session;
  profile: PinnedProfile;
  teardown: () => void;
};

async function setup(host = drivableHost(), opts: ExtraOpts = {}): Promise<Setup> {
  const { wss, port } = await startServer(host.onConn);
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  await t.connect();
  const { session, profile } = await pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-1" });
  const driver = new Driver(t, { session, profile, ...opts });
  driver.start();
  const teardown = () => {
    driver.stop();
    t.close();
    wss.close();
  };
  return { wss, t, driver, host, session, profile, teardown };
}

const perception = () => ({ self: { position: { x: 0, y: 0 }, status: "idle" }, nearby: [] });
const flush = () => new Promise((r) => setTimeout(r, 60));

test("dispatches events by kind and tracks lastEventSeq", TIMEOUT, async () => {
  const { driver, host, teardown } = await setup();
  try {
    const got = once(driver, "perception");
    host.sendEvent("perception", 0, perception());
    const [data] = await got;
    assert.equal((data as { self: { status: string } }).self.status, "idle");

    const tickGot = once(driver, "tick");
    host.sendEvent("tick", 1, { world_time: 99 });
    await tickGot;
    host.sendEvent("tick", 2, { world_time: 100 });
    await flush();
    assert.equal(driver.lastEventSeq, 2);
  } finally {
    teardown();
  }
});

test("turn -> onTurn action is submitted correlated to the turn id", TIMEOUT, async () => {
  const host = drivableHost();
  const { driver, teardown } = await setup(host, {
    onTurn: () => ({ kind: "say", data: { conversation_id: "c1", text: "hello there" } }),
  });
  try {
    host.sendEvent("turn", 5, { deadline_ms: 2000, allowed_actions: ["say", "noop"] });
    await flush();
    const act = host.actions.find((a) => a.payload.kind === "say");
    assert.ok(act, "host received a say action");
    assert.equal(act!.corr, "evt-5");
    assert.deepEqual(act!.payload.data, { conversation_id: "c1", text: "hello there" });
  } finally {
    teardown();
  }
});

test("turn deadline -> turn_timeout + noop submitted", TIMEOUT, async () => {
  const host = drivableHost();
  const { driver, teardown } = await setup(host, { onTurn: () => new Promise(() => {}) });
  try {
    const timedOut = once(driver, "turn_timeout");
    host.sendEvent("turn", 8, { deadline_ms: 30, allowed_actions: ["say", "noop"] });
    await timedOut;
    await flush();
    const noop = host.actions.find((a) => a.payload.kind === "noop");
    assert.ok(noop, "noop submitted on timeout");
    assert.equal(noop!.corr, "evt-8");
  } finally {
    teardown();
  }
});

test("action outside turn.allowed_actions is refused (emits error, not sent)", TIMEOUT, async () => {
  const host = drivableHost();
  const { driver, teardown } = await setup(host, {
    onTurn: () => ({ kind: "say", data: { conversation_id: "c1", text: "hi" } }),
  });
  try {
    const errored = once(driver, "error");
    host.sendEvent("turn", 3, { deadline_ms: 2000, allowed_actions: ["noop"] });
    const [err] = await errored;
    assert.match((err as Error).message, /allowed_actions/);
    await flush();
    assert.equal(host.actions.find((a) => a.payload.kind === "say"), undefined);
  } finally {
    teardown();
  }
});

test("composed validation active: invalid profile data -> invalid, not dispatched", TIMEOUT, async () => {
  const host = drivableHost();
  const { driver, teardown } = await setup(host);
  try {
    let dispatched = false;
    driver.on("event", () => { dispatched = true; });
    const invalid = once(driver, "invalid");
    host.sendEvent("message", 1, { conversation_id: "c1", seq: 0 }); // missing from_role + content
    await invalid;
    await flush();
    assert.equal(dispatched, false);
  } finally {
    teardown();
  }
});

test("proactive act() submits without corr", TIMEOUT, async () => {
  const host = drivableHost();
  const { driver, host: h, teardown } = await setup(host);
  try {
    driver.act({ kind: "emote", data: { emote: "wave" } });
    await flush();
    const emote = h.actions.find((a) => a.payload.kind === "emote");
    assert.ok(emote, "proactive emote submitted");
    assert.equal(emote!.corr, undefined);
  } finally {
    teardown();
  }
});

test("manual mode: respond() submits correlated to the current turn and clears it", TIMEOUT, async () => {
  const host = drivableHost();
  const { driver, teardown } = await setup(host, { noopOnTimeout: false }); // no onTurn -> manual
  try {
    const turnGot = once(driver, "turn");
    host.sendEvent("turn", 4, { deadline_ms: 2000, allowed_actions: ["say", "noop"] });
    await turnGot;
    assert.equal(driver.currentTurnId, "evt-4");
    driver.respond({ kind: "say", data: { conversation_id: "c1", text: "manual hi" } });
    await flush();
    const say = host.actions.find((a) => a.payload.kind === "say");
    assert.ok(say);
    assert.equal(say!.corr, "evt-4");
    assert.equal(driver.currentTurnId, null);
  } finally {
    teardown();
  }
});

test("respond() with no active turn throws", TIMEOUT, async () => {
  const { driver, teardown } = await setup(drivableHost(), { noopOnTimeout: false });
  try {
    assert.throws(() => driver.respond({ kind: "noop", data: {} }), /no active turn/);
  } finally {
    teardown();
  }
});

test("respond() enforces turn.allowed_actions", TIMEOUT, async () => {
  const host = drivableHost();
  const { driver, teardown } = await setup(host, { noopOnTimeout: false });
  try {
    const turnGot = once(driver, "turn");
    host.sendEvent("turn", 6, { deadline_ms: 2000, allowed_actions: ["noop"] });
    await turnGot;
    assert.throws(() => driver.respond({ kind: "say", data: { conversation_id: "c1", text: "no" } }), /allowed_actions/);
  } finally {
    teardown();
  }
});

test("act() requires the proactive capability", TIMEOUT, async () => {
  const host = drivableHost();
  const { t, profile, session, teardown } = await setup(host);
  try {
    const limited = new Session({ token: session.token, role: session.role, capabilities: ["say"], profile: session.profile, expiresAt: session.expiresAt });
    const d = new Driver(t, { session: limited, profile });
    assert.throws(() => d.act({ kind: "say", data: { conversation_id: "c1", text: "x" } }), /proactive/);
  } finally {
    teardown();
  }
});
