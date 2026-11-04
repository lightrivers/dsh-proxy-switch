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
| `lib/proxy-client.js` | 私有通道的客户端：HTTP 走绝对 URI，HTTPS 走 CONNECT 再接 TLS；把转发器的错误码映射回 `WebError` | `requestThroughLocalProxy` |
| `lib/forwarder.js` | 只监听 127.0.0.1 的严格转发器（web_fetch 一个实例，`global` 一个实例），按 `getMode()` 选择上游或直连 | `forwardHttp` :349，`directHttp` :420，`connectViaUpstream` :569 |
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
                   ├─ getMode()=forward → 上游代理（只拦截非公网 IP 字面量）
                   └─ getMode()=direct  → resolveTarget → judgeAddresses → 连接校验过的 IP
  └─ 结果末尾追加 [dsh-proxy-switch] 警告段落（如果有）
```

两个转发器的 `getMode` 都等于 `effectiveMode()`，所以每个请求在处理时都会重新判定线路。

### 3.2 检测生命周期（v0.4）

触发时机：插件启动；每次切换模式（`setMode` 提交后）；`upstreamSource` 改回 `auto`；探测失败（30 秒限频）；auto 模式下遇到 fake-IP 拒绝（10 秒限频）；`POST /detect`（不限频）。

`runDetection` 同一时间只运行一个实例。它在命令队列之外执行，只把最后一步写入放进队列；写入前会再检查一次 `upstreamSource === "auto"`，防止和用户的手动修改竞争。找到的地址先经过 `parseUpstream`，再写入 `state.json`，然后立刻探测一次。

`detectUpstream` 的顺序：

1. 系统代理和环境变量（显式配置）：只要对方返回 HTTP 状态行就接受，包括 4xx/5xx。
2. 扫描 `COMMON_PORTS`：必须返回 200（可用）或 407（需要密码）才接受。

本插件自己的端口（`listenPort`、web_fetch 通道端口、global 通道端口）永远不会成为候选。

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

---

## 6. 建议重点审查的风险（按优先级）

下面是作者已知或怀疑的问题，**不是已修复清单**。请逐条判断是否成立、能否被利用、修复代价多大。

### A1（高）走代理时，主机名形式的内网目标不受检查

`forwarder.js` 在 forward 模式下只拒绝**非公网 IP 字面量**（:355、:577）。主机名会原样交给上游代理去解析，例如 `http://localhost:8080/`、`http://127.0.0.1.nip.io/`、某个解析到 `10.x` 的内部域名。本机代理（Clash 等）会在本机解析并连接，也就是说，模型可以借 `web_fetch` 访问用户本机或局域网的服务（SSRF）。上游 `dsh-web-fetch-http` 在走代理时同样跳过了检查，所以这是"和原生行为一致"，但：

- v0.4 把 `auto` 设为默认，代理在运行时 forward 是最常见的路径，影响面比 v0.3 大；
- 在 TUN/fake-IP 环境下，本地 DNS 对所有域名都返回 198.18.x.x，没法在本地预先判断。

可以讨论的缓解办法：拒绝 `localhost`、`*.localhost` 和单标签主机名；本地预解析的结果如果是非 fake-IP 的私网地址就拒绝；或者在 forward 模式下也要求整组解析结果为公网或 fake-IP。请评估误伤和绕过的可能。

### A2（中）控制接口不经过 DSH 的身份校验

`/dsh-proxy-switch/*` 通过 `webServer.register({ kind: "prefix" })` 注册。实测 DSH Web 端口的 `/` 返回 401，而 `GET /dsh-proxy-switch/state` 不带令牌就能返回 200。`guard`（index.js :656）只检查 loopback、`Sec-Fetch-Site` 和 `Origin`，**没有 `Origin` 头的本机进程可以直接读取状态、切换模式、改写上游**，例如把 `web_fetch` 的流量导向一个恶意代理，以便查看明文 HTTP 或篡改内容。另外 guard 不校验 `Host` 头：DNS rebinding 页面发起的同源 GET 不带 `Origin`，可能读到状态（上游已脱敏，但能看到 `stats.lastHost`）。POST 会带 `Origin`，所以会被拒绝。请确认 DSH 是否提供插件路由可用的鉴权钩子。

### A3（中）私有 web_fetch 通道是 loopback 上没有认证的开放代理

web_fetch 转发器监听 127.0.0.1 的随机端口，任何本机进程都能把它当 HTTP 代理用，而且走代理时它会替请求附上上游的 `Proxy-Authorization`。直连时仍然有 SSRF 检查。这是 v0.3 的 R11，v0.4 没有变化。

### A4（中）检测会自动采用系统代理和环境变量指向的任何地址

系统代理、`HTTPS_PROXY` 可以指向局域网甚至公网主机。`upstreamSource=auto` 时，插件会验证后直接采用，之后 web_fetch 的流量都会发往那里。这符合"用户配置了什么就用什么"的预期，但请评估：同一用户会话里的恶意程序能否通过修改系统代理设置来劫持 web_fetch（它本来就能做别的事，是否构成新的攻击面）？验证握手（`verifyHttpProxy`）会把环境变量里的凭据发给候选地址；扫描到的端口不带凭据。

### A5（低）检测相关的资源消耗

`POST /detect` 不限频，每次最多并发连接约 11 个本机端口，外加若干次 `CONNECT example.com:443`。结合 A2，本机进程可以反复触发。探测失败时的自动重测有 30 秒限频，fake-IP 拒绝触发的重测有 10 秒限频。

### A6（低）auto 的判定依据只是 TCP 可达

`probeUpstream` 只做 TCP connect。端口在监听但代理已经坏掉（例如订阅失效）时，auto 仍然会选 forward，导致 web_fetch 失败，而且不会自动回退到直连（设计上没有静默回退）。每次 web_fetch 之前会以 1 秒的新鲜度重新探测，以减少代理刚关闭时的误判。

### A7（低）Linux 上的 `gsettings` 依赖 PATH

macOS 的 `scutil` 和 Windows 的 `reg.exe` 用的是绝对路径（`reg.exe` 取自 `SystemRoot` 环境变量）；Linux 的 `gsettings` 从 PATH 查找。所有调用都使用 `execFile`，参数是常量，没有 shell。

### 沿用 v0.3 的检查清单

`REVIEW.md` 第 6 节的 8 个问题仍然适用：`HttpFetchProvider` 是否还有其它网络入口、volatile ref 在反复启停时是否会悬空、隧道在异常和取消路径上是否都被销毁、NAT64 发现失败时是否会放行、回滚分支是否完整、`<invalid-upstream>` 之外是否还有未脱敏的路径、IPv6 方括号规则是否一致。

---

## 7. 测试覆盖对照

| 区域 | 测试 | 说明 |
|---|---|---|
| IP 分类、mapped/translated、NAT64、authority | `test/net-guard.test.mjs` | 纯函数 |
| 转发器严格性、畸形 CONNECT、407、错误响应 | `test/forwarder.test.mjs` | 真实 socket |
| 探测 | `test/probe.test.mjs` | |
| 状态规范化、0.3→0.4 迁移、权限、脱敏 | `test/state.test.mjs` | |
| 警告状态机、`effectiveModeOf` | `test/messages.test.mjs` | |
| 检测：三平台解析、环境变量、`CONNECT` 分类、候选顺序、排除自身端口 | `test/detect.test.mjs` | 本机假服务器，不联网 |
| 客户端：挂载点、渲染、横幅优先级、三段开关 | `test/client.test.mjs` | 用简化版 React 渲染 |
| Host 集成：provider 接管、R1 隧道隔离、R3 NO_PROXY、R6 并发、R7 脱敏、R8 IPv6、**F：auto 与检测** | `scripts/e2e-host.mjs` | 真实 Cordis/WebRuntime/HttpFetchProvider，53 项 |
| 真实上游 | `scripts/e2e-real.mjs` | 需要本机 HTTP 代理 |
| web_fetch 警告文本 | `scripts/e2e-web-fetch-warning.mjs` | |

最近一次结果（2026-11-04，macOS，Node 22）：单元测试 88/88，Host 集成 53/53，e2e-real 4/4（本机 1082 代理），警告文本 5 种组合全部符合预期。

---

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
