import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { ProfileLoader, loadBundledProfile, profileHash } from "@agent-bridge/validator";
import { WssTransport, Keypair, pair, sendResume, PairingError, verifySignature } from "../src/index.ts";

const TIMEOUT = { timeout: 5000 };
const ALL_CAPS = ["say", "move", "interact_start", "interact_leave", "emote", "noop", "proactive"];

type HostOpts = {
  challenge?: boolean;
  badHash?: boolean;
  rejectPair?: boolean;
  verifySig?: boolean;
  record?: (m: { type: string; payload: Record<string, unknown>; session?: string }) => void;
};

function mockHost(opts: HostOpts) {
  const doc = loadBundledProfile("social/1.json");
  const goodHash = profileHash(doc);
  const hash = opts.badHash ? "sha256-WRONGWRONGWRONG" : goodHash;
  let seq = 0;
  return (ws: WebSocket) => {
    let nonce: string | undefined;
    const send = (type: string, payload: unknown) =>
      ws.send(JSON.stringify({ abp: "1", type, id: `h${seq++}`, ts: 1, payload }));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as { type: string; payload: Record<string, unknown>; session?: string };
      opts.record?.(m);
      if (m.type === "hello") {
        send("hello_ack", { abp_core: "1.0.0", profile: { id: "abp.social", version: "1", hash, document: doc }, auth_methods: ["signature"] });
      } else if (m.type === "pair_request") {
        if (opts.rejectPair) return send("error", { code: "unauthorized", message: "rejected" });
        if (opts.challenge && !m.payload.signature) {
          nonce = "nonce-abcdef12";
          return send("pair_challenge", { nonce });
        }
        if (opts.verifySig && m.payload.signature) {
          const ok = verifySignature(String(m.payload.pubkey), String(nonce), String(m.payload.signature));
          if (!ok) return send("error", { code: "unauthorized", message: "bad signature" });
        }
        const roleId = m.payload.target === "create" ? "avatar-new" : String(m.payload.target);
        send("pair_result", {
          session: "sess_tok_123",
          role: { id: roleId, display_name: "NPC" },
          capabilities: ALL_CAPS,
          profile: { id: "abp.social", version: "1", hash },
          expires_at: 2_000_000_000_000,
        });
      }
    });
  };
}

function startServer(onConn: (ws: WebSocket) => void): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      resolve({ wss, port: (wss.address() as AddressInfo).port });
    });
    wss.on("connection", onConn);
  });
}

async function connectTo(port: number): Promise<WssTransport> {
  const t = new WssTransport(`ws://127.0.0.1:${port}`);
  await t.connect();
  return t;
}

test("happy path: challenge -> sign -> pair_result yields a scoped session", TIMEOUT, async () => {
  const { wss, port } = await startServer(mockHost({ challenge: true, verifySig: true }));
  const t = await connectTo(port);
  try {
    const { session, profile } = await pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-7" });
    assert.equal(session.role.id, "avatar-7");
    assert.equal(session.token, "sess_tok_123");
    assert.equal(profile.id, "abp.social");
    assert.equal(session.can("say"), true);
    assert.equal(session.can("teleport"), false);
    assert.equal(session.proactive, true);
    assert.equal(session.profile.hash, profile.hash);
  } finally {
    t.close();
    wss.close();
  }
});

test("no-challenge host: pair_result directly after first pair_request", TIMEOUT, async () => {
  const { wss, port } = await startServer(mockHost({ challenge: false }));
  const t = await connectTo(port);
  try {
    const { session } = await pair(t, Keypair.generate(), new ProfileLoader(), { target: "create" });
    assert.equal(session.role.id, "avatar-new");
  } finally {
    t.close();
    wss.close();
  }
});

test("tampered profile hash -> pair() throws profile_mismatch (pinning)", TIMEOUT, async () => {
  const { wss, port } = await startServer(mockHost({ badHash: true }));
  const t = await connectTo(port);
  try {
    await assert.rejects(
      pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-1" }),
      (e: unknown) => e instanceof PairingError && e.code === "profile_mismatch",
    );
  } finally {
    t.close();
    wss.close();
  }
});

test("host rejecting pairing -> pair() throws unauthorized", TIMEOUT, async () => {
  const { wss, port } = await startServer(mockHost({ rejectPair: true }));
  const t = await connectTo(port);
  try {
    await assert.rejects(
      pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-1" }),
      (e: unknown) => e instanceof PairingError && e.code === "unauthorized",
    );
  } finally {
    t.close();
    wss.close();
  }
});

test("unknown profile without approval -> profile_unsupported", TIMEOUT, async () => {
  // Host advertises a non-bundled profile id; client has no approval hook.
  const doc = { abp_profile: "acme.world", version: "1", events: { e: { data: { type: "object", additionalProperties: false } } }, actions: { a: { data: { type: "object", additionalProperties: false } } } };
  const hash = profileHash(doc);
  const onConn = (ws: WebSocket) => {
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "hello") {
        ws.send(JSON.stringify({ abp: "1", type: "hello_ack", id: "h0", ts: 1, payload: { abp_core: "1.0.0", profile: { id: "acme.world", version: "1", hash, document: doc }, auth_methods: ["signature"] } }));
      }
    });
  };
  const { wss, port } = await startServer(onConn);
  const t = await connectTo(port);
  try {
    await assert.rejects(
      pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-1", profiles: [{ id: "acme.world", version: "1" }] }),
      (e: unknown) => e instanceof PairingError && e.code === "profile_unsupported",
    );
  } finally {
    t.close();
    wss.close();
  }
});

test("resume sends the token in the envelope and the seq cursor in the payload", TIMEOUT, async () => {
  const records: { type: string; payload: Record<string, unknown>; session?: string }[] = [];
  const { wss, port } = await startServer(mockHost({ record: (m) => records.push(m) }));
  const t = await connectTo(port);
  try {
    const { session } = await pair(t, Keypair.generate(), new ProfileLoader(), { target: "avatar-1" });
    sendResume(t, session, 7);
    await new Promise((r) => setTimeout(r, 50));
    const resume = records.find((m) => m.type === "resume");
    assert.ok(resume, "host received a resume");
    assert.equal(resume!.session, "sess_tok_123");
    assert.equal(resume!.payload.last_event_seq, 7);
  } finally {
    t.close();
    wss.close();
  }
});
