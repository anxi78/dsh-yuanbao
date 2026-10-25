/**
 * 聊天媒体历史
 * =============
 * 元宝的「引用消息」只带被引用消息的 id 和类型，媒体类引用（图片/文件）
 * 的 desc 是空的。要还原出真实内容，必须靠本地缓存：
 *
 *   收到媒体消息 → 记下 { messageId, medias[] }
 *   收到引用消息 → 按 quote.id 查缓存 → 找到原来的 URL 和文件名
 *
 * 为什么要独立于消息历史：
 *   群聊里 @bot 之后消息历史会被清理，但引用随时可能指向更早的图片。
 *   媒体历史单独存，生命周期更长。
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

/** 每个会话保留多少条记录 */
const MAX_ENTRIES = 50;

/** chatKey → 媒体历史 */
export const chatMediaHistories = new Map<string, MediaHistoryEntry[]>();

/**
 * 生成会话级缓存键。
 * 群聊用 group:{groupCode}，私聊用 direct:{fromAccount}。
 */
export function deriveChatKey(isGroup: boolean, groupCode?: string, fromAccount?: string): string {
  if (isGroup && groupCode) return `group:${groupCode}`;
  return `direct:${fromAccount || 'unknown'}`;
}

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
  while (list.length > MAX_ENTRIES) list.shift();

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

/** 清空某个会话的历史（会话结束时调用） */
export function clearChatHistory(chatKey: string): void {
  chatMediaHistories.delete(chatKey);
}
