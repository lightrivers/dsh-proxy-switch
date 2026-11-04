/**
 * Upstream proxy auto-detection for `dsh-proxy-switch`.
 *
 * People run very different proxy clients (Clash, Surge, v2rayN, MacPacket, …) on very
 * different ports, so asking them to type `http://127.0.0.1:<port>` is the single most
 * error-prone step of the setup. This module finds the address instead, in decreasing
 * order of how explicitly the user configured it:
 *
 * 1. **System proxy settings** — what the proxy client writes when its "system proxy"
 *    switch is on: macOS `scutil --proxy`, Windows `Internet Settings` in the registry,
 *    Linux GNOME `gsettings` or KDE `kioslaverc`.
 * 2. **Launch environment** — `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` as DSH was
 *    started (never the values this plugin itself installs for `global` scope).
 * 3. **Local port scan** — a short list of well-known HTTP / mixed ports on 127.0.0.1.
 *
 * Every candidate is verified with one `CONNECT` handshake before it is used. An explicit
 * candidate (1, 2) is accepted when it answers any HTTP status line, because a proxy that
 * refuses the probe target by rule is still the proxy the user configured; a scanned
 * port must answer `200` (or `407`, meaning "a proxy that wants credentials") so an
 * unrelated local web server on a common port is never mistaken for a proxy.
 *
 * Nothing here runs a shell: platform readers use `execFile` with absolute paths where
 * the OS has a fixed location, a short timeout, and no user-controlled arguments.
 * Detection never throws; every failure becomes a `tried` entry the UI can show.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Well-known local HTTP / mixed proxy ports, most common first. */
export const COMMON_PORTS = Object.freeze([
  7890, // Clash / Mihomo / ClashX mixed port
  7897, // Clash Verge Rev mixed port
  6152, // Surge HTTP
  1087, // ShadowsocksX-NG / V2rayU HTTP
  10809, // v2rayN HTTP
  10808, // v2rayN mixed (newer releases)
  2080, // NekoBox / sing-box mixed
  20171, // v2rayA HTTP
  8889, // Qv2ray HTTP
  1082,
  1080, // usually SOCKS; kept for mixed-port setups
]);

/** The CONNECT target used to prove a candidate speaks the HTTP proxy protocol. */
export const VERIFY_TARGET = "example.com:443";
const VERIFY_TIMEOUT_MS = 2_000;
const EXEC_TIMEOUT_MS = 2_000;
const MAX_HEAD_BYTES = 8 * 1024;

function runFile(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
        resolve(error ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/** Build `http://host:port`, or `null` when the pieces cannot form a valid upstream. */
export function upstreamUrl(host, port) {
  const name = String(host ?? "").trim();
  const number = Number(port);
  if (name === "" || !Number.isInteger(number) || number < 1 || number > 65_535) return null;
  const bracketed = net.isIP(name) === 6 ? `[${name}]` : name;
  try {
    const url = new URL(`http://${bracketed}:${number}`);
    return url.hostname === "" ? null : `http://${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Parse `scutil --proxy` output (macOS).
 *
 * @param text - the command output.
 * @returns HTTPS then HTTP proxy URLs that are enabled, de-duplicated.
 */
export function parseScutilProxy(text) {
  const values = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/u);
    if (match !== null) values.set(match[1], match[2]);
  }
  const result = [];
  for (const prefix of ["HTTPS", "HTTP"]) {
    if (values.get(`${prefix}Enable`) !== "1") continue;
    const url = upstreamUrl(values.get(`${prefix}Proxy`), values.get(`${prefix}Port`));
    if (url !== null && !result.includes(url)) result.push(url);
  }
  return result;
}

/**
 * Parse one Windows `ProxyServer` value.
 *
 * Accepts `host:port` (all protocols) and `http=host:port;https=host:port;socks=…`.
 * SOCKS entries are ignored: the plugin only speaks to HTTP upstreams.
 *
 * @param value - the registry string.
 * @returns HTTPS then HTTP proxy URLs, de-duplicated.
 */
export function parseWindowsProxyServer(value) {
  const text = String(value ?? "").trim();
  if (text === "") return [];
  const entries = new Map();
  if (!text.includes("=")) {
    entries.set("all", text);
  } else {
    for (const part of text.split(";")) {
      const index = part.indexOf("=");
      if (index === -1) continue;
      entries.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
    }
  }
  const result = [];
  for (const key of ["https", "http", "all"]) {
    const raw = entries.get(key);
    if (raw === void 0 || raw === "") continue;
    const stripped = raw.replace(/^https?:\/\//iu, "");
    const colon = stripped.lastIndexOf(":");
    if (colon === -1) continue;
    const url = upstreamUrl(stripped.slice(0, colon).replace(/^\[|\]$/gu, ""), stripped.slice(colon + 1));
    if (url !== null && !result.includes(url)) result.push(url);
  }
  return result;
}

/**
 * Parse `reg query "HKCU\…\Internet Settings"` output (Windows).
 *
 * @param text - the command output.
 * @returns proxy URLs when `ProxyEnable` is 1, otherwise an empty list.
 */
export function parseWindowsInternetSettings(text) {
  let enabled = false;
  let server = "";
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer)\s+REG_\w+\s+(.*?)\s*$/u);
    if (match === null) continue;
    if (match[1] === "ProxyEnable") enabled = Number(match[2]) === 1;
    else server = match[2];
  }
  return enabled ? parseWindowsProxyServer(server) : [];
}

/** Strip the quotes `gsettings get` puts around a string value. */
export function parseGsettingsValue(text) {
  return String(text ?? "")
    .trim()
    .replace(/^'(.*)'$/su, "$1");
}

/**
 * Parse KDE's `kioslaverc` `[Proxy Settings]` group.
 *
 * `ProxyType=1` is "manual"; the address is `http://host port` (KDE's own form, with a
 * space) or `http://host:port`.
 *
 * @param text - the file content.
 * @returns HTTPS then HTTP proxy URLs.
 */
export function parseKioslaverc(text) {
  let inGroup = false;
  const values = new Map();
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/u);
    if (header !== null) {
      inGroup = header[1] === "Proxy Settings";
      continue;
    }
    if (!inGroup) continue;
    const index = line.indexOf("=");
    if (index !== -1) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  if (values.get("ProxyType") !== "1") return [];
  const result = [];
  for (const key of ["httpsProxy", "httpProxy"]) {
    const raw = values.get(key);
    if (raw === void 0 || raw === "") continue;
    const normalized = raw.replace(/^https?:\/\//iu, "").replace(/\s+(\d+)$/u, ":$1");
    const colon = normalized.lastIndexOf(":");
    if (colon === -1) continue;
    const url = upstreamUrl(normalized.slice(0, colon).replace(/^\[|\]$/gu, ""), normalized.slice(colon + 1));
    if (url !== null && !result.includes(url)) result.push(url);
  }
  return result;
}

/**
 * Read an HTTP proxy from an environment snapshot.
 *
 * Only `http://` values are returned: a `socks5://ALL_PROXY` is not something this plugin
 * can forward to. A value carrying credentials is returned unchanged; the caller masks it
 * before showing it anywhere.
 *
 * @param getEnv - `(name) => string | undefined`.
 * @returns proxy URLs in `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` order.
 */
export function proxiesFromEnvironment(getEnv) {
  const result = [];
  for (const name of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]) {
    const value = String(getEnv(name) ?? "").trim();
    if (value === "") continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" || url.hostname === "") continue;
    const text = `http://${url.username !== "" || url.password !== "" ? `${url.username}:${url.password}@` : ""}${url.host}`;
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

/**
 * Read the operating system's proxy settings.
 *
 * @param options.platform - `process.platform` override for tests.
 * @param options.run - `(file, args) => Promise<string | null>` override for tests.
 * @param options.readText - `(path) => Promise<string | null>` override for tests.
 * @param options.env - environment used to locate system tools.
 * @returns `{ urls, reader }`; `reader` names what was consulted.
 */
export async function readSystemProxy(options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runFile;
  const env = options.env ?? process.env;
  const readText = options.readText ?? ((path) => readFile(path, "utf8").catch(() => null));
  if (platform === "darwin") {
    return { reader: "scutil", urls: parseScutilProxy(await run("/usr/sbin/scutil", ["--proxy"])) };
  }
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    const output = await run(join(root, "System32", "reg.exe"), [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    ]);
    return { reader: "registry", urls: parseWindowsInternetSettings(output) };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    const gnomeMode = parseGsettingsValue(await run("gsettings", ["get", "org.gnome.system.proxy", "mode"]));
    if (gnomeMode === "manual") {
      const urls = [];
      for (const scheme of ["https", "http"]) {
        const host = parseGsettingsValue(await run("gsettings", ["get", `org.gnome.system.proxy.${scheme}`, "host"]));
        const port = parseGsettingsValue(await run("gsettings", ["get", `org.gnome.system.proxy.${scheme}`, "port"]));
        const url = upstreamUrl(host, port);
        if (url !== null && !urls.includes(url)) urls.push(url);
      }
      if (urls.length > 0) return { reader: "gsettings", urls };
    }
    const configHome = env.XDG_CONFIG_HOME || join(options.home ?? homedir(), ".config");
    const kde = parseKioslaverc(await readText(join(configHome, "kioslaverc")));
    return { reader: kde.length > 0 ? "kioslaverc" : "gsettings", urls: kde };
  }
  return { reader: "none", urls: [] };
}

/**
 * Send one `CONNECT` to a candidate and classify the answer.
 *
 * @param url - candidate upstream (`http://[user:pass@]host:port`).
 * @param options.timeoutMs - total budget.
 * @param options.target - CONNECT authority.
 * @returns `{ kind, status?, latencyMs, error? }` where `kind` is `proxy` (200),
 *   `proxy-auth` (407), `http` (another status line), or `none`.
 */
export function verifyHttpProxy(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const target = options.target ?? VERIFY_TARGET;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ kind: "none", latencyMs: 0, error: "invalid-url" });
      return;
    }
    const host = parsed.hostname.replace(/^\[|\]$/gu, "");
    const port = parsed.port === "" ? 80 : Number(parsed.port);
    let settled = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve({ ...result, latencyMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => finish({ kind: "none", error: "timeout" }), timeoutMs);
    timer.unref?.();
    try {
      socket = net.connect({ host, port });
    } catch (error) {
      finish({ kind: "none", error: error?.code ?? "error" });
      return;
    }
    let buffered = "";
    socket.setEncoding("latin1");
    socket.once("error", (error) => finish({ kind: "none", error: error?.code ?? "error" }));
    socket.once("close", () => finish({ kind: "none", error: "closed" }));
    socket.once("connect", () => {
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (parsed.username !== "" || parsed.password !== "") {
        try {
          const user = decodeURIComponent(parsed.username);
          const pass = decodeURIComponent(parsed.password);
          lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`);
        } catch {
          /* undecodable credentials: probe without them; a 407 says so */
        }
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffered += chunk;
      const end = buffered.indexOf("\r\n");
      if (end === -1) {
        if (buffered.length > MAX_HEAD_BYTES) finish({ kind: "none", error: "oversized" });
        return;
      }
      const match = buffered.slice(0, end).match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/u);
      if (match === null) {
        finish({ kind: "none", error: "not-http" });
        return;
      }
      const status = Number(match[1]);
      finish({ kind: status === 200 ? "proxy" : status === 407 ? "proxy-auth" : "http", status });
    });
  });
}

function sameLoopbackPort(url, ports) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/gu, "");
    const loopback = host === "localhost" || host === "::1" || host.startsWith("127.");
    return loopback && ports.includes(Number(parsed.port === "" ? 80 : parsed.port));
  } catch {
    return false;
  }
}

/**
 * Find the user's HTTP proxy.
 *
 * @param options.getEnv - launch-environment reader `(name) => string | undefined`.
 * @param options.excludePorts - this plugin's own loopback ports; never candidates.
 * @param options.commonPorts - scan list override.
 * @param options.readSystem - {@link readSystemProxy} override for tests.
 * @param options.verify - {@link verifyHttpProxy} override for tests.
 * @returns `{ found, tried }`. `found` is `{ url, source, reader?, needsAuth, latencyMs }`
 *   or `null`; `tried` lists every candidate with its verdict (URLs unmasked — mask
 *   before exposing them).
 */
export async function detectUpstream(options = {}) {
  const getEnv = options.getEnv ?? ((name) => process.env[name]);
  const excludePorts = (options.excludePorts ?? []).filter((port) => Number.isInteger(port));
  const commonPorts = options.commonPorts ?? COMMON_PORTS;
  const readSystem = options.readSystem ?? (() => readSystemProxy());
  const verify = options.verify ?? verifyHttpProxy;
  const tried = [];
  const seen = new Set();

  const accept = (url, source, result, extra) => ({
    url,
    source,
    ...extra,
    needsAuth: result.kind === "proxy-auth",
    latencyMs: result.latencyMs ?? null,
  });

  let system = { reader: "none", urls: [] };
  try {
    system = await readSystem();
  } catch {
    /* an unreadable system setting is simply "nothing configured" */
  }
  const explicit = [
    ...system.urls.map((url) => ({ url, source: "system", reader: system.reader })),
    ...proxiesFromEnvironment(getEnv).map((url) => ({ url, source: "environment" })),
  ];
  for (const candidate of explicit) {
    if (seen.has(candidate.url) || sameLoopbackPort(candidate.url, excludePorts)) continue;
    seen.add(candidate.url);
    const result = await verify(candidate.url);
    tried.push({ url: candidate.url, source: candidate.source, kind: result.kind, error: result.error ?? null });
    if (result.kind !== "none") {
      return { found: accept(candidate.url, candidate.source, result, candidate.reader ? { reader: candidate.reader } : {}), tried };
    }
  }

  const scan = commonPorts
    .filter((port) => !excludePorts.includes(port))
    .map((port) => `http://127.0.0.1:${port}`)
    .filter((url) => !seen.has(url));
  const results = await Promise.all(scan.map((url) => verify(url).then((result) => ({ url, result }))));
  let found = null;
  for (const { url, result } of results) {
    tried.push({ url, source: "scan", kind: result.kind, error: result.error ?? null });
    if (found === null && (result.kind === "proxy" || result.kind === "proxy-auth")) found = accept(url, "scan", result, {});
  }
  return { found, tried };
}
