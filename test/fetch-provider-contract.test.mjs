import test from "node:test";
import assert from "node:assert/strict";

import {
  RESPONSE_CLOSE_CONTRACT,
  RESPONSE_CONTRACT,
  bindCloseToBody,
  contractFromBaseSource,
  contractFromVersion,
  contractOf,
  shapeRequestOnceResult,
} from "../lib/provider-contract.js";

/** A base class shaped like `dsh-web-fetch-http` 0.2.1 and earlier. */
class OldBase {
  async followAndRead(url, signal) {
    const request = await this.requestOnce(url, signal);
    const { response } = request;
    if (response.status === 302) {
      await response.body?.cancel();
      await request.close();
    }
    return response;
  }
}

/** A base class shaped like `dsh-web-fetch-http` 0.2.2 and later. */
class NewBase {
  async followAndRead(url, signal) {
    const response = await this.requestOnce(url, signal);
    if (response.status === 302) {
      await response.body?.cancel();
    }
    return response;
  }
}

function counted() {
  const state = { calls: 0 };
  return {
    state,
    close() {
      state.calls += 1;
      return Promise.resolve();
    },
  };
}

function bodyOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("the contract is read from the base class's own redirect loop", () => {
  assert.equal(contractOf(OldBase).contract, RESPONSE_CLOSE_CONTRACT);
  assert.equal(contractOf(NewBase).contract, RESPONSE_CONTRACT);
  assert.equal(contractOf(OldBase).reason, "base-class source");
  assert.equal(contractOf(NewBase).reason, "base-class source");
  // A class whose loop shows neither shape (or is unreadable) falls through to the version.
  class Opaque {}
  assert.equal(contractOf(Opaque, { version: "0.2.2-rc.1" }).contract, RESPONSE_CONTRACT);
  assert.equal(contractOf(Opaque, { version: "0.2.1-rc.5" }).contract, RESPONSE_CLOSE_CONTRACT);
  assert.equal(contractOf(Opaque, { version: null }).contract, RESPONSE_CLOSE_CONTRACT);
  assert.equal(contractOf(undefined, { version: null }).contract, RESPONSE_CLOSE_CONTRACT);
});

test("source and version helpers classify the shapes they document", () => {
  assert.equal(contractFromBaseSource("const response = await this.requestOnce(u, s);"), RESPONSE_CONTRACT);
  assert.equal(contractFromBaseSource("const request = await this.requestOnce(u, s); … request.close()"), RESPONSE_CLOSE_CONTRACT);
  assert.equal(contractFromBaseSource("something else"), null);
  assert.equal(contractFromBaseSource(""), null);

  const cases = [
    ["0.2.0-rc.1", RESPONSE_CLOSE_CONTRACT],
    ["0.2.1-rc.5", RESPONSE_CLOSE_CONTRACT],
    ["0.2.1", RESPONSE_CLOSE_CONTRACT],
    ["0.2.2-rc.1", RESPONSE_CONTRACT],
    ["0.2.2", RESPONSE_CONTRACT],
    ["0.1.9", null],
    ["0.3.0", null],
    ["not-a-version", null],
  ];
  for (const [version, expected] of cases) {
    assert.equal(contractFromVersion(version), expected, version);
  }
});

test("the old contract is returned untouched", () => {
  const response = new Response("hello", { headers: { "content-type": "text/plain" } });
  const proxied = { response, close: () => Promise.resolve() };
  assert.equal(shapeRequestOnceResult(RESPONSE_CLOSE_CONTRACT, proxied), proxied);
});

test("the new contract returns a Response and releases the channel after a full read", async () => {
  const { state, close } = counted();
  const shaped = shapeRequestOnceResult(RESPONSE_CONTRACT, {
    response: new Response(bodyOf("hello"), { status: 200, headers: { "content-type": "text/plain" } }),
    close,
  });
  assert.ok(shaped instanceof Response);
  assert.equal(shaped.status, 200);
  assert.equal(shaped.headers.get("content-type"), "text/plain");
  assert.equal(await shaped.text(), "hello");
  assert.equal(state.calls, 1, "the body ending must release the channel exactly once");
});

test("the new contract releases the channel on cancel", async () => {
  const { state, close } = counted();
  const shaped = shapeRequestOnceResult(RESPONSE_CONTRACT, { response: new Response(bodyOf("hello")), close });
  await shaped.body.cancel();
  assert.equal(state.calls, 1);
});

test("the new contract releases the channel when the body errors", async () => {
  const { state, close } = counted();
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("boom"));
    },
  });
  const shaped = shapeRequestOnceResult(RESPONSE_CONTRACT, { response: new Response(body), close });
  await assert.rejects(shaped.text());
  assert.equal(state.calls, 1);
});

test("the new contract releases a body-less response immediately", async () => {
  const { state, close } = counted();
  const shaped = shapeRequestOnceResult(RESPONSE_CONTRACT, { response: new Response(null, { status: 204 }), close });
  await Promise.resolve();
  assert.equal(shaped.status, 204);
  assert.equal(state.calls, 1);
});

test("a close that rejects does not escape", async () => {
  const shaped = bindCloseToBody({
    response: new Response(bodyOf("x")),
    close: () => Promise.reject(new Error("already gone")),
  });
  assert.equal(await shaped.text(), "x");
});
