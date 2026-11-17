import { createRef, useState, type ComponentProps, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBeltIntents, queueBeltIntent } from "@/lib/belt-intent";
import { saveDraft } from "@/lib/drafts";
import { beginCatchUp, endCatchUp, setLocked } from "@/lib/idle";
import { markLive, resetLiveness } from "@/lib/liveness";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { paneScopeKey } from "@/lib/scope";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __resetHandsFree } from "@/lib/stt";
import { clearStatus, currentStatus } from "@/lib/status";
import type { HeldRow } from "@/lib/surface/send";
import type { Surface } from "@/lib/surface/surface";
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";
import { installFakeMediaRecorder, uninstallFakeMediaRecorder } from "@/test/media-recorder";
import { expectTapAnswers } from "@/test/tap-guard";
import { CrewProvider } from "./crew-provider";
import { Composer, type ComposerHandle } from "./composer";
import { ScreenStop } from "./harness-bar";

// M102 spec 11, "No tap vanishes": every control of the composer, in every state in which it cannot act,
// answers a tap with a request, a visible change the person asked for, or words on screen. Each case drives
// one control in one state and asks the guard (test/tap-guard.ts) that the tap changed the text, the request
// log or the status line. Roles and accessible names only, never a class or a test id for the control.

vi.mock("@/components/image-editor", () => ({
  ImageEditor: () => <div role="dialog" aria-label="Edit image" />,
}));
vi.mock("@/lib/image-edit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/image-edit")>()),
  canvasAvailable: () => true,
}));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  __forgetSendAgainMemory();
  __resetBeltIntents();
  __resetOperatorCommands();
  __resetHandsFree();
});
afterEach(() => {
  cleanup();
  setLocked(false);
  endCatchUp();
  uninstallFakeMediaRecorder();
});

const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
const RUNNING: Surface = { revision: 2, turn: "running", modal: "none", composer: "empty" };
const ASK: Surface = {
  revision: 3,
  turn: "idle",
  modal: { ask: { id: "ask-menu", kind: "menu", options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }], channel: "keys", hash: "0a1b2c" } },
  composer: "unknown",
};
const SECRET: Surface = { revision: 4, turn: "idle", modal: "none", composer: "empty", field: "secret" };
const SHELL: Surface = { revision: 9, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" };

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
  /** Change the composer's props the way the next poll would. */
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
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
  return { handle, update: (next) => update(next) };
}

/** A send the fake bridge holds until the test lets it go: the composer is `sending` meanwhile. */
function holdSends() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.post("/api/send", async ({ request }) => {
      // SAFETY: the phone's own JSON body is an object with a string `id`.
      const body = (await request.json()) as { id: string };
      await gate;
      return HttpResponse.json(sendAnswer(body.id, "sent"));
    }),
  );
  return release;
}

const field = () => screen.getByRole("textbox");
const status = () => currentStatus()?.text ?? null;

async function startSend(user: ReturnType<typeof userEvent.setup>, words = "first message") {
  await user.type(field(), words);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(document.querySelector("[data-slot='composer-primary'] .animate-spin")).not.toBeNull());
}

describe("composer taps: send() from anywhere but the round Send button (fix 1)", () => {
  it("no tap vanishes: a harness pill while a send runs says another send is still running", async () => {
    const user = userEvent.setup();
    const release = holdSends();
    mount();
    await startSend(user);
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Compact" })));
    expect(screen.getByText("Another send from this phone is still running. Wait for it to end.")).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByText(/still running/)).toBeNull());
  });

  it("no tap vanishes: a harness pill while the launch starts says Starting", async () => {
    const user = userEvent.setup();
    mount({ starting: true });
    // The header says Starting now; in the composer the box is off and its placeholder says it. No row holds the words.
    expect(screen.queryByText("Starting…")).toBeNull();
    expect(field()).not.toBeDisabled();
    expect(field()).toHaveAttribute("readonly");
    expect(field()).toHaveAttribute("aria-disabled", "true");
    expect(field()).toHaveAttribute("placeholder", "Starting…");
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Compact" })));
    expect(screen.getAllByText("Starting…")).toHaveLength(1);
    expect(recordedSends()).toEqual([]);
  });

  it("no tap vanishes: a send for a locked pane says the lock's own words", async () => {
    const m = mount({ gone: true });
    await expectTapAnswers(async () => {
      await act(() => m.handle.current?.typeAnyway());
    });
    expect(screen.getByText("Pane is gone")).toBeInTheDocument();
  });
});

describe("composer taps: the sign-in frame (fix 2)", () => {
  it("no tap vanishes: a locked frame says why under the frame", () => {
    mount({ surface: SECRET, gone: true });
    const frame = screen.getByRole("group", { name: "Sign-in code" });
    expect(frame).toBeInTheDocument();
    // The lock's words stand as the field's own placeholder (stage's `lockedWhy`), so the frame is never dead.
    expect(screen.getByRole("textbox", { name: "Sign-in code" })).toHaveAttribute("placeholder", "Pane is gone");
  });

  it("no tap vanishes: a frame that waits for the launch says Starting", () => {
    mount({ surface: SECRET, starting: true });
    expect(screen.getAllByText("Starting…").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Sign-in code" })).toBeDisabled();
  });

  it("no tap vanishes: a code the bridge refused stays in the frame to send again", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "not_free", { offers: ["keys"], surface: SECRET })));
    mount({ surface: SECRET });
    await user.type(screen.getByRole("textbox", { name: "Sign-in code" }), "654321");
    await user.click(screen.getByRole("button", { name: "Send the code" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(recordedSends()[0]?.secret).toBe(true);
    expect(screen.getByRole("textbox", { name: "Sign-in code" })).toHaveValue("654321");
  });

  it("no tap vanishes: while the code is sent, Send shows a busy state, and a code that went empties the frame", async () => {
    const user = userEvent.setup();
    const release = holdSends();
    mount({ surface: SECRET });
    await user.type(screen.getByRole("textbox", { name: "Sign-in code" }), "654321");
    await user.click(screen.getByRole("button", { name: "Send the code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send the code" })).toHaveAttribute("aria-busy", "true"));
    release();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Sign-in code" })).toHaveValue(""));
  });
});

describe("composer taps: Answer the dialog with no card to go to (fix 3)", () => {
  it("no tap vanishes: the Send slot's word says the card is not on screen, with the Screen button", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    mount({ surface: ASK, onAnswerDialog: () => false, dialogCard: true, screen: { on: false, onToggle } });
    await user.type(field(), "for after the dialog");
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Answer the dialog" })));
    expect(screen.getByText("The question's card is not on screen. Open the Screen to answer it in the terminal.")).toBeInTheDocument();
    const notice = document.querySelector<HTMLElement>('[data-slot="composer-refusal"]')!.closest<HTMLElement>('[data-slot="notice"]')!;
    await user.click(within(notice).getByRole("button", { name: "Screen" }));
    expect(onToggle).toHaveBeenCalled();
  });

  it("no tap vanishes: the notice's card button says so too when no card took the focus", async () => {
    const user = userEvent.setup();
    mount({ surface: ASK, onAnswerDialog: () => false, dialogCard: true, screen: { on: false, onToggle: vi.fn() } });
    // A quick reply meets the ask and is told at the Send slot, with the way to the card.
    await user.click(screen.getByRole("button", { name: "Compact" }));
    const first = await screen.findByText(/dialog is waiting/i);
    expect(first).toBeInTheDocument();
    const notice = document.querySelector<HTMLElement>('[data-slot="composer-refusal"]')!.closest<HTMLElement>('[data-slot="notice"]')!;
    await expectTapAnswers(() => user.click(within(notice).getByRole("button", { name: "Answer the dialog" })));
    expect(screen.getByText(/card is not on screen/i)).toBeInTheDocument();
  });

  it("no tap vanishes: a card that took the focus needs no words", async () => {
    const user = userEvent.setup();
    const onAnswerDialog = vi.fn(() => true);
    mount({ surface: ASK, onAnswerDialog, dialogCard: true });
    await user.type(field(), "for after the dialog");
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));
    expect(onAnswerDialog).toHaveBeenCalledOnce();
    expect(screen.queryByText(/card is not on screen/i)).toBeNull();
  });
});

describe("composer taps: the answer slot with no card for its dialog opens the exit (M102 spec 10)", () => {
  const UNSEEN = "A dialog is waiting that no card shows. Use your keys or Type.";

  it("no tap vanishes: Answer the dialog with no card asks the pane for the exit, and says so", async () => {
    const user = userEvent.setup();
    const onAnswerUnseen = vi.fn();
    mount({ surface: ASK, onAnswerDialog: () => false, dialogCard: false, onAnswerUnseen });
    await user.type(field(), "123456");
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Answer the dialog" })));
    expect(onAnswerUnseen).toHaveBeenCalledTimes(1);
    expect(screen.getByText(UNSEEN)).toBeInTheDocument();
    expect(screen.queryByText(/card is not on screen/i)).toBeNull();
    expect(recordedSends()).toEqual([]);
  });

  it("no tap vanishes: a quick reply into the answer slot with no card asks for the exit and types nothing", async () => {
    const user = userEvent.setup();
    const onAnswerUnseen = vi.fn();
    mount({ surface: ASK, onAnswerDialog: () => false, dialogCard: false, onAnswerUnseen });
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Compact" })));
    expect(onAnswerUnseen).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(UNSEEN)).toBeInTheDocument();
    expect(recordedSends()).toEqual([]);
  });

  it("a card on screen keeps today's words, and no exit is asked for", async () => {
    const user = userEvent.setup();
    const onAnswerUnseen = vi.fn();
    mount({ surface: ASK, onAnswerDialog: () => false, dialogCard: true, onAnswerUnseen });
    await user.click(screen.getByRole("button", { name: "Compact" }));
    expect(await screen.findByText(/dialog is waiting\. Answer it first/i)).toBeInTheDocument();
    expect(onAnswerUnseen).not.toHaveBeenCalled();
  });
});

describe("composer taps: the round Send button that cannot act (fix 4)", () => {
  it("no tap vanishes: offline, a tap says Reconnect to send", async () => {
    const user = userEvent.setup();
    mount({ stale: true });
    await user.type(field(), "hello");
    const send = screen.getByRole("button", { name: "Reconnect to send" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    await expectTapAnswers(() => user.click(send));
    expect(document.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent("Reconnect to send");
    expect(recordedSends()).toEqual([]);
  });

  it("no tap vanishes: locked, a tap says why the box is locked", async () => {
    const user = userEvent.setup();
    saveDraft(undefined, "w1:p1", "left over");
    mount({ readOnly: true });
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Send" })));
    expect(document.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent("Read-only, not authorised");
    expect(recordedSends()).toEqual([]);
  });

  it("no tap vanishes: while the launch starts, a tap says Starting", async () => {
    const user = userEvent.setup();
    // The draft is typed before the start: the box is off while it starts, and the draft stays in it.
    const m = mount();
    await user.type(field(), "hello");
    m.update({ starting: true });
    expect(field()).not.toBeDisabled();
    expect(field()).toHaveAttribute("readonly");
    expect(field()).toHaveAttribute("aria-disabled", "true");
    expect(field()).toHaveValue("hello");
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Send" })));
    expect(document.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent("Starting…");
    expect(field()).toHaveValue("hello");
    expect(recordedSends()).toEqual([]);
  });
});

describe("composer taps: Send in the fullscreen editor while an ask owns the keys (fix 5)", () => {
  let area: HTMLElement;
  beforeEach(() => {
    area = document.createElement("div");
    document.body.append(area);
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return this.value.split("\n").length * 21 + 12;
      },
    });
  });
  afterEach(() => {
    area.remove();
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
  });

  it("no tap vanishes: the editor closes and the dialog notice shows", async () => {
    const user = userEvent.setup();
    const m = mount({ layout: "box", expandArea: area });
    const long = Array.from({ length: 8 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    await user.click(field());
    fireEvent.change(field(), { target: { value: long } });
    await user.click(await screen.findByRole("button", { name: "Expand" }));
    const layer = document.querySelector<HTMLElement>('[data-slot="composer-expanded"]')!;
    expect(layer).not.toBeNull();
    // The ask arrives while the editor is open.
    m.update({ surface: ASK });
    await expectTapAnswers(() => user.click(within(layer).getByRole("button", { name: "Send" })));
    expect(document.querySelector('[data-slot="composer-expanded"]')).toBeNull();
    expect(screen.getByText("A dialog is waiting. Answer it first, then send.")).toBeInTheDocument();
    expect(recordedSends()).toEqual([]);
  });
});

describe("composer taps: held rows while the launch starts (fix 6)", () => {
  const NOW = 1_700_000_000_000;
  const typed: HeldRow = { requestId: "req00001", mode: "send", text: "left in the box", heldAt: NOW, expiresAt: NOW + 30 * 60_000, state: "ended", outcome: "typed_not_submitted" };
  const ended: HeldRow = { ...typed, requestId: "req00002", outcome: "expired" };

  it("no tap vanishes: Submit, Discard and Resend are off while starting, with the box off and saying Starting", () => {
    mount({ held: [typed], starting: true });
    expect(field()).not.toBeDisabled();
    expect(field()).toHaveAttribute("readonly");
    expect(field()).toHaveAttribute("aria-disabled", "true");
    expect(field()).toHaveAttribute("placeholder", "Starting…");
    expect(screen.getByRole("button", { name: "Submit the text in the box" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard the text in the box" })).toBeDisabled();
    cleanup();
    mount({ held: [ended], starting: true });
    expect(screen.getByRole("button", { name: "Resend the message" })).toBeDisabled();
  });

  it("no tap vanishes: once the launch is over the same buttons are live", () => {
    mount({ held: [typed] });
    expect(screen.getByRole("button", { name: "Submit the text in the box" })).toBeEnabled();
  });
});

describe("composer taps: Type, when arming refuses (fix 7)", () => {
  it("no tap vanishes: Type while a send runs says it turns on when the send ends", async () => {
    const user = userEvent.setup();
    const release = holdSends();
    mount();
    await startSend(user);
    const type = screen.getByRole("button", { name: "Type into terminal" });
    expect(type).toHaveAttribute("aria-disabled", "true");
    await expectTapAnswers(() => user.click(type));
    expect(status()).toBe("Type turns on when the send or the upload ends.");
    release();
    await waitFor(() => expect(document.querySelector("[data-slot='composer-primary'] .animate-spin")).toBeNull());
  });

  it("no tap vanishes: Type under the idle cover says Collie is catching up", async () => {
    const user = userEvent.setup();
    mount();
    act(() => setLocked(true));
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Type into terminal" })));
    expect(status()).toBe("Collie is catching up with the pane. Tap Type again in a moment.");
  });

  it("no tap vanishes: Type while the page catches up says the same", async () => {
    const user = userEvent.setup();
    mount();
    act(() => beginCatchUp());
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Type into terminal" })));
    expect(status()).toBe("Collie is catching up with the pane. Tap Type again in a moment.");
  });

  it("no tap vanishes: Use Type in the password notice, refused, keeps the draft and says why", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "5ad0", surface: SHELL })));
    mount({ isShell: true, agent: undefined, surface: SHELL, text: "$ sudo systemctl restart collie\n[sudo] password for altan:" });
    await user.type(screen.getByRole("textbox"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /use type/i });
    act(() => beginCatchUp());
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: /use type/i })));
    expect(status()).toBe("Collie is catching up with the pane. Tap Type again in a moment.");
    // The draft went only when Type armed: it is still there, and so is the notice.
    expect(screen.getByRole("textbox")).toHaveValue("hunter2hunter2");
    expect(screen.getByRole("button", { name: /use type/i })).toBeInTheDocument();
  });

  it("no tap vanishes: Use Type that arms takes the draft away", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "5ad0", surface: SHELL })));
    mount({ isShell: true, agent: undefined, surface: SHELL, text: "$ sudo systemctl restart collie\n[sudo] password for altan:" });
    await user.type(screen.getByRole("textbox"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: /use type/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Type into terminal" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});

describe("composer taps: a belt tap from another column that cannot act (fix 8)", () => {
  const address = paneScopeKey(undefined, "w1:p1");

  it("no tap vanishes: Agents with no subagent says the button has nothing to do", async () => {
    queueBeltIntent(address, { kind: "agents" });
    mount();
    await waitFor(() => expect(status()).toBe("This button has nothing to do on this pane now."));
  });

  it("no tap vanishes: Stop with no Stop on this belt says the same", async () => {
    queueBeltIntent(address, { kind: "stop" });
    mount();
    await waitFor(() => expect(status()).toBe("This button has nothing to do on this pane now."));
  });

  it("no tap vanishes: a run on a locked pane says the lock's own words", async () => {
    queueBeltIntent(address, { kind: "run", text: "/compact" });
    mount({ gone: true });
    await waitFor(() => expect(status()).toBe("Pane is gone"));
    expect(recordedSends()).toEqual([]);
  });

  it("no tap vanishes: an action the belt does not draw says the button has nothing to do", async () => {
    queueBeltIntent(address, { kind: "action", id: "nowhere" });
    mount();
    await waitFor(() => expect(status()).toBe("This button has nothing to do on this pane now."));
  });
});

describe("composer taps: paste of a file the box refuses (fix 9)", () => {
  const paste = (items: { kind: string; file?: File }[], text = "") =>
    fireEvent.paste(field(), {
      clipboardData: {
        items: items.map((item) => ({ kind: item.kind, getAsFile: () => item.file ?? null })),
        getData: () => text,
      },
    });
  const refused = () => new File(["MZ"], "setup.exe", { type: "application/x-msdownload" });

  it("no tap vanishes: a refused file and no text says the box cannot attach it", async () => {
    mount();
    await expectTapAnswers(() => {
      paste([{ kind: "file", file: refused() }]);
      return Promise.resolve();
    });
    expect(status()).toBe("Collie cannot attach this kind of file.");
  });

  it("no tap vanishes: a refused file with text on the clipboard stays a plain text paste, with no word", () => {
    mount();
    paste([{ kind: "file", file: refused() }], "a few words");
    expect(status()).toBeNull();
  });
});

describe("composer taps: the microphone that cannot record (fix 10)", () => {
  function config(stt: { provider: string; available: boolean; reason?: string }) {
    server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", stt })));
  }

  it("no tap vanishes: a provider that cannot serve says its reason on tap", async () => {
    const user = userEvent.setup();
    installFakeMediaRecorder();
    config({ provider: "codex", available: false, reason: "codex is not signed in" });
    mount();
    const mic = await screen.findByRole("button", { name: /codex is not signed in/i });
    await expectTapAnswers(() => user.click(mic));
    expect(status()).toBe("codex is not signed in");
  });

  it("no tap vanishes: a locked pane says the lock's words, and an offline one says Reconnect to send", async () => {
    const user = userEvent.setup();
    installFakeMediaRecorder();
    config({ provider: "openai-compatible", available: true });
    mount({ gone: true });
    await expectTapAnswers(async () => user.click(await screen.findByRole("button", { name: "Record a voice message" })));
    expect(status()).toBe("Pane is gone");
    cleanup();
    clearStatus();
    __resetOperatorCommands();
    mount({ stale: true });
    await expectTapAnswers(async () => user.click(await screen.findByRole("button", { name: "Record a voice message" })));
    expect(status()).toBe("Reconnect to send");
  });
});

describe("composer taps: the belt X while a send runs (fix 11)", () => {
  it("no tap vanishes: Clear message says to wait for the send", async () => {
    const user = userEvent.setup();
    const release = holdSends();
    mount();
    await startSend(user);
    // The box let go of the sent text at the tap (M104): the X a tap can meet is over words typed since.
    await user.type(field(), "a new line");
    const clear = screen.getByRole("button", { name: "Clear message" });
    expect(clear).toHaveAttribute("aria-disabled", "true");
    await expectTapAnswers(() => user.click(clear));
    expect(status()).toBe("You can clear the draft when the send ends.");
    release();
    await waitFor(() => expect(document.querySelector("[data-slot='composer-primary'] .animate-spin")).toBeNull());
  });
});

describe("composer taps: keys on a pane that cannot take them (fix 12)", () => {
  it("no tap vanishes: a key pressed for a gone pane says the lock's words and sends nothing", async () => {
    const m = mount({ gone: true });
    await expectTapAnswers(async () => {
      await act(() => m.handle.current?.padKeys(["Enter"]));
    });
    expect(status()).toBe("Pane is gone");
  });
});

describe("composer taps: a file the field locked on (fix 13)", () => {
  const png = () => new File([Uint8Array.from([1, 2, 3, 4])], "shot.png", { type: "image/png" });

  it("no tap vanishes: a file picked for a locked box says the file was not added", async () => {
    mount({ readOnly: true });
    await expectTapAnswers(async () => {
      fireEvent.change(screen.getByTestId("attach-photos"), { target: { files: [png()] } });
    });
    expect(status()).toBe("The box is locked now, so the file was not added.");
  });

  it("no tap vanishes: an editor open when the pane locks closes with the same words", async () => {
    const m = mount();
    fireEvent.change(screen.getByTestId("attach-photos"), { target: { files: [png()] } });
    await screen.findByRole("dialog", { name: "Edit image" });
    await expectTapAnswers(async () => m.update({ gone: true }));
    expect(status()).toBe("The box is locked now, so the file was not added.");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit image" })).toBeNull());
  });
});

describe("composer taps: the Keys pad opened with the link down (fix 15)", () => {
  it("no tap vanishes: the pad says there is no link, and Clear says so on tap", async () => {
    const user = userEvent.setup();
    mount({ stale: true });
    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByText("No link to the bridge. Keys cannot go out now.")).toBeInTheDocument();
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Clear the input box" })));
    expect(status()).toBe("No link to the bridge. Keys cannot go out now.");
  });

  it("no tap vanishes: Clear with an empty box says the box is empty, and under a dialog says to answer it", async () => {
    const user = userEvent.setup();
    const m = mount();
    await user.click(screen.getByRole("button", { name: "Keys" }));
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Clear the input box" })));
    expect(status()).toBe("The agent's box is empty. There is nothing to clear.");
    m.update({ surface: ASK });
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Clear the input box" })));
    expect(status()).toBe("A dialog is open. Answer it first, then clear.");
  });
});

describe("composer taps: Stop when the turn is not running (fix 16)", () => {
  it("no tap vanishes: the dimmed Stop says Collie sees no running turn", async () => {
    const user = userEvent.setup();
    render(<ScreenStop onStop={() => Promise.resolve()} paneId="w1:p1" running={false} />);
    const stop = screen.getByRole("button", { name: "Stop the turn" });
    expect(stop).toHaveAttribute("aria-disabled", "true");
    await expectTapAnswers(() => user.click(stop));
    expect(status()).toBe("Collie does not see a running turn, so Stop is off. If the agent is busy, press Esc on the Keys pad.");
  });
});

describe("composer taps: the notices in Type mode and under the password notice (fix 17)", () => {
  it("no tap vanishes: a refusal shows while Type mode is armed", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "turn_running", { offers: ["keys"], surface: RUNNING })));
    mount();
    await user.click(screen.getByRole("button", { name: "Type into terminal" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Type into terminal" })).toHaveAttribute("aria-pressed", "true"));
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Compact" })));
    await waitFor(() => expect(document.querySelector('[data-slot="composer-refusal"]')).not.toBeNull());
  });

  it("no tap vanishes: a Stop receipt shows under the password notice", async () => {
    const user = userEvent.setup();
    server.use(
      ...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "5ad0", surface: SHELL })),
      http.post(/\/api\/pane\/[^/]+\/abort$/, () => HttpResponse.json({ requestId: "stop-0001", outcome: "stopped" })),
    );
    mount({ isShell: true, agent: undefined, surface: { ...SHELL, turn: "running" }, text: "$ sudo systemctl restart collie\n[sudo] password for altan:", stopOffered: true });
    await user.type(screen.getByRole("textbox"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /use type/i });
    // The password notice stands, and a refused SEND stays under it.
    // Stop is a two-second hold for a pointer; a click no pointer made (detail 0, a key) keeps the two-tap arm.
    fireEvent.click(screen.getByRole("button", { name: "Stop the turn" }), { detail: 0 });
    await new Promise((resolve) => setTimeout(resolve, 450));
    await expectTapAnswers(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tap again to stop the turn" }), { detail: 0 });
    });
    expect(await screen.findByText("Stopped.")).toBeInTheDocument();
  });
});

describe("composer taps: Send past this screen reads the screen (fix 18)", () => {
  it("no tap vanishes: the status says Reading the screen while the read runs, and clears after", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post("/api/send", async ({ request }) => {
        // SAFETY: the phone's own JSON body is an object with a string `id`.
        const body = (await request.json()) as { id: string };
        await gate;
        return HttpResponse.json(sendAnswer(body.id, null, undefined, { rowsHash: "0abc" }));
      }),
    );
    const m = mount();
    await act(async () => {
      m.handle.current?.typeAnyway();
      await Promise.resolve();
    });
    expect(status()).toBe("Reading the screen.");
    release();
    await waitFor(() => expect(status()).toBeNull());
  });
});
