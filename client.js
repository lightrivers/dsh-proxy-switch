/**
 * `dsh-proxy-switch` Client half — the sidebar switch.
 *
 * Registers one `sidebar.footer.action` occupant: a compact mode badge that opens a panel
 * with the mode switch, upstream health, listener port, last switch time, the warning, and
 * the three settings. State comes from the Host over the same origin (`/dsh-proxy-switch/…`),
 * polled while mounted, so the badge never disagrees with the forwarder.
 *
 * Text is bilingual: the active DSH locale decides, with the browser language as fallback.
 * All mutations are the Host's: the Client only sends the requested mode/settings and
 * renders whatever state comes back.
 */
window.__ModuleLoader__.load({
  id: 'dsh-proxy-switch',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const TEXT = {
      zh: {
        title: '代理开关',
        subtitle: '本地出站转发器',
        forward: '转发',
        direct: '直连',
        mode: '当前模式',
        forwardHint: '所有出站经上游 HTTP 代理。',
        directHint: '自行 DNS 解析并直连；目标落在 fake-IP 段时拒绝。',
        scope: '策略范围',
        scopeWebFetch: '仅 web_fetch',
        scopeGlobal: '全局',
        scopeHintWebFetch: '只接管 web_fetch：使用独立 provider 与独立本地通道，不改全局 dispatcher、进程代理变量和子进程环境。',
        scopeHintGlobal: '显式全局接管：其它模块也经本插件；web_fetch 仍走独立通道。',
        provider: 'web_fetch 接管',
        providerActive: '已接管（独立通道）',
        providerBlocked: '被外部配置占用',
        providerError: '接管失败',
        providerPending: '等待 web 服务',
        notTakenOver: '不接管全局',
        globalOnly: '仅全局模式',
        webFetchPort: 'web_fetch 通道端口',
        webFetchRequests: '其中 web_fetch',
        upstream: '上游代理',
        upstreamMaskedHint: '凭据已隐藏；修改上游请重新填写完整地址（含 user:pass）。',
        reachable: '可达',
        unreachable: '不可达',
        probing: '检测中',
        latency: '延迟',
        port: '监听端口',
        policy: '全局策略',
        installed: '已接管',
        notInstalled: '未接管',
        policyBroken: '全局策略未生效：@deepseek-ai/dsh-http-proxy 可能被解析成第二份模块副本，检查 peerDependencies',
        lastSwitch: '最后切换',
        never: '尚未切换',
        warnTitle: '需要注意',
        settings: '设置',
        upstreamField: '上游地址（只支持 http://）',
        portField: '全局监听端口（仅全局模式，1024–65535）',
        intervalField: '探测间隔（秒，3–600）',
        save: '保存设置',
        saving: '保存中…',
        saved: '已保存',
        close: '关闭',
        requests: '请求',
        failures: '失败',
        lastSeen: '最近目标',
        unreachableState: '无法读取插件状态',
        retry: '重试',
        switchTo: '切到',
        switching: '切换中…',
        liveHint: '切换立即生效，无需重启 DSH。',
        portHint: '仅全局模式使用；web_fetch 通过独立的随机本地端口。',
        disabledHint: '监听未建立：已保持原有出站路径。',
        statsHint: '统计只记录目标主机与状态码，不记录 URL 与正文。',
        localeTag: '中文',
      },
      en: {
        title: 'Proxy Switch',
        subtitle: 'local outbound forwarder',
        forward: 'Forward',
        direct: 'Direct',
        mode: 'Mode',
        forwardHint: 'Every outbound request goes through the upstream HTTP proxy.',
        directHint: 'Resolve and dial directly; a fake-IP destination is refused.',
        scope: 'Scope',
        scopeWebFetch: 'web_fetch only',
        scopeGlobal: 'Global',
        scopeHintWebFetch: 'Only web_fetch is taken over: a private provider and private local channel; the global dispatcher, process proxy variables, and child environments are untouched.',
        scopeHintGlobal: 'Explicit global takeover: other modules also follow the switch; web_fetch still uses its private channel.',
        provider: 'web_fetch takeover',
        providerActive: 'active (private channel)',
        providerBlocked: 'blocked by external config',
        providerError: 'takeover failed',
        providerPending: 'waiting for the web service',
        notTakenOver: 'global not taken over',
        globalOnly: 'global mode only',
        webFetchPort: 'web_fetch channel port',
        webFetchRequests: 'of which web_fetch',
        upstream: 'Upstream',
        upstreamMaskedHint: 'Credentials are hidden; to change the upstream, re-enter the full address including user:pass.',
        reachable: 'reachable',
        unreachable: 'unreachable',
        probing: 'probing',
        latency: 'latency',
        port: 'Port',
        policy: 'Global policy',
        installed: 'installed',
        notInstalled: 'not installed',
        policyBroken: 'Global policy is not effective: @deepseek-ai/dsh-http-proxy may be a second module copy — check peerDependencies',
        lastSwitch: 'Last switch',
        never: 'never',
        warnTitle: 'Attention',
        settings: 'Settings',
        upstreamField: 'Upstream address (http:// only)',
        portField: 'Global listen port (global mode only, 1024–65535)',
        intervalField: 'Probe interval (seconds, 3–600)',
        save: 'Save settings',
        saving: 'Saving…',
        saved: 'Saved',
        close: 'Close',
        requests: 'requests',
        failures: 'failed',
        lastSeen: 'last target',
        unreachableState: 'Cannot read plugin state',
        retry: 'Retry',
        switchTo: 'Switch to',
        switching: 'Switching…',
        liveHint: 'Switching applies immediately; no DSH restart.',
        portHint: 'Used by global mode only; web_fetch uses a separate ephemeral local port.',
        disabledHint: 'Listener not bound: the previous outbound path was kept.',
        statsHint: 'Only the target host and status code are counted — never URLs or bodies.',
        localeTag: 'EN',
      },
    }

    function readLocaleId(getLocale) {
      try {
        const snapshot = getLocale?.()
        const id = snapshot?.active ?? snapshot?.id ?? snapshot?.locale
        if (typeof id === 'string' && id !== '') return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        /* fall through to the browser language */
      }
      const browser = typeof navigator === 'object' ? navigator.language ?? '' : ''
      return browser.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    const styles = {
      trigger: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
        padding: '5px 8px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.2,
      },
      dot: (color) => ({
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: color,
        flex: '0 0 auto',
        boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 25%, transparent)`,
      }),
      panel: {
        position: 'fixed',
        left: '10px',
        bottom: '76px',
        width: '336px',
        maxHeight: '72vh',
        overflowY: 'auto',
        padding: '14px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.36)',
        zIndex: 9000,
        fontSize: '12.5px',
        lineHeight: 1.45,
      },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' },
      section: { marginTop: '12px' },
      sectionTitle: {
        fontSize: '11px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        marginBottom: '6px',
      },
      segments: { display: 'flex', gap: '6px' },
      segment: (active) => ({
        flex: 1,
        padding: '7px 10px',
        borderRadius: '8px',
        border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
        background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent)' : 'transparent',
        color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: active ? 600 : 400,
      }),
      row: { display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '3px 0' },
      key: { color: 'var(--dsw-alias-label-secondary)' },
      value: { textAlign: 'right', wordBreak: 'break-all' },
      warning: (severity) => ({
        marginTop: '10px',
        padding: '9px 10px',
        borderRadius: '9px',
        border: `1px solid ${severity === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)'}`,
        background: `color-mix(in srgb, ${
          severity === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)'
        } 12%, transparent)`,
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'pre-wrap',
      }),
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        marginTop: '4px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
      },
      label: { display: 'block', marginTop: '9px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px' },
      footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '12px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', marginTop: '8px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '11.5px', marginTop: '8px' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
      button: {
        padding: '5px 12px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
      },
    }

    async function requestState() {
      const response = await fetch('/dsh-proxy-switch/state', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function post(path, body) {
      const response = await fetch(`/dsh-proxy-switch${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`)
      return data.state
    }

    function formatTime(value, locale) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      try {
        return new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      } catch {
        return new Date(value).toISOString()
      }
    }

    function createBadge(ctx) {
      const getLocaleSnapshot = () => {
        try {
          return ctx.get('locale')?.getSnapshot?.()
        } catch {
          return void 0
        }
      }

      return function ProxySwitchBadge(props) {
        const [locale, setLocale] = useState(() => readLocaleId(getLocaleSnapshot))
        const [state, setState] = useState(null)
        const [error, setError] = useState(null)
        const [open, setOpen] = useState(false)
        const [busy, setBusy] = useState(null)
        const [saved, setSaved] = useState(false)
        const [draft, setDraft] = useState({ upstream: '', upstreamDirty: false, listenPort: '', intervalSeconds: '' })
        const alive = useRef(true)
        const t = TEXT[locale] ?? TEXT.zh

        useEffect(() => {
          alive.current = true
          const dispose = ctx.on('locale/change', () => setLocale(readLocaleId(getLocaleSnapshot)))
          return () => {
            alive.current = false
            if (typeof dispose === 'function') dispose()
          }
        }, [])

        const refresh = useCallback(async () => {
          try {
            const next = await requestState()
            if (!alive.current) return
            setState(next)
            setError(null)
            setDraft((current) => {
              const untouched = current.upstream === '' && current.listenPort === ''
              if (untouched) {
                return {
                  upstream: next.upstream ?? '',
                  upstreamDirty: false,
                  listenPort: String(next.listenPort ?? ''),
                  intervalSeconds: String(Math.round((next.probeIntervalMs ?? 15000) / 1000)),
                }
              }
              // Never overwrite a credential the user is editing; the Host only returns a
              // masked value, so writing it back would replace the real password with "***".
              if (current.upstreamDirty) return current
              return { ...current, upstream: next.upstream ?? '' }
            })
          } catch (caught) {
            if (!alive.current) return
            setError(String(caught?.message ?? caught))
          }
        }, [])

        useEffect(() => {
          void refresh()
          const timer = setInterval(() => void refresh(), open ? 1500 : 4000)
          return () => clearInterval(timer)
        }, [open, refresh])

        const switchMode = useCallback(
          async (mode) => {
            if (busy !== null || state?.mode === mode) return
            setBusy(mode)
            try {
              const next = await post('/mode', { mode })
              if (alive.current && next) setState(next)
              setError(null)
            } catch (caught) {
              if (alive.current) setError(String(caught?.message ?? caught))
            } finally {
              if (alive.current) setBusy(null)
            }
          },
          [busy, state?.mode],
        )

        const changeScope = useCallback(
          async (scope) => {
            if (busy !== null || state?.scope === scope) return
            setBusy(scope)
            try {
              const next = await post('/settings', { scope })
              if (alive.current && next) setState(next)
              setError(null)
            } catch (caught) {
              if (alive.current) setError(String(caught?.message ?? caught))
            } finally {
              if (alive.current) setBusy(null)
            }
          },
          [busy, state?.scope],
        )

        const saveSettings = useCallback(async () => {
          setBusy('save')
          try {
            const payload = {
              listenPort: Number(draft.listenPort),
              probeIntervalMs: Math.round(Number(draft.intervalSeconds) * 1000),
            }
            // Omit the upstream unless the user actually edited it: the rendered value is
            // masked, and sending it back would persist "***" as the password.
            if (draft.upstreamDirty) payload.upstream = draft.upstream.trim()
            const next = await post('/settings', payload)
            if (alive.current && next) setState(next)
            setDraft((current) => ({ ...current, upstream: next?.upstream ?? current.upstream, upstreamDirty: false }))
            setError(null)
            setSaved(true)
            setTimeout(() => {
              if (alive.current) setSaved(false)
            }, 1800)
          } catch (caught) {
            if (alive.current) setError(String(caught?.message ?? caught))
          } finally {
            if (alive.current) setBusy(null)
          }
        }, [draft])

        const mode = state?.mode ?? 'direct'
        const warning = state?.warning ?? null
        const reachable = state?.probe?.reachable
        const healthColor =
          reachable === true
            ? 'var(--dsw-alias-state-success-primary)'
            : reachable === false
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-state-idle-primary)'
        const badgeColor = warning !== null ? 'var(--dsw-alias-state-warn-primary)' : healthColor
        const modeLabel = mode === 'forward' ? t.forward : t.direct
        const wide = props?.wide !== false

        const healthText =
          reachable === true
            ? t.reachable
            : reachable === false
              ? t.unreachable
              : t.probing

        const scopeLabel = state?.scope === 'global' ? t.scopeGlobal : t.scopeWebFetch
        const providerStatus = state?.provider?.status ?? 'pending'
        const providerLabel =
          providerStatus === 'active'
            ? t.providerActive
            : providerStatus === 'blocked'
              ? t.providerBlocked
              : providerStatus === 'error'
                ? t.providerError
                : t.providerPending
        const globalScope = state?.scope === 'global'
        const rows = [
          [t.scope, state === null ? '—' : scopeLabel],
          [t.provider, state === null ? '—' : providerLabel],
          [t.upstream, state?.upstream ?? '—'],
          [t.port, state === null ? '—' : globalScope ? String(state.listenPort ?? '—') : t.globalOnly],
          [t.webFetchPort, state?.webFetchPort === null || state?.webFetchPort === void 0 ? '—' : String(state.webFetchPort)],
          [t.policy, state === null ? '—' : globalScope ? (state.policySelfCheck?.ok === true ? t.installed : t.notInstalled) : t.notTakenOver],
          [t.lastSwitch, formatTime(state?.lastSwitchAt, locale) ?? t.never],
        ]
        if (state?.stats !== undefined) {
          rows.push([t.requests, `${state.stats.requests ?? 0} · ${t.failures} ${state.stats.failures ?? 0}`])
          if (typeof state.stats.webFetchRequests === 'number' && state.stats.webFetchRequests > 0) {
            rows.push([t.webFetchRequests, String(state.stats.webFetchRequests)])
          }
          if (typeof state.stats.lastHost === 'string' && state.stats.lastHost !== '') rows.push([t.lastSeen, state.stats.lastHost])
        }

        const trigger = h(
          'button',
          {
            type: 'button',
            style: styles.trigger,
            title: `${t.title} · ${modeLabel} · ${t.upstream}: ${state?.upstream ?? '—'} (${healthText})`,
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            'aria-label': t.title,
          },
          h('span', { style: styles.dot(badgeColor) }),
          wide ? h('span', { style: { whiteSpace: 'nowrap' } }, modeLabel) : null,
        )

        if (!open) return trigger

        return h(
          React.Fragment,
          null,
          trigger,
          h(
            'div',
            { style: styles.panel, role: 'dialog', 'aria-label': t.title },
            h(
              'div',
              { style: styles.header },
              h(
                'div',
                null,
                h('div', { style: { fontWeight: 600, fontSize: '13px' } }, t.title),
                h('div', { style: { ...styles.hint, marginTop: '2px' } }, t.subtitle),
              ),
              h('button', { type: 'button', style: styles.button, onClick: () => setOpen(false) }, t.close),
            ),

            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: styles.dot(badgeColor) }),
              h('span', { style: { fontWeight: 600, fontSize: '15px' } }, modeLabel),
              h('span', { style: { ...styles.hint, marginTop: 0 } }, `· ${t.upstream} ${healthText}`),
            ),

            h(
              'div',
              { style: styles.segments },
              ['forward', 'direct'].map((candidate) =>
                h(
                  'button',
                  {
                    key: candidate,
                    type: 'button',
                    style: styles.segment(mode === candidate),
                    disabled: busy !== null,
                    onClick: () => void switchMode(candidate),
                    title: candidate === 'forward' ? t.forwardHint : t.directHint,
                  },
                  candidate === 'forward' ? t.forward : t.direct,
                ),
              ),
            ),
            h('div', { style: styles.hint }, mode === 'forward' ? t.forwardHint : t.directHint),

            h(
              'div',
              { style: styles.segments, marginTop: '8px' },
              ['web_fetch_only', 'global'].map((candidate) =>
                h(
                  'button',
                  {
                    key: candidate,
                    type: 'button',
                    style: styles.segment((state?.scope ?? 'web_fetch_only') === candidate),
                    disabled: busy !== null,
                    onClick: () => void changeScope(candidate),
                    title: candidate === 'web_fetch_only' ? t.scopeHintWebFetch : t.scopeHintGlobal,
                  },
                  candidate === 'web_fetch_only' ? t.scopeWebFetch : t.scopeGlobal,
                ),
              ),
            ),
            h('div', { style: styles.hint }, (state?.scope ?? 'web_fetch_only') === 'global' ? t.scopeHintGlobal : t.scopeHintWebFetch),

            warning !== null
              ? h(
                  'div',
                  { style: styles.warning(warning.severity) },
                  h('div', { style: { fontWeight: 600, marginBottom: '3px' } }, `${t.warnTitle} · ${warning.code}`),
                  h('div', null, locale === 'zh' ? warning.zh : warning.en),
                  warning.actionZh !== void 0
                    ? h('div', { style: { ...styles.hint, marginTop: '4px' } }, locale === 'zh' ? warning.actionZh : warning.actionEn)
                    : null,
                )
              : null,

            globalScope && state?.policySelfCheck !== null && state?.policySelfCheck !== void 0 && state.policySelfCheck.ok !== true
              ? h('div', { style: styles.error }, t.policyBroken)
              : null,
            state?.provider?.error !== null && state?.provider?.error !== void 0
              ? h('div', { style: styles.error }, String(state.provider.error))
              : null,
            state !== null && state.listenError !== null && state.listenError !== void 0
              ? h('div', { style: styles.error }, `${t.disabledHint} (${state.listenError})`)
              : null,
            state?.lastError !== null && state?.lastError !== void 0
              ? h('div', { style: styles.error }, String(state.lastError))
              : null,
            error !== null ? h('div', { style: styles.error }, `${t.unreachableState}: ${error}`) : null,

            h(
              'div',
              { style: styles.section },
              h('div', { style: styles.sectionTitle }, t.mode),
              rows.map(([key, value]) =>
                h(
                  'div',
                  { key, style: styles.row },
                  h('span', { style: styles.key }, key),
                  h('span', { style: styles.value }, value),
                ),
              ),
            ),

            h(
              'div',
              { style: styles.section },
              h('div', { style: styles.sectionTitle }, t.settings),
              h('label', { style: styles.label }, t.upstreamField, h('input', {
                style: styles.input,
                value: draft.upstream,
                spellCheck: false,
                onChange: (event) => setDraft({ ...draft, upstream: event.target.value, upstreamDirty: true }),
              })),
              state?.upstreamHasCredentials === true ? h('div', { style: styles.hint }, t.upstreamMaskedHint) : null,
              h('label', { style: styles.label }, t.portField, h('input', {
                style: styles.input,
                value: draft.listenPort,
                inputMode: 'numeric',
                onChange: (event) => setDraft({ ...draft, listenPort: event.target.value }),
              })),
              h('label', { style: styles.label }, t.intervalField, h('input', {
                style: styles.input,
                value: draft.intervalSeconds,
                inputMode: 'numeric',
                onChange: (event) => setDraft({ ...draft, intervalSeconds: event.target.value }),
              })),
              h(
                'div',
                { style: styles.footer },
                h('button', { type: 'button', style: styles.button, disabled: busy !== null, onClick: () => void saveSettings() }, busy === 'save' ? t.saving : saved ? t.saved : t.save),
                h('button', { type: 'button', style: styles.button, disabled: busy !== null, onClick: () => void refresh() }, t.retry),
              ),
              h('div', { style: styles.hint }, t.portHint),
            ),

            h('div', { style: styles.hint }, t.liveHint),
            h('div', { style: styles.hint }, t.statsHint),
          ),
        )
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const component = createBadge(ctx)
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-proxy-switch', order: 40 }, component),
        )
      },
    }
  },
})
