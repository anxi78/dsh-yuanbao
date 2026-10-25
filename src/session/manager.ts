import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {
  AgentDefaultModelLike,
  AgentPresetsLike,
  AgentSetup,
  ChatScope,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  Logger,
  ReplyTarget,
  SessionRecord,
  YuanbaoDshConfig,
} from '../types.js';
import { IdleEvictor } from './idle-evictor.js';
import { createServiceReader, type ServiceReader } from '../services.js';

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly evictor: IdleEvictor;
  private readonly services: ServiceReader;

  constructor(
    ctx: Context,
    private readonly agents: DshAgentRegistry,
    private readonly config: YuanbaoDshConfig,
    private readonly logger: Logger,
  ) {
    this.services = createServiceReader(ctx, m => logger.warn(m));
    this.evictor = new IdleEvictor(this, config.sessionIdleTimeout, logger);
    this.evictor.start();
  }

  enqueue(scope: ChatScope, peerId: string, task: () => Promise<void>): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    this.logger.info(`session enqueue: key=${key}; hasPending=${this.queues.has(key) ? 'yes' : 'no'}`);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task).finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    this.queues.set(key, next);
    return next;
  }

  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);
    if (existing) {
      this.logger.info(`session reuse in-memory: key=${key}; session=${existing.sessionId}`);
      existing.replyTarget = replyTarget;
      existing.senderId = senderId;
      existing.lastActivity = Date.now();
      return existing;
    }

    const sessionId = this.deriveSessionId(key);
    this.logger.info(`session resolve: key=${key}; session=${sessionId}`);
    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    this.logger.info(`session live lookup start: session=${sessionId}`);
    const live = this.agents.get(sessionId);
    this.logger.info(`session live lookup done: session=${sessionId}; found=${live ? 'yes' : 'no'}`);
    if (live) {
      agent = live;
      this.logger.info(`session reuse live agent: session=${sessionId}`);
      this.logger.info(`reusing live agent: key=${key}, sessionId=${sessionId}`);
    } else {
      this.logger.info(`session compose preset start: preset=${this.config.preset ?? 'none'}`);
      const composed = await this.composePreset();
      this.logger.info(`session compose preset done: agentPreset=${composed.agentPreset ?? 'none'}; hasSetup=${composed.setup ? 'yes' : 'no'}`);
      agentPreset = composed.agentPreset;
      try {
        this.logger.info(`session resume start: session=${sessionId}`);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(this.agentOptionsForResume() ? { agentOptions: this.agentOptionsForResume() } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`session resumed: session=${sessionId}`);
        this.logger.info(`resumed session: key=${key}, sessionId=${sessionId}`);
      } catch (error) {
        this.logger.warn(`session resume failed, creating new: session=${sessionId}; error=${error instanceof Error ? error.message : String(error)}`);
        // Resume can lose a race with a concurrent turn that already opened the
        // session (DSH persistence allows one writer per session id per process).
        // Re-check the live registry before falling back to create.
        const raced = this.agents.get(sessionId);
        if (raced) {
          agent = raced;
          this.logger.info(`session adopted after resume race: session=${sessionId}`);
        } else {
          this.logger.info(`session create start: session=${sessionId}; cwd=${this.config.cwd || process.cwd()}`);
          const agentOptions = this.agentOptionsForCreate();
          try {
            const created = await this.agents.create({
              sessionId,
              meta: {
                cwd: this.config.cwd || process.cwd(),
                ...(agentPreset ? { agentPreset } : {}),
              },
              ...(agentOptions ? { agentOptions } : {}),
              ...(composed.setup ? { setup: composed.setup } : {}),
            });
            agent = created.agent;
            handle = created;
            this.logger.info(`session created: session=${sessionId}`);
            this.logger.info(`created session: key=${key}, sessionId=${sessionId}`);
          } catch (createError) {
            // The id is already owned or stored by this process, yet `get` did
            // not surface it. Dropping the message would be worse than reusing
            // whatever handle the registry can still produce, so try once more.
            const adopted = this.agents.get(sessionId);
            if (!adopted) throw createError;
            agent = adopted;
            this.logger.warn(`session adopted after create conflict: session=${sessionId}; error=${createError instanceof Error ? createError.message : String(createError)}`);
          }
        }
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };
    this.sessions.set(key, record);
    return record;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return;
    this.sessions.delete(key);
    record.replyHeartbeat?.finishIfNeeded();
    record.replyHeartbeat = undefined;
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => undefined);
  }

  async evictIdle(beforeTs: number): Promise<void> {
    const stale = [...this.sessions.values()].filter(record => record.lastActivity < beforeTs);
    for (const record of stale) {
      this.sessions.delete(record.sessionKey);
      record.replyHeartbeat?.finishIfNeeded();
      record.replyHeartbeat = undefined;
      await record.handle.dispose().catch(() => undefined);
      this.logger.info(`evicted idle session: key=${record.sessionKey}`);
    }
  }

  async disposeAll(): Promise<void> {
    this.evictor.dispose();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.replyHeartbeat?.finishIfNeeded();
      record.replyHeartbeat = undefined;
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map(record => record.handle.dispose()));
  }

  getStatus(scope: ChatScope, peerId: string): string {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return 'No active Yuanbao DSH session.';
    const events = record.agent.session.events?.length ?? 0;
    return [
      'Yuanbao DSH session',
      `scope: ${record.scope}`,
      `sessionId: ${record.sessionId}`,
      `events: ${events}`,
      `lastActivity: ${new Date(record.lastActivity).toISOString()}`,
    ].join('\n');
  }

  private sessionKey(scope: ChatScope, peerId: string): string {
    // ── 会话路由 ──
    // per-peer（默认，原版行为）：每个群聊/私聊各开一个会话，key 里带 scope + peerId。
    // pinned：所有消息都路由到同一个 key，于是都进 pinnedSessionId 那个会话。
    //
    // 为什么用固定 key 而不是「先拿 pinnedSessionId 去查 agent」：
    //   getOrCreate 的整个流程（复用内存记录 / 查活跃 agent / 创建）都挂在 key 上，
    //   只要 key 相同，后续所有路径自然都会落到同一个会话，改动面最小。
    const mode = this.config.sessionMode ?? 'per-peer';
    const pinned = (this.config.pinnedSessionId ?? '').trim();
    if (mode === 'pinned' && pinned) {
      // 用 pinnedSessionId 本身当 key 的后缀，保证「同一个 pinned 会话」稳定复用一个 record
      return `yuanbao:${this.config.appKey || 'unknown'}:pinned:${pinned}`;
    }
    return `yuanbao:${this.config.appKey || 'unknown'}:${scope}:${peerId}`;
  }

  private deriveSessionId(key: string): string {
    // pinned 模式：直接用用户指定的会话 ID，不要再哈希成新 UUID ——
    // 否则「指定会话」会变成一个全新的空会话，达不到引流的目的。
    const mode = this.config.sessionMode ?? 'per-peer';
    const pinned = (this.config.pinnedSessionId ?? '').trim();
    if (mode === 'pinned' && pinned) {
      return pinned;
    }
    const hash = createHash('sha256').update(key).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private agentOptionsForCreate(): { provider?: string; model?: string } | undefined {
    const route = this.resolveModelRoute();
    if (!route) {
      this.logger.warn('model route missing: set provider/model in config or configure agentDefaultModel');
      return undefined;
    }
    this.logger.info(`model route selected: provider=${route.provider}; model=${route.model}`);
    return route;
  }

  private agentOptionsForResume(): { provider?: string; model?: string } | undefined {
    const route = this.resolveModelRoute();
    if (!route) {
      this.logger.warn('resume model route missing: set provider/model in config or configure agentDefaultModel');
      return undefined;
    }
    this.logger.info(`resume model route selected: provider=${route.provider}; model=${route.model}`);
    return route;
  }

  private resolveModelRoute(): { provider: string; model: string } | undefined {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }
    const service = this.getService('agentDefaultModel') as AgentDefaultModelLike | undefined;
    const selection = service?.currentSelection();
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model };
    }
    return undefined;
  }

  private async composePreset(): Promise<{ agentPreset?: string; setup?: AgentSetup }> {
    if (!this.config.preset) {
      this.logger.warn('no agent preset configured: the Yuanbao session will have no tools (no shell, no file access); set `preset` in the plugin config');
      return {};
    }
    const service = this.getService('agentPresets') as AgentPresetsLike | undefined;
    if (!service) {
      // Falling through here silently produces a tool-less agent, which looks
      // like "the bot ignores me" rather than a configuration fault.
      this.logger.error(`agentPresets service unavailable: cannot mount preset "${this.config.preset}"; the session will have no tools`);
      return {};
    }
    const resolved = await service.resolve(this.config.preset);
    return {
      agentPreset: resolved.id,
      setup: async agentCtx => {
        await service.mount(agentCtx, resolved.id);
      },
    };
  }

  /**
   * Resolve an optional DSH service.
   *
   * `agentPresets` is intentionally not declared in `inject`: making it a hard
   * dependency would stop the plugin loading wherever presets are absent, and
   * cordis refuses a plain `ctx.agentPresets` read for undeclared services.
   * `createServiceReader` goes through `ctx.reflect.get`, which is documented as
   * reading without the inject requirement.
   */
  private getService(name: string): unknown {
    return this.services.require(name);
  }
}
