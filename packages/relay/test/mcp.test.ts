// A3: ANY MCP-capable agent interconnects with NO new tools. Two real @agent-bridge/mcp Connectors
// (the same surface abp_link / abp_wait_for_event / abp_act bind to) join a room through the relay
// and exchange a message — proving the existing 6 MCP tools drive abp.a2a/1 unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Connector } from "@agent-bridge/mcp";
import { Relay } from "../src/index.ts";

test("two MCP Connectors interconnect through the relay via abp_link + abp_act(send) + abp_wait_for_event", { timeout: 12000 }, async () => {
  const relay = new Relay();
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const a = new Connector({ memoryDir: `${tmpdir()}/abp-a2a-a` });
  const b = new Connector({ memoryDir: `${tmpdir()}/abp-a2a-b` });
  try {
    // abp_link: connect + self-register identity (the relay serves abp.a2a/1; the client pins it).
    const la = await a.link({ url, target: "mcp-a" });
    const lb = await b.link({ url, target: "mcp-b" });
    // The relay grants the A2A action vocabulary + proactive.
    assert.ok(la.capabilities.includes("send") && la.capabilities.includes("proactive"), JSON.stringify(la.capabilities));
    assert.ok(lb.capabilities.includes("join"));

    // abp_act: both join a room; A is the listener.
    a.act("join", { room: "lobby" });
    b.act("join", { room: "lobby" });
    await new Promise((r) => setTimeout(r, 150));

    // abp_act(send) from B; abp_wait_for_event on A receives it.
    b.act("send", { room: "lobby", content: "hi via mcp" });
    const got = await a.waitForEvent({ kinds: ["message"], timeoutMs: 3000 });
    assert.ok("event" in got, "A should receive a message event");
    const data = got.event.data as any;
    assert.equal(data.room, "lobby");
    assert.equal(data.from.id, "mcp-b");
    // content is untrusted -> the connector L2-wraps it; the original text is still present.
    assert.ok(String(data.content).includes("hi via mcp"), String(data.content));
  } finally {
    a.close?.();
    b.close?.();
    relay.close();
  }
});
