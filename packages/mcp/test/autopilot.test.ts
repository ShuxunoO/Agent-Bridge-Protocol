import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadBundledProfile, profileHash } from "@agent-bridge/validator";
import { Connector, Autopilot, type BufferedEvent } from "../src/index.ts";

const ALL_CAPS = ["say", "move", "interact_start", "interact_leave", "emote", "noop", "proactive"];
const tmpMem = () => mkdtempSync(join(tmpdir(), "abp-mem-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A host that pairs then sends `n` turns on a timer, comfortably spaced (40ms) so only one turn
 * is ever outstanding (the autopilot answers in <1ms). Records received actions.
 */
function turnHost(n: number) {
  const doc = loadBundledProfile("social/1.json");
  const hash = profileHash(doc);
  const actions: { payload: { kind: string; data: Record<string, unknown> }; corr?: string }[] = [];
  let sock: WebSocket | undefined;
  let idc = 0;
  const send = (type: string, payload: unknown) => sock!.send(JSON.stringify({ abp: "1", type, id: `h${idc++}`, ts: 1, payload }));
  const sendTurn = (seq: number) =>
    sock!.send(JSON.stringify({ abp: "1", type: "event", id: `evt-${seq}`, ts: 1, session: "tok", payload: { kind: "turn", seq, data: { conversation_id: "c", deadline_ms: 2000, allowed_actions: ["say", "noop", "emote"] } } }));
  const onConn = (ws: WebSocket) => {
    sock = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "hello") send("hello_ack", { abp_core: "1.0.0", profile: { id: "abp.social", version: "1", hash, document: doc }, auth_methods: ["signature"] });
      else if (m.type === "pair_request") {
        send("pair_result", { session: "tok", role: { id: "avatar-1" }, capabilities: ALL_CAPS, profile: { id: "abp.social", version: "1", hash }, expires_at: 2_000_000_000_000 });
        for (let i = 0; i < n; i++) setTimeout(() => sendTurn(i), 10 + i * 40);
      } else if (m.type === "action") {
        actions.push(m);
      }
    });
  };
  return { onConn, actions };
}

function startServer(onConn: (ws: WebSocket) => void): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => resolve({ wss, port: (wss.address() as AddressInfo).port }));
    wss.on("connection", onConn);
  });
}

async function linkedAutopilot(host: ReturnType<typeof turnHost>, opts: { brain: any; maxTurns: number }) {
  const { wss, port } = await startServer(host.onConn);
  const connector = new Connector({ memoryDir: tmpMem() });
  await connector.link({ url: `ws://127.0.0.1:${port}`, target: "avatar-1" });
  const autopilot = new Autopilot(connector, { brain: opts.brain, maxTurns: opts.maxTurns, waitTimeoutMs: 3000 });
  return { connector, autopilot, teardown: () => { connector.close(); wss.close(); } };
}

test("autopilot drives N turns autonomously, each answered with a say", { timeout: 10000 }, async () => {
  const N = 5;
  const host = turnHost(N);
  const brain = ({ event }: { event: BufferedEvent }) => [
    { tool: "abp_say", args: { conversation_id: String(event.data.conversation_id), text: `hello turn ${event.seq}` } },
  ];
  const { autopilot, teardown } = await linkedAutopilot(host, { brain, maxTurns: N });
  try {
    const transcript = await autopilot.run();
    await sleep(60); // let the final action frame flush to the host
    assert.equal(transcript.length, N);
    assert.ok(transcript.every((r) => r.tool === "abp_say" && r.ok));
    assert.equal(host.actions.length, N);
    assert.ok(host.actions.every((a) => a.payload.kind === "say"));
    assert.equal(host.actions[0].payload.data.text, "hello turn 0");
    assert.equal(host.actions[N - 1].payload.data.text, `hello turn ${N - 1}`);
  } finally {
    teardown();
  }
});

test("autopilot refuses an out-of-allowlist tool the brain asks for (L1 runtime)", { timeout: 10000 }, async () => {
  const host = turnHost(1);
  const brain = () => [
    { tool: "Bash", args: { cmd: "cat /etc/passwd" } },
    { tool: "abp_act", args: { kind: "noop" } },
  ];
  const { autopilot, teardown } = await linkedAutopilot(host, { brain, maxTurns: 1 });
  try {
    const transcript = await autopilot.run();
    const bash = transcript.find((r) => r.tool === "Bash");
    const noop = transcript.find((r) => r.tool === "abp_act");
    assert.ok(bash && !bash.ok && /refused/.test(bash.detail));
    assert.ok(noop && noop.ok);
    assert.ok(!host.actions.some((a) => a.payload.kind === "Bash"));
  } finally {
    teardown();
  }
});

test("autopilot's say is DLP-blocked when it would leak a secret (L3 runtime)", { timeout: 10000 }, async () => {
  const host = turnHost(1);
  const secretText = `my token is ghp_${"A".repeat(36)}`;
  const brain = ({ event }: { event: BufferedEvent }) => [
    { tool: "abp_say", args: { conversation_id: String(event.data.conversation_id), text: secretText } },
  ];
  const { autopilot, teardown } = await linkedAutopilot(host, { brain, maxTurns: 1 });
  try {
    const transcript = await autopilot.run();
    await sleep(40);
    const say = transcript.find((r) => r.tool === "abp_say");
    assert.ok(say && !say.ok && /blocked/.test(say.detail));
    assert.ok(!host.actions.some((a) => typeof a.payload.data.text === "string" && (a.payload.data.text as string).includes("ghp_")));
  } finally {
    teardown();
  }
});
