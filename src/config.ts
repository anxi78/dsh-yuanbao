import Schema from '@deepseek-ai/schemastery';
import type { YuanbaoDshConfig } from './types.js';

export const ConfigSchema: Schema<YuanbaoDshConfig> = Schema.object({
  appKey: Schema.string().default('').description('Yuanbao App Key'),
  appSecret: Schema.string().default('').description('Yuanbao App Secret'),
  token: Schema.string().description('Pre-signed Yuanbao WebSocket token'),
  apiDomain: Schema.string().default('bot.yuanbao.tencent.com').description('Yuanbao API domain'),
  wsGatewayUrl: Schema.string().default('wss://bot-wss.yuanbao.tencent.com/wss/connection').description('Yuanbao WebSocket gateway URL'),
  routeEnv: Schema.string().description('Yuanbao route environment'),
  botId: Schema.string().description('Known Yuanbao bot id'),
  provider: Schema.string().description('DSH LLM provider name'),
  model: Schema.string().description('DSH model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().default('/').description('Agent working directory'),
  requireMention: Schema.boolean().default(true).description('Require mention in group chats'),
  directPrompt: Schema.string().description('Extra system prompt for direct chats'),
  groupPrompt: Schema.string().description('Extra system prompt for group chats'),
  textChunkLimit: Schema.number().default(3000).description('Maximum chars per outbound message'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('Idle session eviction timeout in ms'),
  sessionMode: Schema.union(['per-peer', 'pinned'])
    .default('per-peer')
    .description('会话路由模式：per-peer = 每个群聊/私聊各开一个会话（原版行为）；pinned = 所有消息都进下面指定的那个会话'),
  pinnedSessionId: Schema.string()
    .default('')
    .description('sessionMode=pinned 时使用的会话 ID（在 DSH 会话列表里能看到，形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）。留空则回退到 per-peer'),
  processingTimeoutMs: Schema.number().default(120000).description('Agent processing timeout in ms'),
  maxReconnectAttempts: Schema.number().default(100).description('Maximum WebSocket reconnect attempts'),
  access: Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open'),
    c2cAllow: Schema.array(Schema.string()).default([]),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open'),
    groupAllow: Schema.array(Schema.string()).default([]),
  }).default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('Channel-level access control'),
  debug: Schema.boolean().default(false),
});
