[English](README.md) | 简体中文

# agent-bridge

**一套安全、可复用的协议(ABP),让 AI 智能体既能接入"世界",也能彼此互联。**

一套协议 + SDK,做两件事:

1. **驱动远端的化身/世界。** 本地 AI 助手(Claude Code、Codex、OpenClaw、Hermes……)**出站**连接到远端
   **host**,绑定一个可驱动的**角色(role)**,然后驱动它——感知、行动、社交——而它的推理、能力和记忆都
   留在用户本机。(profile:`abp.social/1`;例如在 AI Town 里驱动一个角色。)
2. **Agent 之间的网格互联。** 任意机器上的 agent **出站**连接到一个 **relay(会合中继)**,自助注册一个身份,
   加入**房间(room)**,然后收发消息——**1v1**(私聊 dm)、**1vn**(广播)、**mvn**(群聊)。(profile:
   `abp.a2a/1`。)因为复用同一套协议,**任何会说 ABP/MCP 的 agent 都能零额外代码地互联。**

本仓库**不依赖任何具体 host 应用**:只包含协议本身和可复用的 SDK。任何实现了 host 端的程序都能用;
host 专属的业务逻辑放在各自的仓库里。

## 目录结构

| 路径 | 说明 |
|---|---|
| `SPEC/abp-v1.md` | **协议本体**(ABP v1)——规范性文档。分层:稳定的 **Core** + 各世界的 **Profile**。§4.2.1 连接凭证;§5.7 A2A 网格 profile。 |
| `SPEC/schemas/core/` | Core JSON Schema(envelope、event/action、error、profile 元 schema)——稳定的安全边界。 |
| `SPEC/schemas/profiles/` | 各世界的 Profile(闭合词汇表,由客户端 pin)。内置 `social/1.json`(化身)+ `a2a/1.json`(agent 网格)。 |
| `packages/validator/` | ABP/1 校验器:Core + pin 后的 profile 组合校验、profile 哈希、连接凭证。 |
| `packages/client/` | 客户端 connector:出站 wss、配对/鉴权、事件循环、DLP、凭证解析。 |
| `packages/host/` | 通用 Host SDK,供任何 host 嵌入(配对、事件、动作鉴权、resume、凭证、自助注册)。 |
| `packages/mcp/` | MCP server,把 connector 暴露给 Claude Code 等——6 个 `abp_*` 工具。 |
| `packages/relay/` | **A2A relay**:服务 `abp.a2a/1` 的会合中继(房间 + 扇出)。`run-relay.ts`。 |
| `docs/a2a-mesh.md` | Agent 网格设计(中文)。还有 `docs/connection-invites.md`、`docs/claude-code.md`。 |
| `DESIGN.md` · `feature_list.json` · `progress.txt` · `CLAUDE.md` · `init.sh` | 架构/威胁模型 · 开发跟踪 · 日志 · 启动协议 · 一键引导。 |

## 为什么"天生安全"

仅出站连接 · 双向闭合 schema(Core + 客户端 **pin** 的 World Profile)· 不传可执行物/工具/文件(profile 是
内联、按内容寻址的数据,绝不是一个要去抓取的 URL)· 机器可识别的不可信内容契约(`x-abp-trust`)·
角色+profile+能力域、会过期的 token · 单次使用、带签名的**连接凭证** · 客户端侧出口 DLP。
详见 `SPEC/abp-v1.md` §0.2 与 `DESIGN.md`。

---

## Agent 网格互联(`abp.a2a/1`)

### 设计模式

> 起一个 **relay(会合中继)**。每个 agent 用**一条出站 wss** 连上它(NAT 友好,无需公网入口)。relay 维护
> **房间**(成员集合),把每条消息**扇出**给房间里其他成员。房间即拓扑:**1v1** = `dm` / 2 人房,**1vn** =
> 向房间 `send`,**mvn** = 多人同房群聊。

- **"三次握手"** 即 ABP 配对:① `hello` → `hello_ack`(relay 内联 profile)② 客户端签名挑战(Ed25519)+
  可选出示**连接凭证** ③ `pair_result`(scoped token + 能力)。之后没有 `turn`——agent 主动发;`seq` + `resume`
  保证有序、断线重连不丢消息。
- **对底层 agent 不敏感。** relay 就是普通的 ABP host;agent 是它们**自助注册**的角色。现有的 **6 个 MCP 工具**
  原样即可驱动——`abp_link`(连接)、`abp_wait_for_event`(收 `message`/`presence`/`roster`)、`abp_act`(通用
  动作:`send`/`dm`/`join`/`leave`/`create_room`/`roster`)、`abp_persona_memory`(本地)。任何 MCP agent
  (Claude/Codex……)零改造即可入网。
- **安全。** Ed25519 身份(私钥永不出本机)、scoped/会过期的 token、单次签名凭证、闭合 schema、对端内容一律
  当作**不可信**数据(绝不当指令)、对自己要发的内容做出口 DLP。
- 完整设计(中文):`docs/a2a-mesh.md`。规范:`SPEC/abp-v1.md` §5.7。

### 使用方式

**1. 起一个 relay**(任意可达处——服务器,或本机测试):

```bash
cd packages/relay
node run-relay.ts 19200
# -> [relay] A2A relay listening on ws://127.0.0.1:19200
# 用凭证做门禁,而非开放加入:
node run-relay.ts 19200 --require-invite --mint alice
# -> 为 agent "alice" 打印一张单次使用的 abp1.<...> 凭证
```

**2. 接入 agent** —— 用 agent-bridge 的 MCP server(6 个 `abp_*` 工具),从任意 MCP agent 调用;或直接用
客户端 SDK。每个 agent 自取一个身份(`target`)。开启 `--require-invite` 时,把签发的 token 作为 `invite`
传入,代替 `url`+`target`。

```jsonc
// 开放的 relay
abp_link            { "url": "ws://127.0.0.1:19200", "target": "alice" }
// 凭证门禁的 relay(粘贴一次即连上)
abp_link            { "invite": "abp1...." }
```

**3. 聊天** —— 用 `abp_act` 驱动房间,用 `abp_wait_for_event` 收消息:

```jsonc
// 1vn / mvn 群聊
abp_act             { "kind": "join",        "data": { "room": "lobby" } }
abp_act             { "kind": "send",        "data": { "room": "lobby", "content": "大家好" } }
abp_wait_for_event  { "kinds": ["message", "presence"] }   // -> {from:{id:"bob"}, content:"...", room:"lobby"}

// 1v1 私聊
abp_act             { "kind": "dm",          "data": { "to": "bob", "content": "悄悄话,只给你" } }

// 房间管理
abp_act             { "kind": "create_room", "data": { "room": "team", "policy": "invite" } }
abp_act             { "kind": "leave",       "data": { "room": "lobby" } }
abp_act             { "kind": "roster",      "data": { "room": "lobby" } }   // -> 返回 roster 事件(成员列表)
```

整个网格就这么简单:起一个 relay,把 agent 指向它,`join` + `send`/`dm`。编程方式(客户端 SDK)与此对应——
见 `packages/relay/test/relay.test.ts`(群聊/私聊/现身/隔离)与 `test/mcp.test.ts`(两个 MCP Connector 互联)。

---

## 状态

协议 v1 已实现。化身驱动(`abp.social/1`)+ 连接凭证 + agent 网格互联(`abp.a2a/1`,relay)均已上线并通过
测试(`npm test`)。开发跟踪见 `feature_list.json`。
