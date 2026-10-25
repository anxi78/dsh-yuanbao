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
import { buildMediaBlocks, extractMedias, type InboundMedia } from './media.js';
import { formatQuoteContext, parseQuote, resolveQuoteMedia, type QuoteInfo } from './quote.js';
import { deriveChatKey, rememberMedia } from './chat-history.js';
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

  const body = buildAgentBody({ msg, text, scope, mentioned, config, quote, quoteMedia });
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
    let mediaBlocks = await buildMediaBlocks({ body: msgBody, attachments, logger });
    // 引用的图片/文件也要附上，否则 agent 只看到「[引用消息]」却看不到内容
    if (quoteMedia) {
      try {
        const quoteBlocks = await buildMediaBlocks({
          body: [{
            msg_type: quoteMedia.kind === 'image' ? 'TIMImageElem' : 'TIMFileElem',
            msg_content: {
              url: quoteMedia.url,
              file_name: quoteMedia.name,
            },
          }],
          attachments,
          logger,
        });
        if (quoteBlocks.length > 0) {
          mediaBlocks = mediaBlocks.concat(quoteBlocks);
          logger.info(`inbound quoted media attached: kind=${quoteMedia.kind}; name=${quoteMedia.name}`);
        }
      } catch (error) {
        logger.warn(`inbound quoted media attach failed: ${error instanceof Error ? error.message : String(error)}`);
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
}): string {
  const { msg, text, scope, mentioned, config, quote, quoteMedia } = params;
  const prompt = scope === 'group' ? config.groupPrompt : config.directPrompt;
  const header = scope === 'group'
    ? `[Yuanbao group message from ${msg.sender_nickname ?? msg.from_account ?? 'unknown'} in group ${msg.group_name ?? msg.group_code ?? 'unknown'}${mentioned ? ', mentioned bot' : ''}]`
    : `[Yuanbao direct message from ${msg.sender_nickname ?? msg.from_account ?? 'unknown'}]`;
  const metadata = [
    msg.msg_id ? `message_id: ${msg.msg_id}` : '',
    msg.trace_id ? `trace_id: ${msg.trace_id}` : '',
  ].filter(Boolean).join('\n');

  // 引用内容放在正文之前，让 agent 先看到"他在回复哪条消息"
  const quoteBlock = quote ? formatQuoteContext(quote, quoteMedia) : '';

  return [prompt, header, metadata ? `<metadata>\n${metadata}\n</metadata>` : '', quoteBlock, text]
    .filter(Boolean)
    .join('\n\n');
}
