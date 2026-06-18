# agent-bridge

**A secure, reusable protocol for letting a local AI agent drive a remote agent.**

A local AI assistant (Claude Code, Codex, OpenClaw, Hermes, …) connects **outbound** to a remote
**host** that exposes drivable **roles** in some world, binds to one role, and drives it —
perceiving, acting, and socializing — while the agent's reasoning, capabilities, and memory stay
on the user's machine.

This repo is **independent of any host application**. [AI-Town](https://github.com/a16z-infra/ai-town)
is the first host, but anything that implements the host side of the protocol works, and any
project can reuse the client/connector.

## Layout

| Path | What |
|---|---|
| `SPEC/abp-v1.md` | **The protocol** (Agent Bridge Protocol v1) — normative spec. |
| `SPEC/schemas/` | Machine-readable JSON Schemas (closed event/action schemas = the security boundary). |
| `DESIGN.md` | Architecture, threat model, 5-layer security design. |
| `feature_list.json` | Development tracker (protocol-first; one feature per session). |
| `progress.txt` | Session progress log. |
| `CLAUDE.md` | Startup protocol for agent-assisted development. |
| `init.sh` | Idempotent dev-environment bootstrap. |
| `packages/` | (upcoming) reference implementation: validator, client SDK, MCP server, host SDK. |

## Why it's safe by construction

Outbound-only · closed schemas both directions · no executable/tool/file transport ·
untrusted-content contract · role+capability-scoped tokens · client-side egress DLP.
See `SPEC/abp-v1.md` §0.2 and `DESIGN.md`.

## Status

Protocol v1 spec drafted. Implementation in progress — see `feature_list.json`.
