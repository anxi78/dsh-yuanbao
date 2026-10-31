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
 * chatKey → 该会话收到的**最后一条消息**的元信息。
 *
 * 和 chatTextHistories 的区别：文本历史只记有正文的消息，
 * 纯图片消息没有正文会被跳过。但「发图后立刻 @bot」需要知道
 * 上一条消息**到底是什么**（哪怕它没有文字），所以单独记一份。
 */
export type LastMessageEntry = {
  /** 消息 id */
  messageId?: string;
  /** 发送者账号（稳定标识，用于判断是不是同一个人） */
  senderId?: string;
  /** 发送者昵称 */
  senderNickname?: string;
  /** 这条消息携带的媒体类型（image/file/undefined） */
  mediaKinds: Array<'image' | 'file'>;
  /** 媒体列表（供自动附图使用） */
  medias: Array<{ url: string; name?: string; kind?: 'image' | 'file' }>;
  /** 记录时间 */
  timestamp: number;
};

export const chatLastMessage = new Map<string, LastMessageEntry>();

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

/**
 * 记录「这个会话收到的最后一条消息」。
 *
 * 每条消息都要调（包括没有正文的纯图片消息），
 * 这样「发图后立刻 @bot」才能判断上一条到底是什么。
 */
export function rememberLastMessage(
  chatKey: string,
  entry: {
    messageId?: string;
    senderId?: string;
    senderNickname?: string;
    medias: InboundMedia[];
  },
): void {
  const medias = (entry.medias || [])
    .filter(m => m.url)
    .map(m => ({ url: m.url, name: m.name, kind: m.kind }));

  chatLastMessage.set(chatKey, {
    messageId: entry.messageId,
    senderId: entry.senderId,
    senderNickname: entry.senderNickname,
    mediaKinds: medias.map(m => m.kind).filter((k): k is 'image' | 'file' => Boolean(k)),
    medias,
    timestamp: Date.now(),
  });
}

/** 取这个会话的最后一条消息（没有则 undefined） */
export function lastMessage(chatKey: string): LastMessageEntry | undefined {
  return chatLastMessage.get(chatKey);
}

/**
 * 取最近一条媒体记录。
 *
 * 用于「发图后立刻 @bot」的自动附图机制：需要判断上一条消息
 * 是不是同一人发的图片。只看最后一条，不做模糊匹配。
 */
export function latestMedia(chatKey: string): MediaHistoryEntry | undefined {
  const list = chatMediaHistories.get(chatKey);
  if (!list || list.length === 0) return undefined;
  return list[list.length - 1];
}

/** 清空某个会话的全部历史（会话结束时调用） */
export function clearChatHistory(chatKey: string): void {
  chatMediaHistories.delete(chatKey);
  chatTextHistories.delete(chatKey);
  chatLastMessage.delete(chatKey);
}


// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
// 历史原本只在内存里，DSH 一重启就全没了。
// 这里落盘到 ~/.dsh/.yuanbao-history.json，启动时读回。
//
// 设计取舍：
//   · 只存文本历史，不存媒体历史 —— 媒体的 url 有签名时效，过期了也用不了
//   · 写入做防抖，避免每条消息都碰一次磁盘
//   · 读取失败静默忽略，历史丢失不能阻断插件启动

const HISTORY_FILE = '.yuanbao-history.json';

/** 每个会话最多落盘多少条（比内存上限小，控制文件体积） */
const PERSIST_MAX_PER_CHAT = 50;

type PersistedShape = {
  version: 1;
  chats: Record<string, TextHistoryEntry[]>;
};

function historyPath(): string {
  const home = process.env.DSH_HOME
    || (process.env.HOME ? `${process.env.HOME}/.dsh` : '');
  if (!home) return '';
  return `${home}/${HISTORY_FILE}`;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistPending = false;

/** 把当前文本历史写入磁盘（异步、防抖、失败只警告） */
async function flushHistory(logger?: { warn: (m: string) => void }): Promise<void> {
  const file = historyPath();
  if (!file) return;

  const chats: Record<string, TextHistoryEntry[]> = {};
  for (const [key, list] of chatTextHistories) {
    if (list.length === 0) continue;
    chats[key] = list.slice(-PERSIST_MAX_PER_CHAT);
  }

  const payload: PersistedShape = { version: 1, chats };
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) {
    logger?.warn(`history persist failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 安排一次防抖写盘（200ms 内的多次改动合并成一次） */
export function schedulePersist(logger?: { warn: (m: string) => void }): void {
  if (!historyPath()) return;
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (!persistPending) return;
    persistPending = false;
    void flushHistory(logger);
  }, 200);
  // 不让定时器拖住进程退出
  if (typeof persistTimer === 'object' && persistTimer && 'unref' in persistTimer) {
    (persistTimer as { unref: () => void }).unref();
  }
}

/**
 * 启动时从磁盘恢复文本历史。
 *
 * 只恢复最近的条目，过旧的历史带进上下文反而干扰。
 */
export async function loadPersistedHistory(
  logger?: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  const file = historyPath();
  if (!file) return;
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || parsed.version !== 1 || !parsed.chats) return;

    let restored = 0;
    for (const [key, list] of Object.entries(parsed.chats)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      chatTextHistories.set(key, list.slice(-TEXT_MAX_PER_CHAT));
      restored += list.length;
    }
    logger?.info(`history restored: ${restored} entries across ${Object.keys(parsed.chats).length} chats`);
  } catch (error) {
    // 文件不存在是正常的首次启动
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('ENOENT')) {
      logger?.warn(`history load failed: ${msg}`);
    }
  }
}
