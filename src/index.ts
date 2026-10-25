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

/**
 * 设置持久化
 * ===========
 * 设置面板改的东西只写内存的话，DSH 一重启就全丢了。
 * 这里存到 ~/.dsh/.yuanbao-settings.json，启动时读回来覆盖配置默认值。
 *
 * 为什么不用 cordis.patch.yml：
 *   那是静态配置，用户改一次要手写 YAML 再重启，体验太差。
 *   运行时设置放独立文件，互不干扰。
 */
const SETTINGS_FILE = '.yuanbao-settings.json';

type PersistedSettings = {
  sessionMode?: 'per-peer' | 'pinned';
  pinnedSessionId?: string;
  /** 元宝开放平台 AppKey */
  appKey?: string;
  /** 元宝开放平台 AppSecret */
  appSecret?: string;
  /** 预签名 token（可选，有就优先用） */
  token?: string;
};

function settingsPath(): string {
  // 跟随 DSH 家目录，默认 ~/.dsh
  const home = process.env.DSH_HOME
    || (process.env.HOME ? `${process.env.HOME}/.dsh` : '');
  if (!home) return '';
  return `${home}/${SETTINGS_FILE}`;
}

async function readPersistedSettings(): Promise<PersistedSettings> {
  const file = settingsPath();
  if (!file) return {};
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as PersistedSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 文件不存在或损坏都不影响启动，回退到配置默认值
    return {};
  }
}

async function writePersistedSettings(next: PersistedSettings): Promise<void> {
  const file = settingsPath();
  if (!file) throw new Error('DSH_HOME / HOME 都未设置，无法定位设置文件');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export async function apply(ctx: Context, config: YuanbaoDshConfig): Promise<void> {
  const services = createServiceReader(ctx);
  const rootSink = services.get('logger') as Partial<Logger> | undefined;
  const logger = createLog('main', rootSink);
  const loadedEnvFiles = loadLocalEnv();
  const resolvedConfig = resolveEnvConfig(config);

  // 读回上次在设置面板里保存的选项，覆盖配置文件的默认值。
  // 这样重启 DSH 之后不需要重新设置一遍。
  const persisted = await readPersistedSettings();
  if (persisted.sessionMode === 'per-peer' || persisted.sessionMode === 'pinned') {
    resolvedConfig.sessionMode = persisted.sessionMode;
  }
  if (typeof persisted.pinnedSessionId === 'string') {
    resolvedConfig.pinnedSessionId = persisted.pinnedSessionId;
  }
  // 凭据：设置面板里存的优先于环境变量。
  // 用户既然在面板里填了，就是想用它，不该被旧的 env 覆盖。
  if (persisted.appKey) resolvedConfig.appKey = persisted.appKey;
  if (persisted.appSecret) resolvedConfig.appSecret = persisted.appSecret;
  if (persisted.token) resolvedConfig.token = persisted.token;

  logger.info(`apply() called; envFiles=${loadedEnvFiles.length}; appKey=${resolvedConfig.appKey ? 'set' : 'missing'}; secret=${resolvedConfig.appSecret ? 'set' : 'missing'}; token=${resolvedConfig.token ? 'set' : 'missing'}; sessionMode=${resolvedConfig.sessionMode ?? 'per-peer'}; pinned=${resolvedConfig.pinnedSessionId || '(none)'}`);

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

    // 凭据一律不回显明文，只告诉前端「有没有设置」和末尾几位。
    // 设置页不需要看到完整密钥，回显明文只会多一个泄漏面。
    const mask = (v: string | undefined): string => {
      if (!v) return '';
      if (v.length <= 6) return '****';
      return `${v.slice(0, 3)}${'*'.repeat(Math.min(12, v.length - 6))}${v.slice(-3)}`;
    };

    const current = () => ({
      sessionMode: resolvedConfig.sessionMode ?? 'per-peer',
      pinnedSessionId: resolvedConfig.pinnedSessionId ?? '',
      appKey: mask(resolvedConfig.appKey),
      appSecret: mask(resolvedConfig.appSecret),
      token: mask(resolvedConfig.token),
      hasAppKey: Boolean(resolvedConfig.appKey),
      hasAppSecret: Boolean(resolvedConfig.appSecret),
      hasToken: Boolean(resolvedConfig.token),
      apiDomain: resolvedConfig.apiDomain ?? '',
      botId: resolvedConfig.botId ?? '',
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

            // ── 凭据 ──
            // 前端传空字符串表示「不改」，传 __clear__ 表示「清空」。
            // 之所以不用空串代表清空：用户可能只是想改会话路由，不该顺手把密钥抹掉。
            let credentialsChanged = false;
            const applySecret = (incoming: unknown, key: 'appKey' | 'appSecret' | 'token'): void => {
              if (typeof incoming !== 'string') return;
              if (incoming === '__clear__') {
                // 用空串表示清空（配置类型是 string，不是 string|undefined）
                resolvedConfig[key] = '';
                credentialsChanged = true;
                return;
              }
              const v = incoming.trim();
              if (!v) return; // 空串 = 保持不变
              resolvedConfig[key] = v;
              credentialsChanged = true;
            };
            applySecret(parsed.appKey, 'appKey');
            applySecret(parsed.appSecret, 'appSecret');
            applySecret(parsed.token, 'token');

            // 同时写盘：不然 DSH 一重启，面板里改的东西就没了。
            try {
              await writePersistedSettings({
                sessionMode: resolvedConfig.sessionMode,
                pinnedSessionId: resolvedConfig.pinnedSessionId ?? '',
                appKey: resolvedConfig.appKey,
                appSecret: resolvedConfig.appSecret,
                token: resolvedConfig.token,
              });
              logger.info(`settings persisted: mode=${resolvedConfig.sessionMode}; pinned=${resolvedConfig.pinnedSessionId || '(none)'}; credentialsChanged=${credentialsChanged}`);
            } catch (persistError) {
              // 写盘失败不影响本次生效，但要留痕 —— 否则用户会以为保存成功了
              logger.warn(`settings persist failed: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
            }

            if (credentialsChanged) {
              logger.info('credentials updated — 重启 DSH 后生效（WebSocket 需要重新握手）');
            }
            logger.info(
              `settings updated: mode=${resolvedConfig.sessionMode}; pinned=${resolvedConfig.pinnedSessionId || '(none)'}`,
            );
            json(res, 200, {
              ok: true,
              ...current(),
              // 凭据改动需要重启才能重连，明确告诉前端
              needsRestart: credentialsChanged,
            });
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
