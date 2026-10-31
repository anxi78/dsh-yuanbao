/**
 * dsh-yuanbao 客户端 —— 设置页「元宝」一栏
 * ============================================
 * 只做一件事：配置「会话路由」。
 *   · 按群聊/私聊各开一个会话（原版行为）
 *   · 所有消息都进指定的那个会话
 *
 * 客户端 bundle 不是 ESM，是自注册脚本（跟 dsh-bili-scroll / dsh-meme 同一套约定）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {...} })
 *
 * 进「设置」的写法也是照抄现成插件的：
 *   const slots = ctx.get('slots')
 *   slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))
 */
window.__ModuleLoader__.load({
  id: '@anxi78/dsh-yuanbao',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/yuanbao-session'

    const CSS = `
.yb-wrap{display:flex;flex-direction:column;gap:18px;max-width:640px;font-size:14px;line-height:1.65}
.yb-card{border:1px solid var(--dsw-alias-border-base,#e5e7eb);border-radius:12px;padding:18px 20px;background:var(--dsw-alias-bg-base,#fff)}
.yb-title{font-size:15px;font-weight:600;margin:0 0 4px}
.yb-desc{color:var(--dsw-alias-text-secondary,#6b7280);font-size:13px;margin:0 0 16px}
.yb-opt{display:flex;gap:12px;padding:13px 14px;border:1.5px solid var(--dsw-alias-border-base,#e5e7eb);border-radius:10px;cursor:pointer;margin-bottom:10px;transition:all .16s}
.yb-opt:hover{border-color:#9db4d8}
.yb-opt.on{border-color:#3a6ff0;background:rgba(58,111,240,.05)}
.yb-opt-radio{width:18px;height:18px;border-radius:50%;border:2px solid #c7ced8;flex:0 0 auto;margin-top:2px;position:relative;transition:all .16s}
.yb-opt.on .yb-opt-radio{border-color:#3a6ff0}
.yb-opt.on .yb-opt-radio:after{content:'';position:absolute;inset:3px;border-radius:50%;background:#3a6ff0}
.yb-opt-body{flex:1;min-width:0}
.yb-opt-name{font-weight:600;margin-bottom:2px}
.yb-opt-hint{color:var(--dsw-alias-text-secondary,#6b7280);font-size:12.5px}
.yb-field{margin-top:14px}
.yb-label{display:block;font-size:13px;font-weight:550;margin-bottom:7px;color:var(--dsw-alias-text-secondary,#6b7280)}
.yb-input{width:100%;box-sizing:border-box;padding:10px 13px;border:1px solid var(--dsw-alias-border-base,#e5e7eb);border-radius:9px;font-size:14px;font-family:ui-monospace,Menlo,monospace;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none;transition:border-color .16s}
.yb-input:focus{border-color:#3a6ff0}
select.yb-input{font-family:inherit;cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,#8b939e 50%),linear-gradient(135deg,#8b939e 50%,transparent 50%);background-position:calc(100% - 18px) 50%,calc(100% - 13px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:38px}
.yb-input:disabled{opacity:.5;cursor:not-allowed}
.yb-tip{font-size:12.5px;color:var(--dsw-alias-text-secondary,#6b7280);margin-top:7px}
.yb-actions{display:flex;align-items:center;gap:12px;margin-top:18px}
.yb-btn{padding:9px 22px;border-radius:9px;border:0;background:#3a6ff0;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity .16s}
.yb-btn:hover{opacity:.88}
.yb-btn:disabled{opacity:.45;cursor:not-allowed}
.yb-btn.ghost{background:transparent;color:var(--dsw-alias-text-secondary,#6b7280);border:1px solid var(--dsw-alias-border-base,#e5e7eb)}
.yb-msg{font-size:13px;font-weight:500}
.yb-msg.ok{color:#0ea472}
.yb-msg.err{color:#e0483d}
.yb-loading{color:var(--dsw-alias-text-secondary,#6b7280);font-size:13px}
.yb-badge{font-weight:400;font-size:12px;color:#0ea472;font-family:ui-monospace,Menlo,monospace}
.yb-badge.empty{color:#9aa3ae}
`

    async function asJson(res) {
      if (res.ok) return res.json()
      let detail = ''
      try {
        const j = await res.json()
        detail = j && j.error ? `：${j.error}` : ''
      } catch (_) { /* ignore */ }
      throw new Error(`HTTP ${res.status}${detail}`)
    }

    function Panel(props) {
      const sessions = props && props.sessions
      const [mode, setMode] = useState('per-peer')
      const [pinned, setPinned] = useState('')
      const [sessionList, setSessionList] = useState([])
      // 凭据：输入框里始终是空串，只有用户主动填了才会提交。
      // 后端不会回显明文，只给掩码 + has* 标记。
      const [appKey, setAppKey] = useState('')
      const [appSecret, setAppSecret] = useState('')
      const [token, setToken] = useState('')
      const [cred, setCred] = useState({ hasAppKey: false, hasAppSecret: false, hasToken: false, appKey: '', appSecret: '', token: '', botId: '' })
      const [loading, setLoading] = useState(true)
      const [saving, setSaving] = useState(false)
      const [msg, setMsg] = useState(null) // { kind: 'ok'|'err', text }

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const d = await asJson(await fetch(API, { credentials: 'same-origin' }))
          setMode(d.sessionMode === 'pinned' ? 'pinned' : 'per-peer')
          setPinned(d.pinnedSessionId || '')
          setCred({
            hasAppKey: Boolean(d.hasAppKey),
            hasAppSecret: Boolean(d.hasAppSecret),
            hasToken: Boolean(d.hasToken),
            appKey: d.appKey || '',
            appSecret: d.appSecret || '',
            token: d.token || '',
            botId: d.botId || '',
          })
          // 输入框保持空白 —— 留空代表"不修改"
          setAppKey('')
          setAppSecret('')
          setToken('')
        } catch (e) {
          setMsg({ kind: 'err', text: '读取失败：' + (e && e.message ? e.message : String(e)) })
        } finally {
          setLoading(false)
        }
      }, [])

      // 从 DSH 的会话列表里取可选项（前端 ctx.sessions.list.getSnapshot()）
      const readSessions = useCallback(() => {
        try {
          const snap = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
            ? sessions.list.getSnapshot()
            : null
          const byId = snap && snap.byId ? snap.byId : {}
          const rows = Object.keys(byId).map((id) => {
            const item = byId[id] || {}
            const title = String(item.title || item.name || item.preview || '').trim()
            return {
              id,
              label: title || id.slice(0, 8),
              cwd: String(item.cwd || ''),
            }
          })
          // 按标题排一下，方便找
          rows.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
          setSessionList(rows)
        } catch (e) {
          setSessionList([])
        }
      }, [sessions])

      useEffect(() => { void load() }, [load])
      useEffect(() => {
        readSessions()
        // 订阅变化：新建会话后列表要跟着更新
        try {
          if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
            return sessions.list.subscribe(() => readSessions())
          }
        } catch (_) { /* ignore */ }
        return undefined
      }, [readSessions, sessions])

      const save = useCallback(async () => {
        setSaving(true)
        setMsg(null)
        try {
          const d = await asJson(await fetch(API, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionMode: mode,
              pinnedSessionId: pinned.trim(),
              // 留空 = 不修改；填了才提交
              appKey: appKey.trim(),
              appSecret: appSecret.trim(),
              token: token.trim(),
            }),
          }))
          setMode(d.sessionMode === 'pinned' ? 'pinned' : 'per-peer')
          setPinned(d.pinnedSessionId || '')
          setAppKey('')
          setAppSecret('')
          setToken('')
          if (d.needsRestart) {
            setMsg({ kind: 'ok', text: '已保存。凭据改动需要重启 DSH 才会生效' })
          } else {
            setMsg({ kind: 'ok', text: '已保存，下一条消息就会按新规则路由' })
          }
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + (e && e.message ? e.message : String(e)) })
        } finally {
          setSaving(false)
        }
      }, [mode, pinned, appKey, appSecret, token])

      if (loading) return h('div', { className: 'yb-wrap' }, h('div', { className: 'yb-loading' }, '读取中…'))

      const opt = (value, name, hint) =>
        h('div', {
          className: 'yb-opt' + (mode === value ? ' on' : ''),
          onClick: () => setMode(value),
          role: 'button',
          tabIndex: 0,
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setMode(value) },
        },
          h('div', { className: 'yb-opt-radio' }),
          h('div', { className: 'yb-opt-body' },
            h('div', { className: 'yb-opt-name' }, name),
            h('div', { className: 'yb-opt-hint' }, hint),
          ),
        )

      return h('div', { className: 'yb-wrap' },
        h('style', null, CSS),
        h('div', { className: 'yb-card' },
          h('h3', { className: 'yb-title' }, '会话路由'),
          h('p', { className: 'yb-desc' }, '决定元宝收到的消息进哪个 DSH 会话。'),
          opt('per-peer', '按群聊/私聊分开', '原版行为：每个群聊、每个私聊各开一个独立会话，互不干扰。'),
          opt('pinned', '全部进指定会话', '所有群聊和私聊的消息都送到同一个会话里处理。'),

          mode === 'pinned'
            ? h('div', { className: 'yb-field' },
                h('label', { className: 'yb-label' }, '目标会话'),
                h('select', {
                  className: 'yb-input',
                  value: pinned,
                  onChange: (e) => setPinned(e.target.value),
                },
                  h('option', { value: '' }, '— 请选择会话 —'),
                  sessionList.map((row) =>
                    h('option', { key: row.id, value: row.id },
                      row.label + (row.cwd ? `　(${row.cwd})` : ''),
                    ),
                  ),
                ),
                sessionList.length === 0
                  ? h('div', { className: 'yb-tip' }, '没读到会话列表。先在 DSH 里打开过一次会话，再回到这里刷新。')
                  : h('div', { className: 'yb-tip' },
                      `共 ${sessionList.length} 个会话可选。留空会回退到「按群聊/私聊分开」。`),
              )
            : null,

          h('div', { className: 'yb-actions' },
            h('button', { className: 'yb-btn', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
            h('button', { className: 'yb-btn ghost', onClick: load, disabled: saving }, '重新读取'),
            msg ? h('span', { className: 'yb-msg ' + msg.kind }, msg.text) : null,
          ),
        ),

        // ── 凭据 ──
        h('div', { className: 'yb-card' },
          h('h3', { className: 'yb-title' }, '凭据'),
          h('p', { className: 'yb-desc' },
            '元宝开放平台的 AppKey / AppSecret。保存后会写到本地设置文件，重启 DSH 生效。',
          ),

          h('div', { className: 'yb-field' },
            h('label', { className: 'yb-label' },
              'AppKey',
              cred.hasAppKey
                ? h('span', { className: 'yb-badge' }, ' 已设置 ' + cred.appKey)
                : h('span', { className: 'yb-badge empty' }, ' 未设置'),
            ),
            h('input', {
              className: 'yb-input',
              type: 'text',
              value: appKey,
              placeholder: cred.hasAppKey ? '留空则不修改' : '粘贴 AppKey',
              onChange: (e) => setAppKey(e.target.value),
              autoComplete: 'off',
              spellCheck: false,
            }),
          ),

          h('div', { className: 'yb-field' },
            h('label', { className: 'yb-label' },
              'AppSecret',
              cred.hasAppSecret
                ? h('span', { className: 'yb-badge' }, ' 已设置 ' + cred.appSecret)
                : h('span', { className: 'yb-badge empty' }, ' 未设置'),
            ),
            h('input', {
              className: 'yb-input',
              type: 'password',
              value: appSecret,
              placeholder: cred.hasAppSecret ? '留空则不修改' : '粘贴 AppSecret',
              onChange: (e) => setAppSecret(e.target.value),
              autoComplete: 'new-password',
              spellCheck: false,
            }),
          ),

          h('div', { className: 'yb-field' },
            h('label', { className: 'yb-label' },
              'Token（可选）',
              cred.hasToken
                ? h('span', { className: 'yb-badge' }, ' 已设置 ' + cred.token)
                : h('span', { className: 'yb-badge empty' }, ' 未设置'),
            ),
            h('input', {
              className: 'yb-input',
              type: 'password',
              value: token,
              placeholder: cred.hasToken ? '留空则不修改' : '有预签名 token 才填，否则留空',
              onChange: (e) => setToken(e.target.value),
              autoComplete: 'new-password',
              spellCheck: false,
            }),
            h('div', { className: 'yb-tip' },
              '填了 token 会优先使用它；留空则用 AppKey + AppSecret 自动换取。',
            ),
          ),

          cred.botId
            ? h('div', { className: 'yb-tip' }, '当前 bot id：' + cred.botId)
            : null,

          h('div', { className: 'yb-tip', style: { marginTop: '14px' } },
            '安全说明：密钥只存在本机设置文件里，接口不会回显明文。',
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', '@anxi78/dsh-yuanbao')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), '@anxi78/dsh-yuanbao: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) || ctx.sessions
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'yuanbao', order: 32, label: '元宝' },
          () => h(Panel, { sessions }),
        ))
      },
    }
  },
})
