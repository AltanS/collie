import { createRef, useState, type ComponentProps, type RefObject } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { clearStatus, currentStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";
import { CrewProvider } from "./crew-provider";
import { Composer, type ComposerHandle } from "./composer";

// The M102 safety review: the "cannot tell" card's Send again sends the send it speaks about (C), and the
// notice's Send again waits and asks exactly as the card does (E).

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

const field = () => screen.getByRole("textbox");

/** The first send ends unknown; every later one is sent. */
function unknownThenSent(parts: Parameters<typeof sendAnswer>[3] = {}) {
  server.use(...sendHandler((request) => (recordedSends().length <= 1 ? sendAnswer(request.id, "unknown", "no_evidence", { offers: ["keys"], surface: FREE, ...parts }) : sendAnswer(request.id, "sent"))));
}

describe("C: the card's Send again sends the send it is about", () => {
  it("sends the kept text, not the half-typed words now in the box, and leaves the box as it is", async () => {
    const user = userEvent.setup();
    unknownThenSent();
    const m = mount({ onCannotTell: vi.fn() });
    await user.type(field(), "first message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await user.clear(field());
    await user.type(field(), "half typed");
    act(() => m.handle.current?.answerAgain());
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]?.text).toBe("first message");
    await waitFor(() => expect(currentStatus()?.text).toMatch(/^Sent/));
    expect(field()).toHaveValue("half typed");
  });
});

describe("E: the notice's Send again waits as the card does", () => {
  const WAITING = "Collie is waiting for the agent's own word that it arrived. Send again turns on when the wait ends.";

  it("while the agent's own word may still come, the notice's Send again sends nothing and says why", async () => {
    const user = userEvent.setup();
    unknownThenSent({ awaitingEventUntil: Date.now() + 60_000 });
    mount();
    await user.type(field(), "first message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    const again = await screen.findByRole("button", { name: "Send again" });
    await user.click(again);
    expect(screen.getByText(WAITING)).toBeInTheDocument();
    expect(recordedSends()).toHaveLength(1);
  });

  it("once the wait is over, the notice's Send again sends the kept text", async () => {
    const user = userEvent.setup();
    unknownThenSent({ awaitingEventUntil: Date.now() + 400 });
    mount();
    await user.type(field(), "first message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    const again = await screen.findByRole("button", { name: "Send again" });
    await waitFor(() => expect(again).toBeEnabled(), { timeout: 2_000 });
    expect(screen.queryByText(WAITING)).toBeNull();
    await user.click(again);
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]?.text).toBe("first message");
  });
});
