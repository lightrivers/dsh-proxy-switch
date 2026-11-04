import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STATE,
  isLoopbackPort,
  loadState,
  maskUpstream,
  normalizeState,
  parseUpstream,
  saveState,
  statePath,
} from "../lib/state.js";

test("parseUpstream accepts only http://", () => {
  assert.equal(parseUpstream("http://127.0.0.1:1082").ok, true);
  assert.equal(parseUpstream("http://127.0.0.1").ok, true);

  for (const value of ["socks5://127.0.0.1:1080", "https://127.0.0.1:1082", "pac+http://x", "not a url", ""]) {
    assert.equal(parseUpstream(value).ok, false, `${value} must be refused`);
  }
});

test("isLoopbackPort rejects privileged and out-of-range ports", () => {
  assert.equal(isLoopbackPort(7899), true);
  assert.equal(isLoopbackPort(80), false);
  assert.equal(isLoopbackPort(0), false);
  assert.equal(isLoopbackPort(70_000), false);
  assert.equal(isLoopbackPort("7899"), false);
});

test("normalizeState keeps valid fields and repairs invalid ones", () => {
  const repaired = normalizeState({
    mode: "sideways",
    listenPort: 80,
    upstream: "socks5://127.0.0.1:1080",
    probeIntervalMs: 10,
    lastSwitchAt: 1234,
  });
  assert.equal(repaired.state.mode, DEFAULT_STATE.mode);
  assert.equal(repaired.state.listenPort, DEFAULT_STATE.listenPort);
  assert.equal(repaired.state.upstream, DEFAULT_STATE.upstream);
  assert.equal(repaired.state.probeIntervalMs, DEFAULT_STATE.probeIntervalMs);
  assert.equal(repaired.state.lastSwitchAt, 1234);
  assert.equal(repaired.notes.length, 4);

  const nullSwitch = normalizeState({ mode: "direct", lastSwitchAt: null });
  assert.equal(nullSwitch.state.lastSwitchAt, null);
  const emptySwitch = normalizeState({ mode: "direct", lastSwitchAt: "" });
  assert.equal(emptySwitch.state.lastSwitchAt, null);

  const kept = normalizeState({
    mode: "forward",
    listenPort: 7999,
    upstream: "http://127.0.0.1:1082",
    probeIntervalMs: 5000,
  });
  assert.equal(kept.state.mode, "forward");
  assert.equal(kept.state.listenPort, 7999);
  assert.equal(kept.state.probeIntervalMs, 5000);
  assert.deepEqual(kept.notes, []);
});

test("normalizeState applies configuration defaults for a fresh install", () => {
  const fresh = normalizeState(void 0, { listenPort: 8123 });
  assert.equal(fresh.state.mode, "auto");
  assert.equal(fresh.state.upstreamSource, "auto");
  assert.equal(fresh.state.listenPort, 8123);
});

test("normalizeState keeps auto mode and migrates a v0.3 upstream to a source", () => {
  assert.equal(normalizeState({ mode: "auto" }).state.mode, "auto");
  // v0.3 never wrote upstreamSource: the old built-in default stays detectable…
  const untouched = normalizeState({ mode: "forward", upstream: DEFAULT_STATE.upstream });
  assert.equal(untouched.state.upstreamSource, "auto");
  // …while an address the user typed is kept as manual.
  const typed = normalizeState({ mode: "forward", upstream: "http://127.0.0.1:7890" });
  assert.equal(typed.state.upstreamSource, "manual");
  assert.deepEqual(typed.notes, []);

  const explicit = normalizeState({ upstream: "http://127.0.0.1:7890", upstreamSource: "auto" });
  assert.equal(explicit.state.upstreamSource, "auto");
  // A Loader-config upstream counts as a decision, the built-in default does not.
  assert.equal(normalizeState(void 0, { upstream: "http://127.0.0.1:7890" }).state.upstreamSource, "manual");
  assert.equal(normalizeState(void 0, { upstream: DEFAULT_STATE.upstream }).state.upstreamSource, "auto");
  const bogus = normalizeState({ upstreamSource: "magic" });
  assert.equal(bogus.state.upstreamSource, "auto");
  assert.equal(bogus.notes.length, 1);
});

test("state survives a save/load round-trip", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = { ...DEFAULT_STATE, mode: "forward", lastSwitchAt: 42 };
  await saveState(home, state);
  const loaded = await loadState(home);
  assert.equal(loaded.state.mode, "forward");
  assert.equal(loaded.state.lastSwitchAt, 42);
  assert.deepEqual(loaded.notes, []);
  const raw = await readFile(statePath(home), "utf8");
  assert.match(raw, /"mode": "forward"/);
});

test("loadState tolerates a missing file and reports a corrupt one", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const missing = await loadState(home);
  assert.equal(missing.state.mode, DEFAULT_STATE.mode);
  assert.equal(missing.loadError, void 0);

  await saveState(home, DEFAULT_STATE);
  await writeFile(statePath(home), "{not json", "utf8");
  const corrupt = await loadState(home);
  assert.equal(corrupt.state.mode, DEFAULT_STATE.mode);
  assert.equal(typeof corrupt.loadError, "string");
});


test("parseUpstream rejects incomplete percent-encoding and paths", () => {
  for (const value of [
    "http://u%ZZ:p@127.0.0.1:1082",
    "http://u:p%ZZ@127.0.0.1:1082",
    "http://u:%ZZ@127.0.0.1:1082",
    "http://127.0.0.1:1082/proxy",
    "http://127.0.0.1:1082/?x=1",
  ]) {
    assert.equal(parseUpstream(value).ok, false, `${value} must be refused`);
  }
  const encoded = parseUpstream("http://u%40ser:p%3Ass@127.0.0.1:1082");
  assert.equal(encoded.ok, true);
  assert.equal(encoded.url.username, "u%40ser");
  assert.equal(encoded.url.password, "p%3Ass");
});

test("maskUpstream hides the password everywhere a value is displayed", () => {
  assert.equal(maskUpstream("http://user:secret@127.0.0.1:1082"), "http://user:***@127.0.0.1:1082");
  assert.equal(maskUpstream("http://user@127.0.0.1:1082"), "http://user:***@127.0.0.1:1082");
  assert.equal(maskUpstream("http://127.0.0.1:1082"), "http://127.0.0.1:1082");
  assert.equal(maskUpstream("socks5://user:secret@host:1"), "<invalid-upstream>");
  assert.equal(maskUpstream("not a url with user:secret@host"), "<invalid-upstream>");
  assert.equal(maskUpstream("http://user:REVIEW-SECRET/part@proxy:1082"), "<invalid-upstream>");
  assert.doesNotMatch(maskUpstream("http://user:secret@127.0.0.1:1082"), /secret/u);
});

test("a corrupt upstream note never echoes a credential", () => {
  const repaired = normalizeState({ upstream: "socks5://user:secret@127.0.0.1:1080" });
  assert.equal(repaired.state.upstream, DEFAULT_STATE.upstream);
  assert.equal(repaired.notes.some((note) => note.includes("secret")), false);
  assert.equal(repaired.notes.some((note) => note.includes("<invalid-upstream>")), true);
});

test("normalizeState understands scope and repairs an unknown one", () => {
  const kept = normalizeState({ scope: "global" });
  assert.equal(kept.state.scope, "global");
  assert.deepEqual(kept.notes, []);

  const repaired = normalizeState({ scope: "everything" });
  assert.equal(repaired.state.scope, DEFAULT_STATE.scope);
  assert.equal(repaired.notes.length, 1);
});

test("state.json is written 0600 and its directory 0700", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveState(home, { ...DEFAULT_STATE, mode: "forward" });
  const fileMode = (await stat(statePath(home))).mode & 0o777;
  assert.equal(fileMode, 0o600, `state.json mode is ${fileMode.toString(8)}`);
  const dirMode = (await stat(join(home, "storages", "dsh-proxy-switch"))).mode & 0o777;
  assert.equal(dirMode, 0o700, `state dir mode is ${dirMode.toString(8)}`);

  // A pre-existing 0644 file must be repaired on the next save, not left readable.
  await writeFile(statePath(home), "{}", { encoding: "utf8", mode: 0o644 });
  await saveState(home, { ...DEFAULT_STATE, mode: "direct" });
  assert.equal((await stat(statePath(home))).mode & 0o777, 0o600);
});

test("scope survives a save/load round-trip", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveState(home, { ...DEFAULT_STATE, mode: "forward", scope: "global" });
  const loaded = await loadState(home);
  assert.equal(loaded.state.scope, "global");
  assert.equal(loaded.state.mode, "forward");
});


test("two same-millisecond saves use distinct temp files and both succeed", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    await Promise.all([
      saveState(home, { ...DEFAULT_STATE, mode: "forward" }),
      saveState(home, { ...DEFAULT_STATE, mode: "direct" }),
    ]);
  } finally {
    Date.now = originalNow;
  }
  const parsed = JSON.parse(await readFile(statePath(home), "utf8"));
  assert.ok(parsed.mode === "forward" || parsed.mode === "direct");
  assert.equal((await stat(statePath(home))).mode & 0o777, 0o600);
});

test("F16: loading repairs a 0755 directory and a 0644 state file before reading it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, "storages", "dsh-proxy-switch");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755);
  const file = join(dir, "state.json");
  await writeFile(file, JSON.stringify({ ...DEFAULT_STATE, upstream: "http://u:p@127.0.0.1:1082", upstreamSource: "manual" }), {
    encoding: "utf8",
  });
  await chmod(file, 0o644);

  const loaded = await loadState(home);
  assert.equal(loaded.state.upstreamSource, "manual");
  assert.equal((await stat(dir)).mode & 0o777, 0o700, "the directory is repaired on load");
  assert.equal((await stat(file)).mode & 0o777, 0o600, "the file is repaired on load");
});

test("F17: saveState sets the mode on the temp file before the rename commit", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = [];
  const io = {
    chmod: async (path, mode) => {
      operations.push({ op: "chmod", path, mode });
      await chmod(path, mode);
    },
    rename: async (from, to) => {
      operations.push({ op: "rename", from, to });
      await rename(from, to);
    },
  };
  await saveState(home, { ...DEFAULT_STATE, mode: "forward" }, { io });
  const tempChmod = operations.findIndex((entry) => entry.op === "chmod" && entry.path.endsWith(".tmp"));
  const renameIndex = operations.findIndex((entry) => entry.op === "rename");
  assert.ok(tempChmod !== -1, "the temp file must be chmod-ed");
  assert.ok(renameIndex !== -1, "the commit must be a rename");
  assert.ok(tempChmod < renameIndex, "chmod must precede the rename commit");
  assert.equal(operations.some((entry) => entry.op === "chmod" && entry.path.endsWith("state.json")), false);
  assert.equal((await stat(statePath(home))).mode & 0o777, 0o600);
});

test("F17: a chmod failure before the commit leaves the old state and reports failure", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveState(home, { ...DEFAULT_STATE, mode: "direct" });
  const io = {
    chmod: async (path, mode) => {
      if (path.endsWith(".tmp")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      await chmod(path, mode);
    },
  };
  await assert.rejects(saveState(home, { ...DEFAULT_STATE, mode: "forward" }, { io }));
  const disk = JSON.parse(await readFile(statePath(home), "utf8"));
  assert.equal(disk.mode, "direct", "the reported failure must match what is on disk");
});
