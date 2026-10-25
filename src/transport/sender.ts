import type { YuanbaoWsClient } from '../gateway/protocol/client.js';
import type { WsHeartbeatValue } from '../gateway/protocol/types.js';
import { WS_HEARTBEAT_GROUP_DISSOLVED_CODE } from '../gateway/protocol/types.js';
import type { Logger, ReplyTarget, ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from '../types.js';
import { buildMediaMessageBody, type HttpAuth } from '../outbound-media.js';
import { buildStickerMsgBody, findSticker } from '../stickers.js';

export class YuanbaoSender {
  constructor(
    private readonly client: YuanbaoWsClient,
    private readonly account: ResolvedYuanbaoAccount,
    private readonly logger: Logger,
    /** Resolves HTTP auth headers; required only for media uploads. */
    private readonly resolveAuth?: (account: ResolvedYuanbaoAccount) => Promise<HttpAuth>,
  ) {}

  async sendText(target: ReplyTarget, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.logger.info(`sender sendText: target=${target.scope}:${target.targetId}; chars=${trimmed.length}`);
    const result = await this.sendRaw(target, [{ msg_type: 'TIMTextElem', msg_content: { text: trimmed } }]);
    if (!result.ok) {
      // Surface the failure: a silently dropped reply looks like the bot is
      // ignoring the user, which is the hardest kind of bug to diagnose.
      this.logger.error(`send text failed: target=${target.scope}:${target.targetId}; ${result.error ?? 'unknown error'}`);
    }
  }

  /**
   * Upload a local file and send it as an image or file message.
   * Returns false when the media path is unavailable, so callers can fall back
   * to a text message instead of losing the reply entirely.
   */
  async sendMedia(target: ReplyTarget, filePath: string, data: Uint8Array, displayName?: string): Promise<boolean> {
    if (!this.resolveAuth) {
      this.logger.warn(`send media skipped: HTTP auth resolver unavailable; path=${filePath}`);
      return false;
    }
    try {
      const msgBody = await buildMediaMessageBody({
        deps: { account: this.account, logger: this.logger, resolveAuth: this.resolveAuth },
        filePath,
        data,
        ...(displayName ? { displayName } : {}),
      });
      const result = await this.sendRaw(target, msgBody);
      if (!result.ok) {
        this.logger.warn(`send media transport failed: path=${filePath}; ${result.error ?? 'unknown error'}`);
        return false;
      }
      this.logger.info(`sender sendMedia: target=${target.scope}:${target.targetId}; kind=${msgBody[0]?.msg_type ?? 'unknown'}`);
      return true;
    } catch (error) {
      this.logger.warn(`send media failed: path=${filePath}; ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Send a sticker by id or exact name.
   * Returns false when the reference matches nothing, so the caller can reply
   * with text instead of silently sending nothing.
   */
  async sendSticker(target: ReplyTarget, ref: string): Promise<boolean> {
    const sticker = findSticker(ref);
    if (!sticker) {
      this.logger.warn(`send sticker skipped: no sticker matches "${ref}"`);
      return false;
    }
    this.logger.info(`sender sendSticker: target=${target.scope}:${target.targetId}; id=${sticker.stickerId}; name=${sticker.name}`);
    const result = await this.sendRaw(target, buildStickerMsgBody(sticker));
    if (!result.ok) {
      this.logger.warn(`send sticker failed: id=${sticker.stickerId}; ${result.error ?? 'unknown error'}`);
    }
    return result.ok;
  }

  /**
   * Send text to an explicit destination, not necessarily the current chat.
   *
   * @param to - `group:<groupCode>` for a group, or a raw user id for a DM.
   *   A `user:` / `direct:` prefix is accepted and stripped, matching the
   *   reference implementation's target grammar.
   */
  async sendTextTo(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const target = this.resolveTarget(to);
    if (!target) {
      return { ok: false, error: `unrecognised target "${to}"; use group:<groupCode> or a user id` };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, error: 'message text is empty' };
    }
    try {
      // Propagate the transport outcome: reporting success unconditionally is
      // what made the tool claim "sent" while nothing left the device.
      return await this.sendRaw(target, [{ msg_type: 'TIMTextElem', msg_content: { text: trimmed } }]);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Parse a target string into a ReplyTarget.
   *
   * Grammar (mirrors the reference plugin): `group:<code>` addresses a group;
   * `user:<id>` / `direct:<id>` or a bare id addresses a direct chat. A leading
   * `yuanbao:` prefix is ignored.
   */
  resolveTarget(to: string): ReplyTarget | undefined {
    const raw = (to ?? '').trim().replace(/^yuanbao:/i, '');
    if (!raw) return undefined;

    const fromAccount = this.account.botId || '';

    if (raw.startsWith('group:')) {
      const groupCode = raw.slice('group:'.length).trim();
      if (!groupCode) return undefined;
      return { scope: 'group', targetId: groupCode, groupCode, fromAccount };
    }

    const userId = raw.replace(/^(user|direct):/i, '').trim();
    if (!userId) return undefined;
    return { scope: 'c2c', targetId: userId, fromAccount };
  }

  /**
   * List the members of a group.
   *
   * Needed to address a direct message: the platform identifies users by an
   * opaque base64 id, so a nickname has to be resolved to an id first.
   */
  async listGroupMembers(groupCode: string): Promise<Array<{ userId: string; nickName: string; userType: number }>> {
    const code = (groupCode ?? '').trim().replace(/^group:/i, '');
    if (!code) return [];
    try {
      const result = await this.client.getGroupMemberList({ group_code: code });
      if (result.code !== 0) {
        this.logger.warn(`get group member list failed: group=${code}; code=${result.code}; message=${result.message}`);
        return [];
      }
      return (result.member_list ?? []).map(m => ({
        userId: m.user_id,
        nickName: m.nick_name,
        userType: m.user_type,
      }));
    } catch (error) {
      this.logger.warn(`get group member list error: group=${code}; ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Send one message body and report the outcome.
   *
   * The result is returned rather than merely logged: callers that report
   * success to a tool user must be able to observe a failure, otherwise a
   * skipped or rejected send is indistinguishable from a delivered one.
   */
  async sendRaw(target: ReplyTarget, msgBody: YuanbaoMsgBodyElement[]): Promise<{ ok: boolean; error?: string }> {
    if (target.scope === 'group') {
      const groupCode = target.groupCode ?? target.targetId;
      const fromAccount = target.fromAccount || this.account.botId || '';
      if (!fromAccount) {
        const error = 'missing fromAccount (bot id not resolved yet)';
        this.logger.warn(`send group message skipped: ${error}; group=${groupCode}`);
        return { ok: false, error };
      }
      this.logger.info(`sender sendGroupMessage: group=${groupCode}; from=${fromAccount}; body=${msgBody.length}`);
      const result = await this.client.sendGroupMessage({
        group_code: groupCode,
        from_account: fromAccount,
        msg_body: msgBody,
        random: String(Math.floor(Math.random() * 4294967295)),
        ...(target.refMsgId ? { ref_msg_id: target.refMsgId, msg_id: target.refMsgId } : {}),
        ...(target.traceId ? { trace_id: target.traceId } : {}),
      });
      if (result.code !== 0) {
        const error = `code=${result.code}, message=${result.message}`;
        this.logger.warn(`send group message failed: ${error}`);
        return { ok: false, error };
      }
      return { ok: true };
    }

    // The platform rejects a C2C send without a sender identity ("参数无效:
    // bot_id is required"), which the encoder maps to `fromAccount`. It must
    // therefore always be supplied from the resolved account.
    const fromAccount = this.account.botId || target.fromAccount || '';
    if (!fromAccount) {
      const error = 'missing fromAccount (bot id not resolved yet)';
      this.logger.warn(`send c2c message skipped: ${error}; to=${target.targetId}`);
      return { ok: false, error };
    }
    this.logger.info(`sender sendC2CMessage: to=${target.targetId}; from=${fromAccount}; body=${msgBody.length}`);
    const result = await this.client.sendC2CMessage({
      to_account: target.targetId,
      from_account: fromAccount,
      msg_body: msgBody,
      msg_random: Math.floor(Math.random() * 4294967295),
      ...(target.groupCode ? { group_code: target.groupCode } : {}),
      ...(target.traceId ? { trace_id: target.traceId } : {}),
    });
    if (result.code !== 0) {
      const error = `code=${result.code}, message=${result.message}`;
      this.logger.warn(`send c2c message failed: ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  }

  async sendHeartbeat(target: ReplyTarget, heartbeat: WsHeartbeatValue, sendTime: number): Promise<void> {
    const fromAccount = target.fromAccount || this.account.botId || '';
    if (!fromAccount) {
      this.logger.warn(`reply heartbeat skipped: missing fromAccount; target=${target.scope}:${target.targetId}`);
      return;
    }

    if (target.scope === 'group') {
      const groupCode = target.groupCode ?? target.targetId;
      this.logger.debug(`sender sendGroupHeartbeat: group=${groupCode}; heartbeat=${heartbeat}`);
      const result = await this.client.sendGroupHeartbeat({
        from_account: fromAccount,
        to_account: target.refFromAccount || target.targetId,
        group_code: groupCode,
        send_time: sendTime,
        heartbeat,
      });
      if (result.code !== 0) {
        this.logger.warn(`send group heartbeat failed: code=${result.code}, message=${result.msg ?? result.message ?? ''}`);
        if (result.code === WS_HEARTBEAT_GROUP_DISSOLVED_CODE) {
          this.logger.warn(`send group heartbeat stopped: group dissolved; group=${groupCode}`);
        }
      }
      return;
    }

    this.logger.debug(`sender sendPrivateHeartbeat: to=${target.targetId}; heartbeat=${heartbeat}`);
    const result = await this.client.sendPrivateHeartbeat({
      from_account: fromAccount,
      to_account: target.targetId,
      heartbeat,
    });
    if (result.code !== 0) {
      this.logger.warn(`send c2c heartbeat failed: code=${result.code}, message=${result.msg ?? result.message ?? ''}`);
    }
  }

  getAccount(): ResolvedYuanbaoAccount {
    return this.account;
  }

  /**
   * 把元宝的 resourceId 换成真正的下载地址。
   *
   * 入站媒体里的 url 形如：
   *   https://hunyuan.tencent.com/api/resource/download?resourceId=xxx
   * 这个地址直接 GET 会返回 401 —— 它需要 X-ID / X-Token 鉴权头。
   *
   * 正确做法是先调元宝的 resource/v1/download 接口（带鉴权）换出
   * 一个真正的 COS 地址，再下载那个地址。
   *
   * @returns 可直接匿名下载的 URL；解析失败返回 undefined
   */
  async resolveDownloadUrl(rawUrl: string): Promise<string | undefined> {
    const resourceId = extractResourceId(rawUrl);
    if (!resourceId) return undefined;

    if (!this.resolveAuth) {
      this.logger.warn('resolveDownloadUrl: no auth resolver, cannot exchange resourceId');
      return undefined;
    }

    let auth: HttpAuth;
    try {
      auth = await this.resolveAuth(this.account);
    } catch (error) {
      this.logger.warn(`resolveDownloadUrl: auth failed; ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }

    const endpoint = `https://${this.account.apiDomain}/api/resource/v1/download?resourceId=${encodeURIComponent(resourceId)}`;
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-ID': auth.botId || this.account.botId || '',
          'X-Token': auth.token,
          'X-Source': auth.source || 'web',
          'X-Instance-Id': '16',
        },
      });
      if (!response.ok) {
        this.logger.warn(`resolveDownloadUrl: exchange failed; status=${response.status}`);
        return undefined;
      }
      const raw = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        this.logger.warn(`resolveDownloadUrl: non-JSON response; preview=${raw.slice(0, 200)}`);
        return undefined;
      }

      // 诊断：把完整返回结构打出来。不同版本的接口字段名不一样，
      // 之前假设是 data.url / data.realUrl，但实测 data 是空的。
      this.logger.info(`resolveDownloadUrl: raw response=${raw.slice(0, 500)}`);

      const pick = (obj: unknown): string | undefined => {
        if (!obj || typeof obj !== 'object') return undefined;
        const rec = obj as Record<string, unknown>;
        for (const key of ['url', 'realUrl', 'real_url', 'downloadUrl', 'download_url', 'cosUrl', 'cos_url']) {
          const v = rec[key];
          if (typeof v === 'string' && v) return v;
        }
        return undefined;
      };

      const root = body as Record<string, unknown>;
      const url = pick(root) ?? pick(root?.data) ?? pick(root?.result);
      if (!url) {
        this.logger.warn(`resolveDownloadUrl: no url in response; rootKeys=${Object.keys(root ?? {}).join(',')}; dataKeys=${Object.keys((root?.data as object) ?? {}).join(',')}`);
        return undefined;
      }
      return url;
    } catch (error) {
      this.logger.warn(`resolveDownloadUrl: request error; ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}

/** 从 hunyuan 的下载地址里抠出 resourceId */
function extractResourceId(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const id = parsed.searchParams.get('resourceId');
    return id || undefined;
  } catch {
    return undefined;
  }
}
