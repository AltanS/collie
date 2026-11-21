import { describe, expect, it } from "vitest";

import { isNewAddress, overOf, queueSidebarReveal, takeSidebarReveal, withOver, withoutOver } from "./new-over";

// New over the screen (ADR 0173): the `over=` address and the one-shot sidebar reveal.

describe("the over= address", () => {
  it("knows the two New addresses, with or without a query", () => {
    expect(isNewAddress("/new")).toBe(true);
    expect(isNewAddress("/new?machine=a")).toBe(true);
    expect(isNewAddress("/new/add?kind=agent")).toBe(true);
    expect(isNewAddress("/news")).toBe(false);
    expect(isNewAddress("/pane/w1%3Ap1")).toBe(false);
  });

  it("puts New over a screen, keeps the screen's own query and replaces a New already there", () => {
    expect(withOver("/", "/new")).toBe("/?over=%2Fnew");
    const pane = withOver("/pane/w1%3Ap1?h=lodge", "/new?pane=w1%3Ap1");
    expect(pane.startsWith("/pane/w1%3Ap1?h=lodge&over=")).toBe(true);
    expect(overOf(pane)).toBe("/new?pane=w1%3Ap1");
    expect(overOf(withOver(pane, "/new/add?kind=agent"))).toBe("/new/add?kind=agent");
  });

  it("takes New off and gives the screen back exactly", () => {
    expect(withoutOver(withOver("/", "/new"))).toBe("/");
    expect(withoutOver(withOver("/pane/w1%3Ap1?h=lodge", "/new"))).toBe("/pane/w1%3Ap1?h=lodge");
    expect(withoutOver("/pane/x")).toBe("/pane/x");
  });

  it("reads nothing that is not a New address", () => {
    expect(overOf("/")).toBeUndefined();
    expect(overOf("/?over=%2Fpane%2Fx")).toBeUndefined();
    expect(overOf("/?h=lodge")).toBeUndefined();
  });
});

describe("the sidebar reveal", () => {
  it("is spent once, and only by the pane it was queued for", () => {
    queueSidebarReveal("w1:p1");
    expect(takeSidebarReveal("w2:p1")).toBe(false);
    expect(takeSidebarReveal("w1:p1")).toBe(true);
    expect(takeSidebarReveal("w1:p1")).toBe(false);
  });
});
