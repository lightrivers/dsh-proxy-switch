# dsh-proxy-switch v0.3.0 — 审查与验收记录

> 当前版本 **0.3.0**；DSH 运行时 `0.2.1-rc.5`；Node v22.22.2；macOS 26.5.2。
> 本文件是唯一的审查/验收记录；实现说明见 [README.md](./README.md)。

---

## 0. 当前状态

| 项目 | 结果 |
|---|---|
| 默认 scope | `web_fetch_only` |
| 默认行为 | 只替换 web_fetch 的 `ctx.web.fetch` provider；不装全局 policy、不改 `process.env`/`NO_PROXY` |
| 显式 `global` | 额外装进程级策略；web_fetch 仍走独立私有通道 |
| provider 接管 | `web.config.fetchProvider = "dsh-proxy-switch"`；覆盖内置 `http`，其它显式 id 不覆盖 |
| 测试 | 单元 69/69；Host 级 40/40；真实上游 e2e 的可运行项通过（环境不满足自动 SKIP） |
| App 内 | 通过 disable/enable 重载验收；**完整重启复验待做** |

---

## 1. 关键修复（R1–R8）

| ID | 原问题 | 处理 | 证据 |
|---|---|---|---|
| R1 | 共享 HTTPS 隧道绕过新 strict/direct 路由 | 独立 provider + 私有 loopback 通道；`isolateConnections` 每请求新建连接/隧道，不共享全局 pool | Host e2e B：预热 `http` provider 的 HTTPS 隧道后 direct web_fetch 命中 direct origin，上游 CONNECT 1→1；原 provider 隧道仍可用 |
| R2 | legacy 误拦内网，且不保留原策略 | 默认不装全局 policy、不改 env、无 legacy 分支；其它模块走原 provider/dispatcher | Host e2e A：plain fetch 与 `proxyRouteFor` 均未被接管 |
| R3 | 清空 NO_PROXY 形成“原代理 + 新 bypass” | 默认不碰 `NO_PROXY`；global 安装策略时保留原列表 | Host e2e D：真实 curl 在原 proxy+NO_PROXY 下直连内网，上游收到 0；global 下同样 0 |
| R4 | 地址校验弱于原 provider；mapped/NAT64 缺口 | 字节级 IP 解析；mapped/translated/compatible 统一处理；RFC 7050 前缀发现 + RFC 6052 内嵌 IPv4；补 `100:0:0:1::/64` | 单测 16 项，含注入 DNS 的 NAT64 用例 |
| R5 | 租约过期旧 release 删除新租约 | 删除整个租约机制；provider 本身就是身份 | 代码中无 `strict-targets` |
| R6 | 并发设置丢更新；临时文件碰撞 | 所有状态修改进入串行命令队列；`saveState` 随机 UUID + `wx`，失败清理临时文件 | Host e2e C：并发 mode+scope、port+upstream 都保留；单测同毫秒双 save |
| R7 | 非法上游脱敏兜底泄露密码片段 | 无法解析的 upstream 一律 `<invalid-upstream>` | 单测 + Host e2e E：`REVIEW-SECRET` 未出现 |
| R8 | IPv6 上游保留方括号无法拨号 | 统一 `dialHostname()`；probe/HTTP/CONNECT 全用 | 单测 IPv6 probe + Host e2e C 实际传输 |

### 1.1 R1 的关键设计

v0.2 用 `host:port` 租约猜“哪个请求是 web_fetch”，并以全局 dispatcher 承载；共享 HTTPS 池会让新请求复用旧上游隧道。v0.3 改为：

- `ctx.web.registerFetchProvider()` 注册新 provider；
- provider 的 `requestOnce` 只与私有 loopback 通道通信；
- 通道 forwarder 每请求新建上游/直连连接；
- 其它模块的 dispatcher/池/env 完全不动。

---

## 2. App 内验收（2026-11-01，GUI 64817）

### 2.1 通过项

| 项目 | 证据 |
|---|---|
| `/state` | `version 0.3.0`、`provider.status active`、`policyInstalled false`、`webFetchPort` 独立随机端口 |
| forward + 真实 web_fetch | `https://example.com/` → 200；`webFetchRequests:1`、`globalRequests:0` |
| direct + 代理开启 | `PROXY_SWITCH_FAKE_IP` + 双 content block；**拒绝后模型请求继续** |
| direct + 公网 IP literal | `https://1.1.1.1/` 修复 TLS 后正常进入同源重定向限制 |
| `scope=global` | 7899 监听、`policySelfCheck.ok=true`、子进程 env=7899；web_fetch 仍走独立通道 |
| 切回 `web_fetch_only` | `policyInstalled:false`；Host 进程 env 干净（`ps e`） |
| Client badge | `sidebar.footer.action` 中 `dsh-proxy-switch` order 40 active（Inspect 验证，未截图） |

### 2.2 App 内暴露并修复的三个问题

1. **`TypeError: Invalid effect`**：`apply` 返回 controls 普通对象，Cordis 把它当 effect。修复：不返回，改存 `WeakMap` + `controlsOf(ctx)`。
2. **桌面 bundle 固定 `fetchProvider: "http"`**：原逻辑把内置 `http` 当成“外部配置”而 blocked。修复：只覆盖内置 `http`，其它 id 仍 blocked。
3. **IP literal TLS 报 `Host: localhost`**：`tls.connect` 未传 `host`，Node 用 localhost 做证书校验。修复：传 `host`；IP 不传 SNI，用 IP SAN 校验。Host e2e 使用 `ca + rejectUnauthorized:true` 防回归。

### 2.3 仍待复验

- **完整退出并重启 App**（本轮是 disable/enable 重载）。
- 浏览器面板截图。
- 切回 `web_fetch_only` 后当前会话的 bash shell 仍显示 `HTTP_PROXY=7899`；Host 进程 env 已干净，疑似 bash 工具/session 保留了 global 期间的快照，需新会话复查。

---

## 3. 测试命令

```bash
npm test
DSH_RUNTIME_MODULES=/path/to/runtime/dsh/node_modules node scripts/e2e-host.mjs
node scripts/e2e-real.mjs  # 可选；需要可用的 1082 HTTP 代理
node scripts/e2e-web-fetch-warning.mjs
```

`e2e-host.mjs` 使用真实 Cordis `Context`、`WebRuntime`、`HttpFetchProvider`、`installProxyFromEnvironment`；不是纯函数脚本，也不是 Electron App。

---

## 4. 残余风险

| ID | 风险 |
|---|---|
| R9 | provider 接管依赖 `web.config.fetchProvider` 的 volatile ref 与 `HttpFetchProvider.requestOnce` 可覆盖性；大版本变化需适配，失败会显示 `provider.status=error` |
| R10 | 用户显式配置其它 fetch provider 时插件不覆盖，web_fetch 不受控；UI 显示 blocked |
| R11 | 私有通道是本机随机 loopback HTTP 代理，无认证；本机其它进程理论上可用，只做 strict 转发 |
| R12 | `ipv4only.arpa` NAT64 前缀发现失败时，网络特定前缀不检查；固定前缀规则仍生效 |
| R13 | 多 DSH 进程共享 `state.json` 无跨进程锁 |
| R14 | `state.json` 明文凭据，靠 0600/0700 + 全链路脱敏保护 |

---

## 5. 未验证边界

1. 修复后完整 App 重启（provider 从零加载、面板、真实会话）。
2. Client 面板新字段的浏览器截图。
3. Windows/Linux。
4. 数小时稳定性/压力。
5. 真实第三方认证代理、HTTP/2 目标。
6. 物理 NAT64 网络（只做了注入 DNS 的策略测试）。

---

## 6. 给下一次审核的检查清单

1. `HttpFetchProvider` 除 `requestOnce` 外是否还有别的网络入口会绕过覆盖？
2. `fetchProvider` volatile ref 在 HMR、重复 enable/disable、快速重启时是否会留下悬空 id？
3. 私有通道 `agent:false` / 每请求 CONNECT 是否在异常、取消、超时路径都销毁？
4. NAT64 前缀发现是否可能被攻击者控制？失败时是否 fail-open？
5. 串行队列在 `applyRuntime` 失败回滚的所有分支是否恢复 listener/policy/current/state.json？
6. `<invalid-upstream>` 是否仍出现在其它未脱敏路径（policyDiagnostics/lastError/Host 日志）？
7. IPv6 上游的 Host/CONNECT authority/SNI 方括号规则是否一致？
8. 完整重启、面板截图、Windows/Linux、长时间运行、真实认证代理。

---

## 7. 复现与回滚

```bash
# 状态
curl -s --noproxy '*' http://127.0.0.1:<webPort>/dsh-proxy-switch/state | python3 -m json.tool

# 切模式/scope
curl -s --noproxy '*' -X POST -H 'content-type: application/json' \
  -d '{"mode":"direct"}' http://127.0.0.1:<webPort>/dsh-proxy-switch/mode
curl -s --noproxy '*' -X POST -H 'content-type: application/json' \
  -d '{"scope":"global"}' http://127.0.0.1:<webPort>/dsh-proxy-switch/settings
```

回滚：`plugin_manager remove_bundle dsh-proxy-switch`（或从 profile 删除依赖后重启），删除 `~/.dsh/storages/dsh-proxy-switch/`；需要恢复旧代理时把 `HTTP_PROXY`/`HTTPS_PROXY` 写回 `~/.dsh/.env` 并重启。
