import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {
  ChatScope,
  Logger,
  ReplyTarget,
  YuanbaoDshConfig,
  YuanbaoInboundMessage,
  YuanbaoMsgBodyElement,
} from './types.js';
import type { SessionManager } from './session/manager.js';
import type { YuanbaoSender } from './transport/sender.js';
import { createReplyHeartbeatController } from './transport/heartbeat.js';
import { handleBuiltinCommand } from './commands.js';
import { buildMediaBlocks, downloadMedia, extractMedias, guessImageMediaType, IMAGE_MEDIA_TYPES, type InboundMedia } from './media.js';
import { formatQuoteContext, parseQuote, resolveQuoteMedia, type QuoteInfo } from './quote.js';
import { consumeText, deriveChatKey, lastMessage, recentText, rememberLastMessage, rememberMedia, rememberText, schedulePersist, type TextHistoryEntry } from './chat-history.js';
import type { AttachmentStoreLike } from './media.js';

export async function handleInbound(params: {
  msg: YuanbaoInboundMessage;
  isGroup: boolean;
  manager: SessionManager;
  sender: YuanbaoSender;
  config: YuanbaoDshConfig;
  logger: Logger;
  /** DSH attachment store, used to persist inbound images/files for the agent. */
  attachments?: AttachmentStoreLike;
}): Promise<void> {
  const { msg, isGroup, manager, sender, config, logger, attachments } = params;
  const scope: ChatScope = isGroup ? 'group' : 'c2c';
  const peerId = isGroup ? msg.group_code : msg.from_account;
  const senderId = msg.from_account;
  logger.info(`inbound received: scope=${scope}; peer=${peerId ?? ''}; sender=${senderId ?? ''}; to=${msg.to_account ?? ''}; msgId=${msg.msg_id ?? ''}; body=${msg.msg_body?.length ?? 0}`);
  if (!peerId || !senderId) {
    logger.warn(`inbound dropped: missing peerId or senderId; scope=${scope}; peer=${peerId ?? ''}; sender=${senderId ?? ''}`);
    logger.warn('drop inbound message: missing peerId or senderId');
    return;
  }

  if (!allowed(config, scope, peerId, senderId)) {
    logger.warn(`inbound dropped: access denied; scope=${scope}; peer=${peerId}; sender=${senderId}`);
    logger.warn(`drop inbound message by access policy: scope=${scope}, peer=${peerId}, sender=${senderId}`);
    return;
  }

  const msgBody = msg.msg_body ?? [];
  const extracted = extractText(msgBody);

  // ── 先记录本条消息的媒体 ──
  // 关键：必须放在 @bot 检查**之前**。
  // 元宝里图片消息不能 @bot，所以用户先发图（没 @bot）→ 会被下面的
  // requireMention 直接 return 掉。如果把记录放在后面，那张图就永远
  // 进不了历史，之后引用它时只能降级成 [image] 占位。
  const chatKey = deriveChatKey(isGroup, msg.group_code, msg.from_account);

  // ── 诊断：把收到的消息体结构打出来 ──
  // 图片引用拿不到 URL 时，靠这段日志判断是「图片消息没收到」
  // 还是「收到了但 image_info_array 里没有 url」。
  try {
    const shape = msgBody.map((e) => {
      const c = e.msg_content ?? {};
      const info = Array.isArray(c.image_info_array) ? c.image_info_array : [];
      return {
        type: e.msg_type,
        hasText: Boolean(c.text),
        hasData: Boolean(c.data),
        hasUrl: Boolean(c.url),
        uuid: c.uuid ? String(c.uuid).slice(0, 20) : '',
        imgInfoCount: info.length,
        imgInfoUrls: info.map((x) => (x && typeof x.url === 'string' ? x.url.slice(0, 60) : '')),
        keys: Object.keys(c).slice(0, 12),
      };
    });
    logger.info(`inbound body shape: ${JSON.stringify(shape)}`);
  } catch (e) {
    logger.warn(`inbound body shape dump failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const ownMedias = extractMedias(msgBody);
  if (ownMedias.length > 0) {
    rememberMedia(chatKey, {
      sender: msg.sender_nickname ?? msg.from_account ?? 'unknown',
      messageId: msg.msg_id,
      medias: ownMedias,
    });
    logger.info(`inbound media remembered: count=${ownMedias.length}; chatKey=${chatKey}; msgId=${msg.msg_id ?? ''}`);
  }

  // ── 先取出「当前消息之前」的历史，再记录当前消息 ──
  // 顺序不能反：先记录再取，当前消息会在历史和正文里各出现一次。
  // 只有群聊需要历史；私聊本身就是一对一，没有「群里别人说话」的概念。
  const historyLimit = isGroup ? (config.historyLimit ?? 20) : 0;
  const pendingHistory: TextHistoryEntry[] = historyLimit > 0
    ? recentText(chatKey, historyLimit)
    : [];

  // ── 发图后立刻 @bot：自动把那张图带上 ──
  // 场景：用户先发一张图（这条 @ 不到 bot），紧接着 @bot 问「这张图是什么」。
  // 如果中间没有别人插话，就把那张图自动作为附件。
  //
  // 严格条件：
  //   1. 上一条媒体记录必须是**当前发送者**发的
  //   2. 必须是**最后一条**消息（中间有任何人的消息都不算）
  //   3. 只对图片生效，文件不生效
  // 先读「上一条消息」——必须在记录当前消息之前。
  // 顺序反了的话，读到的就是当前这条，判断永远不成立。
  const prevMessage = isGroup ? lastMessage(chatKey) : undefined;

  const autoImages: InboundMedia[] = [];
  if (isGroup && msg.from_account) {
    // 用「最后一条消息」判断，不是「最后一条媒体」。
    // 差别很关键：如果中间有人发了文字，媒体历史里不会有记录，
    // 用媒体历史就会误判成「上一条还是那张图」。
    const last = prevMessage;
    if (last && last.senderId === msg.from_account) {
      // 严格条件：上一条必须**只有图片**，且至少一张。
      // 混着文件、或纯文件、或纯文字，都不触发。
      const onlyImages = last.medias.length > 0 && last.medias.every(m => m.kind === 'image');
      if (onlyImages) {
        // 一次发多张时全部带上，不是只取第一张
        for (const m of last.medias) {
          if (!m.url) continue;
          const name = m.name || `auto-image-${autoImages.length + 1}.jpg`;
          autoImages.push({
            kind: 'image',
            url: m.url,
            name,
            placeholder: `[image: ${name}]`,
          });
        }
        logger.info(`inbound auto-image: 上一条是同一人发的纯图片，自动附带 ${autoImages.length} 张`);
      } else {
        logger.info(`inbound auto-image skipped: 上一条不是纯图片（kinds=${last.mediaKinds.join(',') || 'none'}）`);
      }
    } else if (last) {
      logger.info(`inbound auto-image skipped: 上一条不是同一人发的（last=${last.senderId ?? 'unknown'}）`);
    }
  }

  // 判断完上一条，再把当前这条记成「最后一条」。
  // 位置很关键：早了会把当前消息当成上一条，晚了下次就查不到。
  if (isGroup) {
    rememberLastMessage(chatKey, {
      messageId: msg.msg_id,
      senderId: msg.from_account,
      senderNickname: msg.sender_nickname,
      medias: ownMedias,
    });
  }

  // 记录当前这条消息（同样在 @bot 检查之前）。
  // 没 @bot 的消息会被 requireMention 丢掉，但它已经进了历史，
  // 下次有人 @bot 时就能看到它。
  if (isGroup && historyLimit > 0) {
    rememberText(chatKey, {
      messageId: msg.msg_id,
      sender: msg.sender_nickname ?? msg.from_account ?? 'unknown',
      senderId: msg.from_account,
      body: stripMention(extracted, config.botId || msg.to_account || sender.getAccount().botId || ''),
    });
    schedulePersist(logger);
  }

  // 诊断：把 cloud_custom_data 原文打出来。
  if (msg.cloud_custom_data) {
    logger.info(`inbound cloud_custom_data: ${String(msg.cloud_custom_data).slice(0, 600)}`);
  } else {
    logger.info('inbound cloud_custom_data: (empty)');
  }

  // ── 先解析引用（必须在 @bot 检查之前）──
  // 用户可能发一条「只有引用、没有 @」的消息（比如引用一段文字然后只打
  // 几个不可见字符）。这条消息会被 requireMention 丢掉，但它引用的内容
  // 应该记进历史 —— 否则后面 @bot 时完全不知道之前引用过什么。
  const earlyQuote = parseQuote(msg.cloud_custom_data);
  if (earlyQuote) {
    logger.info(`inbound early quote: type=${earlyQuote.type ?? '?'}; hasDesc=${Boolean(earlyQuote.desc)}; id=${earlyQuote.id ?? ''}`);
    if (isGroup && historyLimit > 0) {
      const quoteText = earlyQuote.desc?.trim();
      if (quoteText) {
        // 引用的是文字：把引用内容也记进历史，让它成为上下文的一部分
        rememberText(chatKey, {
          messageId: msg.msg_id,
          sender: msg.sender_nickname ?? msg.from_account ?? 'unknown',
          senderId: msg.from_account,
          body: `[引用 ${earlyQuote.sender_nickname ?? earlyQuote.sender_id ?? '某人'} 的消息: ${quoteText}]`,
        });
        schedulePersist(logger);
        logger.info(`inbound early quote recorded to history: chars=${quoteText.length}`);
      }
    }
  }

  // Prefer the explicitly configured botId; otherwise fall back to the id
  // resolved during the sign-token exchange, which is the authoritative
  // identity for deciding whether this bot was @mentioned.
  const botIdentity = config.botId || msg.to_account || sender.getAccount().botId || '';
  const mentioned = detectMention(msgBody, extracted, botIdentity);
  logger.info(`inbound text extracted: chars=${extracted.length}; requireMention=${scope === 'group' && config.requireMention ? 'yes' : 'no'}; mentioned=${mentioned ? 'yes' : 'no'}; botIdentity=${botIdentity || 'empty'}`);
  if (scope === 'group' && config.requireMention && !mentioned) {
    // Distinguish "nobody mentioned us" from "we have no identity to compare
    // against": the latter silently disables every group reply.
    if (!botIdentity) {
      logger.warn(`inbound dropped: bot identity unknown, cannot detect @mention; group=${peerId}; textPreview=${preview(extracted)}`);
    } else {
      logger.warn(`inbound dropped: group message without mention; group=${peerId}; textPreview=${preview(extracted)}`);
    }
    logger.debug(`drop group message without mention: group=${peerId}`);
    return;
  }

  const text = stripMention(extracted, botIdentity).trim();

  // ── 引用消息 ──
  // 元宝里要 @bot 必须是文字消息，所以用户想让我看图时，
  // 实际发的是「引用那条图片 + @我 + 一句文字」。
  // 引用信息在消息级的 cloud_custom_data 里，不在 msg_body。
  const quote = parseQuote(msg.cloud_custom_data);
  const quoteMedia = quote ? resolveQuoteMedia(quote, chatKey) : undefined;
  if (quote) {
    logger.info(`inbound quote detected: type=${quote.type ?? '?'}; hasDesc=${Boolean(quote.desc)}; id=${quote.id ?? ''}; mediaResolved=${quoteMedia ? 'yes' : 'no'}`);
  }

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    groupCode: msg.group_code,
    fromAccount: msg.to_account || sender.getAccount().botId,
    refMsgId: msg.msg_id,
    refFromAccount: msg.from_account,
    traceId: msg.trace_id,
  };

  if (await handleBuiltinCommand({ text, scope, peerId, replyTarget, manager, sender, logger })) {
    logger.info(`inbound handled by builtin command: ${preview(text)}`);
    return;
  }

  const body = buildAgentBody({ msg, text, scope, mentioned, config, quote, quoteMedia, history: pendingHistory, botIdentity, autoImages });
  if (!body.trim()) {
    logger.warn('inbound dropped: empty agent body');
    return;
  }

  logger.info(`inbound enqueue: scope=${scope}; peer=${peerId}; bodyChars=${body.length}; preview=${preview(text)}`);
  await manager.enqueue(scope, peerId, async () => {
    const record = await manager.getOrCreate(scope, peerId, senderId, replyTarget);
    const content: ContentBlock[] = [{ type: 'text', text: body }];
    // Attach images/files so the agent can actually inspect them. Failures are
    // logged and skipped: losing media must not lose the accompanying text.
    // 诊断：确认附件存储到底有没有注入
    logger.info(`inbound media diag: hasAttachments=${Boolean(attachments)}; ownBody=${msgBody.length}; hasQuoteMedia=${Boolean(quoteMedia)}`);
    if (attachments) {
      logger.info(`inbound media diag: store keys=${Object.keys(attachments).join(',')}; hasSaveImage=${typeof (attachments as { saveImage?: unknown }).saveImage}`);
    }
    let mediaBlocks = await buildMediaBlocks({ body: msgBody, attachments, logger });
    logger.info(`inbound media diag: ownBlocks=${mediaBlocks.length}`);
    // 引用的图片/文件也要附上，否则 agent 只看到「[引用消息]」却看不到内容
    //
    // 注意：这里不能走 buildMediaBlocks。
    // 那个函数靠 extractMedias 解析消息体，而图片的 URL 只从
    // msg_content.image_info_array 里读 —— 构造一个只有 msg_content.url
    // 的伪元素是匹配不上的（实测 extracted=0）。
    // 引用媒体已经有现成的 url 和 name，直接下载 + 存进附件库即可。
    if (quoteMedia && attachments) {
      try {
        // 入站媒体给的是 hunyuan 的 resourceId 地址，直接 GET 会 401。
        // 先换成真正的 COS 地址再下载。
        let effective = quoteMedia;
        if (quoteMedia.url.includes('resourceId=')) {
          const resolvedUrl = await sender.resolveDownloadUrl(quoteMedia.url);
          if (resolvedUrl) {
            effective = { ...quoteMedia, url: resolvedUrl };
            logger.info(`inbound quoted media url resolved: name=${quoteMedia.name}`);
          } else {
            logger.warn(`inbound quoted media url unresolved, trying raw: name=${quoteMedia.name}`);
          }
        }
        const downloaded = await downloadMedia(effective, logger);
        if (downloaded) {
          const guessed = quoteMedia.kind === 'image' ? guessImageMediaType(quoteMedia.name) : undefined;
          const mediaType = guessed ?? downloaded.mediaType;
          if (quoteMedia.kind === 'image' && mediaType && IMAGE_MEDIA_TYPES.has(mediaType)) {
            const ref = await attachments.saveImage({
              data: downloaded.data,
              mediaType,
              name: quoteMedia.name,
            });
            mediaBlocks = mediaBlocks.concat([{ type: 'image', attachment: ref } as unknown as ContentBlock]);
            logger.info(`inbound quoted media attached as image: name=${quoteMedia.name}; bytes=${downloaded.data.byteLength}`);
          } else {
            const ref = await attachments.saveFile({
              data: downloaded.data,
              name: quoteMedia.name,
            });
            mediaBlocks = mediaBlocks.concat([{ type: 'file', attachment: ref } as unknown as ContentBlock]);
            logger.info(`inbound quoted media attached as file: name=${quoteMedia.name}; bytes=${downloaded.data.byteLength}`);
          }
        } else {
          logger.warn(`inbound quoted media download failed: name=${quoteMedia.name}; url=${quoteMedia.url.slice(0, 100)}`);
        }
      } catch (error) {
        logger.warn(`inbound quoted media attach failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // ── 自动附图（发图后立刻 @bot）──
    // 和引用媒体走同一套下载流程：先换 COS 地址，再下载、存附件库。
    // 一次发多张时逐张处理，任何一张失败都不影响其他张。
    if (autoImages.length > 0 && attachments) {
      for (const image of autoImages) {
        try {
          let effective = image;
          if (image.url.includes('resourceId=')) {
            const resolvedUrl = await sender.resolveDownloadUrl(image.url);
            if (resolvedUrl) {
              effective = { ...image, url: resolvedUrl };
              logger.info(`inbound auto-image url resolved: name=${image.name}`);
            }
          }
          const downloaded = await downloadMedia(effective, logger);
          if (downloaded) {
            const guessed = guessImageMediaType(image.name);
            const mediaType = guessed ?? downloaded.mediaType;
            if (mediaType && IMAGE_MEDIA_TYPES.has(mediaType)) {
              const ref = await attachments.saveImage({
                data: downloaded.data,
                mediaType,
                name: image.name,
              });
              mediaBlocks = mediaBlocks.concat([{ type: 'image', attachment: ref } as unknown as ContentBlock]);
              logger.info(`inbound auto-image attached: name=${image.name}; bytes=${downloaded.data.byteLength}`);
            }
          } else {
            logger.warn(`inbound auto-image download failed: name=${image.name}`);
          }
        } catch (error) {
          logger.warn(`inbound auto-image attach failed: ${image.name}; ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (mediaBlocks.length > 0) {
      content.push(...mediaBlocks);
      logger.info(`inbound media attached: count=${mediaBlocks.length}; scope=${scope}; peer=${peerId}`);
    }
    const message = createUserMessage({
      content,
      source: { kind: 'user' as const },
    });
    record.replyHeartbeat?.finishIfNeeded();
    record.replyHeartbeat = createReplyHeartbeatController({ sender, target: replyTarget, logger });
    record.replyHeartbeat.emitRunning();

    logger.info(`agent followup start: session=${record.sessionId}; scope=${scope}; peer=${peerId}`);
    record.agent.followup(message);
    logger.info(`agent followup sent: session=${record.sessionId}; scope=${scope}; peer=${peerId}`);
    logger.info(`followup sent: scope=${scope}, peer=${peerId}, session=${record.sessionId}`);

    // 这批历史已经进了 agent 的上下文，清掉避免下次重复。
    // 只清「本次带进去的条数」，期间新到的消息保留。
    if (scope === 'group' && historyLimit > 0 && pendingHistory.length > 0) {
      consumeText(chatKey, pendingHistory.length);
      schedulePersist(logger);
      logger.info(`inbound history consumed: count=${pendingHistory.length}; chatKey=${chatKey}`);
    }
  });
}

function allowed(config: YuanbaoDshConfig, scope: ChatScope, peerId: string, senderId: string): boolean {
  if (scope === 'group') {
    if (config.access.groupMode === 'disabled') return false;
    if (config.access.groupMode === 'allowlist') return config.access.groupAllow.includes(peerId);
    return true;
  }
  if (config.access.c2cMode === 'disabled') return false;
  if (config.access.c2cMode === 'allowlist') return config.access.c2cAllow.includes(senderId);
  return true;
}

function extractText(body: YuanbaoMsgBodyElement[]): string {
  const parts: string[] = [];
  for (const elem of body) {
    const content = elem.msg_content ?? {};
    if (elem.msg_type === 'TIMTextElem' && content.text) {
      parts.push(String(content.text));
      continue;
    }
    if (elem.msg_type === 'TIMCustomElem' && typeof content.data === 'string' && content.data) {
      try {
        const parsed = JSON.parse(content.data) as { elem_type?: number; text?: string };
        if (parsed?.elem_type === 1002) {
          // @mention: render as its human-readable form so the agent sees it.
          if (parsed.text) parts.push(String(parsed.text));
          continue;
        }
      } catch {
        // Not JSON: fall through to the generic handling below.
      }
    }
    if (content.text) parts.push(String(content.text));
    if (content.desc) parts.push(`[${elem.msg_type}: ${content.desc}]`);
    if (content.sound) parts.push('[voice message]');
    // Media elements carry no text of their own; surface a placeholder so the
    // agent knows an attachment accompanies this message.
    const media = extractMedias([elem])[0];
    if (media) parts.push(media.placeholder);
  }
  return parts.join('\n').trim();
}

/**
 * Extract @mention elements from the message body.
 *
 * TIMCustomElem carries `msg_content.data` as a JSON string; elem_type=1002
 * means an @mention and carries the mentioned user's id in `user_id`.
 * Some payloads only expose a human-readable `desc`, so both are handled.
 */
function extractMentions(body: YuanbaoMsgBodyElement[]): Array<{ userId: string; text: string }> {
  const mentions: Array<{ userId: string; text: string }> = [];
  for (const elem of body) {
    const content = elem.msg_content ?? {};
    if (elem.msg_type !== 'TIMCustomElem') continue;
    const raw = typeof content.data === 'string' ? content.data : '';
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { elem_type?: number; text?: string; user_id?: string };
      if (parsed?.elem_type !== 1002) continue;
      mentions.push({
        userId: typeof parsed.user_id === 'string' ? parsed.user_id : '',
        text: typeof parsed.text === 'string' ? parsed.text : '',
      });
    } catch {
      // Not JSON (or malformed): fall through to desc-based detection below.
      const desc = typeof content.desc === 'string' ? content.desc.trim() : '';
      if (desc.startsWith('@')) mentions.push({ userId: '', text: desc });
    }
  }
  return mentions;
}

function detectMention(body: YuanbaoMsgBodyElement[], text: string, botId: string): boolean {
  const mentions = extractMentions(body);
  // Fail closed: without a known bot identity we cannot tell whether a mention
  // targets this bot, so we never claim one. Replying to every @mention is far
  // worse than staying silent -- the group would see the bot answer messages
  // addressed to other members.
  if (!botId) return false;
  if (mentions.some(m => m.userId === botId)) return true;
  // Fallback for payloads that omit user_id: match the bot id in the @text.
  if (mentions.some(m => m.userId === '' && m.text.replace(/^@/, '') === botId)) return true;
  return text.includes(`@${botId}`);
}

/**
 * Remove only the mentions addressed to this bot, leaving mentions of other
 * members intact so the agent still sees who else was referenced.
 */
function stripMention(text: string, botId: string): string {
  let result = text;
  if (botId) {
    result = result.replaceAll(`@${botId}`, '');
  }
  // Drop the placeholder rendering of our own @mention custom element only.
  // Mentions of other users render as `[TIMCustomElem: @昵称]` too, but we
  // cannot attribute those here, so keep them rather than mangling the text.
  return result.replace(/\[TIMCustomElem:\s*@[^\]]*\]\s*/g, '').trim();
}

function preview(text: string, max = 120): string {
  return text.replace(/\s+/g, ' ').slice(0, max);
}

function buildAgentBody(params: {
  msg: YuanbaoInboundMessage;
  text: string;
  scope: ChatScope;
  mentioned: boolean;
  config: YuanbaoDshConfig;
  /** 被引用的消息；有值时会把内容作为上下文附在正文前 */
  quote?: QuoteInfo;
  /** 引用里回查到的媒体实体（图片/文件） */
  quoteMedia?: InboundMedia;
  /** @bot 之前群里最近的若干条消息（不含当前这条） */
  history?: TextHistoryEntry[];
  /** bot 自己的身份，用于在上下文里标注「你是谁」 */
  botIdentity?: string;
  /** 发图后立刻 @bot 时自动附带的图片（可能多张） */
  autoImages?: InboundMedia[];
}): string {
  const { msg, text, scope, mentioned, config, quote, quoteMedia, history, botIdentity, autoImages } = params;
  const prompt = scope === 'group' ? config.groupPrompt : config.directPrompt;
  const header = scope === 'group'
    ? `[Yuanbao group message from ${msg.sender_nickname ?? msg.from_account ?? 'unknown'} in group ${msg.group_name ?? msg.group_code ?? 'unknown'}${mentioned ? ', mentioned bot' : ''}]`
    : `[Yuanbao direct message from ${msg.sender_nickname ?? msg.from_account ?? 'unknown'}]`;

  const metadata = [
    msg.msg_id ? `message_id: ${msg.msg_id}` : '',
    msg.trace_id ? `trace_id: ${msg.trace_id}` : '',
    scope === 'group' && botIdentity ? `you_are: ${botIdentity}` : '',
  ].filter(Boolean).join('\n');

  // ── 群聊上下文 ──
  // 把 @bot 之前的群消息按时间顺序拼进来，让 agent 知道刚才在聊什么。
  // 每行格式：`昵称: 内容`，跟当前消息的署名风格保持一致。
  let historyBlock = '';
  if (scope === 'group' && history && history.length > 0) {
    const lines = history.map((entry) => {
      const who = entry.sender || entry.senderId || 'unknown';
      return `${who}: ${entry.body}`;
    });
    historyBlock = [
      '[群聊最近消息（按时间顺序，最后一条最旧→最新）]',
      ...lines,
      '[以上是 @bot 之前的消息，下面是本次 @bot 的内容]',
    ].join('\n');
  }

  // 引用内容放在正文之前，让 agent 先看到"他在回复哪条消息"
  const quoteBlock = quote ? formatQuoteContext(quote, quoteMedia) : '';

  // 自动附图时给 agent 一句提示，否则它不知道附件从哪来的
  const autoBlock = autoImages && autoImages.length > 0
    ? `[附注：发送者刚发了 ${autoImages.length} 张图片，已作为附件一并提供：${autoImages.map(i => i.name).join('、')}]`
    : '';

  return [prompt, header, metadata ? `<metadata>\n${metadata}\n</metadata>` : '', historyBlock, autoBlock, quoteBlock, text]
    .filter(Boolean)
    .join('\n\n');
}
