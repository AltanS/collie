import { describe, expect, it } from "vitest";

import { keysSendable, muxCapability, muxTopologyLatency } from "./mux-capability";
import type { MuxConfig } from "./types";

// The two rules every gated control in the app leans on, asserted where they live rather than
// through eight rendered components: an unanswered capability is PRESENT, and an explanation's words
// are the adapter's own. mux-gated-controls.test.tsx then proves each control obeys them.

/** A fabricated declaration. The name is deliberately not a real multiplexer's — nothing reads it. */
function cfg(over: Partial<MuxConfig> = {}): MuxConfig {
  return { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {}, ...over };
}

describe("muxCapability — the default is CAPABLE, and only an explicit no is a no", () => {
  it("no config at all reads as capable: an older bridge must not hide working controls", () => {
    expect(muxCapability(null, "createSpace").capable).toBe(true);
    expect(muxCapability(null, "agentSessionRef").capable).toBe(true);
  });

  it("a config that does not mention the capability reads as capable", () => {
    // The mid-upgrade case: a bridge that has never heard of a capability this bundle knows.
    expect(muxCapability(cfg(), "createSpace").capable).toBe(true);
  });

  it("`true` is capable and `false` is not — nothing else moves the answer", () => {
    expect(muxCapability(cfg({ capabilities: { createSpace: true } }), "createSpace").capable).toBe(true);
    expect(muxCapability(cfg({ capabilities: { createSpace: false } }), "createSpace").capable).toBe(false);
  });

  it("answers each capability independently — one absence never takes another down", () => {
    const declaration = cfg({ capabilities: { agentSessionRef: false, gridScrollback: true } });
    expect(muxCapability(declaration, "agentSessionRef").capable).toBe(false);
    expect(muxCapability(declaration, "gridScrollback").capable).toBe(true);
  });
});

describe("muxCapability — the words come from the adapter", () => {
  const declaration = cfg({
    capabilities: { agentSessionRef: false, createSpace: false, paneGrid: true },
    notes: {
      agentSessionRef: "this multiplexer keeps no agent session log for Collie to read.",
      paneGrid: "developer prose about a capability it HAS",
    },
  });

  it("an absent capability carries its reason", () => {
    expect(muxCapability(declaration, "agentSessionRef").note).toBe(
      "this multiplexer keeps no agent session log for Collie to read.",
    );
  });

  it("a present capability carries none — there is nothing to explain", () => {
    expect(muxCapability(declaration, "paneGrid").note).toBe("");
  });

  it("an absent capability with no note carries an empty string, not undefined", () => {
    // Call sites render an explanation only when this has words; `""` is the "hide it" signal.
    expect(muxCapability(declaration, "createSpace").note).toBe("");
  });

  it("the multiplexer's name rides for display, and is empty before the bridge answers", () => {
    expect(muxCapability(declaration, "paneGrid").mux).toBe("reference");
    expect(muxCapability(null, "paneGrid").mux).toBe("");
  });
});

describe("keysSendable — a key is not a capability", () => {
  it("nothing refused means everything sends", () => {
    expect(keysSendable(["Enter", "ctrl+c"], [])).toBe(true);
  });

  it("a refused bare key blocks its own chord and nothing else", () => {
    expect(keysSendable(["PageUp"], ["PageUp"])).toBe(false);
    expect(keysSendable(["Up"], ["PageUp"])).toBe(true);
  });

  it("the BASE key decides, so a modifier cannot smuggle a refused key through", () => {
    expect(keysSendable(["ctrl+Home"], ["Home"])).toBe(false);
    expect(keysSendable(["ctrl+shift+End"], ["End"])).toBe(false);
  });

  it("spelling case is not a hiding place — both sides use the contract's alphabet", () => {
    expect(keysSendable(["home"], ["Home"])).toBe(false);
  });

  it("a batch is refused if ANY of its chords is — the whole sequence goes as one call", () => {
    expect(keysSendable(["Escape", "Delete", "Enter"], ["Delete"])).toBe(false);
  });

  it("the `+` key survives its own splitting", () => {
    expect(keysSendable(["ctrl++"], ["Delete"])).toBe(true);
    expect(keysSendable(["ctrl++"], ["+"])).toBe(false);
  });
});

// TOPOLOGY LATENCY — a declared fact, not a capability, and the one thing that decides whether the
// home screen talks about freshness at all (ADR 0031). Its fail-open direction is the OPPOSITE
// shape from a capability's and it is worth saying why: a capability defaults to present because
// hiding a working control is unfixable; this defaults to `push` because inventing a staleness
// counter for a bridge that never claimed to be stale is noise the operator cannot act on.
describe("muxTopologyLatency — absent means push, and only an explicit bound is a bound", () => {
  it("no config at all reads as push, so an older bridge says nothing about freshness", () => {
    expect(muxTopologyLatency(null)).toEqual({ kind: "push" });
  });

  it("a config that does not carry the field reads as push", () => {
    expect(muxTopologyLatency(cfg())).toEqual({ kind: "push" });
  });

  it("a declared bound is carried through with its number intact", () => {
    expect(muxTopologyLatency(cfg({ topologyLatency: { kind: "bounded", ms: 12_000 } }))).toEqual({
      kind: "bounded",
      ms: 12_000,
    });
  });

  it("an explicit push is push — the same answer as absence, arrived at honestly", () => {
    expect(muxTopologyLatency(cfg({ topologyLatency: { kind: "push" } }))).toEqual({ kind: "push" });
  });
});
