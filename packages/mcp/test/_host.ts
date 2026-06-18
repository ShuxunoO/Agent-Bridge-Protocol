import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { loadBundledProfile, profileHash } from "@agent-bridge/validator";

const ALL_CAPS = ["say", "move", "interact_start", "interact_leave", "emote", "noop", "proactive"];

/** A mock ABP host that pairs, lets a test push events, and records received actions. */
export function drivableHost() {
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
      else if (m.type === "pair_request") send("pair_result", { session: "sess_tok", role: { id: "avatar-1", display_name: "NPC" }, capabilities: ALL_CAPS, profile: { id: "abp.social", version: "1", hash }, expires_at: 2_000_000_000_000 });
      else if (m.type === "action") actions.push(m);
    });
  };
  const sendEvent = (kind: string, seq: number, dataObj: unknown) =>
    sock!.send(JSON.stringify({ abp: "1", type: "event", id: `evt-${seq}`, ts: 1, session: "sess_tok", payload: { kind, seq, data: dataObj } }));
  return { onConn, actions, sendEvent };
}

export function startServer(onConn: (ws: WebSocket) => void): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => resolve({ wss, port: (wss.address() as AddressInfo).port }));
    wss.on("connection", onConn);
  });
}

export const perception = () => ({ self: { position: { x: 0, y: 0 }, status: "idle" }, nearby: [] });
export const message = (text: string) => ({ from_role: { id: "r2" }, conversation_id: "c1", content: text, seq: 0 });
export const flush = () => new Promise((r) => setTimeout(r, 60));
