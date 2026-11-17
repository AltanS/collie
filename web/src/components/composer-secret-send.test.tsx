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
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";
import { CrewProvider } from "./crew-provider";
import { Composer, type ComposerHandle } from "./composer";

// The M102 safety review: a sign-in code is never kept for a resend (A), and while the screen asks for a
// code, only the code field may send (B). The code below is invented for the test.

const CODE = "FAKEcode1234";
const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
const SECRET: Surface = { revision: 4, turn: "idle", modal: "none", composer: "empty", field: "secret" };
const ONLY_FIELD = "The screen asks for a sign-in code. Only the code field can send now, so nothing was sent.";

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
  surface: SECRET,
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

const codeField = () => screen.getByRole("textbox", { name: "Sign-in code" });

async function sendCode(user: ReturnType<typeof userEvent.setup>) {
  await user.type(codeField(), CODE);
  await user.click(screen.getByRole("button", { name: "Send the code" }));
  await waitFor(() => expect(recordedSends()).toHaveLength(1));
}

/** No request ever carried the code without `secret`. */
function codeNeverPlain() {
  expect(recordedSends().filter((request) => request.text.includes(CODE) && request.secret !== true)).toEqual([]);
}

describe("A: a sign-in code is never kept for a resend", () => {
  it("a code that ended unknown leaves no Send again once the field has gone, and nothing more is sent", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "unknown", "no_evidence", { offers: ["keys"], surface: SECRET })));
    const m = mount();
    await sendCode(user);
    await screen.findByText(/cannot tell/i);
    m.update({ surface: FREE });
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
    expect(recordedSends()).toHaveLength(1);
    codeNeverPlain();
  });

  it("a refused code's notice offers Enter it again while the field shows, and that tap sends nothing", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: [], surface: SECRET })));
    mount();
    await sendCode(user);
    const step = await screen.findByRole("button", { name: "Enter it again" });
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
    await user.click(step);
    await waitFor(() => expect(codeField()).toHaveValue(""));
    expect(recordedSends()).toHaveLength(1);
  });

  it("a refused code makes no offer that carries the code, so nothing can send it as text after the field goes", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "draft_present", { offers: ["append", "replace", "cancel"], surface: SECRET })));
    const m = mount();
    await sendCode(user);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Sign-in code" })).toBeInTheDocument());
    m.update({ surface: FREE });
    expect(screen.queryAllByRole("button", { name: /^(Add|Replace)/ })).toEqual([]);
    codeNeverPlain();
  });
});

describe("B: while the screen asks for a code, only the code field sends", () => {
  it("a send from elsewhere (the queued card, a quick reply) is refused with words and sends nothing", async () => {
    const m = mount();
    let went: boolean | undefined;
    await act(async () => {
      went = await m.handle.current?.sendLine("hello from a quick reply");
    });
    expect(went).toBe(false);
    expect(recordedSends()).toEqual([]);
    expect(screen.getByText(ONLY_FIELD)).toBeInTheDocument();
  });

  it("with the code field closed, the normal box's Send is refused with words and sends nothing", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Close the code field" }));
    await user.type(screen.getByRole("textbox"), "a normal message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(ONLY_FIELD);
    expect(recordedSends()).toEqual([]);
  });
});

describe("D: a code that may have gone cannot be sent twice by one tap", () => {
  it("after a code send that ended unknown, the code field is empty", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "unknown", "no_evidence", { offers: ["keys"], surface: SECRET })));
    mount({ onCannotTell: vi.fn() });
    await sendCode(user);
    await waitFor(() => expect(codeField()).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Send the code" })).toBeDisabled();
    expect(recordedSends()).toHaveLength(1);
  });

  it("a code the bridge refused (it did not go) still stays in the field to send again", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: [], surface: SECRET })));
    mount();
    await sendCode(user);
    await screen.findByRole("button", { name: "Enter it again" });
    expect(codeField()).toHaveValue(CODE);
  });
});
