/**
 * Durable switch state for `dsh-proxy-switch`.
 *
 * The mode is user-facing runtime state, not plugin configuration: it must survive a
 * Harness restart while the user never edits YAML. It lives in the documented plugin
 * storage directory (`$DSH_HOME/storages/<plugin>/state.json`) and is rewritten
 * atomically so a crash mid-write cannot leave an unreadable file.
 *
 * The file may hold proxy credentials (`http://user:pass@host:port`), so it is created
 * and repaired to `0600`. Everything that leaves this module — the Web API snapshot,
 * repair notes, warnings — goes through {@link maskUpstream}; the unmasked value is
 * only used to build the upstream `Proxy-Authorization` header.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STATE_SCHEMA_VERSION = 3;
export const DEFAULT_LISTEN_PORT = 7899;
export const DEFAULT_UPSTREAM = "http://127.0.0.1:1082";
export const DEFAULT_PROBE_INTERVAL_MS = 15_000;
export const MIN_PROBE_INTERVAL_MS = 3_000;
export const MAX_PROBE_INTERVAL_MS = 600_000;

/**
 * The user's route choice. `auto` follows the probe: forward while the upstream answers,
 * direct while it does not. `forward` / `direct` pin one route regardless of the probe.
 */
export const MODES = Object.freeze(["auto", "forward", "direct"]);

/**
 * Where the upstream address comes from. `auto` lets {@link ./detect.js} replace it with
 * whatever the system proxy settings, the launch environment, or a local port scan find;
 * `manual` keeps the address the user typed and never overwrites it.
 */
export const UPSTREAM_SOURCES = Object.freeze(["auto", "manual"]);

/** How much of the outbound path this plugin is allowed to own. */
export const SCOPE_WEB_FETCH_ONLY = "web_fetch_only";
export const SCOPE_GLOBAL = "global";
export const SCOPES = Object.freeze([SCOPE_WEB_FETCH_ONLY, SCOPE_GLOBAL]);

/**
 * First-run defaults: the route follows the probe (`auto`), the upstream address is
 * detected, and the least invasive scope wins. `web_fetch_only` keeps model calls and other
 * modules on the original outbound path; only the `web_fetch` target this plugin observes
 * is held to the strict direct-mode check.
 */
export const DEFAULT_STATE = Object.freeze({
  schemaVersion: STATE_SCHEMA_VERSION,
  mode: "auto",
  scope: SCOPE_WEB_FETCH_ONLY,
  listenPort: DEFAULT_LISTEN_PORT,
  upstream: DEFAULT_UPSTREAM,
  upstreamSource: "auto",
  probeIntervalMs: DEFAULT_PROBE_INTERVAL_MS,
  lastSwitchAt: null,
});

export function storageDir(dshHome) {
  return join(dshHome, "storages", "dsh-proxy-switch");
}

export function statePath(dshHome) {
  return join(storageDir(dshHome), "state.json");
}

export function isLoopbackPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65_535;
}

/**
 * A percent sign that does not start a two-digit hex escape.
 *
 * `decodeURIComponent("u%ZZ")` throws `URIError`; validating here keeps the throw out of
 * the forwarding path, where it would surface as an uncaught exception in an event
 * handler rather than a configuration error.
 */
const BROKEN_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/u;

/**
 * Validate and normalize one upstream proxy URL.
 *
 * Only `http://` is accepted: a SOCKS URL would be rejected by `dsh-http-proxy` anyway,
 * and this plugin's forwarding is plain HTTP. An `https://` upstream is refused for the
 * same reason the product decision names one scheme, so the UI can say so instead of
 * half-working.
 *
 * @param value - candidate upstream URL.
 * @returns `{ ok: true, url }` or `{ ok: false, error }` with a user-facing message.
 */
export function parseUpstream(value) {
  const text = String(value ?? "").trim();
  if (text === "") return { ok: false, error: "上游地址不能为空。The upstream address must not be empty." };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "上游地址不是合法 URL。The upstream address is not a valid URL." };
  }
  if (parsed.protocol !== "http:") {
    return {
      ok: false,
      error: `只支持 http:// 上游（收到 ${parsed.protocol}//）。仅支持 HTTP 上游代理，不支持 SOCKS/PAC。 Only http:// upstreams are supported; SOCKS/PAC is not.`,
    };
  }
  if (parsed.hostname === "") {
    return { ok: false, error: "上游地址缺少主机名。The upstream address has no hostname." };
  }
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { ok: false, error: "上游端口不合法。The upstream port is invalid." };
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return {
      ok: false,
      error: "上游地址不能带路径、查询串或片段，只接受 http://host:port。An upstream must be http://host:port without a path, query, or fragment.",
    };
  }
  for (const [field, label] of [
    [parsed.username, "用户名 / username"],
    [parsed.password, "密码 / password"],
  ]) {
    if (BROKEN_PERCENT_ESCAPE.test(field)) {
      return {
        ok: false,
        error: `上游凭据的百分号编码不完整（${label}）。The upstream credentials contain an incomplete percent-encoding (${label}).`,
      };
    }
    try {
      decodeURIComponent(field);
    } catch {
      return {
        ok: false,
        error: `上游凭据无法解码（${label}）。The upstream credentials cannot be decoded (${label}).`,
      };
    }
  }
  return { ok: true, url: parsed };
}

/**
 * Return an upstream URL safe to show in the Web API, the sidebar, a warning, or a log.
 *
 * The username stays visible (it is usually not secret and helps the user recognise the
 * proxy), while the password is replaced by `***`. A value that does not parse is
 * returned unchanged but with any `pass@` segment stripped defensively.
 *
 * @param value - upstream URL text.
 * @returns the masked URL text.
 */
export function maskUpstream(value) {
  const parsed = parseUpstream(value);
  if (!parsed.ok) {
    // Never echo an unparseable URL: a password can contain an unencoded `/`, `@`, or a
    // broken percent escape, and a best-effort regex cannot prove it removed every secret.
    return "<invalid-upstream>";
  }
  const url = parsed.url;
  if (url.username === "" && url.password === "") return url.origin;
  const user = url.username === "" ? "***" : url.username;
  return `${url.protocol}//${user}:***@${url.host}`;
}

/**
 * Merge persisted state over defaults, dropping every invalid field rather than
 * failing the whole load — a corrupt single field must not brick the plugin.
 *
 * @param raw - the parsed JSON body, or `undefined` when no file exists.
 * @param overrides - configuration-supplied defaults (Loader `config`).
 * @returns the effective state plus a list of human-readable repair notes.
 */
export function normalizeState(raw, overrides = {}) {
  const notes = [];
  const candidate = raw !== null && typeof raw === "object" ? raw : {};
  const base = { ...DEFAULT_STATE, ...overrides };
  // An upstream given in the Loader config is as deliberate as one typed in the panel.
  if (!UPSTREAM_SOURCES.includes(overrides.upstreamSource)) {
    base.upstreamSource = typeof overrides.upstream === "string" && overrides.upstream !== DEFAULT_UPSTREAM ? "manual" : "auto";
  }
  const mode = MODES.includes(candidate.mode) ? candidate.mode : base.mode;
  if (candidate.mode !== void 0 && candidate.mode !== mode) notes.push(`unknown mode "${candidate.mode}" ignored`);

  const scope =
    candidate.scope === SCOPE_WEB_FETCH_ONLY || candidate.scope === SCOPE_GLOBAL ? candidate.scope : base.scope;
  if (candidate.scope !== void 0 && candidate.scope !== scope) {
    notes.push(`unknown scope "${candidate.scope}" ignored`);
  }

  const listenPort = isLoopbackPort(candidate.listenPort) ? candidate.listenPort : base.listenPort;
  if (candidate.listenPort !== void 0 && candidate.listenPort !== listenPort) {
    notes.push(`invalid listenPort "${candidate.listenPort}" ignored`);
  }

  const upstreamInput = typeof candidate.upstream === "string" ? candidate.upstream : base.upstream;
  const upstream = parseUpstream(upstreamInput);
  const upstreamValue = upstream.ok ? upstreamInput : base.upstream;
  if (!upstream.ok) {
    // Never echo a credential into a note that the Web API and the log both carry.
    notes.push(`invalid upstream "${maskUpstream(upstreamInput)}" ignored`);
  }

  // A state file from v0.3 has no source. Its upstream is either the old built-in default
  // (never touched, so detection may replace it) or an address the user typed (keep it).
  let upstreamSource;
  if (UPSTREAM_SOURCES.includes(candidate.upstreamSource)) {
    upstreamSource = candidate.upstreamSource;
  } else {
    if (candidate.upstreamSource !== void 0) notes.push(`unknown upstreamSource "${candidate.upstreamSource}" ignored`);
    upstreamSource = typeof candidate.upstream === "string" && upstreamValue !== DEFAULT_UPSTREAM ? "manual" : base.upstreamSource;
  }

  const rawInterval = Number(candidate.probeIntervalMs ?? base.probeIntervalMs);
  const probeIntervalMs =
    Number.isFinite(rawInterval) && rawInterval >= MIN_PROBE_INTERVAL_MS && rawInterval <= MAX_PROBE_INTERVAL_MS
      ? Math.round(rawInterval)
      : base.probeIntervalMs;
  if (!Number.isFinite(rawInterval) || rawInterval !== probeIntervalMs) notes.push("out-of-range probeIntervalMs ignored");

  const lastSwitchAt =
    candidate.lastSwitchAt === null || candidate.lastSwitchAt === void 0 || candidate.lastSwitchAt === ""
      ? null
      : Number.isFinite(Number(candidate.lastSwitchAt))
        ? Number(candidate.lastSwitchAt)
        : null;

  return {
    state: {
      schemaVersion: STATE_SCHEMA_VERSION,
      mode,
      scope,
      listenPort,
      upstream: upstreamValue,
      upstreamSource,
      probeIntervalMs,
      lastSwitchAt,
    },
    notes,
  };
}

/**
 * Read persisted state. A missing file is not an error (first run); an unreadable or
 * malformed one is reported through `notes` and replaced by defaults on the next save.
 *
 * @param dshHome - `$DSH_HOME`.
 * @param overrides - configuration-supplied defaults.
 */
export async function loadState(dshHome, overrides = {}) {
  let text;
  try {
    text = await readFile(statePath(dshHome), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeState(void 0, overrides);
    // The path is not secret, but the OS message can quote more than the plugin wants in a
    // Web snapshot; a category is enough for the notes.
    return { ...normalizeState(void 0, overrides), loadError: `read failed (${error?.code ?? "unknown"})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Node's JSON syntax error quotes a slice of the input. A damaged file may hold the
    // upstream password there, so only a fixed category is reported.
    return { ...normalizeState(void 0, overrides), loadError: "invalid JSON (SyntaxError)" };
  }
  return normalizeState(parsed, overrides);
}

/**
 * Persist state atomically (write a sibling temp file, then rename over the target).
 *
 * The temp file is created `0600`, and the renamed target is chmod-ed again: a pre-existing
 * `state.json` written by an older build may still be `0644`, and rename preserves the temp
 * file's mode but not every platform's `chmod` semantics. The directory is `0700` for the
 * same reason — it may be the only thing protecting a credential on a shared machine.
 *
 * @param dshHome - `$DSH_HOME`.
 * @param state - the state to serialize.
 */
export async function saveState(dshHome, state) {
  const dir = storageDir(dshHome);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mkdir` does not repair an existing directory's mode, and the directory is part of
  // what protects a credential on a shared machine.
  await chmod(dir, 0o700);
  const target = join(dir, "state.json");
  // A random suffix, not `pid + Date.now()`: two saves in the same millisecond must not
  // share a temp path. `wx` makes creation exclusive, so even a collision cannot truncate
  // the other writer's file.
  const temporary = join(dir, `.state.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
