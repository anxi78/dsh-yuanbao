import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { YuanbaoMsgBodyElement } from './types.js';

/**
 * Sticker (表情) support.
 *
 * A sticker is a `TIMFaceElem` whose `data` is a JSON descriptor; unlike media
 * it needs no upload, so sending one is a single message. The platform exposes
 * no sticker-list API (several candidate paths return 404), which is why the
 * reference implementation ships a fixed built-in catalogue.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PATH = resolve(__dirname, '../assets/builtin-stickers.json');

/** One entry as stored in `assets/builtin-stickers.json`. */
type BuiltinSticker = {
  emoji_id: string;
  emoji_pack_id: string;
  name: string;
  description?: string;
  width?: number;
  height?: number;
  formats?: string;
};

/** A resolved sticker ready to be sent. */
export type Sticker = {
  stickerId: string;
  packageId: string;
  name: string;
  description: string;
  width: number;
  height: number;
  formats: string;
};

let catalogue: Sticker[] | undefined;

function loadCatalogue(): Sticker[] {
  if (catalogue) return catalogue;
  try {
    const raw = JSON.parse(readFileSync(BUILTIN_PATH, 'utf8')) as BuiltinSticker[];
    catalogue = raw.map(entry => ({
      stickerId: entry.emoji_id,
      packageId: entry.emoji_pack_id,
      name: entry.name,
      description: entry.description?.trim() ? `${entry.name} ${entry.description.trim()}` : entry.name,
      width: entry.width ?? 0,
      height: entry.height ?? 0,
      formats: entry.formats ?? 'png',
    }));
  } catch {
    // A missing catalogue must not break the plugin: stickers degrade to an
    // empty set and the tool reports that nothing matched.
    catalogue = [];
  }
  return catalogue;
}

/** Normalise text for matching: lowercase, strip punctuation and spacing. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.,!?，。！？、；：]/g, '');
}

/**
 * Find stickers matching a free-text query.
 *
 * Matches the sticker name, its extended keywords, and its numeric id, so both
 * "开心" (via keywords) and "278" (via id) resolve. An empty query returns the
 * first `limit` entries.
 */
export function searchStickers(query: string, limit = 10): Sticker[] {
  const all = loadCatalogue();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const q = normalize(query ?? '');
  if (!q) return all.slice(0, safeLimit);

  const scored: Array<{ sticker: Sticker; score: number }> = [];
  for (const sticker of all) {
    const name = normalize(sticker.name);
    const desc = normalize(sticker.description);
    const id = normalize(sticker.stickerId);

    let score = 0;
    if (name === q || id === q) score = 100;
    else if (name.includes(q)) score = 80;
    else if (id.includes(q)) score = 70;
    else if (desc.includes(q)) score = 60;

    if (score > 0) scored.push({ sticker, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, safeLimit).map(s => s.sticker);
}

/** Look up one sticker by id or exact name. */
export function findSticker(ref: string): Sticker | undefined {
  const all = loadCatalogue();
  const key = normalize(ref);
  if (!key) return undefined;
  return all.find(s => normalize(s.stickerId) === key || normalize(s.name) === key);
}

/** Build the `TIMFaceElem` body for a sticker. */
export function buildStickerMsgBody(sticker: Sticker): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: 'TIMFaceElem',
      msg_content: {
        index: 0,
        data: JSON.stringify({
          sticker_id: sticker.stickerId,
          package_id: sticker.packageId,
          width: sticker.width,
          height: sticker.height,
          formats: [sticker.formats],
          name: sticker.name,
        }),
      },
    },
  ];
}

/** Total number of available stickers (for diagnostics). */
export function stickerCount(): number {
  return loadCatalogue().length;
}
