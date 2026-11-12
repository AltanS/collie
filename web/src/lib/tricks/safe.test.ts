import { describe, expect, it } from "vitest";

import { INVALID_KIND, safeNode, safeValue } from "./safe";

// THE TOLERANT READER OF A VIEW'S NODES (M94 review): `attrs` is an object, `kids` an array for the kinds
// that draw kids, and a node that is no node is a node of the kind `invalid`.

describe("safeNode", () => {
  it("makes attrs an object where it is read, and kids an array where it is there", () => {
    expect(safeNode({ kind: "list", kids: "no", attrs: 7 })).toEqual({ kind: "list", attrs: {}, kids: [] });
    expect(safeNode({ kind: "card", attrs: null })).toEqual({ kind: "card", attrs: {} });
    // The three kinds whose types require attrs get an empty object when they have none.
    for (const kind of ["button", "link", "image"]) expect(safeNode({ kind })).toEqual({ kind, attrs: {} });
    // A kind whose attrs are optional keeps them absent.
    expect(safeNode({ kind: "spacer" })).toEqual({ kind: "spacer" });
  });

  it("reads the kids of a node one by one", () => {
    expect(safeNode({ kind: "card", kids: [{ kind: "line", text: "a" }, null, { kind: "button" }] })).toEqual({
      kind: "card",
      kids: [{ kind: "line", text: "a" }, { kind: INVALID_KIND, attrs: {} }, { kind: "button", attrs: {} }],
    });
  });

  it("turns a value with no kind into a node of the kind invalid", () => {
    for (const bad of [null, "text", 3, [1], { nope: 1 }, { kind: 2 }]) expect(safeNode(bad)).toEqual({ kind: INVALID_KIND, attrs: {} });
  });

  it("leaves a node that fits as it is, field for field", () => {
    const fits = { kind: "card", attrs: { tone: "ok" }, kids: [{ kind: "button", attrs: { label: "Run", intent: "rerun" } }] };
    expect(safeNode(fits)).toEqual(fits);
  });
});

describe("safeValue", () => {
  it("reads a part's view, and leaves a value with no view list as it came", () => {
    expect(safeValue({ at: "session", id: "a", view: [{ kind: "card", kids: 1 }, null] })).toEqual({ at: "session", id: "a", view: [{ kind: "card", kids: [] }, { kind: INVALID_KIND, attrs: {} }] });
    expect(safeValue({ at: "belt", id: "a", mark: { icon: "flask" } })).toEqual({ at: "belt", id: "a", mark: { icon: "flask" } });
    expect(safeValue({ at: "session", id: "a", view: "oops" })).toEqual({ at: "session", id: "a", view: "oops" });
  });
});
