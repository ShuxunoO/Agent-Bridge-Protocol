/**
 * L1 capability isolation (DESIGN §4). A programmatic, default-deny guard: in the avatar
 * sub-context only the ABP tool surface + persona memory may be invoked — filesystem, shell,
 * network, Task, and any *other* MCP server are refused. This is the code-level complement to
 * the Claude Code settings allowlist (packages/mcp/examples/claude-settings.json, which is
 * derived from AVATAR_MCP_ALLOWLIST), and the gate the autopilot (F6.2) applies before
 * forwarding any tool call from a headless agent.
 *
 * It does not rely on model goodwill: an out-of-allowlist tool name is refused mechanically.
 */

export const MCP_SERVER_NAME = "agent-bridge";

/** The bare ABP tool names the avatar may use. MUST match packages/mcp/src/server.ts. */
export const ABP_TOOL_NAMES = [
  "abp_link",
  "abp_perceive",
  "abp_wait_for_event",
  "abp_say",
  "abp_act",
  "abp_persona_memory",
] as const;

/** MCP-qualified tool name as the host agent sees it (e.g. mcp__agent-bridge__abp_say). */
export function mcpToolName(bare: string): string {
  return `mcp__${MCP_SERVER_NAME}__${bare}`;
}

/** The avatar allowlist as MCP-qualified names (for Claude Code `permissions.allow`). */
export const AVATAR_MCP_ALLOWLIST: string[] = ABP_TOOL_NAMES.map(mcpToolName);

export class CapabilityError extends Error {
  readonly tool: string;
  constructor(tool: string) {
    super(`tool "${tool}" is not in the avatar capability allowlist (DESIGN §4 L1)`);
    this.name = "CapabilityError";
    this.tool = tool;
  }
}

/**
 * Default-deny capability guard. Allows only the ABP tools — accepted in either bare
 * (`abp_say`) or MCP-qualified (`mcp__agent-bridge__abp_say`) form — plus any explicitly
 * granted extras. Everything else (Bash/Read/Edit/Write/WebFetch/Task, other MCP servers,
 * arbitrary names) is refused.
 */
export class CapabilityGuard {
  readonly #allowed: Set<string>;
  constructor(extra: string[] = []) {
    this.#allowed = new Set<string>([...ABP_TOOL_NAMES, ...AVATAR_MCP_ALLOWLIST, ...extra]);
  }
  isAllowed(tool: string): boolean {
    return this.#allowed.has(tool);
  }
  assertAllowed(tool: string): void {
    if (!this.isAllowed(tool)) throw new CapabilityError(tool);
  }
  get allowlist(): string[] {
    return [...this.#allowed];
  }
}
