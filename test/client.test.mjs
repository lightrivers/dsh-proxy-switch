import test from "node:test";
import assert from "node:assert/strict";

/**
 * The Client half has no build step: it is a plain script that registers a factory on
 * `window.__ModuleLoader__`. Loading it in Node with a minimal `window` catches structural
 * mistakes (missing id, wrong inject list, wrong slot) without a browser.
 */

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol("Fragment"),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  };
}

let captured;
globalThis.window = { __ModuleLoader__: { load: (mod) => (captured = mod) } };
await import("../client.js");

test("client.js registers a sidebar.footer.action occupant", () => {
  assert.ok(captured, "the module loader must receive one declaration");
  assert.equal(captured.id, "dsh-proxy-switch");
  assert.equal(typeof captured.factory, "function");

  const plugin = captured.factory((specifier) => {
    if (specifier === "react") return fakeReact();
    throw new Error(`unexpected require: ${specifier}`);
  });
  assert.deepEqual(plugin.inject, ["slots"]);

  const injections = [];
  let registered;
  plugin.apply({
    slots: {
      inject(slot, callback) {
        injections.push(slot);
        return callback();
      },
      register(options, component) {
        registered = { options, component };
        return () => {};
      },
    },
    on: () => () => {},
    get: () => void 0,
  });

  assert.deepEqual(injections, ["sidebar.footer.action"]);
  assert.equal(registered.options.id, "dsh-proxy-switch");
  assert.equal(registered.options.name, "sidebar.footer.action");
  assert.equal(typeof registered.component, "function");
});

test("the registered component renders a badge without a Host state", () => {
  const React = fakeReact();
  const plugin = captured.factory(() => React);
  let component;
  plugin.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (_options, next) => {
        component = next;
        return () => {};
      },
    },
    on: () => () => {},
    get: () => void 0,
  });
  // useState is stubbed to a static pair, so one render is a pure function call here.
  const tree = component({ wide: true });
  assert.equal(tree.type, "button");
  assert.match(tree.props["aria-label"], /^(Proxy Switch|代理开关)$/);
});

test("the panel renders the scope control without a Host state", () => {
  // Render with `open = true` (the 4th useState call) so the full panel is exercised.
  function openReact() {
    let index = 0;
    return {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: Symbol("Fragment"),
      useState: (initial) => {
        const value = index === 3 ? true : typeof initial === "function" ? initial() : initial;
        index += 1;
        return [value, () => {}];
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (initialValue) => ({ current: initialValue }),
    };
  }

  const React = openReact();
  const plugin = captured.factory(() => React);
  let component;
  plugin.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (_options, next) => {
        component = next;
        return () => {};
      },
    },
    on: () => () => {},
    get: () => void 0,
  });

  const strings = [];
  const walk = (node) => {
    if (typeof node === "string" || typeof node === "number") {
      strings.push(String(node));
      return;
    }
    if (node === null || node === void 0) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(component({ wide: true }));
  const text = strings.join("\n");
  // The fake `window` has no DSH locale, so the component falls back to the browser/Node
  // language, which is `en` in this test process.
  assert.match(text, /web_fetch only/i);
  assert.match(text, /Global/);
  assert.match(text, /Only web_fetch is taken over/);
  assert.match(text, /Switching applies immediately/);
});
