import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer, Connector } from "../src/index.ts";
import { drivableHost, startServer, perception, flush } from "./_host.ts";

const TIMEOUT = { timeout: 5000 };
const tmpMemDir = () => mkdtempSync(join(tmpdir(), "abp-mem-"));

/** Wire a real MCP client to the agent-bridge server over an in-memory transport pair. */
async function mcpPair(connector = new Connector({ memoryDir: tmpMemDir() })) {
  const server = createServer(connector);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return { client, connector };
}

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "null");
}

test("server registers the six ABP tools", TIMEOUT, async () => {
  const { client } = await mcpPair();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["abp_act", "abp_link", "abp_perceive", "abp_persona_memory", "abp_say", "abp_wait_for_event"]);
  } finally {
    await client.close();
  }
});

test("persona_memory round-trips through MCP callTool", TIMEOUT, async () => {
  const { client } = await mcpPair();
  try {
    await client.callTool({ name: "abp_persona_memory", arguments: { op: "set", key: "k", value: { n: 1 } } });
    const got = parse(await client.callTool({ name: "abp_persona_memory", arguments: { op: "get", key: "k" } }) as never);
    assert.deepEqual(got, { value: { n: 1 } });
  } finally {
    await client.close();
  }
});

test("abp_link + abp_wait_for_event drive the full stack over MCP", TIMEOUT, async () => {
  const host = drivableHost();
  const { wss, port } = await startServer(host.onConn);
  const { client, connector } = await mcpPair();
  try {
    const link = parse(await client.callTool({ name: "abp_link", arguments: { url: `ws://127.0.0.1:${port}`, target: "avatar-1" } }) as never);
    assert.equal(link.role.id, "avatar-1");

    host.sendEvent("perception", 0, perception());
    await flush();
    const ev = parse(await client.callTool({ name: "abp_wait_for_event", arguments: { kinds: ["perception"], timeout_ms: 2000 } }) as never);
    assert.equal(ev.event.kind, "perception");

    const per = parse(await client.callTool({ name: "abp_perceive", arguments: {} }) as never);
    assert.equal(per.perception.self.status, "idle");
  } finally {
    connector.close();
    await client.close();
    wss.close();
  }
});

test("calling a tool before link returns an MCP error", TIMEOUT, async () => {
  const { client } = await mcpPair();
  try {
    const res = (await client.callTool({ name: "abp_perceive", arguments: {} })) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(res.isError, true);
    assert.match(res.content[0].text ?? "", /not linked/);
  } finally {
    await client.close();
  }
});
