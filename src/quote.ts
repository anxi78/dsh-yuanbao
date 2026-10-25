/**
 * 引用消息处理
 * =============
 * 元宝的消息结构限制：
 *   · 要 @bot 触发，必须是**文字消息**
 *   · 图片/文件消息本身不能 @bot
 *
 * 所以用户想让我看图时，实际发的是：
 *   「引用某条图片消息 + @bot + 一句文字」
 *
 * 引用信息不在 msg_body 里，而在消息级的 cloud_custom_data：
 *
 *   {
 *     "quote": {
 *       "desc": "被引用的文字内容",   // 文字引用时有值
 *       "type": 1,                    // 1文字 2图片 3文件 4视频 5语音
 *       "id": "被引用消息的 msgId",   // 媒体引用时用它查历史
 *       "sender_id": "...",
 *       "sender_nickname": "..."
 *     }
 *   }
 *
 * 媒体类引用的 desc 是空的，必须靠 chat-history 按 id 回查。
 */

import { findMediaByMessageId } from './chat-history.js';
import type { InboundMedia } from './media.js';

/** IM 消息类型（对应腾讯 IM 协议） */
export const enum ImClientMessageType {
  MT_UNKNOWN = 0,
  MT_TEXT = 1,
  MT_PIC = 2,
  MT_FILE = 3,
  MT_VIDEO = 4,
  MT_AUDIO = 5,
}

/** 引用信息 */
export type QuoteInfo = {
  /** 被引用的文字内容；媒体类引用时为空 */
  desc?: string;
  /** 被引用消息的类型 */
  type?: number;
  /** 被引用消息的 id */
  id?: string;
  sender_id?: string;
  sender_nickname?: string;
};

/** 媒体类型 → 展示标签 */
const TYPE_LABEL: Record<number, string> = {
  [ImClientMessageType.MT_PIC]: 'image',
  [ImClientMessageType.MT_FILE]: 'file',
  [ImClientMessageType.MT_VIDEO]: 'video',
  [ImClientMessageType.MT_AUDIO]: 'voice',
};

function isMediaQuoteType(type: number): boolean {
  return type in TYPE_LABEL;
}

/** 引用文本最大长度，避免超长引用占满上下文 */
const QUOTE_DESC_MAX_LENGTH = 500;

/**
 * 从 cloud_custom_data 解析引用信息。
 *
 * @returns undefined 表示没有引用，或引用里没有任何可用信息
 */
export function parseQuote(cloudCustomData: string | undefined): QuoteInfo | undefined {
  if (!cloudCustomData) return undefined;
  try {
    const parsed = JSON.parse(cloudCustomData) as { quote?: QuoteInfo };
    if (!parsed?.quote || typeof parsed.quote !== 'object') return undefined;
    const quote = parsed.quote;

    // 文字引用：desc 直接就是内容
    if (quote.desc?.trim()) return quote;

    // 媒体引用：desc 为空，但类型能识别出来 —— 保留，后面按 id 回查
    if (isMediaQuoteType(Number(quote.type))) return quote;

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析引用对应的媒体。
 *
 * 媒体引用的 desc 是空的，只能靠 quote.id 去本地媒体历史里找。
 * 找不到就返回 undefined —— 这时调用方会退化成 `[image]` 这样的标签。
 */
export function resolveQuoteMedia(
  quote: QuoteInfo,
  chatKey: string,
): InboundMedia | undefined {
  const type = Number(quote.type);
  if (!isMediaQuoteType(type)) return undefined;

  const entry = findMediaByMessageId(chatKey, quote.id);
  if (!entry || entry.medias.length === 0) return undefined;

  const first = entry.medias[0];
  if (!first || !first.url) return undefined;

  const label = TYPE_LABEL[type] ?? 'media';
  const kind: 'image' | 'file' = type === ImClientMessageType.MT_PIC ? 'image' : 'file';
  const name = first.name || label;

  return {
    kind,
    url: first.url,
    name,
    placeholder: `[quoted ${label}: ${name}]`,
  };
}

/**
 * 把引用格式化成给 agent 看的上下文。
 *
 * 文字引用：
 *   > [引用 @某人 的消息]:
 *   >被引用的内容
 *
 * 媒体引用（查不到实体时）：
 *   > [引用 @某人 的消息]:
 *   >[image]
 */
export function formatQuoteContext(quote: QuoteInfo): string {
  let senderPart = '';
  if (quote.sender_nickname) senderPart = ` from ${quote.sender_nickname}`;
  else if (quote.sender_id) senderPart = ` from ${quote.sender_id}`;

  let desc = quote.desc?.trim() || '';
  if (!desc) {
    const type = Number(quote.type);
    const label = TYPE_LABEL[type] ?? 'media';
    desc = `[${label}]`;
  }
  if (desc.length > QUOTE_DESC_MAX_LENGTH) {
    desc = `${desc.slice(0, QUOTE_DESC_MAX_LENGTH)}...(truncated)`;
  }

  return `> [引用消息${senderPart}]:\n>${desc}`;
}
