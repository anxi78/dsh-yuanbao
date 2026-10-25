import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger, ReplyTarget, SessionRecord } from './types.js';
import type { YuanbaoSender } from './transport/sender.js';
import { createServiceReader } from './services.js';
import { findSticker, searchStickers, stickerCount } from './stickers.js';

/**
 * `@deepseek-ai/dsh-tools` ships `.js` type stubs rather than `.d.ts`, so it has
 * no importable type surface. Import it lazily and describe only the shape this
 * plugin uses; the host resolves the real module at runtime.
 */
type DefineToolOptions = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    /** Required: defineTool unconditionally calls output.render. */
    render: (args: unknown, value: unknown) => unknown;
  };
  execute: (args: never, exec: ToolExec) => Promise<unknown>;
};

type DefineTool = (options: DefineToolOptions) => unknown;

let cachedDefineTool: DefineTool | undefined;
let loadAttempted = false;

async function loadDefineTool(): Promise<DefineTool | undefined> {
  if (loadAttempted) return cachedDefineTool;
  loadAttempted = true;
  try {
    const mod = (await import('@deepseek-ai/dsh-tools')) as { defineTool?: DefineTool };
    cachedDefineTool = mod.defineTool;
  } catch {
    cachedDefineTool = undefined;
  }
  return cachedDefineTool;
}

/**
 * Agent-facing tool that sends a local file to the current Yuanbao chat.
 *
 * Without this, media could only ever be sent by echoing an attachment back in
 * a reply; the agent had no way to choose a file on disk and push it out.
 */

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export type SendMediaContext = {
  /** Resolve the sender + session record for the agent executing this tool. */
  resolveSession: (sessionId: string | undefined) => { sender: YuanbaoSender; record: SessionRecord } | undefined;
  /** Sender bound to the live connection, for tools that target an explicit chat. */
  sender?: YuanbaoSender;
  logger: Logger;
  cwd: string;
};

/** Shape of the execution context DSH passes to a tool's execute(). */
type ToolExec = {
  agent?: { session?: { header?: { id?: string; cwd?: string } } };
  signal?: AbortSignal;
};

export async function registerSendMediaTool(ctx: Context, getContext: () => SendMediaContext): Promise<void> {
  const context = getContext();
  const tools = createServiceReader(ctx, m => context.logger.warn(m)).require('tools') as
    | { register(tool: unknown): void }
    | undefined;
  if (!tools || typeof tools.register !== 'function') {
    context.logger.warn('send media tool not registered: ctx.tools unavailable');
    return;
  }
  const defineTool = await loadDefineTool();
  if (!defineTool) {
    context.logger.warn('send media tool not registered: defineTool unavailable');
    return;
  }

  tools.register(
    defineTool({
      name: 'yuanbao_send_media',
      description:
        'Send a local image or file to the current Yuanbao chat. Use this when the user asks to see a picture, '
        + 'or when a file (report, log, archive) is better delivered as an attachment than pasted as text.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to the file to send. Relative paths resolve against the session workspace directory.',
        },
        caption: {
          type: 'string',
          description: 'Optional text message sent before the attachment.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sent: { type: 'boolean', required: true, description: 'Whether the attachment was delivered.' },
            name: { type: 'string', description: 'Display name of the sent file.' },
            bytes: { type: 'number', description: 'Size of the sent file in bytes.' },
            reason: { type: 'string', description: 'Why the send failed, when sent is false.' },
          },
        },
        // `defineTool` always wraps output.render and calls it, so it is required
        // even for a plain JSON result: omitting it fails at call time with
        // "output.render failed: userRender is not a function".
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: JSON.stringify(value) },
        ],
      },
      async execute(args: { path: string; caption?: string }, exec: ToolExec) {
        const context = getContext();
        // Identify the originating chat by the executing agent's session id, so
        // the file goes back to the conversation that asked for it.
        const sessionId = exec?.agent?.session?.header?.id;
        const current = context.resolveSession(sessionId);
        if (!current) {
          return { sent: false, reason: `no Yuanbao session bound to this agent${sessionId ? ` (${sessionId})` : ''}` };
        }
        const { sender, record } = current;
        const target: ReplyTarget = record.replyTarget;

        const baseDir = exec?.agent?.session?.header?.cwd ?? context.cwd;
        const resolved = isAbsolute(args.path) ? args.path : resolve(baseDir, args.path);
        let data: Uint8Array;
        try {
          const buffer = await readFile(resolved);
          data = new Uint8Array(buffer);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          context.logger.warn(`send media tool: cannot read ${resolved}; ${reason}`);
          return { sent: false, reason: `cannot read file: ${reason}` };
        }

        if (data.byteLength === 0) {
          return { sent: false, reason: 'file is empty' };
        }
        if (data.byteLength > MAX_MEDIA_BYTES) {
          return {
            sent: false,
            reason: `file too large: ${data.byteLength} bytes (limit ${MAX_MEDIA_BYTES})`,
          };
        }

        if (args.caption?.trim()) {
          await sender.sendText(target, args.caption);
        }

        const name = basename(resolved);
        const ok = await sender.sendMedia(target, resolved, data, name);
        if (!ok) {
          return { sent: false, name, bytes: data.byteLength, reason: 'upload or send failed' };
        }
        return { sent: true, name, bytes: data.byteLength };
      },
    }),
  );

  // Sticker search: lets the agent discover what is available before sending.
  tools.register(
    defineTool({
      name: 'yuanbao_search_stickers',
      description:
        'Search the available Yuanbao stickers (表情) by keyword. Use this to find a sticker id or name '
        + 'before calling yuanbao_send_sticker. Returns up to `limit` matches.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keyword to match against sticker names and their synonyms, e.g. "开心", "点赞", "吃瓜".',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return. Defaults to 10.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number', required: true, description: 'Number of matches returned.' },
            total: { type: 'number', required: true, description: 'Total stickers available.' },
            stickers: {
              type: 'array',
              required: true,
              description: 'Matching stickers.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args: { query: string; limit?: number }) {
        const matches = searchStickers(args.query ?? '', args.limit ?? 10);
        return {
          count: matches.length,
          total: stickerCount(),
          stickers: matches.map(s => ({ id: s.stickerId, name: s.name, description: s.description })),
        };
      },
    }),
  );

  // Sticker send: a TIMFaceElem needs no upload, so this is a single message.
  tools.register(
    defineTool({
      name: 'yuanbao_send_sticker',
      description:
        'Send a sticker (表情) to the current Yuanbao chat. Pass a sticker id from yuanbao_search_stickers, '
        + 'or an exact sticker name such as "点赞". Use stickers to react naturally instead of describing one in text.',
      parameters: {
        sticker: {
          type: 'string',
          required: true,
          description: 'Sticker id (e.g. "278") or exact name (e.g. "六六六").',
        },
        text: {
          type: 'string',
          description: 'Optional text message sent before the sticker.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sent: { type: 'boolean', required: true, description: 'Whether the sticker was delivered.' },
            id: { type: 'string', description: 'Sticker id that was sent.' },
            name: { type: 'string', description: 'Sticker name that was sent.' },
            reason: { type: 'string', description: 'Why the send failed, when sent is false.' },
          },
        },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args: { sticker: string; text?: string }, exec: ToolExec) {
        const context = getContext();
        const sessionId = exec?.agent?.session?.header?.id;
        const current = context.resolveSession(sessionId);
        if (!current) {
          return { sent: false, reason: `no Yuanbao session bound to this agent${sessionId ? ` (${sessionId})` : ''}` };
        }
        const { sender, record } = current;

        const sticker = findSticker(args.sticker ?? '');
        if (!sticker) {
          return { sent: false, reason: `no sticker matches "${args.sticker}"; use yuanbao_search_stickers first` };
        }

        if (args.text?.trim()) {
          await sender.sendText(record.replyTarget, args.text);
        }
        const ok = await sender.sendSticker(record.replyTarget, sticker.stickerId);
        if (!ok) {
          return { sent: false, id: sticker.stickerId, name: sticker.name, reason: 'send failed' };
        }
        return { sent: true, id: sticker.stickerId, name: sticker.name };
      },
    }),
  );

  // Send text to an explicit destination, which may differ from the chat the
  // agent is replying in (e.g. a direct message requested from within a group).
  tools.register(
    defineTool({
      name: 'yuanbao_send_message',
      description:
        'Send a text message to a specific Yuanbao group or direct chat. Use this only when the destination '
        + 'differs from the current conversation — for example a direct message requested inside a group. '
        + 'Ordinary replies do not need this tool.',
      parameters: {
        to: {
          type: 'string',
          required: true,
          description:
            'Destination. `group:<groupCode>` for a group, or a user id for a direct chat '
            + '(`user:<id>` and `direct:<id>` are also accepted). Use yuanbao_list_members to resolve a nickname to a user id.',
        },
        message: {
          type: 'string',
          required: true,
          description: 'Text to send.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sent: { type: 'boolean', required: true, description: 'Whether the message was delivered.' },
            to: { type: 'string', description: 'Resolved destination scope and id.' },
            reason: { type: 'string', description: 'Why the send failed, when sent is false.' },
          },
        },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args: { to: string; message: string }) {
        const context = getContext();
        if (!context.sender) {
          return { sent: false, reason: 'Yuanbao connection not ready' };
        }
        const target = context.sender.resolveTarget(args.to ?? '');
        if (!target) {
          return { sent: false, reason: `unrecognised target "${args.to}"; use group:<groupCode> or a user id` };
        }
        const result = await context.sender.sendTextTo(args.to, args.message ?? '');
        if (!result.ok) {
          return { sent: false, reason: result.error ?? 'send failed' };
        }
        return { sent: true, to: `${target.scope}:${target.targetId}` };
      },
    }),
  );

  // Resolve a nickname to the opaque user id required to address a DM.
  tools.register(
    defineTool({
      name: 'yuanbao_list_members',
      description:
        'List the members of a Yuanbao group, returning each member\'s nickname and user id. '
        + 'Use this to obtain the user id needed by yuanbao_send_message for a direct message.',
      parameters: {
        group: {
          type: 'string',
          description:
            'Group code to inspect. Defaults to the group of the current conversation when omitted.',
        },
        query: {
          type: 'string',
          description: 'Optional nickname filter; matches case-insensitively as a substring.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            group: { type: 'string', description: 'Group code that was inspected.' },
            count: { type: 'number', required: true, description: 'Number of members returned.' },
            members: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  type: { type: 'number' },
                },
              },
            },
            reason: { type: 'string', description: 'Why the lookup failed, when count is 0.' },
          },
        },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args: { group?: string; query?: string }, exec: ToolExec) {
        const context = getContext();
        if (!context.sender) {
          return { group: '', count: 0, members: [], reason: 'Yuanbao connection not ready' };
        }

        // Fall back to the group of the current conversation.
        let group = (args.group ?? '').trim().replace(/^group:/i, '');
        if (!group) {
          const sessionId = exec?.agent?.session?.header?.id;
          const current = context.resolveSession(sessionId);
          const record = current?.record;
          if (record?.scope === 'group') {
            group = record.replyTarget.groupCode ?? record.replyTarget.targetId;
          }
        }
        if (!group) {
          return { group: '', count: 0, members: [], reason: 'no group specified and the current chat is not a group' };
        }

        const all = await context.sender.listGroupMembers(group);
        if (all.length === 0) {
          return { group, count: 0, members: [], reason: 'group member list unavailable or empty' };
        }

        const q = (args.query ?? '').trim().toLowerCase();
        const filtered = q ? all.filter(m => m.nickName.toLowerCase().includes(q)) : all;
        return {
          group,
          count: filtered.length,
          members: filtered.map(m => ({ id: m.userId, name: m.nickName, type: m.userType })),
        };
      },
    }),
  );
}
