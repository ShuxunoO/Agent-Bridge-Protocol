#!/usr/bin/env node
// Standalone ABP demo host (NOT the production Host SDK — that's P7/F7.1).
// A tiny scripted social scene so you can drive an avatar from Claude Code end to end.
//   node packages/mcp/examples/demo-host.ts [port]
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { loadBundledProfile, profileHash } from "@agent-bridge/validator";

const PORT = Number(process.argv[2] ?? 0);
const CAPS = ["say", "move", "interact_start", "interact_leave", "emote", "noop", "proactive"];
const CONV = "c-mira";
const doc = loadBundledProfile("social/1.json");
const hash = profileHash(doc);

const MIRA_LINES = [
  "Hi there! I'm Mira. I don't think we've met — what brings you to the square?",
  "Nice to meet you. People here mostly trade stories. Got one?",
  "Ha, I like that. Maybe I'll see you at the fountain later.",
];

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT }, () => {
  const p = (wss.address() as AddressInfo).port;
  console.log(`ABP demo host listening on  ws://127.0.0.1:${p}`);
  console.log(`Point the MCP tool at it:   abp_link { url: "ws://127.0.0.1:${p}", target: "avatar-1" }`);
});

wss.on("connection", (ws: WebSocket) => {
  let mid = 0;
  let line = 0;
  let seq = 0;
  const send = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    ws.send(JSON.stringify({ abp: "1", type, id: `h${mid++}`, ts: Date.now(), payload, ...extra }));
  const event = (kind: string, data: unknown) => send("event", { kind, seq: seq++, data }, { session: "sess_demo" });

  const openScene = () => {
    event("perception", {
      self: { position: { x: 5, y: 5 }, status: "standing in the square" },
      nearby: [{ role: { id: "mira", display_name: "Mira" }, distance: 1.5 }],
      world: { context: { place: "town-square", time_of_day: "afternoon" } },
    });
    event("invite", { from_role: { id: "mira", display_name: "Mira" }, conversation_id: CONV });
    event("message", { from_role: { id: "mira", display_name: "Mira" }, conversation_id: CONV, content: MIRA_LINES[line++], seq: 0 });
    event("turn", { conversation_id: CONV, deadline_ms: 120000, allowed_actions: ["say", "emote", "interact_leave", "noop"] });
  };

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    switch (m.type) {
      case "hello":
        send("hello_ack", { abp_core: "1.0.0", profile: { id: "abp.social", version: "1", hash, document: doc }, auth_methods: ["signature"] });
        break;
      case "pair_request":
        send("pair_result", { session: "sess_demo", role: { id: "avatar-1", display_name: "You" }, capabilities: CAPS, profile: { id: "abp.social", version: "1", hash }, expires_at: Date.now() + 3_600_000 });
        setTimeout(openScene, 200);
        break;
      case "action": {
        const { kind, data: d } = m.payload;
        console.log(`avatar -> ${kind}`, JSON.stringify(d));
        if (kind === "say") {
          if (line < MIRA_LINES.length) {
            event("message", { from_role: { id: "mira", display_name: "Mira" }, conversation_id: CONV, content: MIRA_LINES[line++], seq: line });
            event("turn", { conversation_id: CONV, deadline_ms: 120000, allowed_actions: ["say", "emote", "interact_leave", "noop"] });
          } else {
            event("message", { from_role: { id: "mira", display_name: "Mira" }, conversation_id: CONV, content: "(Mira waves and walks off.)", seq: 99 });
          }
        }
        break;
      }
      case "resume":
        openScene();
        break;
      case "bye":
        console.log("avatar disconnected:", m.payload?.reason);
        break;
    }
  });
});
