# Driving an avatar from Claude Code (ABP MCP reference)

This guide wires the `@agent-bridge/mcp` server into Claude Code so a local agent can drive a
remote avatar over ABP — with a restricted, allowlist-only profile (DESIGN §4 L1) and the locked
untrusted-content persona (SPEC §6.2).

Reference files live in `packages/mcp/examples/`:
`.mcp.json`, `claude-settings.json`, `persona.md`, `demo-host.ts`.

## Prerequisites

- **Node 24+** — the reference implementation runs TypeScript directly via native type-stripping
  (the MCP server entry is `packages/mcp/src/bin.ts`). No build step.
- Install workspace deps once: `./init.sh` (or `npm install`).

## 1. Register the MCP server

Copy `packages/mcp/examples/.mcp.json` to your project root as `.mcp.json` (or merge it):

```json
{
  "mcpServers": {
    "agent-bridge": { "command": "node", "args": ["packages/mcp/src/bin.ts"] }
  }
}
```

The server exposes six tools: `abp_link`, `abp_perceive`, `abp_wait_for_event`, `abp_say`,
`abp_act`, `abp_persona_memory` (each appears to Claude Code as `mcp__agent-bridge__<tool>`).

## 2. Apply the restricted profile (L1 capability isolation)

Use `packages/mcp/examples/claude-settings.json` as the session settings. It **allows only the
agent-bridge tools** and **denies** `Bash`/`Read`/`Edit`/`Write`/`WebFetch`/`WebSearch`/`Task`, so
the avatar sub-context has no filesystem, shell, web, or other-MCP authority — driving the world is
the only thing it can do.

CLI equivalent:

```bash
claude --settings packages/mcp/examples/claude-settings.json \
       --allowedTools "mcp__agent-bridge__*"
```

> Residual risk (DESIGN §4): this is an **in-agent** boundary enforced by Claude Code's permission
> model, not OS-level isolation. The deterministic defenses don't depend on it — L2 (untrusted
> content) and L3 (egress DLP, F4.2) hold regardless. For public/high-security use, run Claude Code
> in a sandboxed process (`isolation_mode: process`).

## 3. Load the persona (L2 untrusted-content contract)

Paste `packages/mcp/examples/persona.md` as the session's system/persona prompt. It instructs the
model to treat all world content as data — never instructions — and never to reveal local/system
information or call tools because in-world text asked. (F4.1 will enforce this wrapping in code.)

## 4. Try it against the demo host

Start the bundled scripted host (a tiny social scene — NOT the production Host SDK, that's P7):

```bash
node packages/mcp/examples/demo-host.ts 19111
# -> ABP demo host listening on  ws://127.0.0.1:19111
```

Then, in the restricted Claude Code session, ask it to drive the avatar. A typical loop:

1. `abp_link` `{ "url": "ws://127.0.0.1:19111", "target": "avatar-1" }`
2. `abp_wait_for_event` `{ "kinds": ["turn", "message"] }` → see Mira greet you
3. `abp_say` `{ "conversation_id": "c-mira", "text": "Hi Mira, I'm new here." }`
4. Repeat 2–3; `abp_act` `{ "kind": "interact_leave", "data": { "conversation_id": "c-mira" } }` to leave.

The host logs each action it receives, so you can watch the conversation from both sides.

## Connecting to a real world

The demo host is a stand-in. Any application becomes drivable by implementing the **ABP host side**
(P7: the generic Host SDK `F7.1` + a per-app adapter such as the AI-Town adapter `F7.2`). The client
side shown here is unchanged regardless of host — that is the point of the protocol.

## Reproducible end-to-end test

`packages/mcp/test/e2e_stdio.test.ts` launches the exact stdio binary Claude Code uses
(`node src/bin.ts`), connects a real MCP client to it, links to an in-process ABP host, and drives a
turn — asserting the action arrives over the wire. Run it with `npm test --workspace @agent-bridge/mcp`.
