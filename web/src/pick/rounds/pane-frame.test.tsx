import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { columnFrame } from "@/components/strip-column";
import { FOCUS_RING } from "@/components/ui/button";

import ROUND, { IN_EITHER_PLANE, LOOKS, RING_SHOWN } from "./pane-frame";

// The pane-frame round (a proposal, deleted after the pick): its copies of the app's strings stay equal to
// the app's, every look reserves the same mark on every column so a focus change moves nothing, and every
// option draws every case.

afterEach(cleanup);
// jsdom lays out nothing and has no element scroll; the transcript list scrolls to its tail on mount.
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

/** The border width classes of a class string: what a focus change must never change. */
function widths(cls: string): string[] {
  return cls.split(/\s+/u).filter((c) => /^border(-[trbl])?(-[0-9]+)?$/u.test(c));
}

describe("the pane-frame round", () => {
  it("copies the planes' shared tints and the focus ring from the app", () => {
    expect(columnFrame(false)).toContain(IN_EITHER_PLANE);
    expect(columnFrame(true)).toContain(IN_EITHER_PLANE);
    expect(RING_SHOWN).toBe(FOCUS_RING.replaceAll("focus-visible:", ""));
  });

  it("reserves one mark on the focused column and the others, so a focus change moves nothing", () => {
    for (const [id, look] of Object.entries(LOOKS)) expect(widths(look(true)), id).toEqual(widths(look(false)));
    expect(LOOKS.today(true)).toBe(columnFrame(true));
  });

  it("draws every case for every option, one focused column each", async () => {
    for (const option of ROUND.options) {
      for (const c of ROUND.cases) {
        const { container, unmount } = render(<>{option.render(c.id)}</>);
        await waitFor(() => expect(container.querySelector("[data-focused] [data-slot=column-frame]"), `${String(option.n)} ${c.id}`).not.toBeNull());
        expect(container.querySelectorAll("[data-focused]").length).toBe(1);
        expect(container.querySelector(`[data-state="${option.state ?? ""}"]`)).not.toBeNull();
        const ring = container.querySelector("[data-slot=focused-menu]");
        expect(ring?.className.split(" ").includes("outline-offset-2"), `${String(option.n)} ${c.id}`).toBe(c.id === "ring");
        unmount();
      }
    }
  }, 60_000);

  it("names a look for every option", () => {
    const looks = new Set<string>(Object.keys(LOOKS));
    for (const option of ROUND.options) expect(looks.has((option.state ?? "").replace("pane-frame-", "")), option.label).toBe(true);
  });
});
