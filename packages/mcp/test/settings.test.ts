import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AVATAR_MCP_ALLOWLIST } from "@agent-bridge/client";

/**
 * The example Claude Code restricted profile must stay in sync with the canonical capability
 * allowlist (F4.3). The settings allowlist is the in-agent boundary; if the two diverge a tool
 * could be exposed without a code-level grant. This test makes the code the source of truth.
 */
test("claude-settings.json permissions.allow matches AVATAR_MCP_ALLOWLIST", () => {
  const path = fileURLToPath(new URL("../examples/claude-settings.json", import.meta.url));
  const settings = JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[]; deny: string[] } };
  assert.deepEqual([...settings.permissions.allow].sort(), [...AVATAR_MCP_ALLOWLIST].sort());
  // the deny list must keep the dangerous built-ins out
  for (const t of ["Bash", "Read", "Edit", "Write", "WebFetch"]) {
    assert.ok(settings.permissions.deny.includes(t), `${t} must be denied`);
  }
});
