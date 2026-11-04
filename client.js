/**
 * `dsh-proxy-switch` Client half.
 *
 * One status pill opens a popover that answers three questions in order of weight:
 * which route web_fetch takes right now (the hero, with an animated route), how the route
 * is chosen (auto / through proxy / direct), and which proxy the plugin found. Every
 * abnormal Host state becomes one banner with a one-click fix; rare settings (proxy
 * address, scope, where the pill lives) sit behind "More settings".
 *
 * The pill can live in the sidebar footer (default), in the conversation header, or
 * nowhere. The same panel is always available on the plugin's own page in Plugins
 * (`plugins.bundle.config`), so hiding the pill can never lose the controls.
 *
 * Text is bilingual: the active DSH locale decides, with the browser language as fallback.
 * All mutations are the Host's: the Client only sends requests and renders the state.
 */
window.__ModuleLoader__.load({
  id: 'dsh-proxy-switch',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const PACKAGE_NAME = 'dsh-proxy-switch'
    const PLACEMENT_KEY = 'dsh-proxy-switch.placement'
    const PLACEMENTS = ['sidebar', 'header', 'hidden']

    const TEXT = {
      zh: {
        name: '代理开关',
        sep: '，',
        close: '关闭',
        loading: '正在读取状态…',
        heroForward: '正在走代理',
        heroDirect: '正在直连',
        subAutoOnline: '自动选择：代理客户端在运行',
        subAutoOffline: '自动选择：没有可用的代理',
        subAutoChecking: '自动选择：正在检测代理客户端…',
        subPinnedForward: '已固定走代理',
        subPinnedDirect: '已固定直连',
        scopeChipWebFetch: '仅 web_fetch',
        scopeChipGlobal: '所有工具',
        scopeChipTip: (desc) => `作用范围：${desc}点击修改`,
        nodeApp: 'DeepSeek',
        nodeProxy: '代理',
        nodeWeb: '网站',
        modeLabel: '线路选择',
        modeAuto: '自动',
        modeForward: '走代理',
        modeDirect: '直连',
        recommended: '推荐',
        hintAuto: '代理开着就走代理，关着就直连。适合大多数人。',
        hintForward: '始终经过代理。代理关掉后，网页抓取会失败。',
        hintDirect: '始终直连。代理开着时，部分网站会被拒绝。',
        switched: (label) => `已切到「${label}」`,
        proxyLabel: '代理',
        proxyNone: '没有找到可用的代理端口',
        proxySearching: '正在查找代理客户端…',
        sourceSystem: '系统代理',
        sourceEnvironment: '环境变量',
        sourceScan: '端口扫描',
        sourceManual: '手动',
        online: '在线',
        offline: '未运行',
        checking: '检测中',
        ms: (value) => `${value} 毫秒`,
        recheck: '重新检测',
        findAgain: '重新查找',
        warnDirectTitle: '代理客户端正在运行',
        warnDirectBody: '固定直连时，部分网站会被识别成内部地址而拒绝抓取。',
        warnForwardTitle: '连不上代理客户端',
        warnForwardBody: '固定走代理时，网页抓取会失败。打开代理客户端，或改为自动。',
        useAuto: '改为自动',
        autoNotFoundTitle: '找不到代理的端口',
        autoNotFoundBody: '代理客户端似乎在运行，但没找到它的 HTTP 端口，所以只能直连，部分网站被拒绝。',
        enterManually: '手动填写地址',
        needsAuthTitle: '代理需要账号密码',
        needsAuthBody: '找到了代理，但它要求登录。请手动填写带账号密码的地址。',
        blockedTitle: '开关暂时不起作用',
        blockedBody: 'DSH 配置里为 web_fetch 指定了其它抓取方式，插件无法接管。',
        providerErrorTitle: '接管 web_fetch 失败',
        pendingTitle: '正在等待 DSH 网页服务启动…',
        listenErrorTitle: '本地端口无法使用',
        listenErrorBody: (port, detail) => `端口 ${port} 无法监听（${detail}），在「更多设置」里换一个端口。`,
        policyTitle: '「所有工具」没有生效',
        policyBody: '插件依赖被装成了两份。重新安装插件即可修复。',
        lastErrorTitle: '上次操作没有成功',
        unreachableTitle: '读不到插件状态',
        unreachableBody: 'DSH 可能正在重启，几秒后会自动重试。',
        retryNow: '立即重试',
        copyDiagnostics: '复制诊断信息',
        copied: '已复制',
        dismiss: '知道了',
        more: '更多设置',
        addressTitle: '代理地址',
        addressAuto: '自动检测',
        addressAutoDesc: '读取系统代理设置，找不到时扫描常用端口。',
        addressManual: '手动填写',
        addressManualDesc: '自动检测找不到，或代理需要账号密码时使用。',
        addressPlaceholder: '例如 7890 或 http://127.0.0.1:7890',
        addressHelp: '只填端口号也可以。在代理客户端设置里找「HTTP 端口」或「混合端口」。',
        addressHelpCreds: '当前地址含账号密码（已隐藏）。修改时请完整填写，包括 user:pass@。',
        addressInvalid: '格式应为 http://地址:端口，例如 http://127.0.0.1:7890',
        saveAddress: '保存并检测',
        saving: '保存中…',
        addressSaved: '代理地址已保存',
        detectOn: '已改为自动检测',
        scopeTitle: '作用范围',
        scopeWebFetch: '仅 web_fetch',
        scopeWebFetchDesc: '只影响 web_fetch，其它功能保持原样。',
        scopeGlobal: '所有工具',
        scopeGlobalDesc: '插件、命令行工具等所有联网请求都按上面的线路走。',
        scopeSaved: (label) => `作用范围已改为「${label}」`,
        portLabel: '本地端口',
        portHelp: '其它程序从这个端口接入，一般不用改。',
        portInvalid: '请输入 1024–65535 之间的整数',
        savePort: '保存',
        portSaved: '本地端口已保存',
        placementTitle: '按钮位置',
        placeSidebar: '侧栏底部',
        placeHeader: '对话顶栏',
        placeHidden: '不显示',
        placeHelp: {
          sidebar: '在左侧栏底部，和其它插件按钮排在一起。',
          header: '在对话标题栏右侧。侧栏拥挤或常收起时选这个。',
          hidden: '不显示按钮。随时可以在「插件 → 代理开关」页面里设置。',
        },
        placementSaved: '按钮位置已更新',
        stats: (requests, failures) => `本次启动后经插件发出 ${requests} 次请求，失败 ${failures} 次`,
        tipFor: (route, status) => `代理开关：${route}，${status}。点击调整`,
        tipOk: '状态正常',
        tipWarn: '需要处理',
        tipError: '出现问题',
        tipIdle: '正在检测',
        tipAuto: '自动',
      },
      en: {
        name: 'Proxy Switch',
        sep: ', ',
        close: 'Close',
        loading: 'Reading the state…',
        heroForward: 'Going through the proxy',
        heroDirect: 'Going direct',
        subAutoOnline: 'Auto: your proxy app is running',
        subAutoOffline: 'Auto: no usable proxy',
        subAutoChecking: 'Auto: checking for a proxy app…',
        subPinnedForward: 'Pinned to the proxy',
        subPinnedDirect: 'Pinned to direct',
        scopeChipWebFetch: 'web_fetch only',
        scopeChipGlobal: 'All tools',
        scopeChipTip: (desc) => `Applies to: ${desc} Click to change`,
        nodeApp: 'DeepSeek',
        nodeProxy: 'Proxy',
        nodeWeb: 'Web',
        modeLabel: 'Route',
        modeAuto: 'Auto',
        modeForward: 'Proxy',
        modeDirect: 'Direct',
        recommended: 'Best',
        hintAuto: 'Uses the proxy while it runs, goes direct when it does not. Right for most people.',
        hintForward: 'Always through the proxy. Web fetches fail once the proxy is off.',
        hintDirect: 'Always direct. Some sites are refused while the proxy is on.',
        switched: (label) => `Route set to ${label}`,
        proxyLabel: 'Proxy',
        proxyNone: 'No usable proxy port found',
        proxySearching: 'Looking for a proxy app…',
        sourceSystem: 'system proxy',
        sourceEnvironment: 'environment',
        sourceScan: 'port scan',
        sourceManual: 'manual',
        online: 'online',
        offline: 'not running',
        checking: 'checking',
        ms: (value) => `${value} ms`,
        recheck: 'Check again',
        findAgain: 'Search again',
        warnDirectTitle: 'Your proxy app is running',
        warnDirectBody: 'Pinned to direct, some sites resolve to internal addresses and are refused.',
        warnForwardTitle: 'Cannot reach your proxy app',
        warnForwardBody: 'Pinned to the proxy, web fetches fail. Start the proxy app, or switch to Auto.',
        useAuto: 'Switch to Auto',
        autoNotFoundTitle: 'Proxy port not found',
        autoNotFoundBody: 'A proxy app seems to be running, but its HTTP port was not found, so fetches go direct and some are refused.',
        enterManually: 'Enter the address',
        needsAuthTitle: 'The proxy needs a username and password',
        needsAuthBody: 'A proxy was found, but it asks for credentials. Enter the address with user:pass manually.',
        blockedTitle: 'The switch has no effect right now',
        blockedBody: 'The DSH config assigns web_fetch to another provider, so the plugin cannot take over.',
        providerErrorTitle: 'Could not take over web_fetch',
        pendingTitle: 'Waiting for the DSH web service to start…',
        listenErrorTitle: 'Local port unavailable',
        listenErrorBody: (port, detail) => `Port ${port} cannot be opened (${detail}). Pick another port under More settings.`,
        policyTitle: '"All tools" is not in effect',
        policyBody: 'The plugin dependencies were installed twice. Reinstall the plugin to fix it.',
        lastErrorTitle: 'The last action failed',
        unreachableTitle: 'Cannot read the plugin state',
        unreachableBody: 'DSH may be restarting. Retrying automatically in a few seconds.',
        retryNow: 'Retry now',
        copyDiagnostics: 'Copy diagnostics',
        copied: 'Copied',
        dismiss: 'Dismiss',
        more: 'More settings',
        addressTitle: 'Proxy address',
        addressAuto: 'Detect automatically',
        addressAutoDesc: 'Reads the system proxy settings, then scans common ports.',
        addressManual: 'Enter manually',
        addressManualDesc: 'When detection finds nothing, or the proxy needs a password.',
        addressPlaceholder: 'e.g. 7890 or http://127.0.0.1:7890',
        addressHelp: 'A port number alone works. Look for the "HTTP port" or "mixed port" in your proxy app.',
        addressHelpCreds: 'The current address has a username and password (hidden). Enter the full address, including user:pass@.',
        addressInvalid: 'Use http://host:port, for example http://127.0.0.1:7890',
        saveAddress: 'Save and check',
        saving: 'Saving…',
        addressSaved: 'Proxy address saved',
        detectOn: 'Detecting automatically',
        scopeTitle: 'Applies to',
        scopeWebFetch: 'web_fetch only',
        scopeWebFetchDesc: 'Only web_fetch follows the route. Everything else stays as is.',
        scopeGlobal: 'All tools',
        scopeGlobalDesc: 'Every outbound request, including plugins and command-line tools, follows the route above.',
        scopeSaved: (label) => `Now applies to: ${label}`,
        portLabel: 'Local port',
        portHelp: 'Other programs connect through this port. Usually leave it.',
        portInvalid: 'Enter a whole number from 1024 to 65535',
        savePort: 'Save',
        portSaved: 'Local port saved',
        placementTitle: 'Button location',
        placeSidebar: 'Sidebar',
        placeHeader: 'Chat header',
        placeHidden: 'Hidden',
        placeHelp: {
          sidebar: 'At the bottom of the left sidebar, next to other plugin buttons.',
          header: 'On the right of the chat title bar. Good when the sidebar is crowded or collapsed.',
          hidden: 'No button. Open Plugins → Proxy Switch any time to change settings.',
        },
        placementSaved: 'Button location updated',
        stats: (requests, failures) => `${requests} requests through the plugin since start, ${failures} failed`,
        tipFor: (route, status) => `Proxy Switch: ${route}, ${status}. Click to change`,
        tipOk: 'all good',
        tipWarn: 'needs attention',
        tipError: 'something is wrong',
        tipIdle: 'checking',
        tipAuto: 'auto',
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

    // One stylesheet, injected once: inline styles cannot express hover, focus-visible,
    // keyframes, or reduced-motion. Every class is prefixed `dps-`; every colour comes from
    // a `--dsw-alias-*` token so the light and dark themes follow DSH.
    const STYLE_ID = 'dsh-proxy-switch-style'
    const CSS_BASE = `
.dps-root{--dps-accent:var(--dsw-alias-state-business-primary);--dps-ok:var(--dsw-alias-state-success-primary);--dps-warn:var(--dsw-alias-state-warn-primary);--dps-err:var(--dsw-alias-state-error-primary);--dps-idle:var(--dsw-alias-state-idle-primary);--dps-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent));--dps-fill:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);--dps-ease:cubic-bezier(.2,.8,.2,1);--dps-spring:cubic-bezier(.34,1.4,.64,1);--dps-ring:var(--dsw-focus-ring-color,var(--dps-accent))}
.dps-root *{box-sizing:border-box}
.dps-tone-ok{--dps-tone:var(--dps-ok)}.dps-tone-warn{--dps-tone:var(--dps-warn)}.dps-tone-error{--dps-tone:var(--dps-err)}.dps-tone-idle{--dps-tone:var(--dps-idle)}.dps-tone-accent{--dps-tone:var(--dps-accent)}
.dps-badge{display:inline-flex;align-items:center;gap:6px;min-width:0;height:28px;padding:0 9px 0 8px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background-color .15s,border-color .15s,transform .12s var(--dps-ease)}
.dps-badge:hover{background:var(--dps-hover)}
.dps-badge:active{transform:scale(.96)}
.dps-badge[aria-expanded=true]{border-color:var(--dps-accent);background:color-mix(in srgb,var(--dps-accent) 10%,transparent)}
.dps-badge[data-compact]{padding:0 8px;gap:5px}
.dps-badge-icon{display:flex;color:var(--dsw-alias-label-secondary)}
[class*="footerActions"]:has(.dps-row){flex-wrap:wrap}
[class*="_collapsed"] [class*="footerActions"]:has(.dps-row){flex-direction:column;align-items:center}
.dps-row{display:flex;align-items:center;gap:8px;flex:1 0 calc(100% + 4px);width:calc(100% + 4px);min-width:0;height:42px;margin:2px -2px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;transition:background-color .15s}
.dps-row:hover,.dps-row[aria-expanded=true]{background:var(--dps-hover)}
.dps-row-icon{display:flex;flex:0 0 auto}
.dps-row-label{flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dps-row-state{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dps-row[data-rail]{position:relative;flex:0 0 36px;width:36px;height:36px;margin:4px 0;padding:0;justify-content:center;border-radius:50%}
.dps-row[data-rail] .dps-dot{position:absolute;right:6px;top:6px}
.dps-badge-text{white-space:nowrap;font-weight:500}
.dps-badge-text[data-swap]{animation:dps-swap .28s var(--dps-ease)}
.dps-dot{position:relative;width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dps-tone);transition:background-color .3s}
.dps-dot[data-pulse]::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1.5px solid var(--dps-tone);animation:dps-ring 1.6s var(--dps-ease) infinite}
.dps-panel{position:fixed;z-index:9000;width:336px;display:flex;flex-direction:column;overflow:hidden;outline:none;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08),0 18px 44px -10px rgba(0,0,0,.3);font-size:12.5px;line-height:1.45;animation:dps-pop-in .22s var(--dps-ease)}
.dps-panel[data-from=bottom]{transform-origin:20px 100%}
.dps-panel[data-from=top]{transform-origin:calc(100% - 20px) 0;animation-name:dps-drop-in}
.dps-panel[data-closing]{animation:dps-pop-out .14s ease-in forwards}
.dps-page{max-width:520px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dps-body{display:flex;flex-direction:column;gap:12px}
.dps-panel .dps-body{overflow-y:auto;padding:12px 12px 10px}
.dps-head{display:flex;align-items:center;gap:7px;padding:0 2px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dps-head-name{flex:1;font-weight:500}
.dps-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:0 0 auto;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s,color .15s,transform .12s}
.dps-icon-btn:hover{background:var(--dps-hover);color:var(--dsw-alias-label-primary)}
.dps-icon-btn:active{transform:scale(.92)}
.dps-icon-btn:disabled{opacity:.5;cursor:default}
.dps-icon-btn[data-busy] svg{animation:dps-spin .8s linear infinite}
.dps-hero{position:relative;padding:14px 14px 12px;border-radius:14px;background:color-mix(in srgb,var(--dps-tone) 9%,var(--dsw-alias-bg-layer-2));border:1px solid color-mix(in srgb,var(--dps-tone) 24%,transparent);transition:background-color .35s,border-color .35s}
.dps-hero-top{display:flex;align-items:flex-start;gap:8px}
.dps-hero-top .dps-hero-title{flex:1;min-width:0}
.dps-scope-chip{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;height:22px;margin-top:1px;padding:0 8px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,color .15s,border-color .15s}
.dps-scope-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.dps-scope-chip[data-global]{color:var(--dps-warn);border-color:color-mix(in srgb,var(--dps-warn) 45%,transparent)}
.dps-hero-title{font-size:19px;font-weight:650;letter-spacing:-.02em;line-height:1.25}
.dps-hero-title[data-swap]{animation:dps-swap .32s var(--dps-ease)}
.dps-hero-sub{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dps-track{display:flex;align-items:flex-start;margin-top:14px}
.dps-stop{display:flex;flex-direction:column;align-items:center;gap:5px;flex:0 0 auto;width:58px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dps-stop-icon{position:relative;width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.05);transition:border-color .3s,color .3s}
.dps-stop-icon .dps-dot{position:absolute;right:-2px;top:-2px;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2)}
.dps-stop-proxy{overflow:hidden;transition:width .4s var(--dps-ease),opacity .25s,transform .4s var(--dps-ease)}
.dps-track[data-route=direct] .dps-stop-proxy{width:0;opacity:0;transform:scale(.6)}
.dps-track[data-route=forward] .dps-stop-proxy .dps-stop-icon{border-color:color-mix(in srgb,var(--dps-tone) 55%,transparent);color:var(--dps-tone)}
.dps-wire{flex:1;min-width:10px;height:2px;margin-top:17px;color:var(--dps-tone);background-image:linear-gradient(90deg,currentColor 55%,transparent 55%);background-size:8px 2px;animation:dps-flow .55s linear infinite;transition:color .3s}
.dps-track[data-broken] .dps-wire{color:var(--dps-err);animation:none;opacity:.75;background-size:5px 2px}
.dps-track[data-idle] .dps-wire{animation:none;opacity:.5}
.dps-seg{position:relative;display:grid;grid-template-columns:repeat(3,1fr);padding:3px;border-radius:11px;background:var(--dps-fill);border:1px solid var(--dsw-alias-border-l1)}
.dps-seg-thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px) / 3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 1px 3px rgba(0,0,0,.1);transition:transform .32s var(--dps-spring)}
.dps-seg-btn{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 6px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:color .2s}
.dps-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.dps-seg-btn[aria-checked=true]{color:var(--dsw-alias-label-primary);font-weight:600}
.dps-seg-btn[data-pending]::after{content:"";width:10px;height:10px;border-radius:50%;border:1.5px solid var(--dps-accent);border-right-color:transparent;animation:dps-spin .7s linear infinite}
.dps-seg-tag{padding:1px 5px;border-radius:6px;font-size:10px;font-weight:600;color:var(--dps-accent);background:color-mix(in srgb,var(--dps-accent) 13%,transparent)}
.dps-hint{margin-top:-4px;padding:0 4px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dps-hint[data-swap]{animation:dps-fade .3s var(--dps-ease)}
`
    const CSS_PARTS = `
.dps-proxy{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 4px 0 6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dps-proxy-main{flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow:hidden}
.dps-proxy-main>:not(.dps-proxy-meta){flex:0 0 auto;white-space:nowrap}
.dps-addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dps-proxy-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dps-banner{display:flex;gap:9px;padding:10px 11px;border-radius:12px;border:1px solid color-mix(in srgb,var(--dps-tone) 40%,transparent);background:color-mix(in srgb,var(--dps-tone) 10%,transparent);animation:dps-drop .26s var(--dps-ease)}
.dps-banner-icon{display:flex;color:var(--dps-tone);margin-top:1px}
.dps-banner-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dps-banner-title{font-weight:600}
.dps-banner-text{color:var(--dsw-alias-label-secondary);font-size:11.5px;word-break:break-word}
.dps-banner-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dps-btn{height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:background-color .15s,transform .12s,opacity .15s}
.dps-btn:hover{background:var(--dps-hover)}
.dps-btn:active{transform:scale(.97)}
.dps-btn:disabled{opacity:.55;cursor:default;transform:none}
.dps-btn-primary{border-color:transparent;background:var(--dps-accent);color:var(--dsw-alias-label-primary-foreground)}
.dps-btn-primary:hover{background:color-mix(in srgb,var(--dps-accent) 86%,var(--dsw-alias-label-primary))}
.dps-link{border:0;background:transparent;padding:3px 6px;border-radius:6px;color:var(--dps-accent);font:inherit;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;transition:background-color .15s}
.dps-link:hover{background:color-mix(in srgb,var(--dps-accent) 12%,transparent)}
.dps-link:disabled{opacity:.5;cursor:default}
.dps-collapse{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .26s var(--dps-ease),opacity .2s}
.dps-collapse[data-open]{grid-template-rows:1fr;opacity:1}
.dps-collapse>div{overflow:hidden;min-height:0;visibility:hidden;transition:visibility 0s .26s}
.dps-collapse[data-open]>div{visibility:visible;transition:visibility 0s}
.dps-collapse:not([data-open]) .dps-collapse>div{visibility:hidden}
.dps-more{margin:0 -12px;padding:0 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dps-more-toggle{display:flex;align-items:center;gap:6px;width:100%;height:34px;padding:0 4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:color .15s}
.dps-more-toggle:hover{color:var(--dsw-alias-label-primary)}
.dps-chevron{display:flex;transition:transform .24s var(--dps-ease)}
.dps-more-toggle[aria-expanded=true] .dps-chevron{transform:rotate(90deg)}
.dps-more-body{display:flex;flex-direction:column;gap:14px;padding:2px 2px 6px}
.dps-group-title{display:block;margin-bottom:6px;font-size:12px;font-weight:600}
.dps-options{display:flex;flex-direction:column;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);overflow:hidden}
.dps-option{display:flex;gap:9px;width:100%;padding:9px 11px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .15s}
.dps-option+.dps-option,.dps-option+.dps-collapse{border-top:1px solid var(--dsw-alias-border-l1)}
.dps-option:hover{background:var(--dps-hover)}
.dps-option-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dps-option-title{font-weight:500}
.dps-option-desc{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dps-radio{position:relative;width:14px;height:14px;margin-top:2px;flex:0 0 auto;border-radius:50%;border:1.5px solid var(--dsw-alias-label-tertiary);transition:border-color .2s}
.dps-radio::after{content:"";position:absolute;inset:2.5px;border-radius:50%;background:var(--dps-accent);transform:scale(0);transition:transform .25s var(--dps-spring)}
.dps-option[aria-checked=true] .dps-radio{border-color:var(--dps-accent)}
.dps-option[aria-checked=true] .dps-radio::after{transform:scale(1)}
.dps-option[data-pending] .dps-radio{border-color:var(--dps-accent);border-right-color:transparent;animation:dps-spin .7s linear infinite}
.dps-editor{display:flex;flex-direction:column;gap:7px;padding:2px 11px 11px 34px}
.dps-input-row{display:flex;gap:6px}
.dps-input{flex:1;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;outline:none;transition:border-color .15s,box-shadow .15s}
.dps-input::placeholder{color:var(--dsw-alias-label-tertiary);font-family:inherit}
.dps-input:focus{border-color:var(--dps-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dps-accent) 22%,transparent)}
.dps-input[aria-invalid=true]{border-color:var(--dps-err);box-shadow:0 0 0 3px color-mix(in srgb,var(--dps-err) 18%,transparent)}
.dps-input[data-shake]{animation:dps-shake .32s}
.dps-input-port{flex:0 0 110px}
.dps-help{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dps-help[data-error]{color:var(--dps-err)}
.dps-place{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.dps-place-btn{display:flex;flex-direction:column;align-items:center;gap:6px;padding:9px 4px 8px;border-radius:10px;border:1.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;transition:border-color .2s,color .2s,background-color .2s}
.dps-place-btn:hover{background:var(--dps-hover)}
.dps-place-btn[aria-checked=true]{border-color:var(--dps-accent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dps-accent) 7%,transparent)}
.dps-mini{position:relative;width:46px;height:30px;border-radius:5px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);overflow:hidden}
.dps-mini::before{content:"";position:absolute;left:0;top:0;bottom:0;width:13px;background:var(--dps-fill);border-right:1px solid var(--dsw-alias-border-l2)}
.dps-mini::after{content:"";position:absolute;left:15px;right:0;top:0;height:6px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dps-mini i{position:absolute;width:7px;height:4px;border-radius:2px;background:var(--dps-accent);z-index:1}
.dps-mini[data-place=sidebar] i{left:3px;bottom:3px}
.dps-mini[data-place=header] i{right:3px;top:1px}
.dps-mini[data-place=hidden] i{display:none}
.dps-foot{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dps-spacer{flex:1}
.dps-toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;max-width:calc(100% - 28px);padding:6px 11px;border-radius:16px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2);font-size:12px;font-weight:500;white-space:nowrap;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.2);animation:dps-toast 2.2s var(--dps-ease) forwards}
.dps-toast[data-tone=error]{background:var(--dps-err);color:var(--dsw-alias-label-primary-foreground);white-space:normal;text-align:left}
.dps-page .dps-toast{position:fixed;bottom:24px}
.dps-root :focus-visible{outline:2px solid var(--dps-ring);outline-offset:2px}
.dps-root .dps-input:focus-visible{outline:none}
@keyframes dps-pop-in{from{opacity:0;transform:translateY(8px) scale(.96)}}
@keyframes dps-drop-in{from{opacity:0;transform:translateY(-8px) scale(.96)}}
@keyframes dps-pop-out{to{opacity:0;transform:scale(.97)}}
@keyframes dps-ring{0%{opacity:.7;transform:scale(.6)}100%{opacity:0;transform:scale(1.7)}}
@keyframes dps-spin{to{transform:rotate(360deg)}}
@keyframes dps-flow{to{background-position:8px 0}}
@keyframes dps-drop{from{opacity:0;transform:translateY(-4px)}}
@keyframes dps-fade{from{opacity:0}}
@keyframes dps-swap{from{opacity:0;transform:translateY(5px)}}
@keyframes dps-shake{20%,60%{transform:translateX(-4px)}40%,80%{transform:translateX(4px)}}
@keyframes dps-toast{0%{opacity:0;transform:translate(-50%,8px)}10%,85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,4px)}}
@media (prefers-reduced-motion:reduce){.dps-root *,.dps-root *::before,.dps-root *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`

    function ensureStyle() {
      if (typeof document !== 'object' || document === null) return
      if (document.getElementById(STYLE_ID) !== null) return
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS_BASE + CSS_PARTS
      document.head.appendChild(element)
    }

    // 16px line icons, stroke = currentColor.
    const ICON_PATHS = {
      route: ['M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M19 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M7 16h4a3 3 0 0 0 3-3v-2a3 3 0 0 1 3-3'],
      auto: ['M4 12a8 8 0 0 1 13.7-5.6L20 8.5', 'M20 4v4.5h-4.5', 'M20 12a8 8 0 0 1-13.7 5.6L4 15.5', 'M4 20v-4.5h4.5'],
      app: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-1-2Z'],
      proxy: ['M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z'],
      web: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3.5 9h17M3.5 15h17', 'M12 3c2.5 2.6 3.5 5.6 3.5 9s-1 6.4-3.5 9c-2.5-2.6-3.5-5.6-3.5-9s1-6.4 3.5-9Z'],
      refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
      close: ['M6 6l12 12M18 6 6 18'],
      chevron: ['M9 6l6 6-6 6'],
      alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
      info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5', 'M12 8h.01'],
      check: ['M5 12.5 10 17l9-10'],
      copy: ['M9 9h10v10H9Z', 'M5 15V5h10'],
      tools: ['M4 4h7v7H4Z', 'M13 4h7v7h-7Z', 'M4 13h7v7H4Z', 'M13 13h7v7h-7Z'],
    }

    function Icon({ name, size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        ...(ICON_PATHS[name] ?? []).map((d) => h('path', { key: d, d })),
      )
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

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /**
     * One poller shared by every mounted view (sidebar pill, header pill, plugin page), so
     * two places never disagree and the Host is not polled twice. It polls only while
     * something is subscribed, faster while a panel is open, and runs one command at a time.
     */
    function createHostStore() {
      let snapshot = { state: null, error: null, pending: null }
      const listeners = new Set()
      let timer = null
      let fast = 0
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const set = (patch) => {
        snapshot = { ...snapshot, ...patch }
        emit()
      }
      const refresh = async () => {
        try {
          set({ state: await requestState(), error: null })
        } catch (caught) {
          set({ error: String(caught?.message ?? caught) })
        }
      }
      const schedule = () => {
        clearTimeout(timer)
        if (listeners.size === 0) return
        timer = setTimeout(async () => {
          await refresh()
          schedule()
        }, fast > 0 ? 1500 : 4000)
        // Node (tests) must not stay alive for a poll; browsers return a number here.
        timer?.unref?.()
      }
      return {
        get: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            void refresh()
            schedule()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) clearTimeout(timer)
          }
        },
        holdFast() {
          fast += 1
          schedule()
          return () => {
            fast -= 1
            schedule()
          }
        },
        refresh,
        /** Run one Host command; resolves `{ ok }` or `{ ok: false, error }`. */
        async run(kind, value, task) {
          if (snapshot.pending !== null) return { ok: false, busy: true }
          set({ pending: { kind, value } })
          try {
            const next = await task()
            set({ state: next ?? snapshot.state, error: null, pending: null })
            return { ok: true }
          } catch (caught) {
            set({ pending: null })
            return { ok: false, error: String(caught?.message ?? caught) }
          }
        },
      }
    }

    /** Where the pill lives; a per-machine UI preference, so it stays in the browser. */
    function createPlacementStore() {
      const listeners = new Set()
      const read = () => {
        try {
          const value = globalThis.localStorage?.getItem(PLACEMENT_KEY)
          return PLACEMENTS.includes(value) ? value : 'sidebar'
        } catch {
          return 'sidebar'
        }
      }
      let value = read()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      if (typeof window === 'object' && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', (event) => {
          if (event.key !== PLACEMENT_KEY) return
          value = read()
          emit()
        })
      }
      return {
        get: () => value,
        set(next) {
          if (!PLACEMENTS.includes(next)) return
          value = next
          try {
            globalThis.localStorage?.setItem(PLACEMENT_KEY, next)
          } catch {
            /* private mode: the choice lasts for this page only */
          }
          emit()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useStore(store) {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((value) => value + 1)), [store])
      return store.get()
    }

    /**
     * Forgive the common shorthands: a bare port means the local proxy app, and a missing
     * scheme means http:// (the only scheme the Host accepts).
     */
    function normalizeUpstream(value) {
      const text = value.trim()
      if (text !== '' && [...text].every((char) => char >= '0' && char <= '9')) return `http://127.0.0.1:${text}`
      if (text !== '' && !text.includes('://')) return `http://${text}`
      return text
    }

    /** Mirrors the Host's `parseUpstream` closely enough to catch typos before a round trip. */
    function isUpstreamLike(value) {
      const text = normalizeUpstream(value)
      if (!text.toLowerCase().startsWith('http://')) return false
      let url
      try {
        url = new URL(text)
      } catch {
        return false
      }
      if (url.protocol !== 'http:' || url.hostname === '' || url.port === '') return false
      return (url.pathname === '/' || url.pathname === '') && url.search === '' && url.hash === ''
    }

    function isPort(value) {
      const port = Number(value)
      return String(value).trim() !== '' && Number.isInteger(port) && port >= 1024 && port <= 65535
    }

    function policyBroken(state) {
      return state?.scope === 'global' && state.policySelfCheck !== null && state.policySelfCheck !== void 0 && state.policySelfCheck.ok !== true
    }

    /** The route a request takes now; older Hosts without `effectiveMode` report `mode`. */
    function routeOf(state) {
      if (state?.effectiveMode === 'forward' || state?.effectiveMode === 'direct') return state.effectiveMode
      return state?.mode === 'forward' ? 'forward' : 'direct'
    }

    /** One health tone for the pill dot and the hero: ok / warn / error / idle. */
    function toneOf(state, error) {
      if (error !== null) return 'error'
      if (state === null) return 'idle'
      const provider = state.provider?.status
      if (provider === 'blocked' || provider === 'error') return 'error'
      if (state.scope === 'global' && state.listenError) return 'error'
      if (policyBroken(state)) return 'error'
      if (state.warning) return state.warning.severity === 'error' ? 'error' : 'warn'
      if (state.detection?.needsAuth === true && state.upstreamSource === 'auto') return 'warn'
      if (provider === 'pending' || state.probe?.reachable === null || state.probe?.reachable === void 0) return 'idle'
      return 'ok'
    }

    /**
     * The single banner worth showing, most severe first. Each one says what happened and
     * offers the fix as a button, so the user never translates a code into an action.
     * Actions: [id, label, primary].
     */
    function bannerOf(state, error, t, dismissed) {
      if (error !== null) {
        return { key: 'unreachable', tone: 'error', title: t.unreachableTitle, body: t.unreachableBody, actions: [['retry', t.retryNow, true]] }
      }
      if (state === null) return null
      const provider = state.provider ?? {}
      if (provider.status === 'blocked') {
        return { key: 'blocked', tone: 'error', title: t.blockedTitle, body: t.blockedBody, actions: [['copy', t.copyDiagnostics, false]] }
      }
      if (provider.status === 'error') {
        return { key: 'provider', tone: 'error', title: t.providerErrorTitle, body: provider.error ? String(provider.error) : null, actions: [['copy', t.copyDiagnostics, false]] }
      }
      if (state.scope === 'global' && state.listenError) {
        return { key: 'listen', tone: 'error', title: t.listenErrorTitle, body: t.listenErrorBody(state.listenPort, state.listenError), actions: [['port', t.more, true]] }
      }
      if (policyBroken(state)) {
        return { key: 'policy', tone: 'error', title: t.policyTitle, body: t.policyBody, actions: [['copy', t.copyDiagnostics, false]] }
      }
      const code = state.warning?.code
      if (code === 'FORWARD_WITHOUT_UPSTREAM') {
        return { key: 'fwd', tone: 'error', title: t.warnForwardTitle, body: t.warnForwardBody, actions: [['auto', t.useAuto, true], ['probe', t.recheck, false]] }
      }
      if (code === 'DIRECT_WITH_UPSTREAM') {
        return { key: 'dir', tone: 'warn', title: t.warnDirectTitle, body: t.warnDirectBody, actions: [['auto', t.useAuto, true]] }
      }
      if (code === 'AUTO_PROXY_NOT_FOUND') {
        return { key: 'auto-missing', tone: 'warn', title: t.autoNotFoundTitle, body: t.autoNotFoundBody, actions: [['manual', t.enterManually, true], ['detect', t.findAgain, false]] }
      }
      if (state.detection?.needsAuth === true && state.upstreamSource === 'auto') {
        return { key: 'auth', tone: 'warn', title: t.needsAuthTitle, body: t.needsAuthBody, actions: [['manual', t.enterManually, true]] }
      }
      if (provider.status === 'pending') return { key: 'pending', tone: 'idle', title: t.pendingTitle, body: null, actions: [] }
      if (state.lastError && state.lastError !== dismissed) {
        return { key: 'last', tone: 'warn', title: t.lastErrorTitle, body: String(state.lastError), actions: [['dismiss', t.dismiss, false]] }
      }
      return null
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      }
    }

    const flag = (condition) => (condition ? '' : void 0)

    function createViews(ctx, host, placementStore) {
      const getLocaleSnapshot = () => {
        try {
          return ctx.get('locale')?.getSnapshot?.()
        } catch {
          return void 0
        }
      }

      function useLocale() {
        const [locale, setLocale] = useState(() => readLocaleId(getLocaleSnapshot))
        useEffect(() => {
          const dispose = ctx.on('locale/change', () => setLocale(readLocaleId(getLocaleSnapshot)))
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }, [])
        return locale
      }

      /** The panel content, shared by the popover and the plugin page. */
      function PanelBody({ t, variant, onClose }) {
        const { state, error, pending } = useStore(host)
        const placement = useStore(placementStore)
        const page = variant === 'page'
        const [toast, setToast] = useState(null)
        const [dismissed, setDismissed] = useState(null)
        const [copied, setCopied] = useState(false)
        const [moreOpen, setMoreOpen] = useState(page)
        const [sourceView, setSourceView] = useState(null)
        const [draft, setDraft] = useState('')
        const [draftError, setDraftError] = useState(null)
        const [shake, setShake] = useState(false)
        const [portDraft, setPortDraft] = useState(null)
        const [portError, setPortError] = useState(null)
        const alive = useRef(true)
        const toastTimer = useRef(null)
        const inputRef = useRef(null)
        const portRef = useRef(null)
        const scopeRef = useRef(null)

        useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
            clearTimeout(toastTimer.current)
          }
        }, [])

        const showToast = useCallback((text, tone = 'ok') => {
          clearTimeout(toastTimer.current)
          setToast({ id: Date.now(), text, tone })
          toastTimer.current = setTimeout(() => {
            if (alive.current) setToast(null)
          }, 2200)
        }, [])

        /** Run a Host command and turn the outcome into a toast. */
        const act = useCallback(
          async (kind, value, task, success) => {
            const result = await host.run(kind, value, task)
            if (!alive.current) return result.ok
            if (result.ok && success) showToast(success)
            if (!result.ok && !result.busy) showToast(result.error, 'error')
            return result.ok
          },
          [showToast],
        )

        const modeLabel = (mode) => (mode === 'auto' ? t.modeAuto : mode === 'forward' ? t.modeForward : t.modeDirect)
        const setMode = (mode) => {
          if (state?.mode === mode) return
          void act('mode', mode, () => post('/mode', { mode }), t.switched(modeLabel(mode)))
        }
        const recheck = () => void act('probe', null, async () => (await Promise.all([post('/probe'), delay(450)]))[0])
        const detect = () => void act('detect', null, async () => (await Promise.all([post('/detect'), delay(450)]))[0])

        const effectiveSource = sourceView ?? state?.upstreamSource ?? 'auto'
        const openManual = () => {
          setMoreOpen(true)
          setSourceView('manual')
          setDraft(state?.upstreamHasCredentials === true || state?.upstreamSource !== 'manual' ? '' : state?.upstream ?? '')
          setDraftError(null)
          setTimeout(() => inputRef.current?.focus?.(), 280)
        }
        const chooseAutoSource = async () => {
          setSourceView(null)
          if (state?.upstreamSource === 'auto') return
          await act('source', 'auto', () => post('/settings', { upstreamSource: 'auto' }), t.detectOn)
        }
        const saveAddress = async () => {
          const upstream = normalizeUpstream(draft)
          if (!isUpstreamLike(upstream)) {
            setDraftError(t.addressInvalid)
            setShake(true)
            inputRef.current?.focus?.()
            return
          }
          const ok = await act('address', upstream, async () => {
            await post('/settings', { upstream })
            return post('/probe')
          }, t.addressSaved)
          if (ok && alive.current) setSourceView(null)
        }
        const changeScope = (scope) => {
          if (state?.scope === scope) return
          void act('scope', scope, () => post('/settings', { scope }), t.scopeSaved(scope === 'global' ? t.scopeGlobal : t.scopeWebFetch))
        }
        const savePort = async () => {
          if (!isPort(portDraft)) {
            setPortError(t.portInvalid)
            return
          }
          const ok = await act('port', null, () => post('/settings', { listenPort: Number(portDraft) }), t.portSaved)
          if (ok && alive.current) {
            setPortDraft(null)
            setPortError(null)
          }
        }
        const choosePlacement = (next) => {
          if (placement === next) return
          placementStore.set(next)
          showToast(t.placementSaved)
        }
        const copyDiagnostics = async () => {
          const report = { capturedAt: new Date().toISOString(), clientError: error, placement, state }
          if (await copyText(JSON.stringify(report, null, 2))) {
            setCopied(true)
            setTimeout(() => {
              if (alive.current) setCopied(false)
            }, 1600)
          }
        }
        const action = (id) => {
          if (id === 'auto') setMode('auto')
          else if (id === 'probe') recheck()
          else if (id === 'detect') detect()
          else if (id === 'manual') openManual()
          else if (id === 'retry') void host.refresh()
          else if (id === 'copy') void copyDiagnostics()
          else if (id === 'dismiss') setDismissed(state?.lastError ?? null)
          else if (id === 'scope') {
            setMoreOpen(true)
            setTimeout(() => scopeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 280)
          } else if (id === 'port') {
            setMoreOpen(true)
            setTimeout(() => portRef.current?.focus?.(), 280)
          }
        }

        // ---- derived view ------------------------------------------------------------
        const mode = pending?.kind === 'mode' ? pending.value : state?.mode ?? 'auto'
        const route = pending?.kind === 'mode' && pending.value !== 'auto' ? pending.value : routeOf(state)
        const scope = pending?.kind === 'scope' ? pending.value : state?.scope ?? 'web_fetch_only'
        const tone = toneOf(state, error)
        const reachable = state?.probe?.reachable
        const probing = pending?.kind === 'probe' || pending?.kind === 'address' || (state !== null && (reachable === null || reachable === void 0))
        const detecting = pending?.kind === 'detect' || state?.detection?.status === 'running'
        const banner = bannerOf(state, error, t, dismissed)
        const heroTone = state === null ? 'idle' : tone === 'ok' ? 'accent' : tone
        const proxyTone = probing ? 'idle' : reachable === true ? 'ok' : route === 'forward' ? 'error' : 'idle'

        const heroTitle = state === null ? t.loading : route === 'forward' ? t.heroForward : t.heroDirect
        let heroSub = ''
        if (state !== null) {
          if (mode === 'auto') heroSub = probing ? t.subAutoChecking : reachable === true ? t.subAutoOnline : t.subAutoOffline
          else heroSub = mode === 'forward' ? t.subPinnedForward : t.subPinnedDirect
        }

        const stop = (icon, label, extra) =>
          h(
            'span',
            { className: extra?.className ? `dps-stop ${extra.className}` : 'dps-stop' },
            h('span', { className: 'dps-stop-icon' }, h(Icon, { name: icon, size: 17 }), extra?.dot ? h('span', { className: `dps-dot dps-tone-${extra.dot}` }) : null),
            label,
          )

        const scopeChip = h(
          'button',
          {
            type: 'button',
            className: 'dps-scope-chip',
            'data-global': flag(scope === 'global'),
            title: t.scopeChipTip(scope === 'global' ? t.scopeGlobalDesc : t.scopeWebFetchDesc),
            onClick: () => action('scope'),
          },
          h(Icon, { name: scope === 'global' ? 'tools' : 'web', size: 12 }),
          scope === 'global' ? t.scopeChipGlobal : t.scopeChipWebFetch,
        )

        const hero = h(
          'div',
          { className: `dps-hero dps-tone-${heroTone}` },
          h(
            'div',
            { className: 'dps-hero-top' },
            h('div', { key: heroTitle, className: 'dps-hero-title', 'data-swap': '', 'aria-live': 'polite' }, heroTitle),
            state === null ? null : scopeChip,
          ),
          heroSub ? h('div', { className: 'dps-hero-sub' }, heroSub) : null,
          h(
            'div',
            {
              className: 'dps-track',
              'aria-hidden': true,
              'data-route': route,
              'data-broken': flag(route === 'forward' && reachable === false && !probing),
              'data-idle': flag(state === null),
            },
            stop('app', t.nodeApp),
            h('span', { className: 'dps-wire' }),
            stop('proxy', t.nodeProxy, { className: 'dps-stop-proxy', dot: proxyTone }),
            h('span', { className: 'dps-wire' }),
            stop('web', t.nodeWeb),
          ),
        )

        const bannerNode =
          banner === null
            ? null
            : h(
                'div',
                { key: banner.key, className: `dps-banner dps-tone-${banner.tone}`, role: banner.tone === 'error' ? 'alert' : 'status' },
                h('span', { className: 'dps-banner-icon' }, h(Icon, { name: banner.tone === 'idle' ? 'info' : 'alert' })),
                h(
                  'div',
                  { className: 'dps-banner-body' },
                  h('div', { className: 'dps-banner-title' }, banner.title),
                  banner.body ? h('div', { className: 'dps-banner-text' }, banner.body) : null,
                  banner.actions.length > 0
                    ? h(
                        'div',
                        { className: 'dps-banner-actions' },
                        banner.actions.map(([id, label, primary]) =>
                          h(
                            'button',
                            { key: id, type: 'button', className: primary ? 'dps-btn dps-btn-primary' : 'dps-btn', disabled: pending !== null, onClick: () => action(id) },
                            id === 'copy' && copied ? t.copied : label,
                          ),
                        ),
                      )
                    : null,
                ),
              )

        const modeIndex = ['auto', 'forward', 'direct'].indexOf(mode)
        const segment = h(
          'div',
          { className: 'dps-seg', role: 'radiogroup', 'aria-label': t.modeLabel },
          h('span', { className: 'dps-seg-thumb', 'aria-hidden': true, style: { transform: `translateX(${Math.max(0, modeIndex) * 100}%)` } }),
          ['auto', 'forward', 'direct'].map((candidate, index) =>
            h(
              'button',
              {
                key: candidate,
                type: 'button',
                role: 'radio',
                className: 'dps-seg-btn',
                'aria-checked': mode === candidate,
                'data-pending': flag(pending?.kind === 'mode' && pending.value === candidate),
                tabIndex: mode === candidate ? 0 : -1,
                onClick: () => setMode(candidate),
                onKeyDown: (event) => {
                  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
                  if (step === 0) return
                  event.preventDefault()
                  const next = ['auto', 'forward', 'direct'][(index + step + 3) % 3]
                  event.currentTarget.parentElement?.querySelectorAll('[role=radio]')[(index + step + 3) % 3]?.focus()
                  setMode(next)
                },
              },
              modeLabel(candidate),
              candidate === 'auto' ? h('span', { className: 'dps-seg-tag' }, t.recommended) : null,
            ),
          ),
        )
        const hintText = mode === 'auto' ? t.hintAuto : mode === 'forward' ? t.hintForward : t.hintDirect
        const hint = h('div', { key: mode, className: 'dps-hint', 'data-swap': '' }, hintText)

        const sourceLabel =
          state?.upstreamSource === 'manual'
            ? t.sourceManual
            : { system: t.sourceSystem, environment: t.sourceEnvironment, scan: t.sourceScan }[state?.detection?.source] ?? ''
        let proxyRow
        if (state !== null && detecting && reachable !== true) {
          proxyRow = h('div', { className: 'dps-proxy-main' }, h('span', { className: 'dps-dot dps-tone-idle', 'data-pulse': '' }), t.proxySearching)
        } else if (state?.upstreamSource === 'auto' && reachable === false && state?.detection?.status === 'none') {
          proxyRow = h('div', { className: 'dps-proxy-main' }, h('span', { className: 'dps-dot dps-tone-idle' }), t.proxyNone)
        } else {
          const address = String(state?.upstream ?? '—').replace(/^http:\/\//u, '')
          const status = probing ? t.checking : reachable === true ? (typeof state?.probe?.latencyMs === 'number' ? t.ms(state.probe.latencyMs) : t.online) : t.offline
          proxyRow = h(
            'div',
            { className: 'dps-proxy-main', title: [state?.upstream, sourceLabel].filter(Boolean).join(' · ') },
            h('span', { className: `dps-dot dps-tone-${proxyTone}`, 'data-pulse': flag(probing) }),
            h('span', null, t.proxyLabel),
            h('span', { className: 'dps-addr' }, address),
            h('span', { className: 'dps-proxy-meta' }, [sourceLabel, status].filter(Boolean).join(t.sep)),
          )
        }
        const lookAgain = state?.upstreamSource === 'auto' && reachable !== true
        const proxy = h(
          'div',
          { className: 'dps-proxy' },
          proxyRow,
          h(
            'button',
            {
              type: 'button',
              className: 'dps-icon-btn',
              title: lookAgain ? t.findAgain : t.recheck,
              'aria-label': lookAgain ? t.findAgain : t.recheck,
              'data-busy': flag(pending?.kind === 'probe' || pending?.kind === 'detect'),
              disabled: pending !== null || state === null,
              onClick: lookAgain ? detect : recheck,
            },
            h(Icon, { name: 'refresh', size: 15 }),
          ),
        )

        const option = ({ key, checked, pendingFlag, title, desc, onClick }) =>
          h(
            'button',
            { key, type: 'button', role: 'radio', className: 'dps-option', 'aria-checked': checked, 'data-pending': flag(pendingFlag), onClick },
            h('span', { className: 'dps-radio', 'aria-hidden': true }),
            h('span', { className: 'dps-option-body' }, h('span', { className: 'dps-option-title' }, title), h('span', { className: 'dps-option-desc' }, desc)),
          )

        const hasCredentials = state?.upstreamHasCredentials === true
        const addressGroup = h(
          'div',
          null,
          h('div', { className: 'dps-group-title' }, t.addressTitle),
          h(
            'div',
            { className: 'dps-options', role: 'radiogroup', 'aria-label': t.addressTitle },
            option({ key: 'auto', checked: effectiveSource === 'auto', pendingFlag: pending?.kind === 'source', title: t.addressAuto, desc: t.addressAutoDesc, onClick: () => void chooseAutoSource() }),
            option({ key: 'manual', checked: effectiveSource === 'manual', title: t.addressManual, desc: t.addressManualDesc, onClick: openManual }),
            h(
              'div',
              { className: 'dps-collapse', 'data-open': flag(effectiveSource === 'manual') },
              h(
                'div',
                null,
                h(
                  'div',
                  { className: 'dps-editor' },
                  h(
                    'div',
                    { className: 'dps-input-row' },
                    h('input', {
                      ref: inputRef,
                      className: 'dps-input',
                      value: draft,
                      placeholder: hasCredentials ? state?.upstream ?? t.addressPlaceholder : t.addressPlaceholder,
                      spellCheck: false,
                      autoComplete: 'off',
                      'aria-label': t.addressTitle,
                      'aria-invalid': draftError !== null,
                      'data-shake': flag(shake),
                      onAnimationEnd: () => setShake(false),
                      onChange: (event) => {
                        setDraft(event.target.value)
                        if (draftError !== null && isUpstreamLike(event.target.value)) setDraftError(null)
                      },
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') void saveAddress()
                      },
                    }),
                    h(
                      'button',
                      { type: 'button', className: 'dps-btn dps-btn-primary', disabled: pending !== null || draft.trim() === '', onClick: () => void saveAddress() },
                      pending?.kind === 'address' ? t.saving : t.saveAddress,
                    ),
                  ),
                  h('div', { className: 'dps-help', 'data-error': flag(draftError !== null) }, draftError ?? (hasCredentials ? t.addressHelpCreds : t.addressHelp)),
                ),
              ),
            ),
          ),
        )

        const portValue = portDraft ?? String(state?.listenPort ?? '')
        const scopeGroup = h(
          'div',
          { ref: scopeRef },
          h('div', { className: 'dps-group-title' }, t.scopeTitle),
          h(
            'div',
            { className: 'dps-options', role: 'radiogroup', 'aria-label': t.scopeTitle },
            ['web_fetch_only', 'global'].map((candidate) =>
              option({
                key: candidate,
                checked: scope === candidate,
                pendingFlag: pending?.kind === 'scope' && pending.value === candidate,
                title: candidate === 'global' ? t.scopeGlobal : t.scopeWebFetch,
                desc: candidate === 'global' ? t.scopeGlobalDesc : t.scopeWebFetchDesc,
                onClick: () => changeScope(candidate),
              }),
            ),
            h(
              'div',
              { className: 'dps-collapse', 'data-open': flag(scope === 'global') },
              h(
                'div',
                null,
                h(
                  'div',
                  { className: 'dps-editor' },
                  h('label', { className: 'dps-help', htmlFor: 'dps-port' }, t.portLabel),
                  h(
                    'div',
                    { className: 'dps-input-row' },
                    h('input', {
                      ref: portRef,
                      id: 'dps-port',
                      className: 'dps-input dps-input-port',
                      value: portValue,
                      inputMode: 'numeric',
                      'aria-invalid': portError !== null,
                      onChange: (event) => {
                        setPortDraft(event.target.value)
                        setPortError(null)
                      },
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') void savePort()
                      },
                    }),
                    portDraft !== null && portDraft !== String(state?.listenPort ?? '')
                      ? h('button', { type: 'button', className: 'dps-btn dps-btn-primary', disabled: pending !== null, onClick: () => void savePort() }, t.savePort)
                      : null,
                  ),
                  h('div', { className: 'dps-help', 'data-error': flag(portError !== null) }, portError ?? t.portHelp),
                ),
              ),
            ),
          ),
        )

        const placementGroup = h(
          'div',
          null,
          h('div', { className: 'dps-group-title' }, t.placementTitle),
          h(
            'div',
            { className: 'dps-place', role: 'radiogroup', 'aria-label': t.placementTitle },
            PLACEMENTS.map((candidate) =>
              h(
                'button',
                { key: candidate, type: 'button', role: 'radio', className: 'dps-place-btn', 'aria-checked': placement === candidate, onClick: () => choosePlacement(candidate) },
                h('span', { className: 'dps-mini', 'data-place': candidate, 'aria-hidden': true }, h('i')),
                candidate === 'sidebar' ? t.placeSidebar : candidate === 'header' ? t.placeHeader : t.placeHidden,
              ),
            ),
          ),
          h('div', { key: placement, className: 'dps-help', 'data-swap': '', style: { marginTop: '6px' } }, t.placeHelp[placement]),
        )

        const stats = state?.stats
        const foot = h(
          'div',
          { className: 'dps-foot' },
          h('span', null, stats ? t.stats(stats.requests ?? 0, stats.failures ?? 0) : ''),
          h('span', { className: 'dps-spacer' }),
          h('button', { type: 'button', className: 'dps-link', onClick: () => void copyDiagnostics() }, h(Icon, { name: copied ? 'check' : 'copy', size: 13 }), copied ? t.copied : t.copyDiagnostics),
        )

        const moreBody = h('div', { className: 'dps-more-body' }, addressGroup, scopeGroup, placementGroup, foot)
        const more = page
          ? moreBody
          : h(
              'div',
              { className: 'dps-more' },
              h(
                'button',
                { type: 'button', className: 'dps-more-toggle', 'aria-expanded': moreOpen, onClick: () => setMoreOpen((value) => !value) },
                h('span', { className: 'dps-chevron' }, h(Icon, { name: 'chevron', size: 14 })),
                t.more,
              ),
              h('div', { className: 'dps-collapse', 'data-open': flag(moreOpen) }, h('div', null, moreBody)),
            )

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dps-body' },
            page
              ? null
              : h(
                  'div',
                  { className: 'dps-head' },
                  h(Icon, { name: 'route', size: 14 }),
                  h('span', { className: 'dps-head-name' }, t.name),
                  h('button', { type: 'button', className: 'dps-icon-btn', title: t.close, 'aria-label': t.close, onClick: onClose }, h(Icon, { name: 'close', size: 15 })),
                ),
            hero,
            bannerNode,
            segment,
            hint,
            proxy,
            more,
          ),
          toast
            ? h('div', { key: toast.id, className: 'dps-toast', 'data-tone': toast.tone, role: 'status' }, h(Icon, { name: toast.tone === 'error' ? 'alert' : 'check', size: 13 }), toast.text)
            : null,
        )
      }

      /** The pill plus its popover; renders only where the user placed it. */
      function createPill(where) {
        return function ProxySwitchPill(props) {
          const locale = useLocale()
          const t = TEXT[locale] ?? TEXT.zh
          const placement = useStore(placementStore)
          const { state, error } = useStore(host)
          const [phase, setPhase] = useState('closed')
          const [anchor, setAnchor] = useState(null)
          const triggerRef = useRef(null)
          const panelRef = useRef(null)
          const alive = useRef(true)
          const open = phase === 'open'

          useEffect(() => {
            alive.current = true
            ensureStyle()
            return () => {
              alive.current = false
            }
          }, [])
          useEffect(() => (open ? host.holdFast() : void 0), [open])

          const place = useCallback(() => {
            const rect = triggerRef.current?.getBoundingClientRect?.()
            if (!rect) return
            const width = 336
            const left = Math.max(8, Math.min(where === 'header' ? rect.right - width : rect.left, window.innerWidth - width - 8))
            if (rect.top > window.innerHeight / 2) {
              setAnchor({ from: 'bottom', left, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(280, rect.top - 16) })
            } else {
              setAnchor({ from: 'top', left, top: rect.bottom + 8, maxHeight: Math.max(280, window.innerHeight - rect.bottom - 16) })
            }
          }, [])

          const close = useCallback(() => {
            setPhase((current) => (current === 'open' ? 'closing' : current))
            setTimeout(() => {
              if (alive.current) setPhase((current) => (current === 'closing' ? 'closed' : current))
            }, 140)
            triggerRef.current?.focus?.()
          }, [])

          const toggle = useCallback(() => {
            if (phase === 'open') {
              close()
              return
            }
            place()
            setPhase('open')
          }, [close, phase, place])

          useEffect(() => {
            if (!open) return void 0
            const frame = requestAnimationFrame(() => panelRef.current?.focus?.({ preventScroll: true }))
            const onKey = (event) => {
              if (event.key === 'Escape') close()
            }
            const onPointer = (event) => {
              if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
              close()
            }
            document.addEventListener('keydown', onKey)
            document.addEventListener('mousedown', onPointer)
            window.addEventListener('resize', place)
            return () => {
              cancelAnimationFrame(frame)
              document.removeEventListener('keydown', onKey)
              document.removeEventListener('mousedown', onPointer)
              window.removeEventListener('resize', place)
            }
          }, [open, close, place])

          if (placement !== where) return null

          const tone = toneOf(state, error)
          const route = routeOf(state)
          const routeLabel = state === null ? t.name : route === 'forward' ? t.modeForward : t.modeDirect
          const status = { ok: t.tipOk, warn: t.tipWarn, error: t.tipError, idle: t.tipIdle }[tone]
          const auto = state?.mode === 'auto'
          const scopeLabel = state?.scope === 'global' ? t.scopeChipGlobal : t.scopeChipWebFetch
          const tip = t.tipFor(`${auto ? `${t.tipAuto} · ` : ''}${routeLabel} · ${scopeLabel}`, status)
          const wide = where === 'header' || props?.wide !== false

          // In the sidebar the entry follows DSH's own footer rows (Settings, Remote
          // Control): a full-width row, or a round icon on the collapsed rail. In the chat
          // header it is a compact pill like the other header utilities.
          const row = where === 'sidebar'
          const trigger = row
            ? h(
                'button',
                {
                  ref: triggerRef,
                  type: 'button',
                  className: 'dps-row',
                  title: tip,
                  'aria-label': tip,
                  'aria-haspopup': 'dialog',
                  'aria-expanded': open,
                  'data-rail': flag(!wide),
                  onClick: toggle,
                },
                h('span', { className: 'dps-row-icon' }, h(Icon, { name: auto ? 'auto' : 'route', size: 16 })),
                wide ? h('span', { className: 'dps-row-label' }, t.name) : null,
                wide
                  ? h(
                      'span',
                      { className: 'dps-row-state' },
                      state === null ? null : h('span', { key: routeLabel, className: 'dps-badge-text', 'data-swap': '' }, routeLabel),
                      h('span', { className: `dps-dot dps-tone-${tone}`, 'data-pulse': flag(tone === 'warn' || tone === 'error') }),
                    )
                  : h('span', { className: `dps-dot dps-tone-${tone}`, 'data-pulse': flag(tone === 'warn' || tone === 'error') }),
              )
            : h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: 'dps-badge',
              title: tip,
              'aria-label': tip,
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              'data-compact': flag(!wide),
              onClick: toggle,
            },
            h('span', { className: 'dps-badge-icon' }, h(Icon, { name: auto ? 'auto' : 'route', size: 14 })),
            wide ? h('span', { key: routeLabel, className: 'dps-badge-text', 'data-swap': '' }, routeLabel) : null,
            h('span', { className: `dps-dot dps-tone-${tone}`, 'data-pulse': flag(tone === 'warn' || tone === 'error') }),
              )
          if (phase === 'closed') return h('span', { className: 'dps-root', style: { display: 'contents' } }, trigger)

          const position = anchor?.from === 'top' ? { top: `${anchor.top}px` } : { bottom: `${anchor?.bottom ?? 76}px` }
          const panel = h(
            'div',
            {
              ref: panelRef,
              className: 'dps-panel',
              role: 'dialog',
              'aria-label': t.name,
              tabIndex: -1,
              'data-from': anchor?.from ?? 'bottom',
              'data-closing': flag(phase === 'closing'),
              style: { left: `${anchor?.left ?? 10}px`, maxHeight: `${anchor?.maxHeight ?? 560}px`, ...position },
            },
            h(PanelBody, { t, variant: 'popover', onClose: close }),
          )
          return h('span', { className: 'dps-root', style: { display: 'contents' } }, trigger, panel)
        }
      }

      /** The plugin's own page in Plugins: always present, so a hidden pill loses nothing. */
      function ProxySwitchPage() {
        const locale = useLocale()
        const t = TEXT[locale] ?? TEXT.zh
        useEffect(() => {
          ensureStyle()
          return host.holdFast()
        }, [])
        return h('div', { className: 'dps-root dps-page' }, h(PanelBody, { t, variant: 'page' }))
      }

      return { SidebarPill: createPill('sidebar'), HeaderPill: createPill('header'), Page: ProxySwitchPage }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        const views = createViews(ctx, createHostStore(), createPlacementStore())
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: PACKAGE_NAME, order: 40 }, views.SidebarPill),
        )
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register({ name: 'conversation.session.header.utilities', id: PACKAGE_NAME, order: 40 }, views.HeaderPill),
        )
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, views.Page),
        )
      },
    }
  },
})
