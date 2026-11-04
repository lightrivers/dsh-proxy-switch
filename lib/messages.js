/**
 * Warning state machine for `dsh-proxy-switch`.
 *
 * Two combinations are dangerous and must never be silent:
 *
 * - `direct` while the upstream proxy still answers: the user believes they are direct,
 *   but the TUN/fake-IP client is still answering DNS, so a "direct" request either gets
 *   refused (fake-IP) or silently leaves through the very proxy they meant to stop using.
 * - `forward` while the upstream proxy is gone: every controlled outbound request fails.
 *
 * The same warning object feeds the sidebar badge and the text appended to `web_fetch`
 * results, so the model and the human never disagree about the current state.
 *
 * The text depends on `scope`: with `web_fetch_only` only `web_fetch` is held strictly,
 * other modules keep their original provider/transport, and the warning must not
 * overclaim that "everything fails".
 *
 * `auto` cannot reach either mismatch by construction (it follows the probe). Its own
 * failure is quieter: a TUN/fake-IP client is evidently running (a direct lookup returned
 * 198.18.0.0/15) but no HTTP port was found, so auto falls back to direct and is refused.
 */

export const WARNING_DIRECT_WITH_UPSTREAM = "DIRECT_WITH_UPSTREAM";
export const WARNING_FORWARD_WITHOUT_UPSTREAM = "FORWARD_WITHOUT_UPSTREAM";
export const WARNING_AUTO_PROXY_NOT_FOUND = "AUTO_PROXY_NOT_FOUND";

/**
 * The route a request actually takes.
 *
 * `auto` forwards only on a positive probe: an unknown probe (`null`, before the first
 * result) goes direct, where the SSRF check still applies, rather than to an upstream
 * nobody has confirmed.
 *
 * @param mode - the stored mode: `auto`, `forward`, or `direct`.
 * @param reachable - the last probe result; `null` means "not measured yet".
 * @returns `forward` or `direct`.
 */
export function effectiveModeOf(mode, reachable) {
  if (mode === "auto") return reachable === true ? "forward" : "direct";
  return mode === "forward" ? "forward" : "direct";
}

const SCOPES = new Set(["web_fetch_only", "global"]);

/**
 * Decide the current warning.
 *
 * @param input.mode - the active mode.
 * @param input.reachable - the last probe result; `null` means "not measured yet".
 * @param input.scope - `web_fetch_only` (default) or `global`.
 * @param input.fakeIpSeen - a direct lookup recently returned a fake-IP answer.
 * @returns the warning object, or `null` when the combination is healthy.
 */
export function warningFor(input) {
  const { mode, reachable } = input;
  const scope = SCOPES.has(input.scope) ? input.scope : "global";
  const webFetchOnly = scope === "web_fetch_only";
  if (mode === "auto") {
    if (input.fakeIpSeen !== true || reachable === true) return null;
    return {
      code: WARNING_AUTO_PROXY_NOT_FOUND,
      severity: "warn",
      zh: "代理客户端似乎在运行（网站被解析到 fake-IP 段），但没有找到它的 HTTP 端口，自动模式只能直连，抓取被拒绝。",
      en: "A proxy client seems to be running (sites resolve into the fake-IP block), but its HTTP port was not found, so auto mode goes direct and the fetch is refused.",
      actionZh: "在代理客户端里打开 HTTP 或混合端口，或在插件设置里手动填写代理地址。",
      actionEn: "Enable the HTTP or mixed port in the proxy client, or enter the proxy address manually in the plugin settings.",
      scope,
    };
  }
  if (mode === "direct" && reachable === true) {
    return {
      code: WARNING_DIRECT_WITH_UPSTREAM,
      severity: "warn",
      zh: webFetchOnly
        ? "代理客户端仍在运行：直连模式下 web_fetch 的目标若落在 fake-IP 段会被拒绝；其它模块保持原出站路径。"
        : "代理客户端仍在运行：直连模式下 DNS 可能仍被 fake-IP 劫持，抓取已按策略拒绝。",
      en: webFetchOnly
        ? "The proxy client is still running: in direct mode a web_fetch target that resolves into the fake-IP block is refused, while other modules keep their original outbound path."
        : "The proxy client is still running: in direct mode DNS may still be hijacked by fake-IP, and fetches are refused by policy.",
      actionZh: "关闭代理客户端，或把线路切到「自动」或「走代理」。",
      actionEn: 'Turn the proxy client off, or set the route to "Auto" or "Through proxy".',
      scope,
    };
  }
  if (mode === "forward" && reachable === false) {
    return {
      code: WARNING_FORWARD_WITHOUT_UPSTREAM,
      severity: "error",
      zh: webFetchOnly
        ? "转发模式下上游代理不可用：web_fetch 会失败；其它模块保持原出站路径。"
        : "转发模式下上游代理不可用：所有出站请求都会失败。",
      en: webFetchOnly
        ? "In forward mode the upstream proxy is unreachable: web_fetch will fail, while other modules keep their original outbound path."
        : "In forward mode the upstream proxy is unreachable: every outbound request will fail.",
      actionZh: "启动代理客户端，或把线路切到「自动」或「直连」。",
      actionEn: 'Start the proxy client, or set the route to "Auto" or "Direct".',
      scope,
    };
  }
  return null;
}

/**
 * Render a warning as the exact text appended to a `web_fetch` result.
 *
 * The prefix is stable so a model (and a human reading a transcript) can recognise where
 * the text came from months later.
 *
 * @param warning - one `warningFor` result.
 * @param details - optional extra lines, e.g. the proxy port.
 * @returns the model-facing block text.
 */
export function warningParagraph(warning, details = {}) {
  const lines = [`[dsh-proxy-switch] ⚠️ ${warning.zh}`, warning.en];
  if (warning.actionZh !== void 0) lines.push(`处理建议 / Next step: ${warning.actionZh} ${warning.actionEn}`);
  if (details.mode !== void 0) lines.push(`当前模式 / Mode: ${details.mode}`);
  if (details.scope !== void 0) {
    lines.push(
      `策略范围 / Scope: ${details.scope}` +
        (details.scope === "web_fetch_only" ? " (web_fetch 严格；其它出站沿用原策略 / other outbound keeps the original path)" : ""),
    );
  }
  if (details.upstream !== void 0) lines.push(`上游代理 / Upstream: ${details.upstream}`);
  return lines.join("\n");
}
