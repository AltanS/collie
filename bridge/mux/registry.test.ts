import { describe, expect, test } from "bun:test";

import {
  buildMuxRegistry,
  createMux,
  DEFAULT_MUX,
  describeMux,
  factoryFor,
  muxNames,
  type MuxAdapterFactory,
  type MuxTarget,
} from "./registry.ts";
import { declareCapabilities, muxAck, muxOk, muxUnsupported, type MuxAdapter } from "./types.ts";

// The registry is the single decision site for "which multiplexer". These pin the properties that
// keep it from rotting — the key comes from the factory itself, a configured name can never resolve
// to something that is not a factory, and an unknown name refuses at startup instead of half-running.

function stubAdapter(mux: string, target: MuxTarget): MuxAdapter {
  return {
    mux,
    capabilities: declareCapabilities({ supports: ["paneGrid"], topologyLatency: { kind: "push" } }),
    reachable: () => Promise.resolve(true),
    snapshot: () => Promise.resolve({ panes: [], spaces: [], tabs: [] }),
    refresh: () => Promise.resolve(),
    readGrid: (paneId) =>
      Promise.resolve(muxOk({ paneId, text: target.endpoint, truncated: false, revision: 1 })),
    typeText: () => Promise.resolve(muxUnsupported("typeText", "stub")),
    sendKeys: () => Promise.resolve(muxUnsupported("sendKeys", "stub")),
    renamePane: () => Promise.resolve(muxUnsupported("renamePane", "stub")),
    closePane: () => Promise.resolve(muxUnsupported("closePane", "stub")),
    setFocus: () => Promise.resolve(muxUnsupported("setFocus", "stub")),
    listWorktrees: () => Promise.resolve(muxUnsupported("listWorktrees", "stub")),
    createWorktree: () => Promise.resolve(muxUnsupported("createWorktree", "stub")),
    openWorktree: () => Promise.resolve(muxUnsupported("openWorktree", "stub")),
    createTab: () => Promise.resolve(muxUnsupported("createTab", "stub")),
    renameTab: () => Promise.resolve(muxUnsupported("renameTab", "stub")),
    closeTab: () => Promise.resolve(muxUnsupported("closeTab", "stub")),
    createSpace: () => Promise.resolve(muxUnsupported("createSpace", "stub")),
    watch: () => ({ close: () => muxAck() }),
  };
}

function stubFactory(mux: string): MuxAdapterFactory {
  return { mux, create: (target) => stubAdapter(mux, target) };
}

const target: MuxTarget = { endpoint: "/tmp/probe.sock", timeoutMs: 5000, options: {} };

describe("buildMuxRegistry", () => {
  test("every key IS its factory's own name — the map can't drift from the factories", () => {
    const registry = buildMuxRegistry([stubFactory("herdr"), stubFactory("tmux")]);
    for (const [key, factory] of Object.entries(registry)) expect(factory.mux).toBe(key);
    expect(muxNames(registry)).toEqual(["herdr", "tmux"]);
  });

  // Herdr landed behind the contract in spec 02; tmux appended one entry in 04, zellij will in 05.
  test("the shipped list builds", () => {
    expect(muxNames(buildMuxRegistry())).toEqual(["herdr", "tmux", "zellij"]);
  });
});

describe("factoryFor", () => {
  const registry = buildMuxRegistry([stubFactory("herdr"), stubFactory("zellij")]);

  test.each(["herdr", "zellij"])("resolves %s", (mux) => {
    expect(factoryFor(registry, mux)?.mux).toBe(mux);
  });

  test("an unregistered name is undefined, not a throw", () => {
    expect(factoryFor(registry, "screen")).toBeUndefined();
    expect(factoryFor(registry, undefined)).toBeUndefined();
  });

  // The name arrives from configuration, so an inherited Object.prototype key must not resolve to
  // a function masquerading as a factory (the journal registry's reasoning, same shape).
  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "%s does not resolve to a non-factory",
    (key) => {
      expect(factoryFor(registry, key)).toBeUndefined();
    },
  );
});

describe("createMux", () => {
  const registry = buildMuxRegistry([stubFactory("herdr"), stubFactory("tmux")]);

  test("no configured name means the default, so nothing changes for an existing operator", () => {
    expect(DEFAULT_MUX).toBe("herdr");
    expect(createMux(registry, undefined, target).mux).toBe("herdr");
    expect(createMux(registry, "", target).mux).toBe("herdr");
  });

  test("builds the named adapter and hands it the target", async () => {
    const adapter = createMux(registry, "tmux", target);
    expect(adapter.mux).toBe("tmux");
    const grid = await adapter.readGrid("%0", { scope: "recent", lines: 40, styling: "preserve" });
    expect(grid.ok).toBe(true);
    if (!grid.ok) throw new Error("expected a grid");
    expect(grid.value.text).toBe("/tmp/probe.sock");
  });

  test("a typo refuses at startup, naming the multiplexers this build drives", () => {
    expect(() => createMux(registry, "tmix", target)).toThrow(/tmix/);
    expect(() => createMux(registry, "tmix", target)).toThrow(/herdr, tmux/);
  });
});

describe("describeMux", () => {
  const registry = buildMuxRegistry();

  // The startup line an operator reads back with `collie logs` (docs/multiplexers.md → "Did it work?").
  test("each shipped adapter words its own endpoint", () => {
    expect(describeMux(registry, "herdr", "/home/you/.config/herdr/herdr.sock")).toBe(
      "herdr · socket /home/you/.config/herdr/herdr.sock",
    );
    expect(describeMux(registry, "tmux", "/run/user/1000/collie-tmux.sock")).toBe(
      "tmux · socket /run/user/1000/collie-tmux.sock",
    );
    expect(describeMux(registry, "tmux", "work")).toBe("tmux · socket name work");
    expect(describeMux(registry, "tmux", "")).toBe("tmux · tmux's own default server");
    expect(describeMux(registry, "zellij", "collie-zellij")).toBe("zellij · session collie-zellij");
    expect(describeMux(registry, "zellij", "")).toBe("zellij · the single running session");
  });

  test("no configured name reads as the default, exactly as createMux resolves it", () => {
    expect(describeMux(registry, undefined, "/tmp/herdr.sock")).toBe("herdr · socket /tmp/herdr.sock");
    expect(describeMux(registry, "", "/tmp/herdr.sock")).toBe("herdr · socket /tmp/herdr.sock");
  });

  // Describing is not connecting: a name this build cannot drive is still printed, and `createMux`
  // is left to be the one site that refuses it.
  test("an adapter with no words of its own, and an unknown name, still describe", () => {
    const stubs = buildMuxRegistry([stubFactory("plain")]);
    expect(describeMux(stubs, "plain", "/tmp/probe.sock")).toBe("plain · /tmp/probe.sock");
    expect(describeMux(stubs, "plain", "")).toBe("plain · its default");
    expect(describeMux(stubs, "tmix", "somewhere")).toBe("tmix · somewhere");
  });
});
