import { createRef, useState, type ComponentProps, type RefObject } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { clearStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import { CrewProvider } from "./crew-provider";
import { Composer, type ComposerHandle } from "./composer";


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

const keys = () => screen.getByRole("button", { name: "Keys" });

// The M102 review 2, I: the drawer follows the pane's unread STATE, never its rows. The pane view names the state
// (`unreadState`, a word such as "unread"); the drawer opens once when a pane goes from not unread to unread.
describe("I: the Keys drawer opens once per unread state of a pane", () => {
  it("a drawer the person closed stays closed while the state lasts", async () => {
    const user = userEvent.setup();
    const m = mount({ unreadState: "unread" });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
    await user.click(keys());
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "false"));
    m.update({ unreadState: "unread", text: "other rows" });
    expect(keys()).toHaveAttribute("aria-expanded", "false");
  });

  it("the state ends and comes again: the drawer opens again", async () => {
    const user = userEvent.setup();
    const m = mount({ unreadState: "unread" });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
    await user.click(keys());
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "false"));
    m.update({ unreadState: null });
    m.update({ unreadState: "unread" });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
  });

  it("another pane's unread state opens the drawer for that pane", async () => {
    const user = userEvent.setup();
    markLive("w1:p2");
    const m = mount({ unreadState: "unread" });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
    await user.click(keys());
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "false"));
    m.update({ paneId: "w1:p2", unreadState: "unread" });
    await waitFor(() => expect(keys()).toHaveAttribute("aria-expanded", "true"));
  });
});
