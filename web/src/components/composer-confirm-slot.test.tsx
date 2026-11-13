import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { rememberUnknownSend, __forgetSendAgainMemory } from "@/lib/send-again";
import { clearStatus } from "@/lib/status";
import { Composer } from "./composer";

// "Arming moves nothing" (Altan, 2026-11-13): the word button that replaces Send for a second tap ("Really send?"
// on a destructive line, "Send it again?" after an unknown send) is drawn over the field, inside a wrapper that
// keeps the round Send button's footprint and its grid cell. jsdom lays nothing out, so this reads structure and
// classes: the wrapper's size and cell are the unarmed Send button's, and the word button is absolute at the outer edge.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  sessionStorage.clear();
  __forgetSendAgainMemory();
});
afterEach(() => cleanup());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>>) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
}

/** The classes that place and size a slot: its footprint and its grid cell. */
function placement(el: Element): string[] {
  return [...el.classList].filter((c) => c === "size-9" || c.startsWith("col-start-") || c.startsWith("row-start-")).toSorted();
}

const CASES = [
  { name: "box, right hand", layout: "box", hand: "right", edge: "right-0", other: "left-0" },
  { name: "box, left hand (mirrored)", layout: "box", hand: "left", edge: "left-0", other: "right-0" },
  { name: "field, right hand", layout: "field", hand: "right", edge: "right-0", other: "left-0" },
  { name: "field, left hand (mirrored)", layout: "field", hand: "left", edge: "left-0", other: "right-0" },
] as const;

const ARMS = [
  { arm: "a destructive draft", word: "Really send?", draft: "rm -rf build", unknown: false },
  { arm: "a send after an unknown one", word: "Send it again?", draft: "run the tests", unknown: true },
] as const;

describe("the Send slot while a confirm word is armed", () => {
  for (const c of CASES) {
    for (const a of ARMS) {
      it(`${a.arm}, ${c.name}: the slot keeps Send's footprint and cell, and the word is drawn over the field at the outer edge`, async () => {
        const user = userEvent.setup();
        if (a.unknown) rememberUnknownSend(undefined, "w1:p1", a.draft, Date.now());
        renderComposer({ layout: c.layout, hand: c.hand });
        await user.type(screen.getByPlaceholderText(/type a reply/i), a.draft);
        const send = await screen.findByRole("button", { name: "Send" });
        const before = placement(send);
        expect(before).toContain("size-9");
        await user.click(send);
        const word = await screen.findByRole("button", { name: a.word });
        const slot = word.parentElement!;
        expect(slot.getAttribute("data-slot")).toBe("composer-send-slot");
        // Same size-9 footprint and the same cell as the Send button it stands in for.
        expect(placement(slot)).toEqual(before);
        // The word is out of flow: absolute, above the field, on the slot's outer edge, at Send's height.
        expect(word.classList.contains("absolute")).toBe(true);
        expect(word.classList.contains("z-10")).toBe(true);
        expect(word.classList.contains("h-9")).toBe(true);
        expect(word.classList.contains("top-0")).toBe(true);
        expect(word.classList.contains(c.edge)).toBe(true);
        expect(word.classList.contains(c.other)).toBe(false);
        // Solid fill (the destructive variant's) and a shadow, so covered text does not shine through.
        expect(word.className).toContain("bg-destructive");
        expect(word.classList.contains("shadow-md")).toBe(true);
        // The ring is gone: a cover does the hiding now.
        expect(word.className).not.toMatch(/\bring-/);
        // The cover: one extra element in the composer's own frame, only while armed, out of flow, and absorbing taps.
        const cover = document.querySelector<HTMLElement>('[data-slot="composer-confirm-cover"]')!;
        expect(cover.getAttribute("aria-hidden")).toBe("true");
        for (const token of ["absolute", "inset-y-0", "z-[5]", "w-40", c.edge])
          expect(cover.classList.contains(token), token).toBe(true);
        expect(cover.classList.contains(c.other)).toBe(false);
        // It swallows taps: what it hides (Attach, the small mic, Expand) cannot be hit while it shows. The word stays above it.
        expect(cover.classList.contains("pointer-events-none")).toBe(false);
        expect(word.classList.contains("z-10")).toBe(true);
        expect(cover.classList.contains(c.hand === "left" ? "rounded-l-xl" : "rounded-r-xl")).toBe(true);
        // Its fill is the box's own, fading toward the text: card in the box layout, background in the field layout.
        const fill = c.layout === "box" ? "--color-card" : "--color-background";
        expect(cover.className).toContain(`linear-gradient(to_${c.hand === "left" ? "right" : "left"},var(${fill})_calc(100%-24px),transparent)`);
        // Its positioned parent is the composer's frame, which is `relative`, and the word's slot is a sibling of it.
        expect(cover.parentElement).toBe(slot.parentElement);
        expect(cover.parentElement!.classList.contains("relative")).toBe(true);
        expect(cover.parentElement!.contains(screen.getByPlaceholderText(/type a reply/i))).toBe(true);
        // The word button no longer carries a cell or a width of the layout's own: nothing in flow changed size.
        expect(placement(word)).toEqual([]);
      });
    }
  }

  it("the cover exists only while the word is armed", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", hand: "right" });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "rm -rf build");
    expect(document.querySelector('[data-slot="composer-confirm-cover"]')).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Really send?" });
    expect(document.querySelector('[data-slot="composer-confirm-cover"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Really send?" }));
    await waitFor(() => expect(document.querySelector('[data-slot="composer-confirm-cover"]')).toBeNull());
  });

  it("the field's classes are the same before the tap, while armed, and after the second tap", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", hand: "right" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "rm -rf build");
    const before = box.className;
    await user.click(await screen.findByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Really send?" });
    expect(screen.getByPlaceholderText(/type a reply/i).className).toBe(before);
    await user.click(screen.getByRole("button", { name: "Really send?" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Really send?" })).toBeNull());
  });
});
