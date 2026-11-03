# dsh-proxy-switch

[![test](https://github.com/lightrivers/dsh-proxy-switch/actions/workflows/test.yml/badge.svg)](https://github.com/lightrivers/dsh-proxy-switch/actions/workflows/test.yml)

DeepSeek Harness 的**可切换 web_fetch 出站通道**：侧栏开关决定 web_fetch 走「上游 HTTP 代理」还是「自行解析并直连」，状态与警告同时出现在侧栏和 `web_fetch` 结果中。

当前版本 **0.3.0**。设计取舍、复审证据与未验证边界见 [REVIEW.md](./REVIEW.md)。

---

## 为什么需要它

`dsh-web-fetch-http` 的直连路径要求 DNS 结果全是公有地址；TUN + fake-IP 代理客户端会把域名解析到 `198.18.0.0/15`，于是 `web_fetch` 报 `non-public IP address`。代理路径又会跳过它自己的校验。过去只能把 `HTTP_PROXY` 写死进 `.env`，代理客户端一关，模型请求也跟着失败。

本插件把 web_fetch 的传输做成独立、可切换、可观察的一层，默认**不影响其它模块**。

---

## 架构

```
ctx.web (WebRuntime)
  ├─ "http"               原始 provider（未接管/禁用时使用）
  └─ "dsh-proxy-switch"    本插件注册，web_fetch 默认使用
        │ requestOnce()
        ▼
  私有 loopback 通道 127.0.0.1:<随机端口>   （strict-only，isolateConnections）
        ├─ forward: CONNECT / 绝对 URI → 上游 HTTP 代理
        └─ direct : 字节级 DNS + NAT64/SSRF 校验 → 直连目标

[仅 scope=global] 第二个 forwarder + 进程级代理策略
  127.0.0.1:<listenPort> ← 其它模块 / 子进程（保留原 NO_PROXY）
```

- **默认 `web_fetch_only`**：只注册 provider，并把 `web.config.fetchProvider` 指向它；不安装全局策略、不写 `process.env`、不碰其它模块的连接池。
- **显式 `global`**：额外接管其它模块的出站路径，`NO_PROXY` 保持用户原值。
- provider 继承运行时 `HttpFetchProvider`，只覆盖 `requestOnce`；重定向、超时/取消、字节/字符上限、内容类型、解码仍用上游实现。
- 私有通道 `isolateConnections`：HTTP 不复用 keep-alive，HTTPS 每请求新建 CONNECT，切换 mode/upstream 后不可能借用旧隧道。

接管的是 `ctx.web.fetch` 这个 seam，而不是按工具名过滤：任何调用 `ctx.web.fetch` 的模块都会跟随本插件；模型请求、`ctx.web.search` 和不经过该 seam 的工具不受影响。

---

## 安装与升级

先取得源码：

```bash
git clone https://github.com/lightrivers/dsh-proxy-switch.git ~/src/dsh-proxy-switch
```

再由桌面端内置 `plugin_manager` 安装（CLI 对 desktop profile 会拒绝）：

```
plugin_manager action=install_bundle target=/绝对路径/dsh-proxy-switch
```

升级时先 `git pull`，再重新执行 `install_bundle`。

安装后刷新页面（Client bundle 随页面加载）；升级 Host 代码需要重启 DSH。

依赖必须写在 `peerDependencies`，不能写进 `dependencies`，否则会装出第二份 `@deepseek-ai/dsh-http-proxy`，策略改在副本上而不生效：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-http-proxy": ">=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-launch-environment": ">=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-web": ">=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-web-fetch-http": ">=0.2.0-rc.1 <0.3.0-0"
}
```

### 从写死 `.env` 迁移

1. 删除 `~/.dsh/.env` 里的 `HTTP_PROXY` / `HTTPS_PROXY`（否则禁用插件后回退到旧代理）。
2. 安装插件，完全退出并重启 DSH。
3. 打开开关确认 `forward`，抓一次 `https://example.com`。
4. 关闭代理客户端、切 `direct`，再抓一次应成功。
5. 代理客户端重新打开但保持 `direct`：web_fetch 应被拒绝并给出 fake-IP 文本，模型请求仍继续。

首次安装默认 `direct + web_fetch_only`。

---

## 配置

侧栏面板「设置」可改，也可编辑 `state.json` 后重启：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `direct` | `forward` / `direct` |
| `scope` | `web_fetch_only` | `web_fetch_only` / `global` |
| `listenPort` | `7899` | 仅 global 使用；1024–65535，只绑 `127.0.0.1` |
| `upstream` | `http://127.0.0.1:1082` | 只接受 `http://host:port`，可带 `user:pass@` |
| `probeIntervalMs` | `15000` | 3000–600000 ms |

- web_fetch 私有通道使用随机 loopback 端口，不占 `listenPort`。
- 所有状态修改通过同一个串行队列提交，并发请求不会互相覆盖。
- `state.json` 目录 0700、文件 0600；API/UI/警告/日志中的凭据脱敏为 `user:***@host`。

---

## 与 web_fetch / UI 的交互

`tools/execute` 在 direct 模式下先做一次 precheck：fake-IP/非公网目标直接返回 `isError` + 双语原因，再追加 `[dsh-proxy-switch]` 警告段落。provider 内部还会再校验一次。

状态 API（Client 半体使用）：

```
GET  /dsh-proxy-switch/state
POST /dsh-proxy-switch/mode      { "mode": "forward" | "direct" }
POST /dsh-proxy-switch/settings  { "scope"?, "upstream"?, "listenPort"?, "probeIntervalMs"? }
POST /dsh-proxy-switch/probe
```

`state` 主要字段：`mode`、`scope`、`listenPort`、`listening`、`webFetchPort`、`webFetchListening`、`upstream`、`upstreamHasCredentials`、`probeIntervalMs`、`provider {id,status,error}`、`policyInstalled`、`policySelfCheck`、`probe {reachable,latencyMs,error}`、`warning`、`stats {requests,failures,rejections,webFetchRequests,globalRequests,lastHost}`。

Client 半体注册在 `sidebar.footer.action`，id `dsh-proxy-switch`，order 40；所有文案/样式在 `client.js`。

---

## 安全

- `direct` 模式整组解析结果必须全为公网；任一非公网即拒绝。
- 字节级 IP 解析：IPv4-mapped（含展开形式）、IPv4-translated（拒绝）、IPv4-compatible、RFC 7050 NAT64 前缀 + RFC 6052 内嵌 IPv4 检查。
- 固定网段包含 `198.18.0.0/15`、RFC1918、loopback、link-local、CGNAT、文档段、`100:0:0:1::/64`、`2001::/23` 等；策略差异见 [REVIEW.md](./REVIEW.md)。
- CONNECT authority 严格校验，畸形输入返回 400 + `PROXY_SWITCH_INVALID_AUTHORITY`。
- 上游 Basic 认证只发往上游握手，不进入隧道、不发给目标；407 有明确机器码。
- 无法解析的上游显示为 `<invalid-upstream>`，不回显原始字符串。
- 默认不改 `NO_PROXY`；global 模式保留用户原列表。
- 状态路由只接受 loopback，校验 `Origin`、`application/json`、`Sec-Fetch-Site`。
- 日志/统计只记 host、状态码、engine、耗时，不记 URL/正文。

---

## 测试

```bash
npm test                               # 69 项单元测试
node scripts/e2e-real.mjs              # 可选：真实 1082 上游；不可用时自动 SKIP
node scripts/e2e-web-fetch-warning.mjs # web_fetch 文本的 5 个组合

# Host 级集成：需要指向 DSH 运行时包闭包（包含 @deepseek-ai/cordis、dsh-web、
# dsh-web-fetch-http、dsh-http-proxy、dsh-launch-environment、undici、ipaddr.js 等）
DSH_RUNTIME_MODULES=/path/to/runtime/dsh/node_modules node scripts/e2e-host.mjs
```

最近一次结果：单元 69/69、Host 级 40/40；真实上游 e2e 在当前环境通过 CONNECT/直连/死上游，fake-IP 用例按 DNS 自动 SKIP。Host 级覆盖 provider 接管、R1 隧道不复用、R3 子进程 NO_PROXY、R6 并发设置、R8 IPv6 上游；不是 Electron App 测试。

---

## 文件结构

```
dsh-proxy-switch/
├─ package.json
├─ cordis.patch.yml
├─ icon.svg
├─ locale/{zh,en}.json
├─ lib/
│  ├─ index.js             # 状态、scope、provider 接管、全局策略、队列、Web 路由、teardown
│  ├─ fetch-provider.js    # 继承 HttpFetchProvider，只覆盖 requestOnce
│  ├─ proxy-client.js      # 私有通道客户端（HTTP absolute-URI / HTTPS CONNECT+TLS）
│  ├─ forwarder.js         # strict-only 本地转发器
│  ├─ net-guard.js         # IP 解析、mapped/translated、NAT64、SSRF
│  ├─ probe.js             # 上游 TCP 探测
│  ├─ state.js             # 原子写、0600/0700、脱敏
│  ├─ messages.js          # 警告状态机
│  └─ host-utils.js        # 策略环境、precheck、警告追加
├─ client.js               # sidebar 开关与面板
├─ test/*.test.mjs
└─ scripts/{e2e-host,e2e-real,e2e-web-fetch-warning}.mjs
```

---

## 已知限制

- provider 接管依赖 `web.config.fetchProvider` 的 volatile ref 与 `HttpFetchProvider.requestOnce` 可覆盖性；运行时大版本变化需适配。
- 桌面 bundle 默认 `fetchProvider: "http"`，插件会覆盖内置 `http`；其它显式 provider id 不会被覆盖，状态显示 `blocked`。
- 默认 `web_fetch_only` 不接管全局；想控制所有出站要显式切 `global`。
- 只在 macOS 验证；Windows/Linux、长时间压力、真实第三方认证代理、HTTP/2 未验证。
- `state.json` 保留明文凭据（转发器需要），靠 0600 + 目录 0700 + 全链路脱敏保护。
- 多 DSH 进程共享 `state.json` 无跨进程锁。

---

## 回滚

1. `plugin_manager remove_bundle dsh-proxy-switch`，或从 profile `package.json` 删除依赖后重启。
2. 删除 `~/.dsh/storages/dsh-proxy-switch/`。
3. 需要恢复“经 1082 代理”时，在 `~/.dsh/.env` 写回 `HTTP_PROXY`/`HTTPS_PROXY` 并重启。
