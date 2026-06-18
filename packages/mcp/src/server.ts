import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Connector } from "./connector.ts";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function jsonError(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: String(err instanceof Error ? err.message : err) }] };
}

/**
 * Build the agent-bridge MCP server: the six ABP avatar-driving tools bound to one
 * Connector (F3.1). Driving the world goes only through these verbs — no filesystem,
 * shell, or other authority crosses the protocol (DESIGN §4 L1).
 */
export function createServer(connector: Connector = new Connector()): McpServer {
  const server = new McpServer({ name: "agent-bridge", version: "0.0.0" });

  server.registerTool(
    "abp_link",
    {
      description: "Connect outbound to an ABP host, pair, and bind a role. Returns the bound role, capabilities, and pinned profile.",
      inputSchema: {
        url: z.string().describe("Host URL (wss://...; ws:// only for loopback)."),
        target: z.string().describe('Role id to bind, or "create".'),
        claim: z.string().optional().describe("Claim credential for a claim_required role."),
        keypair_path: z.string().optional().describe("Path to load/persist the client keypair."),
      },
    },
    async (args) => {
      try {
        return json(await connector.link({ url: args.url, target: args.target, claim: args.claim, keypairPath: args.keypair_path }));
      } catch (e) {
        return jsonError(e);
      }
    },
  );

  server.registerTool(
    "abp_perceive",
    { description: "Return the latest perception snapshot of the bound role's surroundings.", inputSchema: {} },
    async () => {
      try {
        return json(connector.perceive());
      } catch (e) {
        return jsonError(e);
      }
    },
  );

  server.registerTool(
    "abp_wait_for_event",
    {
      description: "Long-poll for the next world event (optionally filtered by kind), e.g. a turn, message, or invite. Returns the event or a timeout.",
      inputSchema: {
        kinds: z.array(z.string()).optional().describe("Event kinds to wait for (default: any)."),
        timeout_ms: z.number().int().positive().optional().describe("Max wait in ms (default 30000)."),
      },
    },
    async (args) => {
      try {
        return json(await connector.waitForEvent({ kinds: args.kinds, timeoutMs: args.timeout_ms }));
      } catch (e) {
        return jsonError(e);
      }
    },
  );

  server.registerTool(
    "abp_say",
    {
      description: "Speak into a conversation. Correlates to the current turn if one is open, else acts proactively (requires the proactive capability).",
      inputSchema: { conversation_id: z.string(), text: z.string().min(1) },
    },
    async (args) => {
      try {
        return json(connector.say(args.conversation_id, args.text));
      } catch (e) {
        return jsonError(e);
      }
    },
  );

  server.registerTool(
    "abp_act",
    {
      description: "Submit an action of the pinned profile (e.g. move, emote, interact_start, interact_leave, noop).",
      inputSchema: { kind: z.string(), data: z.record(z.string(), z.unknown()).optional() },
    },
    async (args) => {
      try {
        return json(connector.act(args.kind, args.data ?? {}));
      } catch (e) {
        return jsonError(e);
      }
    },
  );

  server.registerTool(
    "abp_persona_memory",
    {
      description: "Local persona memory: get/set/delete/list. Stays on the user's machine; never sent to the host.",
      inputSchema: {
        op: z.enum(["get", "set", "delete", "list"]),
        key: z.string().optional(),
        value: z.unknown().optional(),
      },
    },
    async (args) => {
      try {
        return json(connector.personaMemory(args.op, args.key, args.value));
      } catch (e) {
        return jsonError(e);
      }
    },
  );

  return server;
}
