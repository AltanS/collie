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
import { http, HttpResponse } from "msw";
import { asJsonString, parseJsonObject } from "@/lib/json";
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

describe("L: an armed Send past this screen never goes out with a code", () => {
  it("a code sent while Send past this screen is armed carries no rows hash and no override, and the arm is gone after", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => (request.mode === "prepare" ? sendAnswer(request.id, null, undefined, { rowsHash: "ab12cd" }) : sendAnswer(request.id, "sent"))));
    const m = mount({ surface: FREE });
    await act(async () => {
      m.handle.current?.typeAnyway();
    });
    await waitFor(() => expect(screen.getByPlaceholderText(/goes past this screen/)).toBeInTheDocument());
    m.update({ surface: SECRET });
    await user.type(codeField(), CODE);
    await user.click(screen.getByRole("button", { name: "Send the code" }));
    await waitFor(() => expect(recordedSends().filter((request) => request.mode !== "prepare")).toHaveLength(1));
    const code = recordedSends().find((request) => request.secret === true);
    expect(code?.rowsHash).toBeUndefined();
    expect(code?.override).toBeUndefined();
    m.update({ surface: FREE });
    await user.type(screen.getByRole("textbox"), "a normal message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends().filter((request) => request.mode !== "prepare")).toHaveLength(2));
    const normal = recordedSends().filter((request) => request.mode !== "prepare")[1];
    expect(normal?.override).toBeUndefined();
    expect(normal?.rowsHash).toBeUndefined();
  });
});

/**
 * The bridge for a lost answer: the first `lost` requests get no answer (the link drops), then the bridge answers
 * with `then`. Every request's id is kept, and whether it named the code, never the code itself.
 */
function bridgeThatLoses(lost: number, then: (id: string) => ReturnType<typeof sendAnswer>) {
  const asked: { id: string; code: boolean }[] = [];
  server.use(
    http.post("/api/send", async ({ request }) => {
      const body = parseJsonObject(await request.text());
      const id = asJsonString(body?.id) ?? "";
      asked.push({ id, code: asJsonString(body?.text) === CODE && body?.secret === true });
      if (asked.length <= lost) return HttpResponse.error();
      return HttpResponse.json(then(id));
    }),
  );
  return asked;
}

async function tapSendCode(user: ReturnType<typeof userEvent.setup>, asked: readonly unknown[], count: number) {
  await user.click(screen.getByRole("button", { name: "Send the code" }));
  await waitFor(() => expect(asked).toHaveLength(count));
  // The send has ended once the notice or an empty field says so: the button is busy no more.
  await waitFor(() => expect(screen.getByRole("button", { name: "Send the code" })).toHaveAttribute("aria-busy", "false"));
}

describe("D, pass 2: a code whose answer was lost goes again under the same request id", () => {
  it("the next tap on the same code reuses the request id, so the bridge writes it once", async () => {
    const user = userEvent.setup();
    const asked = bridgeThatLoses(1, (id) => sendAnswer(id, "sent"));
    mount();
    await user.type(codeField(), CODE);
    await tapSendCode(user, asked, 1);
    expect(codeField()).toHaveValue(CODE);
    await tapSendCode(user, asked, 2);
    expect(asked[1]).toEqual({ id: asked[0]!.id, code: true });
    // The id was kept in memory only: nothing in the page's storage names the code or the request.
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(asked[0]!.id);
  });

  it("a change to the field's text drops the kept id: the next tap is a new request", async () => {
    const user = userEvent.setup();
    const asked = bridgeThatLoses(1, (id) => sendAnswer(id, "sent"));
    mount();
    await user.type(codeField(), CODE);
    await tapSendCode(user, asked, 1);
    await user.type(codeField(), "9{Backspace}");
    expect(codeField()).toHaveValue(CODE);
    await tapSendCode(user, asked, 2);
    expect(asked[1]!.id).not.toBe(asked[0]!.id);
  });

  it("an answer drops the kept id: after a refusal the next tap is a new request", async () => {
    const user = userEvent.setup();
    const asked = bridgeThatLoses(1, (id) => sendAnswer(id, "refused", "unconfirmed", { offers: [], surface: SECRET }));
    mount();
    await user.type(codeField(), CODE);
    await tapSendCode(user, asked, 1);
    await tapSendCode(user, asked, 2);
    expect(asked[1]!.id).toBe(asked[0]!.id);
    await tapSendCode(user, asked, 3);
    expect(asked[2]!.id).not.toBe(asked[1]!.id);
  });

  it("a closed field drops the kept id: the code typed again after it is a new request", async () => {
    const user = userEvent.setup();
    const asked = bridgeThatLoses(1, (id) => sendAnswer(id, "sent"));
    mount();
    await user.type(codeField(), CODE);
    await tapSendCode(user, asked, 1);
    await user.click(screen.getByRole("button", { name: "Close the code field" }));
    await user.click(await screen.findByRole("button", { name: "Open the code field" }));
    await user.type(codeField(), CODE);
    await tapSendCode(user, asked, 2);
    expect(asked[1]!.id).not.toBe(asked[0]!.id);
  });
});

describe("D, pass 2: a code the bridge found no sign-in field for", () => {
  it("no_secret_field says Collie cannot see the field now, nothing was typed, and offers the Screen and Type (the M102 review 3)", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "no_secret_field", { offers: ["keys"], surface: FREE, detail: "The sign-in field is not on the screen any more. Nothing was typed." })));
    mount({ screen: { on: false, onToggle } });
    await sendCode(user);
    const notice = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="composer-refusal"]');
      expect(found?.textContent).toMatch(/Collie cannot see the sign-in field now\. Nothing was typed\. Look at the screen, or use Type\. Type sends each key at once, with no check\./u);
      return found!;
    });
    // The bridge's English line is not shown: it would claim the field is gone when the bridge may only have failed to read it.
    expect(notice.textContent).not.toMatch(/not on the screen any more/u);
    // The ways on the line names: the notice's Screen button, and the Type pill beside Keys.
    await user.click(screen.getByRole("button", { name: "Screen" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Type into terminal" })).toBeEnabled();
    codeNeverPlain();
  });
});

describe("the M102 review 3: a crew member on an older Collie has no check that the field is still there", () => {
  it("the sign-in field on such a member's pane says so in one line", () => {
    mount({ olderMember: "minibox" });
    expect(codeField()).toBeInTheDocument();
    expect(screen.getByText("minibox runs an older Collie, so it does not check that the sign-in field is still there before it types.")).toBeInTheDocument();
  });

  it("a member whose name is unknown is named in a neutral word, never a sentence that starts with a space", () => {
    mount({ olderMember: "" });
    expect(screen.getByText("This machine runs an older Collie, so it does not check that the sign-in field is still there before it types.")).toBeInTheDocument();
  });

  it("the sign-in field on any other pane draws no such line", () => {
    mount();
    expect(codeField()).toBeInTheDocument();
    expect(screen.queryByText(/runs an older Collie/u)).toBeNull();
  });
});
