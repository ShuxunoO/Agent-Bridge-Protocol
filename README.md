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
| `SPEC/abp-v1.md` | **The protocol** (Agent Bridge Protocol v1) — normative spec. Layered: stable **Core** + per-world **Profiles**. |
| `SPEC/schemas/core/` | Core JSON Schemas (envelope, event/action envelopes, error, profile meta-schema) — the stable security boundary. |
| `SPEC/schemas/profiles/` | World Profiles (per-world closed vocabularies; pinned by the client). Ships `social/1.json`. |
| `DESIGN.md` | Architecture, threat model, 5-layer security design. |
| `feature_list.json` | Development tracker (protocol-first; one feature per session). |
| `progress.txt` | Session progress log. |
| `CLAUDE.md` | Startup protocol for agent-assisted development. |
| `init.sh` | Idempotent dev-environment bootstrap. |
| `packages/validator/` | Reference: ABP/1 validator (Core envelope/type + pinned World Profile composition). |
| `packages/client/` | Reference: client connector — outbound wss transport, pairing/auth, event loop. |
| `packages/mcp/` | Reference: MCP server exposing the connector to Claude Code et al. (`abp_*` tools). |
| `docs/claude-code.md` | How to drive an avatar from Claude Code (restricted profile + demo host). |
| `packages/` | (upcoming) host SDK + AI-Town adapter (P7). |

## Why it's safe by construction

Outbound-only · closed schemas both directions (Core + a client-**pinned** World Profile) ·
no executable/tool/file transport (profiles are inline, content-addressed data — never a URL to
fetch) · machine-marked untrusted-content contract (`x-abp-trust`) · role+profile+capability-scoped
tokens · client-side egress DLP. See `SPEC/abp-v1.md` §0.2 and `DESIGN.md`.

## Status

Protocol v1 spec drafted. Implementation in progress — see `feature_list.json`.
