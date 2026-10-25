import type { Logger, SessionRecord, SessionEventLike, YuanbaoDshConfig } from '../types.js';
import type { SessionManager } from '../session/manager.js';
import { OutboundBuffer } from './outbound-buffer.js';
import type { YuanbaoSender } from './sender.js';
import { chunkText } from './chunker.js';

export type SessionLike = { header?: { id?: string }; id?: string };

export function createOutboundHandler(
  manager: SessionManager,
  sender: YuanbaoSender,
  config: YuanbaoDshConfig,
  logger: Logger,
  mediaStore?: MediaStore,
): (session: SessionLike, event: SessionEventLike) => void {
  const buffers = new Map<string, OutboundBuffer>();

  return (session, event) => {
    const sessionId = session.header?.id ?? session.id;
    if (!sessionId) {
      logger.warn(`outbound event dropped: missing sessionId; type=${event.type}`);
      return;
    }
    const record = manager.findBySessionId(sessionId);
    if (!record) return;
    if (event.type === 'assistant/message' || event.type === 'turn/end') {
      logger.info(`outbound event: type=${event.type}; session=${sessionId}; target=${record.replyTarget.scope}:${record.replyTarget.targetId}`);
    }

    switch (event.type) {
      case 'assistant/chunk':
        handleChunk(sessionId, record, event, buffers, sender, config, logger);
        break;
      case 'assistant/message':
        handleMessage(sessionId, record, event, buffers, sender, config, logger, mediaStore);
        break;
      case 'turn/end':
        handleTurnEnd(sessionId, record, event, buffers, sender, logger);
        break;
      default:
        break;
    }
  };
}

function handleChunk(
  sessionId: string,
  record: SessionRecord,
  event: SessionEventLike,
  buffers: Map<string, OutboundBuffer>,
  sender: YuanbaoSender,
  config: YuanbaoDshConfig,
  logger: Logger,
): void {
  const data = event.data ?? event;
  const chunk = data.chunk as { type?: string; text?: string } | undefined;
  if (!chunk || chunk.type !== 'text-delta' || !chunk.text) {
    return;
  }
  logger.info(`outbound text delta: session=${sessionId}; chars=${chunk.text.length}`);

  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = new OutboundBuffer(record, sender, config.textChunkLimit, logger);
    buffers.set(sessionId, buffer);
  }
  buffer.append(chunk.text);
}

function handleMessage(
  sessionId: string,
  record: SessionRecord,
  event: SessionEventLike,
  buffers: Map<string, OutboundBuffer>,
  sender: YuanbaoSender,
  config: YuanbaoDshConfig,
  logger: Logger,
  mediaStore?: MediaStore,
): void {
  const buffer = buffers.get(sessionId);
  if (buffer && buffer.text.trim()) {
    void buffer.flush();
    buffers.delete(sessionId);
    return;
  }

  const data = event.data ?? event;
  const message = (data.message ?? event.message) as { content?: OutboundBlock[] } | undefined;
  const blocks = message?.content;
  if (!Array.isArray(blocks)) {
    logger.warn(`outbound assistant/message ignored: missing content blocks; session=${sessionId}`);
    return;
  }

  const text = blocks
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n')
    .trim();

  // A reply may carry text, images, files, or any mix. Filtering to text only
  // would silently drop every attachment, so collect media separately.
  const mediaBlocks = blocks.filter(block => block.type === 'image' || block.type === 'file');

  if (!text && mediaBlocks.length === 0) {
    logger.warn(`outbound assistant/message ignored: empty text; session=${sessionId}; blocks=${blocks.length}`);
    return;
  }

  logger.info(`outbound assistant/message: session=${sessionId}; chars=${text.length}; blocks=${blocks.length}; media=${mediaBlocks.length}`);
  void (async () => {
    if (text) {
      for (const chunk of chunkText(text, config.textChunkLimit)) {
        await sender.sendText(record.replyTarget, chunk);
      }
    }
    for (const block of mediaBlocks) {
      await sendMediaBlock(block, record, sender, mediaStore, logger);
    }
  })().catch(error => {
    logger.error(`send assistant message failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** A content block as delivered in an assistant message. */
type OutboundBlock = {
  type: string;
  text?: string;
  attachment?: { attachmentId?: string; name?: string; mediaType?: string };
};

/**
 * The slice of the DSH attachment store needed to read outbound media bytes.
 * Declared structurally so the plugin does not hard-depend on the store package.
 */
export type MediaStore = {
  readImage(ref: { attachmentId?: string; mediaType?: string }): Promise<{ data: Uint8Array } | undefined>;
  readFileStream(ref: { attachmentId?: string }): AsyncIterable<Uint8Array>;
  imageHostPath?(ref: { attachmentId?: string }): string;
  fileHostPath?(ref: { attachmentId?: string }): string;
};

/** Concatenate an async byte stream into one buffer. */
async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Resolve one media block to bytes and send it through the Yuanbao upload path.
 *
 * Failures are logged and swallowed: one unreadable attachment must not abort
 * the rest of the reply. A failed media send degrades to a text note so the
 * user still learns something was attached.
 */
async function sendMediaBlock(
  block: OutboundBlock,
  record: SessionRecord,
  sender: YuanbaoSender,
  mediaStore: MediaStore | undefined,
  logger: Logger,
): Promise<void> {
  const ref = block.attachment;
  if (!ref?.attachmentId) {
    logger.warn(`outbound media skipped: block without attachmentId; type=${block.type}`);
    return;
  }
  if (!mediaStore) {
    logger.warn(`outbound media skipped: attachment store unavailable; id=${ref.attachmentId}`);
    return;
  }

  // Prefer the stored display name; fall back to the host path's leaf name so
  // MIME detection still sees a real extension.
  let name = ref.name ?? '';
  if (!name) {
    const hostPath = block.type === 'image'
      ? mediaStore.imageHostPath?.({ attachmentId: ref.attachmentId })
      : mediaStore.fileHostPath?.({ attachmentId: ref.attachmentId });
    if (hostPath) name = hostPath.split('/').pop() ?? '';
  }
  if (!name) name = `${block.type}-${ref.attachmentId}`;

  try {
    let data: Uint8Array | undefined;
    if (block.type === 'image') {
      const stored = await mediaStore.readImage({ attachmentId: ref.attachmentId, mediaType: ref.mediaType });
      data = stored?.data;
    } else {
      data = await collectStream(mediaStore.readFileStream({ attachmentId: ref.attachmentId }));
    }
    if (!data || data.byteLength === 0) {
      logger.warn(`outbound media skipped: empty bytes; id=${ref.attachmentId}`);
      return;
    }
    const ok = await sender.sendMedia(record.replyTarget, name, data, name);
    if (!ok) {
      logger.warn(`outbound media send failed, notifying by text: ${name}`);
      await sender.sendText(record.replyTarget, `[附件发送失败] ${name}`);
    }
  } catch (error) {
    logger.warn(`outbound media error: id=${ref.attachmentId}; ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleTurnEnd(
  sessionId: string,
  record: SessionRecord,
  event: SessionEventLike,
  buffers: Map<string, OutboundBuffer>,
  sender: YuanbaoSender,
  logger: Logger,
): void {
  const data = event.data ?? event;
  const reason = data.reason as { kind?: string; error?: { message?: string; code?: string }; reason?: { kind?: string } } | undefined;
  logger.info(`turn end reason: session=${sessionId}; reason=${safeJson(reason)}`);

  const buffer = buffers.get(sessionId);
  if (buffer) {
    void buffer.flush();
    buffers.delete(sessionId);
  }

  record.replyHeartbeat?.finishIfNeeded();
  record.replyHeartbeat = undefined;

  if (reason?.kind === 'error') {
    const message = reason.error?.message ?? 'Unknown agent error';
    void sender.sendText(record.replyTarget, `Agent error: ${message}`).catch(error => {
      logger.error(`send turn error failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
