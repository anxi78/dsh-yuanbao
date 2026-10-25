import type { Context } from '@deepseek-ai/cordis';
import type { DshAgentRegistry, Logger, ResolvedYuanbaoAccount, YuanbaoDshConfig } from './types.js';
import { createLog, type LogSink } from './logger.js';
import { YuanbaoGateway } from './gateway/index.js';
import { SessionManager } from './session/manager.js';
import { YuanbaoSender } from './transport/sender.js';
import { createOutboundHandler } from './transport/outbound.js';
import type { MediaStore } from './transport/outbound.js';
import { handleInbound } from './inbound.js';
import type { AttachmentStoreLike } from './media.js';
import { registerSendMediaTool } from './tools.js';
import { createServiceReader, type ServiceReader } from './services.js';

export class YuanbaoDshBridge {
  private gateway: YuanbaoGateway | undefined;
  private manager: SessionManager | undefined;
  private disposeOutbound: (() => void) | undefined;
  /** Sender bound to the live connection, shared with the media tool. */
  private sender: YuanbaoSender | undefined;
  private readonly services: ServiceReader;
  private readonly logger: Logger;

  constructor(
    private readonly ctx: Context,
    private readonly agents: DshAgentRegistry,
    private readonly config: YuanbaoDshConfig,
    private readonly logSink: LogSink,
  ) {
    this.logger = createLog('bridge', logSink);
    this.services = createServiceReader(ctx, m => this.logger.warn(m));
  }

  async start(): Promise<void> {
    const sessionLogger = createLog('session', this.logSink);
    const inboundLogger = createLog('inbound', this.logSink);
    const senderLogger = createLog('sender', this.logSink);
    const outboundLogger = createLog('outbound', this.logSink);
    const gatewayLogger = createLog('gateway', this.logSink);
    const manager = new SessionManager(this.ctx, this.agents, this.config, sessionLogger);
    this.manager = manager;

    const gateway = new YuanbaoGateway(this.config, gatewayLogger, this.logSink, ({ msg, isGroup, client, account }) => {
      const sender = new YuanbaoSender(client, account, senderLogger, a => gateway.httpAuth(a));
      void handleInbound({
        msg,
        isGroup,
        manager,
        sender,
        config: this.config,
        logger: inboundLogger,
        attachments: this.attachmentStore(),
      })
        .catch(error => {
          this.logger.error(`handle inbound failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        });
    });
    this.gateway = gateway;

    const client = await gateway.start();
    if (!client) return;

    // Reuse the gateway's account: sign-token resolution stored the bot id on
    // that exact object. Building a second account here would leave `botId`
    // undefined and make every group send fail the `fromAccount` check.
    const account = gateway.account ?? gatewayAccountFromConfig(this.config);
    const sender = new YuanbaoSender(client, account, senderLogger, a => gateway.httpAuth(a));
    this.sender = sender;

    // Expose the media/sticker/message tools so the agent can act beyond the
    // plain reply path. Resolves the chat from the executing agent's session.
    void registerSendMediaTool(this.ctx, () => ({
      resolveSession: sessionId => {
        if (!sessionId || !this.sender) return undefined;
        const record = manager.findBySessionId(sessionId);
        if (!record) return undefined;
        return { sender: this.sender, record };
      },
      sender: this.sender,
      logger: senderLogger,
      cwd: this.config.cwd || process.cwd(),
    })).catch(error => {
      this.logger.warn(`send media tool registration failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const outboundHandler = createOutboundHandler(
      manager,
      sender,
      this.config,
      outboundLogger,
      this.attachmentStore() as MediaStore | undefined,
    );
    const dispose = (this.ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void | (() => void) })
      .on('session/event', outboundHandler as (...args: unknown[]) => void);
    this.disposeOutbound = typeof dispose === 'function' ? dispose : undefined;
  }

  async stop(): Promise<void> {
    this.disposeOutbound?.();
    this.disposeOutbound = undefined;
    this.gateway?.stop();
    this.gateway = undefined;
    this.sender = undefined;
    await this.manager?.disposeAll();
    this.manager = undefined;
  }

  /**
   * Resolve the DSH attachment store for persisting inbound media.
   *
   * `attachments` is deliberately not declared in `inject`: that would make it a
   * hard dependency and the whole plugin would fail to load wherever the store
   * is absent. Media support is optional, so it must degrade instead.
   *
   * Resolved lazily on every inbound message: some services are provided only
   * after plugin load, and a snapshot taken in apply() would stay undefined.
   */
  private attachmentStore(): AttachmentStoreLike | undefined {
    const store = this.services.get('attachments') as AttachmentStoreLike | undefined;
    if (store && typeof store.saveImage === 'function' && typeof store.saveFile === 'function') {
      return store;
    }
    return undefined;
  }
}

function gatewayAccountFromConfig(config: YuanbaoDshConfig): ResolvedYuanbaoAccount {
  return {
    accountId: 'default',
    enabled: true,
    configured: Boolean(config.token || (config.appKey && config.appSecret)),
    appKey: config.appKey || undefined,
    appSecret: config.appSecret || undefined,
    token: config.token || undefined,
    botId: config.botId || undefined,
    apiDomain: config.apiDomain,
    wsGatewayUrl: config.wsGatewayUrl,
    routeEnv: config.routeEnv,
    wsMaxReconnectAttempts: config.maxReconnectAttempts,
    config,
  };
}
