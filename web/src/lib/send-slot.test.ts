import { describe, expect, it } from "vitest";
import { fieldLocked, paneSurface, sendSlot, UNREAD_SURFACE, unreachable, type ComposerFacts, type SendSlot } from "./send-slot";
import type { Surface } from "./surface/surface";

const NONE: ComposerFacts = { gone: false, readOnly: false, offline: false };
const at = (over: Partial<Surface>): Surface => ({ revision: 7, turn: "idle", modal: "none", composer: "empty", ...over });
const ask = (kind: "menu" | "permission" | "question"): Surface =>
  at({ modal: { ask: { id: "a", kind, options: [{ id: "1", label: "Yes" }], channel: "keys", hash: "h" } }, composer: "unknown" });

// The Send slot is a pure function of the Surface and three facts (M56 spec 06). One row per Surface
// row of the M56 README's composer table, then the facts, which outrank every row.
describe("sendSlot", () => {
  it.each<[string, Surface, string]>([
    ["free", at({}), "send"],
    ["a draft at the desk", at({ composer: "draft" }), "draft"],
    ["a running turn", at({ turn: "running" }), "running"],
    ["a modal ask", ask("menu"), "answer"],
    ["an ask over a running turn", { ...ask("permission"), turn: "running" }, "answer"],
    ["an overlay Collie cannot read", at({ modal: "unreadable" }), "manual"],
    ["no match", UNREAD_SURFACE, "manual"],
    ["a weak cue (idle, modal unknown)", at({ modal: "unknown" }), "manual"],
    ["a stale read", at({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" }), "wait"],
    ["a torn read", at({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "torn" }), "wait"],
    ["a contested read", at({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "contested" }), "wait"],
    ["a box out of reach", at({ composer: "unreachable", turn: "unknown", modal: "unknown" }), "unreachable"],
  ])("%s gives %s", (_name, surface, slot) => {
    expect(sendSlot(surface, NONE)).toBe(slot);
  });

  it("the facts outrank the Surface: gone, then read-only, then a box out of reach, then offline", () => {
    expect(sendSlot(ask("menu"), { gone: true, readOnly: true, offline: true })).toBe("gone");
    expect(sendSlot(at({}), { ...NONE, readOnly: true, offline: true })).toBe("readOnly");
    expect(sendSlot(unreachable(at({})), { ...NONE, offline: true })).toBe("unreachable");
    expect(sendSlot(ask("menu"), { ...NONE, offline: true })).toBe("offline");
  });

  it("only gone, read-only and a box out of reach lock the field", () => {
    const slots: SendSlot[] = ["gone", "readOnly", "unreachable", "offline", "answer", "running", "manual", "wait", "draft", "send"];
    expect(slots.filter((slot) => fieldLocked(slot))).toEqual(["gone", "readOnly", "unreachable"]);
  });
});

describe("paneSurface", () => {
  it("passes the bridge's read through on a marked pane, and reads a pane not read yet as no-match", () => {
    expect(paneSurface(ask("menu"), true, undefined)).toEqual({ surface: ask("menu"), unreachableNote: undefined });
    expect(paneSurface(undefined, true, undefined)).toEqual({ surface: UNREAD_SURFACE, unreachableNote: undefined });
  });

  it("a machine the lead cannot reach makes the box unreachable, in the machine's words", () => {
    const out = paneSurface(at({}), true, "workshop is not answering");
    expect(out.surface.composer).toBe("unreachable");
    expect(out.unreachableNote).toBe("workshop is not answering");
  });

  it("a pane the bridge does not mark for the Send Protocol says sending is off", () => {
    const out = paneSurface(at({}), false, undefined);
    expect(out.surface.composer).toBe("unreachable");
    expect(out.unreachableNote).toBe("This machine cannot take text from the phone. Update its Collie, or check its COLLIE_SEND_PROTOCOL setting. The keys still work.");
  });
});
