# dsh-yuanbao

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

中文 | [English](./README_EN.md)

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的元宝 IM 通道插件，将元宝开放平台 WebSocket 消息接入 dsh agent runtime。

npm: [`@anxi78/dsh-yuanbao`](https://www.npmjs.com/package/@anxi78/dsh-yuanbao)

> **⚠️ 本仓库是定制分支**
>
> 上游：[YuanbaoTeam/dsh-yuanbao](https://github.com/YuanbaoTeam/dsh-yuanbao)
> 本分支： [anxi78/dsh-yuanbao](https://github.com/anxi78/dsh-yuanbao)
>
> 相比上游新增了**媒体消息、表情包、Agent 工具、设置面板**等能力，
> 具体差异见下方「[与上游的差异](#与上游的差异)」。
> 同步上游：`git fetch upstream && git merge upstream/main`


## 与上游的差异

> 对比基准：上游 `9446ebd`（fix: support yuanbao group replies）
> 统计：**23 个文件，+4012 / -115 行**

### 一、新增功能

#### 1. 媒体消息（图片 / 文件）

| 文件 | 作用 |
|---|---|
| `src/media.ts` | 入站媒体：从消息体提取图片/文件、下载到附件存储、转成 agent 可读的 content block |
| `src/outbound-media.ts` | 出站媒体：COS 上传（腾讯云对象存储）、图片尺寸探测、MIME 推断、构造图片消息体 |

- **入站**：元宝发来的图片/文件会被下载并挂到 agent 上下文，agent 能真正"看到"图片，而不是只收到一句占位文本
- **出站**：agent 可以把本地图片/文件发回给用户，走 COS 上传后发送

#### 2. 表情包

| 文件 | 作用 |
|---|---|
| `src/stickers.ts` | 表情搜索、按引用查找、构造表情消息体 |
| `assets/builtin-stickers.json` | 内置表情库（542 行） |

- 支持关键词搜索表情
- agent 可以主动发表情

#### 3. Agent 工具（5 个）

`src/tools.ts` 注册了 5 个可被 agent 调用的工具：

| 工具名 | 用途 |
|---|---|
| `yuanbao_send_media` | 发送图片或文件到当前会话 |
| `yuanbao_send_sticker` | 发送表情包 |
| `yuanbao_search_stickers` | 搜索可用表情 |
| `yuanbao_send_message` | 发送纯文本消息 |
| `yuanbao_list_members` | 列出群成员 |

**意义**：上游只能"被动回复"，现在 agent 可以主动发消息、发图、发表情。

#### 4. 设置面板

`client.js`（219 行）注册了一个设置页「元宝」，支持**会话路由**两种模式：

| 模式 | 行为 |
|---|---|
| `per-peer`（默认） | 原版行为：每个群聊/私聊各开一个独立会话 |
| `pinned` | 所有消息都路由到指定的那一个会话 |

配置项（`src/config.ts`、`src/types.ts`）：

```yaml
sessionMode: 'per-peer' | 'pinned'   # 会话路由模式
pinnedSessionId: ''                  # pinned 模式下的目标会话 ID
```

**留空自动回退到 per-peer**，不会因为配置错误把消息塞进空会话。

#### 5. 群聊上下文

**@bot 时能看到群里刚才聊了什么**，而不只是当前这一条。

| 项 | 说明 |
|---|---|
| `src/chat-history.ts` | 文本历史（每会话 200 条）+ 媒体历史（50 条）+ 最后一条消息追踪 |
| `src/inbound.ts` | 在 @bot 检查**之前**先记录，没 @bot 的消息也会进历史 |

拼进上下文的格式：

```
[群聊最近消息（按时间顺序，最后一条最旧→最新）]
Alice: 刚才那个方案怎么样
Bob: 我觉得可以
[以上是 @bot 之前的消息，下面是本次 @bot 的内容]
```

回复完成后按 `historyLimit` 清掉已消费的部分，避免下次重复。

配置项：

```yaml
historyLimit: 20    # 默认 20 条，0 = 关闭
```

**持久化**：历史落盘到 `~/.dsh/.yuanbao-history.json`，重启不再失忆。
（只存文本，不存媒体 —— 媒体的 url 带签名时效，过期了也用不了。）

#### 6. 发图后立刻 @bot，自动带上那张图

**场景**：用户先发一张图（这条 @ 不到 bot），紧接着 @bot 问「这张图是什么」。

**触发条件（缺一不可）：**

| 条件 | 说明 |
|---|---|
| **同一个人** | 上一条必须是当前发送者发的 |
| **必须是最后一条** | 中间有任何人的消息都不算，**包括自己发的文字** |
| **只对图片** | 文件不生效，图+文件混合也不生效 |

实现要点：`chatLastMessage` 单独追踪「最后一条消息」——文本历史只记有正文的消息，
纯图片会被跳过，所以需要独立的记录来判断上一条到底是什么。

#### 7. 引用消息（文字 + 媒体）

**引用信息不在 `msg_body`，而在消息级的 `cloud_custom_data`：**

```json
{ "quote": { "desc": "被引用的文字", "type": 2, "id": "msgId" } }
```

`type`：1 文字 / 2 图片 / 3 文件 / 4 视频 / 5 语音。

| 引用类型 | 处理 |
|---|---|
| **文字** | 格式化为 `> [引用消息 from 某人]: 内容` |
| **媒体** | `desc` 为空，按 `id` 回查媒体历史 → 换取真实 COS 地址 → 下载 → 作为附件 |

**关键坑**：入站媒体给的是 `hunyuan.tencent.com/api/resource/download?resourceId=xxx`，
直接 GET 返回 **401**。必须先调 `/api/resource/v1/download` 换取真正的 COS 地址。

#### 8. 设置面板持久化

设置存到 `~/.dsh/.yuanbao-settings.json`，重启不丢。
（为什么不写 `cordis.patch.yml`：那是静态配置，改一次要手写 YAML 再重启。）

### 二、修复的问题

#### 1. 群消息发送失败（`bot_id is required`）

**问题**：`bridge.ts` 里原本会单独构造一个 account 对象，导致 `botId` 为 undefined，群消息发送时被平台拒绝。

**修复**：复用 gateway 已解析的 account 对象（`gateway.account`），保证 `botId` 一致。

```ts
// Reuse the gateway's account: sign-token resolution stored the bot id on
// that exact object. Building a second account here would leave `botId`
// undefined and make every group send fail the `fromAccount` check.
const account = gateway.account ?? gatewayAccountFromConfig(this.config);
```

#### 2. @提及判定失效

**问题**：群聊里判断"有没有 @ 我"时，如果拿不到 botId 就静默判定为"没被提及"，导致**所有群消息都不回复**。

**修复**：优先用配置的 `botId`，否则回退到 sign-token 交换时解析出的 id；并区分「确实没人 @ 我」和「我没有身份可比对」两种情况。

#### 3. 发送结果谎报成功

**问题**：发送失败时仍然返回成功，工具层显示"已发送"但实际什么都没发出去。

**修复**：`sender.ts` 传播真实传输结果，失败会抛错。

```ts
// Propagate the transport outcome: reporting success unconditionally is
// what made the tool claim "sent" while nothing left the device.
```

#### 4. 附件被静默丢弃

**问题**：出站消息只处理纯文本，带图片/文件的消息会被过滤掉，附件消失。

**修复**：`outbound.ts` 把文本和媒体分开收集，任何组合都能正确发送。

#### 5. 媒体消息的文本占位

**问题**：图片/文件消息体本身没有文本，agent 收到的消息是空的。

**修复**：为媒体元素生成占位符，让 agent 知道"这里有个图/文件"。

#### 6. @提及显示为原始 JSON

**问题**：消息里的 @ 元素被原样传给 agent，agent 看到的是 JSON 片段。

**修复**：渲染成人类可读的形式（如 `@用户名`）。

### 三、架构改动

#### 服务读取封装（`src/services.ts`）

Cordis 插件读取未声明的服务会抛错。新增的 `createServiceReader` 把这类读取包起来，读取失败降级为 warn 日志而不是崩溃。

```ts
// Cordis throws `cannot get property "X" without inject` when a plugin reads
// a service it did not declare.
```

#### 会话管理器增强（`src/session/manager.ts`）

- `sessionKey()` 支持 `pinned` 模式：所有消息共用同一个 key
- `deriveSessionId()` 在 pinned 模式下直接返回指定 ID，不再哈希成新 UUID
- 队列串行化，避免同一会话并发处理

### 四、文件清单

**新增（10 个）**

```
assets/builtin-stickers.json   542 行   内置表情库
client.js                      327 行   设置面板
src/media.ts                   207 行   入站媒体
src/outbound-media.ts          363 行   出站媒体
src/services.ts                 59 行   服务读取封装
src/stickers.ts                131 行   表情包
src/tools.ts                   407 行   Agent 工具
src/chat-history.ts            363 行   文本/媒体历史、持久化
src/quote.ts                   157 行   引用消息解析
src/dsh-tools.d.ts              13 行   工具类型声明
```

**修改（13 个）**

```
src/inbound.ts                 主要改动  @提及判定、媒体提取、历史、自动附图
src/transport/sender.ts         +265    发送结果传播、身份校验、COS 地址换取
src/transport/outbound.ts       +116    媒体消息支持
src/session/manager.ts          +104    会话路由
src/bridge.ts                    +71    复用 gateway account、注册工具
src/index.ts                     +91    服务注入、配置、历史恢复
src/gateway/index.ts             +33    account 暴露、httpAuth
src/config.ts                    +10    会话路由、historyLimit
src/types.ts                     +10    类型定义
package.json                     +16    client 入口声明
```

**总计**：`23 files changed, 4012 insertions(+), 115 deletions(-)`

### 五、同步上游

```bash
git fetch upstream
git merge upstream/main
```

本分支的改动集中在新增文件和少数函数的局部修改，**冲突面较小**。


## 架构

```text
元宝用户 → 元宝 WebSocket Gateway → dsh-yuanbao → ctx.agents → dsh agent loop → LLM / Tools
                                      ↑                           │
                                      └── session/event ──────────┘
                                            assistant reply → 元宝发送接口
```

`dsh-yuanbao` 作为 Cordis 插件运行在 deepseek-harness 进程内：

- 入站：元宝 WebSocket push → 元宝消息解码 → `agent.followup()`
- 出站：监听 `session/event` → 聚合 `assistant/chunk` → 发送元宝 C2C / 群消息
- 状态：通过元宝 heartbeat 发送 `RUNNING` / `FINISH`，驱动元宝 loading / 思考气泡

## 安装

### 方式一：从 npm registry 安装（推荐）

```bash
# 安装到 web profile
dsh plugin --profile web add @anxi78/dsh-yuanbao

# 启动
dsh --profile web
```

### 方式二：本地路径安装

```bash
# 构建插件
cd /path/to/dsh-yuanbao
pnpm install
pnpm build

# 安装到 web profile
dsh plugin --profile web add /path/to/dsh-yuanbao

# 启动
dsh --profile web
```

## 环境变量

推荐在 deepseek-harness 启动目录放置 `.env`：

```env
YUANBAO_APP_KEY=你的元宝AppKey
YUANBAO_APP_SECRET=你的元宝AppSecret
# 可选：如果已经有预签名 token，可直接配置
YUANBAO_TOKEN=

# 可选：Agent 工作目录
DSH_YUANBAO_CWD=/path/to/workspace
```

如果使用 DeepSeek 官方模型，还需要：

```env
DEEPSEEK_API_KEY=你的DeepSeek API Key
```

如果使用 Ollama 本地模型，可在 `~/.dsh/settings.yaml` 中配置 `agent-default-model` 指向 Ollama provider。

## 模型配置

`dsh-yuanbao` 默认不直接绑定模型，而是继承 deepseek-harness 的宿主默认模型：

```yaml
agent-default-model:
  provider: <provider-id>
  model: <model-id>
```

模型 provider 通常配置在：

```text
~/.dsh/settings.yaml
```

如果设置了 `DSH_HOME`，则配置文件位于：

```text
$DSH_HOME/settings.yaml
```

### OpenAI 示例

在 deepseek-harness 启动目录的 `.env` 中配置：

```env
OPENAI_API_KEY=你的OpenAI API Key
```

在 `~/.dsh/settings.yaml` 中配置：

```yaml
llm-pi-ai:
  providers:
    openai:
      displayName: OpenAI
      apiKeyEnv: OPENAI_API_KEY
      api: openai-completions
      baseURL: https://api.openai.com/v1
      models:
        - id: gpt-4o-mini
          name: GPT-4o mini
          contextWindow: 128000
          maxTokens: 16384
          input:
            - text

agent-default-model:
  provider: openai
  model: gpt-4o-mini
```

### Claude 示例

在 deepseek-harness 启动目录的 `.env` 中配置：

```env
ANTHROPIC_API_KEY=你的Anthropic API Key
```

在 `~/.dsh/settings.yaml` 中配置：

```yaml
llm-pi-ai:
  providers:
    anthropic:
      displayName: Anthropic
      apiKeyEnv: ANTHROPIC_API_KEY
      api: anthropic-messages
      baseURL: https://api.anthropic.com
      models:
        - id: claude-3-5-sonnet-20241022
          name: Claude 3.5 Sonnet
          contextWindow: 200000
          maxTokens: 8192
          input:
            - text

agent-default-model:
  provider: anthropic
  model: claude-3-5-sonnet-20241022
```

### Ollama 示例

在 deepseek-harness 启动目录的 `.env` 中配置一个占位 key：

```env
OLLAMA_API_KEY=ollama
```

在 `~/.dsh/settings.yaml` 中配置：

```yaml
llm-pi-ai:
  providers:
    ollama:
      displayName: Ollama
      apiKeyEnv: OLLAMA_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      models:
        - id: qwen3.5
          name: Qwen3.5
          contextWindow: 32768
          maxTokens: 4096
          input:
            - text

agent-default-model:
  provider: ollama
  model: qwen3.5
```

也可以在 `cordis.patch.yml` 中给 `dsh-yuanbao` 显式指定模型，覆盖宿主默认模型：

```yaml
- insert:
    - id: dsh-yuanbao
      name: '@anxi78/dsh-yuanbao'
      config:
        provider: openai
        model: gpt-4o-mini
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appKey` | string | `''` | 元宝 AppKey，默认读取 `YUANBAO_APP_KEY` |
| `appSecret` | string | `''` | 元宝 AppSecret，默认读取 `YUANBAO_APP_SECRET` |
| `token` | string | - | 预签名元宝 WebSocket token，默认读取 `YUANBAO_TOKEN` |
| `apiDomain` | string | `bot.yuanbao.tencent.com` | 元宝开放平台 API 域名 |
| `wsGatewayUrl` | string | `wss://bot-wss.yuanbao.tencent.com/wss/connection` | 元宝 WebSocket Gateway 地址 |
| `routeEnv` | string | - | 元宝路由环境 |
| `botId` | string | - | 已知元宝 bot id |
| `provider` | string | - | DSH LLM provider；为空时继承宿主默认模型 |
| `model` | string | - | DSH model；为空时继承宿主默认模型 |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent 工作目录 |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 才触发 |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `groupPrompt` | string | - | 群聊额外 system prompt |
| `textChunkLimit` | number | `3000` | 单条出站消息最大字符数 |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时，默认 30 分钟 |
| `sessionMode` | `per-peer` / `pinned` | `per-peer` | **本分支新增**：会话路由模式 |
| `pinnedSessionId` | string | `''` | **本分支新增**：pinned 模式下的目标会话 ID，留空回退 per-peer |
| `historyLimit` | number | `20` | **本分支新增**：群聊上下文条数，@bot 时带上最近 N 条；0 = 关闭 |
| `processingTimeoutMs` | number | `120000` | Agent 处理超时 |
| `maxReconnectAttempts` | number | `100` | WebSocket 最大重连次数 |
| `access.c2cMode` | `open` / `allowlist` / `disabled` | `open` | 私聊访问控制 |
| `access.c2cAllow` | string[] | `[]` | 私聊 allowlist |
| `access.groupMode` | `open` / `allowlist` / `disabled` | `open` | 群聊访问控制 |
| `access.groupAllow` | string[] | `[]` | 群聊 allowlist |
| `debug` | boolean | `false` | 调试模式 |

默认 bundle patch：

```yaml
- insert:
    - id: dsh-yuanbao
      name: '@anxi78/dsh-yuanbao'
      config:
        appKey: !!js process.env.YUANBAO_APP_KEY ?? ''
        appSecret: !!js process.env.YUANBAO_APP_SECRET ?? ''
        token: !!js process.env.YUANBAO_TOKEN ?? ''
        cwd: !!js process.env.DSH_YUANBAO_CWD ?? process.cwd()
        requireMention: true
        textChunkLimit: 3000
        sessionIdleTimeout: 1800000
```

## 内置命令

| 命令 | 说明 |
|------|------|
| `/yb-help` / `/yuanbao-help` | 查看所有指令 |
| `/yb-status` / `/yuanbao-status` | 查看当前会话状态 |
| `/yb-reset` / `/yuanbao-reset` | 重置当前会话上下文 |

## 核心模块

```text
src/
├── index.ts                    # Cordis 插件入口
├── bridge.ts                   # Gateway / SessionManager / 出入站桥接
├── config.ts                   # 配置 Schema
├── types.ts                    # 全局类型定义
├── env-loader.ts               # 本地 .env 加载
├── logger.ts                   # 统一日志入口
├── inbound.ts                  # 元宝入站消息 → agent.followup()
├── commands.ts                 # 内置命令
├── gateway/                    # 元宝 Gateway 层
│   ├── index.ts                # WebSocket 生命周期与 push 分发
│   ├── auth.ts                 # appKey / appSecret 签票鉴权
│   ├── env.ts                  # User-Agent / 设备信息
│   └── protocol/               # WebSocket / protobuf 协议编解码
├── session/                    # 会话管理层
│   ├── manager.ts              # 元宝 peer → dsh Agent 映射
│   └── idle-evictor.ts         # 闲置回收
└── transport/                  # 出站传输层
    ├── sender.ts               # C2C / 群消息 / heartbeat 发送
    ├── outbound.ts             # session/event → 元宝消息
    ├── outbound-buffer.ts      # 流式输出缓冲
    ├── heartbeat.ts            # loading / 思考气泡心跳控制
    └── chunker.ts              # 文本切分
```

## 会话路由

元宝私聊或群聊会稳定映射到一个 dsh session：

```text
sessionKey = yuanbao:${accountId}:${scope}:${peerId}
sessionId  = sha256(sessionKey) 派生
```

解析策略：

```text
进程内复用 → 持久化恢复 → 全新创建
```

这样可以保证：

- 同一个元宝私聊用户上下文连续
- 同一个元宝群聊上下文连续
- dsh 重启后可恢复历史 session
- 不直接暴露元宝用户标识

### pinned 模式（本分支新增）

把 `sessionMode` 设为 `pinned` 并填上 `pinnedSessionId` 后，**所有群聊和私聊的消息都会路由到同一个会话**：

```text
sessionKey = yuanbao:${accountId}:pinned:${pinnedSessionId}
sessionId  = pinnedSessionId（直接使用，不再哈希）
```

使用场景：想让所有渠道的消息都汇总到一个"总控"会话里，由同一个 agent 上下文统一处理。

在「设置 → 元宝」里可以直接切换，会话列表从 DSH 实时读取，不用手填 UUID。

**留空 `pinnedSessionId` 会自动回退到 per-peer**，不会把所有消息塞进一个空会话。

## 设计原则

- **纯 Cordis 插件** — 不修改 deepseek-harness agent loop
- **通道适配独立** — 元宝协议转换在插件内完成，Agent runtime 仍由 dsh 管理
- **会话隔离** — 每个私聊 / 群聊独立映射 Agent session
- **模型继承** — 默认继承宿主 `agent-default-model`，也可显式配置 `provider` / `model`
- **流式缓冲** — 聚合 `assistant/chunk`，避免 IM 侧逐 token 刷屏
- **思考气泡** — 用元宝 heartbeat `RUNNING` / `FINISH` 驱动 loading 状态
- **安全默认** — 密钥只从环境变量读取，日志会对 secret / token 等字段脱敏

## 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# watch
pnpm dev

# 本地安装到 web profile
dsh plugin --profile web add /path/to/dsh-yuanbao
dsh --profile web
```

## License

MIT
