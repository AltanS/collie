import { createRef, useState, type ComponentProps, type RefObject } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { clearStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import { CrewProvider } from "./crew-provider";
import { Composer, type ComposerHandle } from "./composer";
import { unreadIdentity } from "./unread-dialog-block";

// The M102 safety review, I: the Keys drawer opens once per unread screen, and a screen whose clock, spinner or
// timer ticks is the same screen, so a drawer the person closed stays closed.

const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  sessionStorage.clear();
  __forgetSendAgainMemory();
  __forgetSendIntentMemory();
});
afterEach(() => cleanup());

const PROPS: ComponentProps<typeof Composer> = {
  paneId: "w1:p1",
  agent: "claude",
  isShell: false,
  gone: false,
  readOnly: false,
  surface: FREE,
  text: "pane output",
  terminalDraft: null,
  rawTerminalDraft: null,
  prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
  display: { open: false, onToggle: vi.fn() },
  onSent: vi.fn(),
};

interface Mounted {
  readonly handle: RefObject<ComposerHandle | null>;
  readonly update: (next: Partial<ComponentProps<typeof Composer>>) => void;
}

function mount(first: Partial<ComponentProps<typeof Composer>> = {}): Mounted {
  const handle = createRef<ComposerHandle>();
  let update: (next: Partial<ComponentProps<typeof Composer>>) => void = () => undefined;
  function Harness() {
    const [over, setOver] = useState(first);
    update = (next) => act(() => setOver((was) => ({ ...was, ...next })));
    return (
      <CrewProvider servers={undefined}>
        <Composer ref={handle} {...PROPS} {...over} />
      </CrewProvider>
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
  return { handle, update: (next) => update(next) };
}

/** The identity of one unread screen whose spinner row's timer and clock read `seconds`. */
function screenId(seconds: number, words = "Pick a mode for the lab run"): string {
  const text = [words, "  > fast", "    careful", `\u2733 Wibbling\u2026 (${seconds}s \u00b7 \u2193 ${seconds * 10} tokens)`, `lab clock 12:15:0${seconds}`].join("\n");
  return unreadIdentity(null, splitLines(parseAnsi(text)));
}

const keys = () => screen.getByRole("button", { name: "Keys" });

describe("I: the Keys drawer opens once per unread screen", () => {
  it("a drawer the person closed stays closed while the screen's timer and clock tick", async () => {
    const user = userEvent.setup();
    const m = mount({ unreadIdentity: screenId(4) });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
    await user.click(keys());
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "false"));
    m.update({ unreadIdentity: screenId(5) });
    m.update({ unreadIdentity: screenId(6) });
    expect(keys()).toHaveAttribute("aria-expanded", "false");
  });

  it("a new unread screen (other words) opens the drawer again", async () => {
    const user = userEvent.setup();
    const m = mount({ unreadIdentity: screenId(4) });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
    await user.click(keys());
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "false"));
    m.update({ unreadIdentity: screenId(5, "Pick a target for the lab run") });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
  });
});
