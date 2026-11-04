import test from "node:test";
import assert from "node:assert/strict";

/**
 * The Client half has no build step: it is a plain script that registers a factory on
 * `window.__ModuleLoader__`. These tests load it in Node with a minimal React stand-in:
 * `createElement` builds a plain tree, effects run immediately, and a tiny renderer
 * expands function components so the visible text of a whole view can be asserted.
 *
 * The Host is replaced by a `fetch` stub, so the shared state store sees exactly the
 * state a test provides. Node has no DSH locale, so the English text is rendered.
 */

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children }, children }),
    Fragment: Symbol("Fragment"),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: (effect) => {
      effect();
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  };
}

/** Expand function components and collect every text node and every element. */
function render(node, out = { text: [], elements: [] }) {
  if (node === null || node === void 0 || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) render(child, out);
    return out;
  }
  if (typeof node.type === "function") return render(node.type(node.props), out);
  out.elements.push(node);
  for (const child of node.children ?? []) render(child, out);
  return out;
}

let captured;
globalThis.window = { __ModuleLoader__: { load: (mod) => (captured = mod) } };
await import("../client.js");

let hostState = null;
let hostDown = false;
globalThis.fetch = async (url) => {
  if (hostDown) return { ok: false, status: 502, json: async () => ({}) };
  assert.equal(url, "/dsh-proxy-switch/state");
  return { ok: true, status: 200, json: async () => hostState };
}

function loadPlugin() {
  const plugin = captured.factory((specifier) => {
    if (specifier === "react") return fakeReact();
    throw new Error(`unexpected require: ${specifier}`);
  });
  const registered = {};
  plugin.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        registered[options.name] = { options, component };
        return () => {};
      },
    },
    on: () => () => {},
    get: () => void 0,
  });
  return { plugin, registered };
}

/** Render the plugin page (the full panel) after the store has read `state`. */
async function renderPage(state) {
  hostState = state;
  const { registered } = loadPlugin();
  const page = registered["plugins.bundle.config"].component;
  render(page({ view: "page" }));
  // The first render subscribed the store and started a read; let it land.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return render(page({ view: "page" }));
}

function baseState(overrides = {}) {
  return {
    plugin: "dsh-proxy-switch",
    version: "0.4.0",
    mode: "auto",
    effectiveMode: "forward",
    scope: "web_fetch_only",
    listenPort: 7899,
    upstream: "http://127.0.0.1:1082",
    upstreamHasCredentials: false,
    upstreamSource: "auto",
    detection: { status: "found", source: "system", reader: "scutil", needsAuth: false, checkedAt: 1, tried: [] },
    provider: { id: "dsh-proxy-switch", status: "active", error: null },
    probe: { reachable: true, latencyMs: 3, error: null, checkedAt: 1 },
    warning: null,
    lastError: null,
    stats: { requests: 2, failures: 0 },
    ...overrides,
  };
}

test("client.js registers the sidebar pill, the header pill, and the plugin page", () => {
  assert.ok(captured, "the module loader must receive one declaration");
  assert.equal(captured.id, "@lightrivers/dsh-proxy-switch");
  const { plugin, registered } = loadPlugin();
  assert.deepEqual(plugin.inject, ["slots"]);
  assert.deepEqual(Object.keys(registered).sort(), [
    "conversation.session.header.utilities",
    "plugins.bundle.config",
    "sidebar.footer.action",
  ]);
  assert.equal(registered["sidebar.footer.action"].options.id, "@lightrivers/dsh-proxy-switch");
  assert.equal(registered["sidebar.footer.action"].options.order, 40);
  // The plugin page is keyed by the npm package name, as the Plugins page requires.
  assert.equal(registered["plugins.bundle.config"].options.key, "@lightrivers/dsh-proxy-switch");
});

test("the pill renders in the sidebar by default and not in the header", () => {
  hostState = null;
  const { registered } = loadPlugin();
  const sidebar = registered["sidebar.footer.action"].component({ wide: true });
  assert.equal(sidebar.props.children[0].type, "button");
  assert.match(sidebar.props.children[0].props["aria-label"], /Proxy Switch/);
  assert.equal(registered["conversation.session.header.utilities"].component({}), null);
});

test("the page shows a loading hero before the first state", async () => {
  hostDown = false;
  const view = await renderPage(null);
  assert.match(view.text.join("\n"), /Reading the state/);
});

test("auto + reachable proxy: the hero names the route, the scope chip says web_fetch only", async () => {
  const text = (await renderPage(baseState())).text.join("\n");
  assert.match(text, /Going through the proxy/);
  assert.match(text, /Auto: your proxy app is running/);
  assert.match(text, /web_fetch only/);
  assert.match(text, /127\.0\.0\.1:1082/);
  assert.match(text, /system proxy/);
  assert.doesNotMatch(text, /Switch to Auto/);
});

test("global scope is visible on the hero", async () => {
  const text = (await renderPage(baseState({ scope: "global", policySelfCheck: { ok: true } }))).text.join("\n");
  assert.match(text, /All tools/);
});

test("each mismatch offers its one-click fix", async () => {
  const pinnedDirect = await renderPage(
    baseState({ mode: "direct", effectiveMode: "direct", warning: { code: "DIRECT_WITH_UPSTREAM", severity: "warn" } }),
  );
  assert.match(pinnedDirect.text.join("\n"), /Your proxy app is running[\s\S]*Switch to Auto/);

  const pinnedForward = await renderPage(
    baseState({ mode: "forward", probe: { reachable: false }, warning: { code: "FORWARD_WITHOUT_UPSTREAM", severity: "error" } }),
  );
  assert.match(pinnedForward.text.join("\n"), /Cannot reach your proxy app[\s\S]*Switch to Auto/);

  const missing = await renderPage(
    baseState({
      effectiveMode: "direct",
      probe: { reachable: false },
      detection: { status: "none", tried: [] },
      warning: { code: "AUTO_PROXY_NOT_FOUND", severity: "warn" },
    }),
  );
  const missingText = missing.text.join("\n");
  assert.match(missingText, /Proxy port not found[\s\S]*Enter the address[\s\S]*Search again/);
  assert.match(missingText, /No usable proxy port found/);
});

test("a proxy that wants credentials asks for a manual address", async () => {
  const text = (await renderPage(baseState({ detection: { status: "found", source: "system", needsAuth: true, tried: [] } }))).text.join("\n");
  assert.match(text, /needs a username and password[\s\S]*Enter the address/);
});

test("an unreadable Host state becomes a retry banner", async () => {
  hostDown = true;
  try {
    const text = (await renderPage(null)).text.join("\n");
    assert.match(text, /Cannot read the plugin state[\s\S]*Retry now/);
  } finally {
    hostDown = false;
  }
});

test("the route switch is a three-way radio group with Auto first", async () => {
  const view = await renderPage(baseState());
  const radios = view.elements.filter((element) => element.props.role === "radio" && element.props.className === "dps-seg-btn");
  assert.equal(radios.length, 3);
  assert.equal(radios[0].props["aria-checked"], true);
  assert.deepEqual(
    radios.map((radio) => radio.children.filter((child) => typeof child === "string")[0]),
    ["Auto", "Proxy", "Direct"],
  );
});
