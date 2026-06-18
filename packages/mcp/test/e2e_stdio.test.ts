import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { drivableHost, startServer, perception, flush } from "./_host.ts";

const TIMEOUT = { timeout: 20000 };
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "src", "bin.ts");

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "null");
}

/**
 * Full multi-process e2e: a real MCP client speaks to the actual `agent-bridge-mcp`
 * stdio server (the exact binary Claude Code launches), which connects out over wss
 * to an in-process ABP host. Proves the whole P0-P3 stack end to end.
 */
test("stdio MCP server drives an avatar end to end", TIMEOUT, async () => {
  const host = drivableHost();
  const { wss, port } = await startServer(host.onConn);
  const transport = new StdioClientTransport({ command: "node", args: [BIN], cwd: join(here, ".."), env: process.env as Record<string, string> });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  try {
    // The agent links to the host and binds a role.
    const link = parse((await client.callTool({ name: "abp_link", arguments: { url: `ws://127.0.0.1:${port}`, target: "avatar-1" } })) as never);
    assert.equal(link.role.id, "avatar-1");
    assert.ok(link.capabilities.includes("say"));

    // World pushes perception, then a turn; the agent waits, perceives, and speaks.
    host.sendEvent("perception", 0, perception());
    host.sendEvent("turn", 1, { conversation_id: "c1", deadline_ms: 5000, allowed_actions: ["say", "noop"] });

    const ev = parse((await client.callTool({ name: "abp_wait_for_event", arguments: { kinds: ["turn"], timeout_ms: 5000 } })) as never);
    assert.equal(ev.event.kind, "turn");

    const said = parse((await client.callTool({ name: "abp_say", arguments: { conversation_id: "c1", text: "hi, I'm driven from MCP" } })) as never);
    assert.equal(said.mode, "turn");

    await flush();
    const action = host.actions.find((a) => a.payload.kind === "say");
    assert.ok(action, "host received the say action over the wire");
    assert.equal(action!.corr, "evt-1");
    assert.equal(action!.payload.data.text, "hi, I'm driven from MCP");
  } finally {
    await client.close();
    wss.close();
  }
});
