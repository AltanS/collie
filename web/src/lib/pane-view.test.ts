import { describe, expect, it } from "vitest";

import { coercePaneView, PANE_VIEWS } from "./pane-view";

describe("coercePaneView", () => {
  it("keeps either body it knows", () => {
    expect(coercePaneView("terminal")).toBe("terminal");
    expect(coercePaneView("chat")).toBe("chat");
  });

  // The default is about what OPTING IN hands you, not about what Collie shows a device that has
  // never asked: the experiment gate decides that, and it is off. See the module header.
  it("reads anything it does not know as chat, because this value is only read behind the gate", () => {
    expect(coercePaneView(undefined)).toBe("chat");
    expect(coercePaneView("mirror")).toBe("chat");
    expect(coercePaneView(7)).toBe("chat");
    expect(coercePaneView(null)).toBe("chat");
  });

  it("offers exactly two bodies", () => {
    expect([...PANE_VIEWS]).toEqual(["terminal", "chat"]);
  });
});
