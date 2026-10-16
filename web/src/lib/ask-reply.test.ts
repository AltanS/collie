import { describe, expect, it } from "vitest";
import { askOptionFor, readAskTapReply } from "./ask-reply";
import type { Ask } from "./surface/surface";

// M56 spec 08: the phone's pure half of an ask answer.

const PERMISSION: Ask = { id: "ask-0123456789abcd", kind: "permission", options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }], channel: "keys", hash: "0abc" };
const MENU: Ask = { ...PERMISSION, kind: "menu", options: [{ id: "1", label: "Set as default" }, { id: "2", label: "Cancel" }] };

describe("askOptionFor", () => {
  it("names the option at the tapped row when the kind fits and the label matches", () => {
    expect(askOptionFor(PERMISSION, { card: "prompt-select", index: 1, label: "No" })).toBe("2");
    expect(askOptionFor({ ...PERMISSION, kind: "question" }, { card: "prompt-select", index: 0, label: "Yes" })).toBe("1");
    expect(askOptionFor(MENU, { card: "menu", index: 0, label: "Set as default" })).toBe("1");
  });

  it("names nothing when the card and the ask are not the same dialog", () => {
    expect(askOptionFor(PERMISSION, { card: "prompt-select", index: 1, label: "Yes" })).toBeNull();
    expect(askOptionFor(PERMISSION, { card: "menu", index: 0, label: "Yes" })).toBeNull();
    expect(askOptionFor(MENU, { card: "prompt-select", index: 0, label: "Set as default" })).toBeNull();
    expect(askOptionFor(PERMISSION, { card: "prompt-select", index: -1, label: "Yes" })).toBeNull();
    expect(askOptionFor(PERMISSION, { card: "prompt-select", index: 5, label: "Yes" })).toBeNull();
  });
});

describe("readAskTapReply", () => {
  it("reads a sent receipt, a refusal with the new ask, and a replay", () => {
    expect(readAskTapReply({ receipt: { outcome: "sent", keys: ["1"] } })).toEqual({ outcome: "sent", reason: null, ask: null, surface: null, detail: null, replayed: false });
    const ask = { id: "ask-ffffffffffffff", kind: "permission", options: [{ id: "1", label: "Yes" }], channel: "keys", hash: "0abc" };
    const changed = readAskTapReply({ receipt: { outcome: "refused", reason: "ask_changed" }, ask, detail: "moved" });
    expect(changed).toMatchObject({ outcome: "refused", reason: "ask_changed", detail: "moved" });
    expect(changed?.ask?.id).toBe("ask-ffffffffffffff");
    expect(readAskTapReply({ receipt: { outcome: "sent" }, replayed: true })?.replayed).toBe(true);
  });

  it("refuses a body that is not a reply", () => {
    expect(readAskTapReply(undefined)).toBeNull();
    expect(readAskTapReply({})).toBeNull();
    expect(readAskTapReply({ receipt: { outcome: "maybe" } })).toBeNull();
  });
});
