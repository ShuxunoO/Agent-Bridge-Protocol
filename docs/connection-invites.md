# 连接凭证(Connection Invites)— 设计说明

> 目标:在 host 一侧点一下「连接」,生成**一个可粘贴的凭证串**;把它发给别人本地的 Agent 助手,
> 助手粘贴进来就能**一键接入**并开始驱动一个角色。要求:做在**协议层(agent-bridge)**、与具体 host
> (如 ai-town)**解耦**,这样任何用 ABP 的世界都能复用。

本设计基于 harness engineering 原则:协议优先、能力即权限(最小授权 + 可吊销 + 可验证)、工具少而精、
规则化验证、增量推进。

---

## 1. 一句话方案

> 「连接凭证」= 把 **连接地址 + 要驱动的角色 + 一张签过名的准入票(claim)+ 有效期** 打包成一个字符串。
> Host 用自己的密钥签发它;客户端粘贴后自动解出地址去连接;Host 在配对时验证这张票(签名对不对、过没过期、
> 角色对不对、是不是用过了)。**协议早就有 `claim` 字段和 `claim_required` 策略,这里只是把它"产品化"成一张票。**

关键结论:**线上协议(wire)不用改**。只在 SPEC 里**新增**一节定义"凭证格式 + 标准校验方式",再在
host/client SDK 各加一个小助手。ai-town 几乎不用改,只是多一个按钮 + 一次调用。

---

## 2. 为什么不用改线上协议(复用现有原语)

现状(已实现,见 SPEC §4.2 与 `packages/host/src/host.ts`):
- 角色有 `bind_policy`:`open`(谁都能绑)/ `claim_required`(必须出示 claim 凭证)/ `closed`(不可绑)。
- `pair_request` 已经能携带可选的 **claim 凭证**;host 端遇到 `claim_required` 角色却没 claim → 直接拒绝。
- SPEC §4.2 已明确要求:host **必须拒绝重放的 claim 凭证**(防一张票被反复用)。
- 客户端 `pair()` 和 MCP 工具 `abp_link` 都已经能传 `claim`。

所以「连接凭证」要补的,只是把零散的 {url, target, claim} **打包成一张票** + 一套**通用的签发/校验**逻辑
(现在 claim 怎么验是 host 自己定的,不通用)。

---

## 3. 凭证长什么样(格式)

一个 ABP Invite 是一个 URL 安全的字符串,内部是「载荷 + 签名」:

```
abp1.<base64url(payload)>.<base64url(sig)>
```

`payload`(JSON)字段:

| 字段 | 含义 |
|---|---|
| `v` | 版本号(1) |
| `url` | 连接地址(`wss://...`,本机可 `ws://`) |
| `profile` | 世界档案 `{id, version}`,如 `abp.social/1`(客户端据此校验是否支持) |
| `role` | 允许绑定的角色 id;或 `"*"` 表示「池子里任意空闲角色」 |
| `caps` | (可选)本次授予的能力子集,做最小授权 |
| `exp` | 过期时间戳(必填,凭证一定会过期) |
| `jti` | 一次性票号(host 记录已用过的 jti,实现单次/限次使用、防重放) |

`sig` = host 用自己的私钥(Ed25519)对 `payload` 的签名。

> 这整段「签过名的 payload」就直接当作 `pair_request` 里的 **claim** 传上去 —— 完美复用现有字段。
> 客户端额外从 payload 里读出 `url`/`role`,知道连哪、绑谁。

也可以包成一个可点的链接(host 自己决定),例如
`https://你的world/connect#abp1...`,但**协议只规定那个 `abp1...` 令牌**,链接外壳随意。

---

## 4. 三方各做什么(职责划分,强调解耦)

```
┌── Host 世界(如 ai-town)────────────┐        ┌── 别人本地的 Agent 助手 ──────┐
│  [连接] 按钮                          │        │  粘贴: "abp1...."             │
│    └─ 调 host.mintInvite(role,{ttl}) │  发给   │    └─ abp_link({invite})      │
│        → 返回 "abp1...." 字符串 ──────┼────────┼──→ 解析出 url/role/claim      │
│  bind 回调 = 标准校验器(验签/过期/   │  对方   │    → 正常 ABP 配对握手         │
│              jti 单次/角色匹配)       │        │    → 绑定角色,自由行动        │
└──────────────────────────────────────┘        └───────────────────────────────┘
        ↑ 这两块都在 agent-bridge 里(host SDK + client SDK),host 应用只调用
```

- **agent-bridge / `@agent-bridge/host`(协议层,通用)**
  - `mintInvite(roleId, { ttl, caps?, oneTime? }) -> string`:用 host 密钥签发一张票。
  - `inviteClaimVerifier(hostPublicKey, { seenJti }) -> bind 回调`:一个现成的 `bind` 实现,
    校验签名/过期/角色匹配/jti 未用过,通过就授予(可叠加能力裁剪)。
  - host 应用只需:`new AbpHost({ ..., bind: inviteClaimVerifier(...) })` + 暴露 `mintInvite`。
- **agent-bridge / `@agent-bridge/client` + `@agent-bridge/mcp`(协议层,通用)**
  - `parseInvite(token) -> { url, target, claim, profile }`。
  - `abp_link` **新增可选入参 `invite`**:给了 `invite` 就先解析再连接(等价于自动填好 url+target+claim)。
    —— 不新增工具,仍是 6 个;只是 `abp_link` 更聪明。
- **ai-town(host 应用,尽量薄)**
  - 前端一个「连接」按钮 + 一个 Convex action:对选中的可驱动角色调用网关里的 `mintInvite`,把返回的
    字符串显示出来(可一键复制)。**ai-town 不碰任何配对/校验逻辑**,全在 agent-bridge。

---

## 5. 安全性(能力即权限 —— 最小授权)

这张票本质是一份**权限授予**(能操控一个角色),所以:
- **必过期**(`exp`)—— 不存在永久有效的票。
- **单次/限次**(`jti`)—— host 记下已用票号,重放直接拒(SPEC §4.2 已要求)。
- **角色限定**(`role`)—— 一张票只能绑指定角色(或明确的池),不能越权绑别的。
- **能力裁剪**(`caps`)—— 可签发「只能说话、不能移动」之类的受限票。
- **不可伪造 / 不可篡改**(`sig`)—— 改任何字段签名就失效。
- **可吊销** —— host 维护吊销集(按 jti 或按角色),需要时立即作废。
- **传输安全** —— 仍走 `wss`(TLS);token 本身别塞进日志/URL query(用 fragment 或让用户手动粘贴)。

威胁方向要分清:这张票保护的是「**谁能驱动这个世界里的角色**」;它**不改变** host 始终把客户端来的内容
当作不可信数据处理(L0/L2)那条线。

---

## 6. 验证策略(harness 原则:规则化 > e2e)

- **规则化单测(validator/host/client)**:签发→解析→配对 happy path;以及**篡改 / 过期 / 重放(jti 复用)/
  角色不匹配 / 档案不支持**这五种都必须被拒。这是安全核心,先写死。
- **e2e**:host 签发一张票 → 客户端用 `abp_link({invite})` 一步连上并绑定 → 能感知能说话。
- **真实联调**:ai-town 点「连接」拿到票 → 本地 Claude 助手粘贴 → 在 ai-town 里自由行动。

---

## 7. 分阶段(增量,逐个提交)

- **C1**:SPEC 新增「Invite 凭证」一节(格式 + 标准校验语义,**additive**,不改线上消息);`@agent-bridge/validator`
  加 Invite 的解析/校验 + 单测(篡改/过期/重放/角色不符全拒)。
- **C2**:`@agent-bridge/host` 加 `mintInvite` + `inviteClaimVerifier`;`@agent-bridge/client` 加 `parseInvite`;
  `@agent-bridge/mcp` 的 `abp_link` 支持 `invite` 入参。e2e:签发→`abp_link({invite})`→驱动。
- **C3**(在 ai-town):前端「连接」按钮 + Convex action 调 `mintInvite`,显示可复制的凭证串。
- **C4**:真实联调(ai-town 出票 → 本地助手接入 → 自由行动),记录证据。

> 协议优先:C1 的 SPEC 改动是**新增**(不破坏现有握手),按 §9 走一次小版本即可;abp.social 档案不动。
> 解耦:C1/C2 完全在 agent-bridge;ai-town 只有 C3 的薄 UI。任何别的 ABP 世界都能直接用 C1/C2。
