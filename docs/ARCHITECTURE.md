# dsh-proxy-switch 架构与审查指南（v0.4.0）

这份文档给对抗性代码审查用。读完后应该能回答三个问题：插件在 DSH 进程里做了什么、哪些输入不可信、哪些不变量一旦被打破就会出安全或可用性问题。界面（`client.js`）不是审查重点，只在最后简单说明。

历史验收记录（v0.3 的 R1–R8 修复、App 内验收）见 [../REVIEW.md](../REVIEW.md)，本文不重复。

---

## 1. 插件做什么

DeepSeek Harness（DSH）的 `web_fetch` 在 TUN/fake-IP 代理客户端运行时会失败：DNS 把域名解析到 `198.18.0.0/15`，原生 `dsh-web-fetch-http` 的直连安全检查会拒绝非公网地址。本插件把 `web_fetch` 的网络这一跳换成可切换的线路：

- **走代理（forward）**：经用户本机的 HTTP 代理（CONNECT 或绝对 URI）。
- **直连（direct）**：插件自己解析 DNS，整组结果都是公网地址才连接，并且直接连接校验过的那个 IP。
- **自动（auto，v0.4 新增，默认）**：代理端口可达时走代理，否则直连。
- **上游自动检测（v0.4 新增，默认）**：从系统代理设置、启动环境变量或常见端口里找到 HTTP 代理，并通过一次 `CONNECT` 握手验证。

作用范围默认是 `web_fetch_only`：只注册私有 provider，不碰全局 dispatcher、`process.env` 和子进程环境。`global` 是用户需要显式选择的模式，会额外接管其它模块的出站请求。

---

## 2. 组件与文件

| 文件 | 职责 | 关键入口 |
|---|---|---|
| `lib/index.js` | Host 插件主体：状态、命令队列、provider 接管、检测生命周期、Web 路由、`tools/execute` 包装、teardown | `apply()`；`runDetection()` 约在 :428；路由 guard 约在 :656；`tools/execute` 约在 :727 |
| `lib/fetch-provider.js` | 继承运行时的 `HttpFetchProvider`，只覆盖 `requestOnce`，把请求发到私有通道 | `createProxySwitchProvider` |
| `lib/proxy-client.js` | 私有通道的客户端：HTTP 走绝对 URI，HTTPS 走 CONNECT 再接 TLS；携带通道令牌，中止/截止贯穿 TLS 阶段，把转发器的错误码映射回 `WebError` | `requestThroughLocalProxy` |
| `lib/forwarder.js` | 只监听 127.0.0.1 的严格转发器（web_fetch 一个实例，`global` 一个实例），校验通道令牌、拒绝自身上游、跟踪并销毁所有出站连接，按 `getMode()` 选择上游或直连 | `forwardHttp`，`directHttp`，`connectViaUpstream` |
| `lib/net-guard.js` | SSRF 判定：按字节解析 IP、mapped/translated/compatible、NAT64（RFC 7050/6052）、authority 严格解析 | `judgeAddresses` :473，`resolveDirectTarget`，`parseAuthority` |
| `lib/detect.js`（v0.4） | 上游检测：读系统代理（macOS `scutil`、Windows 注册表、Linux `gsettings`/`kioslaverc`）、读环境变量、扫描端口，并用 `CONNECT` 验证 | `readSystemProxy` :233，`verifyHttpProxy` :277，`detectUpstream` :366 |
| `lib/messages.js` | 警告状态机，以及 `effectiveModeOf`（auto 在什么情况下走代理） | `warningFor`，`effectiveModeOf` :38 |
| `lib/probe.js` | 上游 TCP 连通性探测循环（只做 TCP connect，不发 HTTP） | `probeUpstream`，`createProbeLoop` |
| `lib/state.js` | `state.json` 的读取、规范化、0.3→0.4 迁移；原子写（文件 0600、目录 0700）；凭据脱敏 | `normalizeState`，`saveState` :271，`maskUpstream` |
| `lib/host-utils.js` | 纯函数：global 模式的环境覆盖、web_fetch 预检、警告追加 | `precheckWebFetch` |
| `client.js` | 浏览器端 UI（侧栏、对话顶栏、插件页三个挂载点） | 见第 8 节 |

---

## 3. 数据流

### 3.1 一次 web_fetch

```
模型调用 web_fetch
  └─ tools/execute 包装（index.js）
       ├─ provider 不是本插件 → 原样放行，不追加任何文字
       ├─ mode=auto 且上次探测超过 1 秒 → 先等一次 probe.runNow()
       ├─ route = effectiveModeOf(mode, probe.reachable)
       ├─ route=direct → precheckWebFetch：resolveDirectTarget(host)
       │     └─ 拒绝 → 返回 isError 结果（auto 下遇到 fake-IP 还会记录 lastFakeIpAt，并以 10 秒限频重新检测）
       └─ next() → ctx.web.fetch → 本插件 provider.requestOnce
             └─ proxy-client → 127.0.0.1:<随机端口>（web_fetch 转发器，isolateConnections）
                   ├─ getMode()=forward → 本地判定目标 + 上游代理（非公网字面量/本地名拒绝）
                   └─ getMode()=direct  → resolveTarget → judgeAddresses → 连接校验过的 IP
  └─ 结果末尾追加 [dsh-proxy-switch] 警告段落（如果有）
```

两个转发器的 `getMode` 都等于 `effectiveMode()`，所以每个请求在处理时都会重新判定线路。

### 3.2 检测生命周期（v0.4）

触发时机：插件启动；每次切换模式（`setMode` 提交后）；`upstreamSource` 改回 `auto`；探测失败（30 秒限频）；auto 模式下遇到 fake-IP 拒绝（10 秒限频）；`POST /detect`（2 秒冷却，超额返回 429）。

`runDetection` 同一时间只运行一个实例。它在命令队列之外执行，只把最后一步写入放进队列；写入前会再检查一次 `upstreamSource === "auto"`，防止和用户的手动修改竞争。找到的地址先经过 `parseUpstream`，再写入 `state.json`，然后立刻探测一次。

`detectUpstream` 的顺序：

1. 系统代理和环境变量（显式配置）：必须返回 200（可用）或 407（需要密码）。
2. 扫描 `COMMON_PORTS`：同样必须返回 200 或 407。

本插件自己的端口（`listenPort`、web_fetch 通道端口、global 通道端口）永远不会成为候选；候选的主机名按 `localhost.`、IPv4-mapped IPv6、数字 IPv4 写法规范化，端口命中自身时还会解析主机名以排除 hosts 别名。检测提交前按当时的端口再检查一次。

### 3.3 状态与命令

所有修改状态的命令（`setMode`、`updateSettings`、检测写入）都经过同一个串行队列 `enqueue`，并且先落盘、再更新内存。`updateSettings` 在 `applyRuntime` 失败或落盘失败时会回滚运行时状态。

---

## 4. 信任边界与不可信输入

| 输入 | 来源 | 处理位置 |
|---|---|---|
| `web_fetch` 的 URL | 模型（可能受网页内容的提示注入影响） | `precheckWebFetch`、转发器、`net-guard` |
| CONNECT authority / 绝对 URI | 私有通道上的任何本机客户端 | `parseAuthority`、`handleHttpRequest` |
| DNS 应答 | 本机解析器，TUN 模式下由代理客户端控制 | `judgeAddresses`、NAT64 发现 |
| 上游代理的响应 | 本机或局域网代理 | `connectViaUpstream`（响应头 16 KiB 上限、407 处理） |
| `/dsh-proxy-switch/*` 请求 | 任何能连到 DSH Web 端口的本机进程或浏览器页面 | `guard`：loopback、`Sec-Fetch-Site`、`Origin`、`Content-Type` |
| 系统代理设置、环境变量 | 本机配置，用户会话里的任何程序都能改 | `detect.js` 的解析函数 |
| 端口扫描得到的服务 | 本机任意监听者 | `verifyHttpProxy` 的分类 |
| `state.json` | 本机文件，可能损坏或来自旧版本 | `normalizeState`（逐字段修复，不回显凭据） |

---

## 5. 必须保持的不变量

1. **直连只连接校验过的地址**：解析得到的整组地址必须全部是公网地址；连接时直接用 `verdict.address`，不再进行第二次 DNS 查询（防 DNS rebinding）。
2. **web_fetch 每个请求一条新连接**：`agent:false`，每个 HTTPS 请求单独 CONNECT。切换模式或上游后不能复用旧隧道（v0.3 的 R1）。
3. **`web_fetch_only` 不碰全局**：不安装 proxy policy、不写 `process.env`、不改其它模块的连接池。
4. **auto 只有在探测确认可达时才走代理**：`reachable` 为 `null` 时走直连（直连有安全检查），见 `effectiveModeOf`。
5. **手动填写的上游永远不会被检测结果覆盖**：Loader 配置里显式给出的上游也算手动。
6. **凭据不外泄**：API、警告、日志、诊断信息里一律经过 `maskUpstream`；无法解析的地址显示为 `<invalid-upstream>`。
7. **转发路径上的任何异常都不能变成 Host 进程里未捕获的异常**：转发器所有入口都有 try/catch，并使用严格的 authority 解析。
8. **检测和探测失败都不会抛出**：检测失败时 `detection.status = "none"`，探测失败时 `reachable = false`。
9. **私有通道有每次启动的令牌**：HTTP 与 CONNECT 都携带随机令牌，转发器常量时间比较后才处理；令牌不会转发给上游，`/state` 不返回通道端口和 PID。
10. **控制接口绑定 Host**：`Host` 必须等于 `webServer.getOrigin()` 的 host（关闭 DNS rebinding）；修改请求另外要求 `x-dsh-proxy-switch-request: 1`，浏览器跨站发不出该头。
11. **停用即失效**：`disposed` 标志加实例令牌让迟到的请求体、检测、探测和预检不再写盘、监听或安装策略；disable→enable 后旧实例也不能覆盖新实例。
12. **探测结果属于被测地址**：结果携带上游 URL；切换上游后旧结果作废，`auto` 回到"未知 → 直连"，直到新地址自己有结果。
13. **不与自己递归**：上游指向任一已绑定通道（含 `localhost.`、IPv4-mapped、`127.1`、`2130706433` 等写法）时，手动设置被拒绝，拨号前再拒绝一次。
14. **转发目标先做本地判定**：forward 模式下每个请求（重定向各自重新进入）先本地解析；解析出非公网且非 fake-IP 的地址就拒绝，另有本地名黑名单。这是缓解而非根治，见 6.A1。
15. **状态与权限的提交点**：加载时修复存储目录/文件权限；保存时先给临时文件设 0600 再 rename，rename 是唯一的提交点。
16. **检测程序路径固定**：`gsettings` 只从 `/usr/bin`、`/bin` 执行；`reg.exe` 只在 `SystemRoot` 匹配 `^[A-Za-z]:\\Windows$` 时使用，否则回退 `C:\\Windows`。

---

## 6. 风险与当前状态（v0.4.0 修复后）

每一条列出本轮审查（Astra，2026-11-04）之后的处理。A1 是**缓解**，A4、A6 仍有设计上的残余；其余已按条目落地。

### A1（高）走代理时，主机名形式的内网目标 —— 已缓解，不能根治

forward 模式下每个请求在交给上游前于本机解析目标（重定向各自重新进入）：整组结果里只要有一个非公网且不是 fake-IP 的地址就拒绝；另外直接拒绝 `localhost`、`*.localhost`、单段主机名、`.local`/`.internal`/`.lan`/`.home.arpa`。

**残余风险**：上游代理会再次解析同一主机名，上游的解析结果可能与本机不同（DNS rebinding、分流规则、上游侧 hosts）；fake-IP 环境下本机答案（`198.18.0.0/15`）无法判断真实目标；本机 DNS 失败或 2 秒超时时也放行。因此模型仍可能借上游触达内网。用户过去手写 `HTTP_PROXY` 时面对的是同一个风险，插件只是把常见情况挡在前面，不宣称已根治。README 的说明由主会话同步更新。

### A2（中）控制接口身份校验 —— 已修

`Host` 必须与 `webServer.getOrigin()` 的 host 一致（DNS rebinding 页面的 Host 是攻击者域名），修改请求另外要求 `x-dsh-proxy-switch-request: 1`（浏览器跨站发送需要 CORS 预检，本路由不授予）。原有的 loopback、`Sec-Fetch-Site`、`Origin`、`Content-Type` 检查保留。DSH 没有给插件路由的鉴权钩子，同机同用户的进程仍可直接调用，与文件权限属于同一信任级别。

### A3（中）私有通道无认证 —— 已修

每次启动生成随机令牌，proxy-client 在 HTTP 请求头与 CONNECT 头里携带，转发器常量时间比较，令牌在转发前被剥离。`/state` 不再返回通道端口与 PID。全局通道无法携带令牌（其它模块经 policy 访问），其安全性依赖 loopback 绑定与 `web_fetch_only` 默认不开启。

### A4（中）检测自动采用系统代理/环境变量 —— 收窄

所有候选（系统、环境、扫描）都必须完成 CONNECT 并返回 200 或 407；普通 HTTP 服务器或任意状态行不再被采用。系统代理/环境变量仍按"用户配置即信任"处理：同一会话里的恶意程序仍可改系统代理设置，这与其本来就能做的其它事情同级。候选的服务身份无法在协议层验证（端口复用、验证后换主），这是残余风险。

### A5（低）检测资源消耗 —— 已限频

`POST /detect` 2 秒冷却（超额 429）；探测失败与 fake-IP 触发仍分别有 30 秒、10 秒限频；重叠调用仍由 `detectRunning` 合并。

### A6（低）auto 只看 TCP 可达 —— 部分修复

探测结果带上被测上游；切换地址后旧结果作废，必须真正探测新地址。真实请求收到 407 时记录 `probe.needsAuth`，界面沿用现有的"需要登录"锁展示。TCP 可达仍不等于代理可用：上游接受 TCP 但拒绝 CONNECT 时 `auto` 仍可能选 forward 并失败；按产品决定不做失败后自动改直连（fake-IP 下直连同样失败）。

### A7（低）系统检测程序路径 —— 已修

`gsettings` 只从 `/usr/bin`、`/bin` 执行，不再搜索 PATH；`reg.exe` 只在 `SystemRoot` 匹配 `^[A-Za-z]:\Windows$` 时使用，否则回退 `C:\Windows`。所有调用仍是 `execFile` + 常量参数。

### F10（已知行为，不修）

`global` 模式下修改监听端口或切回 `web_fetch_only` 会关闭旧 listener 并销毁在途连接（含 SSE、模型请求、隧道）。这只发生在用户主动改设置时，新端口绑定失败会回滚配置，但已经中断的请求无法恢复。记录为已知行为。

### 沿用 v0.3 的检查清单

`REVIEW.md` 第 6 节的 8 个问题仍然适用：`HttpFetchProvider` 是否还有其它网络入口、volatile ref 在反复启停时是否会悬空、隧道在异常和取消路径上是否都被销毁、NAT64 发现失败时是否会放行、回滚分支是否完整、`<invalid-upstream>` 之外是否还有未脱敏的路径、IPv6 方括号规则是否一致。

---

## 7. 测试覆盖对照

| 区域 | 测试 | 说明 |
|---|---|---|
| IP 分类、mapped/translated、NAT64（含发现失败沿用缓存 F13）、authority 规范化（F2）、转发目标本地判定（F1）、loopback 识别（F9）、预检预算（F14） | `test/net-guard.test.mjs` | 纯函数 |
| 转发器：严格性、畸形 CONNECT、407、错误响应、通道令牌（F4）、非标准 IPv4（F2）、本地名（F1）、出站连接清理（F8） | `test/forwarder.test.mjs` | 真实 socket |
| 探测、探测结果绑定被测上游（F12） | `test/probe.test.mjs` | |
| 状态规范化、0.3→0.4 迁移、脱敏（F15）、加载时修权限（F16）、提交顺序（F17） | `test/state.test.mjs` | |
| 警告状态机、`effectiveModeOf` | `test/messages.test.mjs` | |
| 检测：三平台解析、固定程序路径（F18）、环境变量、200/407 采用规则（F5）、自身端口别名（F9）、候选顺序 | `test/detect.test.mjs` | 本机假服务器，不联网 |
| 客户端：挂载点、渲染、横幅优先级、三段开关、请求头 | `test/client.test.mjs` | 用简化版 React 渲染 |
| 私有通道客户端：越界状态码（F6）、TLS 阶段的取消/截止/握手超时（F7） | `scripts/e2e-host.mjs` Phase P | 依赖 `dsh-web` 运行时，故不放进单元测试 |
| Host 集成：provider 接管、R1 隧道隔离、R3 NO_PROXY、R6 并发、R7 脱敏、R8 IPv6、auto 与检测（F）、控制路由 Host/请求头（F3）、迟到工作（F11）、探测绑定（F12）、预检预算（F14）、脱敏（F15）、检测限频（A5）、通道令牌（F4）、自身上游（F9） | `scripts/e2e-host.mjs` | 真实 Cordis/WebRuntime/HttpFetchProvider，89 项 |
| 真实上游 | `scripts/e2e-real.mjs` | 需要本机 HTTP 代理 |
| web_fetch 警告文本 | `scripts/e2e-web-fetch-warning.mjs` | |

最近一次结果（2026-11-04 审查修复后，macOS，Node 22）：单元测试 105/105，Host 集成 89/89。`e2e-real.mjs` 与警告文本脚本本轮未重跑（前者需要本机 1082 代理）。

## 8. 客户端（非审查重点）

`client.js` 是没有构建步骤的单文件，注册三个挂载点：`sidebar.footer.action`（小胶囊，靠右排在底栏插件那一行；侧栏收起时变成圆形图标）、`conversation.session.header.utilities`（胶囊样式）、`plugins.bundle.config`（插件页，键为包名，始终存在）。按钮位置保存在 `localStorage` 的 `dsh-proxy-switch.placement`。

所有挂载点共用一个状态存储，只在有组件订阅时轮询 `/state`（面板打开时 1.5 秒一次，否则 4 秒一次），同一时间只发一个修改命令。

样式只注入一次（`#dsh-proxy-switch-style`），所有类名以 `dps-` 开头。会影响宿主元素的规则只有两条，都只在底栏出现本插件按钮时生效：`[class*="footerActions"]:has(.dps-side-pill)` 让那一格垂直居中、留 6px 间距；收起侧栏时 `[class*="_collapsed"] [class*="footerActions"]:has(.dps-row)` 改为竖排。胶囊本身 `flex:none` 不被压缩、`margin-left:auto` 靠右，同一格里的其它插件（例如 `@agents-anywhere/dsh-bridge-next` 的「远程控制」）占剩下的宽度，互不重叠。

---

## 9. 未验证边界

1. v0.4 在真实 DSH App 里的完整重启复验（Host 新代码需要重启 DSH 才会加载）。
2. Windows、Linux 上的系统代理读取（只有解析函数的单元测试，没有在真机上跑过）。
3. 需要认证的真实代理、HTTP/2 目标、长时间运行。
4. 侧栏底栏的居中与竖排规则在 DSH 后续版本中是否依然有效（依赖宿主类名包含 `footerActions`）。

## 10. 复现命令

```bash
npm test
DSH_RUNTIME_MODULES=/path/to/dsh/node_modules node scripts/e2e-host.mjs
node scripts/e2e-real.mjs
node scripts/e2e-web-fetch-warning.mjs

# 读取状态（DSH Web 端口可在 DSH 日志或 lsof 中找到）
curl -s --noproxy '*' http://127.0.0.1:<webPort>/dsh-proxy-switch/state | python3 -m json.tool
curl -s --noproxy '*' -X POST -H 'content-type: application/json' -d '{"mode":"auto"}' http://127.0.0.1:<webPort>/dsh-proxy-switch/mode
curl -s --noproxy '*' -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:<webPort>/dsh-proxy-switch/detect
```
