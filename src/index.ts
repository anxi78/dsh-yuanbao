import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema } from './config.js';
import type { DshAgentRegistry, Logger, YuanbaoDshConfig } from './types.js';
import { createLog } from './logger.js';
import { YuanbaoDshBridge } from './bridge.js';
import { loadLocalEnv, resolveEnvConfig } from './env-loader.js';
import { createServiceReader } from './services.js';

export const name = 'dsh-yuanbao';
// `tools` is declared so the plugin may register the media-send tool: cordis
// refuses to read an undeclared service, and every official tool plugin
// (dsh-tool-bash, dsh-tool-fs, dsh-tool-jobs, dsh-tool-ask-user) declares it too.
export const inject = ['agents', 'sessionPersistence', 'agentDefaultModel', 'tools', 'webServer'];
export const Config = ConfigSchema;

export async function apply(ctx: Context, config: YuanbaoDshConfig): Promise<void> {
  const services = createServiceReader(ctx);
  const rootSink = services.get('logger') as Partial<Logger> | undefined;
  const logger = createLog('main', rootSink);
  const loadedEnvFiles = loadLocalEnv();
  const resolvedConfig = resolveEnvConfig(config);
  logger.info(`apply() called; envFiles=${loadedEnvFiles.length}; appKey=${resolvedConfig.appKey ? 'set' : 'missing'}; secret=${resolvedConfig.appSecret ? 'set' : 'missing'}; token=${resolvedConfig.token ? 'set' : 'missing'}`);

  const agents = services.require('agents') as DshAgentRegistry | undefined;
  if (!agents) {
    logger.error('ctx.agents is required but unavailable');
    return;
  }

  const bridge = new YuanbaoDshBridge(ctx, agents, resolvedConfig, rootSink ?? {});
  ctx.effect(() => {
    void bridge.start().catch(error => {
      logger.error(`failed to start Yuanbao DSH bridge: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      void bridge.stop().catch(error => {
        logger.warn(`failed to stop Yuanbao DSH bridge: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
  });

  // ── 设置页 API ──────────────────────────────────────────────
  // 只暴露「会话路由」这两个字段的读写：其它字段（appKey/appSecret 等）
  // 属于敏感配置，继续走 cordis.patch.yml，不在网页上改。
  const webServer = services.get('webServer') as
    | { register?: (route: { kind: string; path: string; handler: (req: any, res: any) => void }) => unknown }
    | undefined;

  if (webServer && typeof webServer.register === 'function') {
    const readBody = (req: any): Promise<string> =>
      new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
          if (data.length > 64 * 1024) reject(new Error('body too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });

    const json = (res: any, code: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    const current = () => ({
      sessionMode: resolvedConfig.sessionMode ?? 'per-peer',
      pinnedSessionId: resolvedConfig.pinnedSessionId ?? '',
    });

    webServer.register({
      kind: 'exact',
      path: '/api/yuanbao-session',
      handler: async (req: any, res: any) => {
        try {
          if (req.method === 'GET') {
            json(res, 200, { ok: true, ...current() });
            return;
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            const raw = await readBody(req);
            const parsed = JSON.parse(raw || '{}');
            const mode = parsed.sessionMode;
            const pinned = parsed.pinnedSessionId;
            if (mode !== undefined && mode !== 'per-peer' && mode !== 'pinned') {
              json(res, 400, { ok: false, error: "sessionMode 只能是 'per-peer' 或 'pinned'" });
              return;
            }
            // 直接改内存里的 resolvedConfig —— bridge 持有同一个对象引用，
            // 下一次 getOrCreate 就会按新模式算 key，不需要重启插件。
            if (mode !== undefined) resolvedConfig.sessionMode = mode;
            if (typeof pinned === 'string') resolvedConfig.pinnedSessionId = pinned.trim();
            logger.info(
              `session routing updated: mode=${resolvedConfig.sessionMode}; pinned=${resolvedConfig.pinnedSessionId || '(none)'}`,
            );
            json(res, 200, { ok: true, ...current() });
            return;
          }
          json(res, 405, { ok: false, error: 'method not allowed' });
        } catch (error) {
          json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    logger.info('settings api registered: /api/yuanbao-session');
  } else {
    logger.warn('webServer unavailable — settings api not registered');
  }
}
