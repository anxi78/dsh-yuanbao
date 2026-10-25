import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { YuanbaoMsgBodyElement } from './types.js';
import type { Logger } from './types.js';

/** Image media types accepted by the DSH attachment store. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Extension -> media type, used when the payload does not declare one. */
const EXT_TO_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** A media resource referenced by one inbound message element. */
export type InboundMedia = {
  kind: 'image' | 'file';
  url: string;
  name: string;
  /** Text placeholder inserted into the message body, e.g. `[image: a.jpg]`. */
  placeholder: string;
};

/**
 * The slice of DSH's AttachmentStore this plugin needs. Declared structurally
 * so the plugin does not hard-depend on @deepseek-ai/dsh-attachment.
 */
export type AttachmentStoreLike = {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>;
  saveFile(input: { data: Uint8Array; name?: string }): Promise<unknown>;
};

function extensionOf(nameOrUrl: string): string {
  const clean = nameOrUrl.split('?')[0] ?? '';
  const dot = clean.lastIndexOf('.');
  const slash = clean.lastIndexOf('/');
  if (dot <= slash || dot < 0) return '';
  return clean.slice(dot).toLowerCase();
}

/** Guess an image media type from a filename or URL; undefined when not an image. */
export function guessImageMediaType(nameOrUrl: string): string | undefined {
  const ext = extensionOf(nameOrUrl);
  const media = EXT_TO_MEDIA[ext];
  return media && IMAGE_MEDIA_TYPES.has(media) ? media : undefined;
}

/** Pick a display filename, falling back to a generated one. */
function mediaName(candidate: string | undefined, fallback: string): string {
  const name = typeof candidate === 'string' ? candidate.trim() : '';
  return name && !name.includes('/') && !name.includes('\\') ? name : fallback;
}

/**
 * Extract media resources from a message body.
 *
 * The gateway delivers images as `TIMImageElem` with the actual URLs inside
 * `image_info_array` (never in `msg_content.url`), so reading only the top-level
 * field silently drops every image. Files, video and voice carry a top-level
 * `url`. This mirrors the reference `yuanbao-openclaw-plugin` behaviour of
 * preferring the medium-size image variant for download.
 */
export function extractMedias(body: YuanbaoMsgBodyElement[]): InboundMedia[] {
  const medias: InboundMedia[] = [];
  let imageCount = 0;
  let fileCount = 0;

  for (const elem of body) {
    const content = elem.msg_content ?? {};

    if (elem.msg_type === 'TIMImageElem') {
      const info = Array.isArray(content.image_info_array) ? content.image_info_array : [];
      // Prefer the medium variant (index 1); fall back to the original.
      const chosen = info[1] ?? info[0];
      const url = typeof chosen?.url === 'string' ? chosen.url : '';
      if (!url) continue;
      imageCount += 1;
      const uuid = typeof content.uuid === 'string' ? content.uuid : '';
      const dims = chosen?.width && chosen?.height ? `_${chosen.width}_${chosen.height}` : '';
      const ext = extensionOf(uuid) || extensionOf(url) || '.jpg';
      const stem = uuid ? uuid.replace(/\.[^.]*$/, '') : `image${imageCount}`;
      const name = mediaName(`${stem}${dims}${ext}`, `image${imageCount}${ext}`);
      medias.push({ kind: 'image', url, name, placeholder: `[image:${name}]` });
      continue;
    }

    if (elem.msg_type === 'TIMFileElem' || elem.msg_type === 'TIMVideoFileElem') {
      const url = typeof content.url === 'string' ? content.url : '';
      if (!url) continue;
      fileCount += 1;
      const name = mediaName(
        typeof content.file_name === 'string' ? content.file_name : undefined,
        `file${fileCount}`,
      );
      medias.push({ kind: 'file', url, name, placeholder: `[file:${name}]` });
      continue;
    }

    if (elem.msg_type === 'TIMSoundElem') {
      const url = typeof content.url === 'string' ? content.url : '';
      if (!url) continue;
      fileCount += 1;
      const name = mediaName(
        typeof content.file_name === 'string' ? content.file_name : undefined,
        `voice${fileCount}.silk`,
      );
      medias.push({ kind: 'file', url, name, placeholder: `[file:${name}]` });
    }
  }

  return medias;
}

/** Render media placeholders in body order, so the agent sees where each sits. */
export function mediaPlaceholders(body: YuanbaoMsgBodyElement[]): string[] {
  return extractMedias(body).map(m => m.placeholder);
}

/**
 * Download one media resource with a hard size ceiling.
 * Returns undefined on any failure: a missing attachment must never drop the
 * whole message, since the text is usually still meaningful on its own.
 */
export async function downloadMedia(
  media: InboundMedia,
  logger: Logger,
  maxBytes = 20 * 1024 * 1024,
  timeoutMs = 30_000,
): Promise<{ data: Uint8Array; mediaType?: string } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(media.url, { signal: controller.signal });
    if (!response.ok) {
      logger.warn(`media download failed: ${media.name}; status=${response.status}`);
      return undefined;
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      logger.warn(`media too large: ${media.name}; bytes=${declared}; limit=${maxBytes}`);
      return undefined;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      logger.warn(`media too large after download: ${media.name}; bytes=${buffer.byteLength}`);
      return undefined;
    }
    const headerType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
    return { data: buffer, mediaType: headerType || undefined };
  } catch (error) {
    logger.warn(`media download error: ${media.name}; ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist downloaded media into the DSH attachment store and build the content
 * blocks the agent understands. Images become `image` blocks, everything else a
 * `file` block. Unsupported images (e.g. heic) degrade to file blocks so the
 * bytes are still reachable through the saved path.
 */
export async function buildMediaBlocks(params: {
  body: YuanbaoMsgBodyElement[];
  attachments?: AttachmentStoreLike;
  logger: Logger;
}): Promise<ContentBlock[]> {
  const { body, attachments, logger } = params;
  if (!attachments) {
    const medias = extractMedias(body);
    if (medias.length > 0) {
      logger.warn(`media skipped: attachment store unavailable; count=${medias.length}`);
    }
    return [];
  }
  const medias = extractMedias(body);
  const blocks: ContentBlock[] = [];
  logger.info(`buildMediaBlocks: extracted=${medias.length}; bodyLen=${body.length}`);
  for (const m of medias) {
    logger.info(`buildMediaBlocks: media kind=${m.kind}; url=${m.url.slice(0, 120)}; name=${m.name}`);
  }

  for (const media of medias) {
    const downloaded = await downloadMedia(media, logger);
    if (!downloaded) continue;
    try {
      const guessed = media.kind === 'image' ? guessImageMediaType(media.name) : undefined;
      const mediaType = guessed ?? downloaded.mediaType;
      if (media.kind === 'image' && mediaType && IMAGE_MEDIA_TYPES.has(mediaType)) {
        const ref = await attachments.saveImage({ data: downloaded.data, mediaType, name: media.name });
        blocks.push({ type: 'image', attachment: ref } as unknown as ContentBlock);
        logger.info(`media attached as image: ${media.name}; bytes=${downloaded.data.byteLength}`);
        continue;
      }
      const ref = await attachments.saveFile({ data: downloaded.data, name: media.name });
      blocks.push({ type: 'file', attachment: ref } as unknown as ContentBlock);
      logger.info(`media attached as file: ${media.name}; bytes=${downloaded.data.byteLength}`);
    } catch (error) {
      logger.warn(`media persist failed: ${media.name}; ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return blocks;
}
