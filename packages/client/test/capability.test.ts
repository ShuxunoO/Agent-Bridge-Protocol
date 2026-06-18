import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  CapabilityGuard,
  CapabilityError,
  ABP_TOOL_NAMES,
  AVATAR_MCP_ALLOWLIST,
  mcpToolName,
  isolatedEnv,
  launchIsolated,
} from "../src/index.ts";

test("guard allows every ABP tool (bare and MCP-qualified)", () => {
  const g = new CapabilityGuard();
  for (const t of ABP_TOOL_NAMES) {
    assert.ok(g.isAllowed(t), `bare ${t} should be allowed`);
    assert.ok(g.isAllowed(mcpToolName(t)), `qualified ${t} should be allowed`);
  }
});

test("guard refuses out-of-allowlist tools (fs/shell/web/Task/other MCP)", () => {
  const g = new CapabilityGuard();
  for (const t of [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Task",
    "fetch",
    "mcp__filesystem__write_file",
    "mcp__agent-bridge__abp_evil", // unknown tool on our own server
    "abp_say_extra",
  ]) {
    assert.equal(g.isAllowed(t), false, `${t} must be refused`);
    assert.throws(() => g.assertAllowed(t), CapabilityError, `${t} should throw`);
  }
});

test("assertAllowed passes for an allowed tool and carries the tool on error", () => {
  const g = new CapabilityGuard();
  assert.doesNotThrow(() => g.assertAllowed("mcp__agent-bridge__abp_say"));
  try {
    g.assertAllowed("Bash");
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof CapabilityError);
    assert.equal((e as CapabilityError).tool, "Bash");
  }
});

test("extra grants extend the allowlist explicitly", () => {
  const g = new CapabilityGuard(["mcp__other__ok"]);
  assert.ok(g.isAllowed("mcp__other__ok"));
  assert.equal(g.isAllowed("mcp__other__nope"), false);
});

test("isolatedEnv drops parent secrets, keeps PATH, honors allow", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x", SECRET_TOKEN: "sk-abc", ALLOWED_VAR: "ok" };
  const scrubbed = isolatedEnv([], base);
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.HOME, "/home/x");
  assert.equal(scrubbed.SECRET_TOKEN, undefined); // secret dropped
  const withAllow = isolatedEnv(["ALLOWED_VAR"], base);
  assert.equal(withAllow.ALLOWED_VAR, "ok");
  assert.equal(withAllow.SECRET_TOKEN, undefined); // still dropped
});

test("launchIsolated spawns a child that cannot see parent secrets (smoke)", () => {
  process.env.ABP_TEST_SECRET = "super-secret-value";
  try {
    const child = launchIsolated(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    // read synchronously via execFileSync mirror for determinism
    const out = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
      env: isolatedEnv(),
      encoding: "utf8",
    });
    const keys = JSON.parse(out) as string[];
    assert.ok(!keys.includes("ABP_TEST_SECRET"), "isolated child must not see the parent secret");
    assert.ok(keys.includes("PATH"), "isolated child should keep PATH");
    assert.ok(child.pid && child.pid > 0, "launchIsolated returns a live child process");
    child.kill();
  } finally {
    delete process.env.ABP_TEST_SECRET;
  }
});
