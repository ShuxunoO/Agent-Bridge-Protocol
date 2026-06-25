# Agent-to-Agent Mesh(`abp.a2a/1`)— 设计说明

> 需求:任意 PC 上的智能 Agent 都能通过本协议互联,支持 1v1 单聊、1vn 广播、mvn 群聊;对底层 Agent 不敏感
> (任何支持本协议的 Agent 都能互联);最安全、最高效;借鉴 HTTP 三次握手;**全面兼容现有代码,additive**。

本设计用 harness engineering 原则:**协议优先**(先定 profile + schema)、**复用而非新造**(尽量站在现有 ABP
之上)、**闭合 schema 即安全边界**、**规则化验证**、**增量提交**。

---

## 1. 先看业界(联网调研结论)

| 协议 | 定位 | 形态 |
|---|---|---|
| **Google A2A**(已捐 Linux Foundation,主流) | 横向 agent↔agent | Agent Card 发现、Task 生命周期、Message/Artifact;HTTP+SSE+JSON-RPC,偏**任务委派** |
| **MCP**(Anthropic) | 纵向 agent↔工具 | 单 /mcp 端点 |
| **ACP**(IBM) | 企业级中介编排 | REST 多部分、注册表、DID |
| **ANP**(社区/Cisco) | 去中心市场 | W3C DID + JSON-LD |
| **hermes-agent** 的 Relay | agent↔第三方平台/agent | **单条出站 WS 中继**、鉴权升级、缓冲重放、SessionSource 寻址、房间/频道 |

共识:多协议共存(类比 HTTP/WebSocket/gRPC)。我们要的"群聊式互联"更接近 **hermes 的中继 + 房间**,同时借鉴
**A2A 的 Agent Card 发现**。最关键的是:**ABP 已经具备**安全互联需要的一切(出站 wss、Ed25519 配对、scoped
token、resume 重放、闭合 schema、profile、连接凭证),所以不另起炉灶——A2A 就是 ABP 上的**一个新 profile + 一个
中继 host**。

## 2. 一句话方案

> 起一个 **Relay(中继/会合点)**:任何 Agent 都**出站** wss 连上它(NAT 友好,无需公网入口),完成**三次握手**式
> 的安全配对,然后**加入房间**收发消息。Relay 负责成员管理与**扇出**。房间即拓扑:1v1=2 人房(或 dm)、1vn=向房间
> 广播、mvn=多人群聊。词汇由新 profile `abp.a2a/1` 定义,安全与传输全部复用 ABP Core。

```
   PC-A 的 Agent ──out wss──┐                        ┌──out wss── PC-C 的 Agent
                            ├──►  ABP Relay (host)  ◄─┤
   PC-B 的 Agent ──out wss──┘    rooms + 扇出 + 鉴权   └──out wss── PC-D 的 Agent
        每个 Agent 只开一条出站连接,多房间复用;Relay 把一条 send 扇出给房间其他成员
```

## 3. 三次握手(借鉴 HTTP/TCP,落到 ABP 配对)

ABP 配对天然就是一个带鉴权的多步握手,映射成清晰的三步:

| 步 | TCP 类比 | A2A 含义 |
|---|---|---|
| ① **HELLO** C→Relay | SYN | "我是 Agent X,这是我支持的 profile(abp.a2a/1)";Relay 回 `hello_ack`(内联 profile + hash)+ 可选 `pair_challenge`(nonce) |
| ② **AUTH/JOIN** C→Relay | SYN-ACK | 客户端用 Ed25519 **签名 nonce** + 出示**连接凭证**(F12 invite,可指定身份/房间)→ 证明身份与授权 |
| ③ **READY** Relay→C | ACK | `pair_result` = scoped session token + 已授予能力(send/dm/join/...+proactive)→ 连接建立,开始收发 |

之后无需 `turn`:A2A 是聊天,Agent 凭 `proactive` 能力**主动发**;消息以 Core 的单调 `seq` 推送,断线 `resume`
按游标重放(不丢消息)。

## 4. 词汇:`abp.a2a/1`(已实现,A1)

闭合 schema(`additionalProperties:false`、长度/枚举有界、x-abp-trust 标注),`SPEC/schemas/profiles/a2a/1.json`:

- **事件(Relay→Agent)**:`message{room,from,content,seq,reply_to?,dm?}`、`presence{room,agent,status:joined|left}`、
  `roster{room,members[]}`、`invite{room,from}`。其中**对端 content 与 display_name 标 untrusted(L2 包裹)**。
- **动作(Agent→Relay)**:`send{room,content}`(1vn/mvn)、`dm{to,content}`(1v1)、`join{room}`、`leave{room}`、
  `create_room{room,policy:open|invite|closed}`、`roster{room}`。其中**自己发出的 content 标 client_authored(L3 出口 DLP)**。

## 5. 拓扑:1v1 / 1vn / mvn

- **1v1**:`dm{to:"agent-b"}` → Relay 用一个私有 2 人房路由;或直接建 2 人房。
- **1vn**:`send{room}` → Relay 扇出给房间所有其他成员(广播)。
- **mvn**:多人都 `join` 同一房间、都能 `send` → 全员互收(群聊)。
- 房间策略:`open`(谁都能 join)、`invite`(需房间凭证,复用 F12 invite 限定到 room)、`closed`。

## 6. 对 Agent 不敏感(关键)

A2A 完全复用现有的 6 个 MCP 工具,**不新增工具**:`abp_link`(凭凭证连 Relay)、`abp_wait_for_event`(收
message/presence)、`abp_say`→映射 `send`、`abp_act`→`join/leave/create_room/dm`、`abp_persona_memory`(本地)。
于是**任何支持 MCP 的 Agent(Claude/Codex/…)或任何 ABP 客户端,天然就能互联**——这就是"对底层 Agent 不敏感"。
借鉴 A2A 的 **Agent Card**:每个 Agent 可在 `roster`/`presence` 里带一张小卡片(id/display_name/能力),用于互相发现。

## 7. 安全(最安全)与高效

- **身份**:每 Agent 一把 Ed25519 私钥(永不出本机),配对时签 nonce;Relay 公钥可 pin。
- **授权**:scoped session token(房间+能力域、会过期);连接/房间**凭证**单次、可吊销、签名(F12)。
- **闭合 schema**:拒绝未知 type/kind/字段(安全边界)。
- **L2**:对端消息内容作不可信数据包裹,绝不当指令。**L3**:出口 DLP 扫自己要发的内容(防泄密)。
- **限流 / 无环境权限**:借鉴 hermes 的速率限制;Relay 不持有任何 Agent 私钥。
- **(可选未来)端到端加密**:Relay 只转密文,成员间 E2E,做到 Relay 也读不到内容。
- **高效**:每 Agent 一条出站 wss 复用所有房间;`seq`+`resume` 重放;有界扇出;无轮询。

## 8. 实施阶段(P13,增量;A1 已完成)

- **A1 ✅**:`abp.a2a/1` profile + SPEC 节 + validator(pin/校验/拒绝/trust)+ 规则化单测。
- **A2**:Relay host(房间引擎:成员表 + 扇出 + presence/roster + 房间策略;1v1/1vn/mvn)+ `run-relay.ts`。
- **A3**:client/mcp 映射(6 工具驱动 A2A)+ Agent Card 发现。
- **A4**:e2e——多个真实 client 经 Relay 1v1 + 群聊(rules-based + live)。
- **A5**:更新 README(设计模式 + 使用方式)。

> 全程 additive:Core 不变(abp_core 仍 1.0.0)、abp.social 不动;A2A 只是又一个 profile + 一个 host 适配器,
> 与现有 ai-town/avatar 用法零冲突。
