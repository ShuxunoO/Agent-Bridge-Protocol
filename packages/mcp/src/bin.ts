#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

/** Entry point: serve the agent-bridge MCP tools over stdio (for Claude Code et al.). */
const server = createServer();
await server.connect(new StdioServerTransport());
