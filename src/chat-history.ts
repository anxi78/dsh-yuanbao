/**
 * 聊天历史
 * =========
 * 两类历史，生命周期不同：
 *
 *   1. 文本历史（chatTextHistories）
 *      群里每条消息都记下来，@bot 时拼进上下文，让 agent 知道刚才在聊什么。
 *      回复完成后按 limit 清空已消费的部分。
 *
 *   2. 媒体历史（chatMediaHistories）
 *      记录消息携带的图片/文件，供「引用消息」按 id 回查。
 *      独立存储：@bot 后文本历史会被清理，但引用随时可能指向更早的图片。
 *
 * 为什么要自己维护文本历史：
 *   元宝只把「@bot 的那条消息」推给插件，群里的其他消息插件根本收不到。
 *   等等——实际上群消息都会推送，只是没有 @ 时被 requireMention 丢掉了。
 *   所以在丢弃之前先记进历史，@bot 时就能带上上下文。
 */

import type { InboundMedia } from './media.js';

/** 一条媒体历史记录 */
export type MediaHistoryEntry = {
  /** 发送者标识（昵称或账号） */
  sender: string;
  /** 消息 id，引用时用它来匹配 */
  messageId?: string;
  /** 记录时间戳（ms），用于 LRU 淘汰 */
  timestamp: number;
  /** 这条消息携带的媒体 */
  medias: Array<{ url: string; name?: string; kind?: 'image' | 'file' }>;
};

/** 一条文本历史记录 */
export type TextHistoryEntry = {
  /** 消息 id */
  messageId?: string;
  /** 发送者昵称（优先）或账号 */
  sender: string;
  /** 发送者账号（稳定标识） */
  senderId?: string;
  /** 消息正文（已去除 @bot 的部分） */
  body: string;
  /** 消息时间戳（ms） */
  timestamp: number;
};

/** 媒体历史每个会话保留多少条 */
const MEDIA_MAX_PER_CHAT = 50;

/** 文本历史每个会话最多保留多少条（防止无限增长） */
const TEXT_MAX_PER_CHAT = 200;

/** chatKey → 媒体历史 */
export const chatMediaHistories = new Map<string, MediaHistoryEntry[]>();

/** chatKey → 文本历史 */
export const chatTextHistories = new Map<string, TextHistoryEntry[]>();

/**
 * 生成会话级缓存键。
 * 群聊用 group:{groupCode}，私聊用 direct:{fromAccount}。
 */
export function deriveChatKey(isGroup: boolean, groupCode?: string, fromAccount?: string): string {
  if (isGroup && groupCode) return `group:${groupCode}`;
  return `direct:${fromAccount || 'unknown'}`;
}

// ---------------------------------------------------------------------------
// 文本历史
// ---------------------------------------------------------------------------

/**
 * 记录一条群聊文本消息。
 *
 * 空正文（比如纯图片消息）不记 —— 图片走媒体历史，
 * 这里记了也只是空行，反而污染上下文。
 */
export function rememberText(
  chatKey: string,
  entry: { messageId?: string; sender: string; senderId?: string; body: string },
): void {
  const body = (entry.body || '').trim();
  if (!body) return;

  const list = chatTextHistories.get(chatKey) ?? [];
  list.push({
    messageId: entry.messageId,
    sender: entry.sender,
    senderId: entry.senderId,
    body,
    timestamp: Date.now(),
  });

  while (list.length > TEXT_MAX_PER_CHAT) list.shift();

  chatTextHistories.set(chatKey, list);
}

/**
 * 取出最近 limit 条文本历史。
 *
 * 返回的是**当前消息之前**的历史 —— 调用方应在记录当前消息之前调用，
 * 否则当前消息会重复出现（一次在历史里，一次在正文里）。
 */
export function recentText(chatKey: string, limit: number): TextHistoryEntry[] {
  if (limit <= 0) return [];
  const list = chatTextHistories.get(chatKey);
  if (!list || list.length === 0) return [];
  return list.slice(-limit);
}

/**
 * 消费掉最近 limit 条历史。
 *
 * 回复完成后调用：这些内容已经进了 agent 的上下文，
 * 下次再拼一遍就是重复。
 */
export function consumeText(chatKey: string, limit: number): void {
  if (limit <= 0) {
    chatTextHistories.delete(chatKey);
    return;
  }
  const list = chatTextHistories.get(chatKey);
  if (!list) return;
  if (list.length <= limit) {
    chatTextHistories.delete(chatKey);
    return;
  }
  chatTextHistories.set(chatKey, list.slice(0, list.length - limit));
}

// ---------------------------------------------------------------------------
// 媒体历史
// ---------------------------------------------------------------------------

/**
 * 记录一条消息携带的媒体。
 *
 * 只记录有 url 的媒体 —— 没有 url 的拿不到实际内容，记了也没用。
 */
export function rememberMedia(
  chatKey: string,
  entry: { sender: string; messageId?: string; medias: InboundMedia[] },
): void {
  const medias = (entry.medias || [])
    .filter(m => m.url)
    .map(m => ({ url: m.url, name: m.name, kind: m.kind }));

  if (medias.length === 0) return;

  const list = chatMediaHistories.get(chatKey) ?? [];
  list.push({
    sender: entry.sender,
    messageId: entry.messageId,
    timestamp: Date.now(),
    medias,
  });

  // LRU：超出上限就丢最旧的
  while (list.length > MEDIA_MAX_PER_CHAT) list.shift();

  chatMediaHistories.set(chatKey, list);
}

/**
 * 按消息 id 查媒体历史。
 *
 * 从后往前找 —— 引用通常指向较近的消息。
 */
export function findMediaByMessageId(
  chatKey: string,
  messageId: string | undefined,
): MediaHistoryEntry | undefined {
  if (!messageId) return undefined;
  const list = chatMediaHistories.get(chatKey);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item && item.messageId === messageId) return item;
  }
  return undefined;
}

/** 清空某个会话的全部历史（会话结束时调用） */
export function clearChatHistory(chatKey: string): void {
  chatMediaHistories.delete(chatKey);
  chatTextHistories.delete(chatKey);
}
