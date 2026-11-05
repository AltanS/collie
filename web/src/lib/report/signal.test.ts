import { describe, expect, it } from "vitest";

import { harnessOf, TROUBLE_MUXES, troubleSignal } from "./signal";

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

  it("keeps a multiplexer from the list, and makes any other word other", () => {
    expect(TROUBLE_MUXES).toEqual(["herdr", "herdr-core", "tmux", "zellij", "durable", "other"]);
    for (const mux of TROUBLE_MUXES) expect(troubleSignal({ ...base, mux })?.mux).toBe(mux);
    for (const mux of ["screen", "", null, undefined, "unknown mux"]) expect(troubleSignal({ ...base, mux })?.mux, String(mux)).toBe("other");
  });
});

describe("harnessOf: the report's own rule", () => {
  const row = { harness: "codex", version: "0.46.0" };

  it("takes the newest receipt first, then the context, then the dialog card's agent", () => {
    expect(harnessOf({ sends: [row, { harness: "claude", version: "2.1.316" }], context: { harness: "pi" } })).toEqual({ harness: "codex", version: "0.46.0" });
    expect(harnessOf({ sends: [], context: { harness: "pi" }, dialog: { agent: "omp" } })).toEqual({ harness: "pi", version: null });
    expect(harnessOf({ sends: [], context: null, dialog: { agent: "omp" } })).toEqual({ harness: "omp", version: null });
    expect(harnessOf({ sends: [], context: null })).toEqual({ harness: "no pane", version: null });
    expect(harnessOf({ sends: [{ harness: "", version: null }], context: null })).toEqual({ harness: "shell", version: null });
  });
});
