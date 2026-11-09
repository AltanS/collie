import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { harnessOf, troubleSignal } from "./signal";

// The trouble signal (M86 spec 05): the four names, cleaned to the shape the bridge accepts.

describe("troubleSignal: the words, cleaned", () => {
  const base = { kind: "send", harness: "claude", version: "2.1.316", mux: "herdr" };

  it("keeps a clean signal as it is, with exactly kind, harness, version, mux", () => {
    const signal = troubleSignal(base);
    expect(signal).toEqual({ kind: "send", harness: "claude", version: "2.1.316", mux: "herdr" });
    expect(Object.keys(signal ?? {}).toSorted()).toEqual(["harness", "kind", "mux", "version"]);
  });

  it("is null for a kind that is neither card", () => {
    expect(troubleSignal({ ...base, kind: "crash" })).toBeNull();
    expect(troubleSignal({ ...base, kind: "dialog" })?.kind).toBe("dialog");
  });

  it("lower-cases the harness word, and makes shell, no pane and any word out of shape other", () => {
    expect(troubleSignal({ ...base, harness: " Codex " })?.harness).toBe("codex");
    expect(troubleSignal({ ...base, harness: "kimi-cli" })?.harness).toBe("kimi-cli");
    for (const harness of ["shell", "no pane", "", null, undefined, "a".repeat(25), "my agent", "agent/1"]) {
      expect(troubleSignal({ ...base, harness })?.harness, String(harness)).toBe("other");
    }
  });

  it("keeps a version that looks like one, at most 40 characters, else null", () => {
    expect(troubleSignal({ ...base, version: "0.9.5-beta.1" })?.version).toBe("0.9.5-beta.1");
    expect(troubleSignal({ ...base, version: "v18.12.6" })?.version).toBe("v18.12.6");
    for (const version of ["latest", "", null, undefined, `1.${"2".repeat(40)}`, "2.1.316 (Claude Code)"]) {
      expect(troubleSignal({ ...base, version })?.version, String(version)).toBeNull();
    }
  });

  it("passes the bridge's multiplexer word through, lower-cased, and makes an empty or malformed one other", () => {
    expect(troubleSignal({ ...base, mux: "wezterm" })?.mux).toBe("wezterm");
    expect(troubleSignal({ ...base, mux: " Herdr-Core " })?.mux).toBe("herdr-core");
    for (const mux of ["", "  ", null, undefined, "unknown mux", "a".repeat(25), "mux/1"]) expect(troubleSignal({ ...base, mux })?.mux, String(mux)).toBe("other");
  });

  it("holds no multiplexer name list: the frontend reads capabilities, never a name", () => {
    const source = readFileSync(join(import.meta.dirname, "signal.ts"), "utf8");
    expect(source).not.toMatch(/TROUBLE_MUXES|TroubleMux/);
    expect(source).not.toMatch(/["'`](herdr|herdr-core|tmux|zellij|durable)["'`]/i);
  });
});

describe("harnessOf: the report's own rule", () => {
  const row = { harness: "codex", version: "0.46.0" };

  it("takes the newest receipt first, then the context, then the dialog card's agent", () => {
    expect(harnessOf({ sends: [row, { harness: "claude", version: "2.1.316" }], context: { harness: "pi", harnessVersion: null } })).toEqual({ harness: "codex", version: "0.46.0" });
    expect(harnessOf({ sends: [], context: { harness: "pi", harnessVersion: null }, dialog: { agent: "omp" } })).toEqual({ harness: "pi", version: null });
    expect(harnessOf({ sends: [], context: null, dialog: { agent: "omp" } })).toEqual({ harness: "omp", version: null });
    expect(harnessOf({ sends: [], context: null })).toEqual({ harness: "no pane", version: null });
    expect(harnessOf({ sends: [{ harness: "", version: null }], context: null })).toEqual({ harness: "shell", version: null });
  });

  it("falls back to the bridge's cached version when no receipt names one (1.27.4)", () => {
    const context = { harness: "omp", harnessVersion: "18.16.0" };
    // No send on the pane: the context's agent and its cached version.
    expect(harnessOf({ sends: [], context, dialog: { agent: "omp" } })).toEqual({ harness: "omp", version: "18.16.0" });
    // A receipt without a version for the same agent takes the cached one.
    expect(harnessOf({ sends: [{ harness: "omp", version: null }], context })).toEqual({ harness: "omp", version: "18.16.0" });
    // A receipt's own version wins over the cache.
    expect(harnessOf({ sends: [{ harness: "omp", version: "18.17.0" }], context })).toEqual({ harness: "omp", version: "18.17.0" });
    // A receipt from another agent on the same pane never borrows this agent's version.
    expect(harnessOf({ sends: [{ harness: "codex", version: null }], context })).toEqual({ harness: "codex", version: null });
    // No context (a crew member's pane): receipts only, as before.
    expect(harnessOf({ sends: [], context: null, dialog: { agent: "omp" } })).toEqual({ harness: "omp", version: null });
    // A context with no cached version, and a bare shell.
    expect(harnessOf({ sends: [], context: { harness: "omp", harnessVersion: null } })).toEqual({ harness: "omp", version: null });
    expect(harnessOf({ sends: [], context: { harness: "", harnessVersion: null } })).toEqual({ harness: "shell", version: null });
  });
});

describe("troubleSignal: the screen hash (1.27.4)", () => {
  const dialog = { kind: "dialog", harness: "codex", version: "0.167.0", mux: "herdr" };

  it("carries a dialog's screen hash in its shape, as a fifth key", () => {
    const signal = troubleSignal({ ...dialog, screen: "634c6530" });
    expect(signal).toEqual({ ...dialog, screen: "634c6530" });
    expect(Object.keys(signal ?? {})).toEqual(["kind", "harness", "version", "mux", "screen"]);
  });

  it("leaves the key out with no hash, a hash out of shape, and on a send signal", () => {
    for (const screen of [null, undefined, "", "634C6530", "634c653", "634c65300", "634c653g", "omp@18.16.0"]) {
      expect(Object.keys(troubleSignal({ ...dialog, screen }) ?? {}), String(screen)).toEqual(["kind", "harness", "version", "mux"]);
    }
    expect(troubleSignal({ ...dialog, kind: "send", screen: "634c6530" })).toEqual({ ...dialog, kind: "send" });
  });
});
