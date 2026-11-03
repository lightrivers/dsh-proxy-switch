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
 */

export const WARNING_DIRECT_WITH_UPSTREAM = "DIRECT_WITH_UPSTREAM";
export const WARNING_FORWARD_WITHOUT_UPSTREAM = "FORWARD_WITHOUT_UPSTREAM";

const SCOPES = new Set(["web_fetch_only", "global"]);

/**
 * Decide the current warning.
 *
 * @param input.mode - the active mode.
 * @param input.reachable - the last probe result; `null` means "not measured yet".
 * @param input.scope - `web_fetch_only` (default) or `global`.
 * @returns the warning object, or `null` when the combination is healthy.
 */
export function warningFor(input) {
  const { mode, reachable } = input;
  const scope = SCOPES.has(input.scope) ? input.scope : "global";
  const webFetchOnly = scope === "web_fetch_only";
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
      actionZh: "关闭代理客户端，或把开关切到「转发」。",
      actionEn: 'Turn the proxy client off, or switch this switch to "forward".',
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
      actionZh: "启动代理客户端，或把开关切到「直连」。",
      actionEn: 'Start the proxy client, or switch this switch to "direct".',
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
