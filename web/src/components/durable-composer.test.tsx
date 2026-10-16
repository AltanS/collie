import { createRef, useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStream } from "@/components/session-stream";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { EMPTY_CHAT_WINDOW } from "@/lib/chat-window";
import { __resetPending } from "@/lib/durable-pending";
import { paneScopeKey } from "@/lib/scope";
import type { ChatEntry } from "@/lib/types";
import { server } from "@/test/setup";
import { loadDraft } from "@/lib/drafts";
import { asJsonObject, type JsonObject } from "@/lib/json";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { useStatus } from "@/lib/status";
import type { Ask, MuxCapability, PaneAction } from "@/lib/types";
import { DurableComposer, type DurableComposerProps } from "./durable-composer";

// The composer of a pane with no screen against stubbed send and abort routes (ADR 0101): what each
// request names, and what each answer does to the draft.

type Sent = JsonObject;

/** Serve the program's declared caps on `/api/config`, the way the bridge publishes them. */
function declares(caps: Partial<Record<MuxCapability, boolean>>): void {
  server.use(
    http.get("/api/config", () =>
      HttpResponse.json({
        push: false,
        vapidPublicKey: "",
        mux: { name: "durable", capabilities: caps, unsupportedKeys: [], notes: {} },
      }),
    ),
  );
}

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the thread's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  __resetPending();
  __resetOperatorCommands();
  declares({ steerTurn: true, abortTurn: true });
});

const steerButton = () => screen.findByRole("button", { name: /Steer the running turn/ });
const stopButton = () => screen.findByRole("button", { name: "Stop the running turn" });

function stub(route: "send" | "abort" | "action", reply: (n: number) => Response): Sent[] {
  const seen: Sent[] = [];
  server.use(
    http.post<never, JsonObject>(new RegExp(`/api/pane/[^/]+/${route}$`), async ({ request }) => {
      seen.push(asJsonObject(await request.json()) ?? {});
      return reply(seen.length);
    }),
  );
  return seen;
}

/** The status line, as text, so a test can read what the person was told. */
function Said() {
  return <p data-testid="said">{useStatus()?.text ?? ""}</p>;
}

function draw(over: Partial<DurableComposerProps> = {}) {
  const onSent = vi.fn();
  const onReload = vi.fn();
  const props: DurableComposerProps = {
    paneId: "c1",
    turnId: "turn-7",
    status: "idle",
    locked: false,
    lockedWhy: "",
    offline: false,
    display: { open: false, onToggle: vi.fn() },
    onSent,
    onReload,
    ...over,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <DurableComposer {...props} />
          <Said />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return { onSent, onReload };
}

const field = () => screen.getByPlaceholderText("Message this conversation");
const sendButton = () => screen.getByRole("button", { name: "Send" });

async function type(text: string) {
  const user = userEvent.setup();
  await user.type(field(), text);
  return user;
}

describe("send", () => {
  it("posts the text with the turn the phone saw and a request id, then clears the draft", async () => {
    const seen = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { onSent, onReload } = draw();
    const user = await type("go left");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ text: "go left", turnId: "turn-7" });
    expect(seen[0]).not.toHaveProperty("steer");
    expect(seen[0]).not.toHaveProperty("askId");
    expect(String(seen[0]!.requestId)).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(loadDraft(undefined, "c1")).toBeNull();
    expect(onSent).toHaveBeenCalled();
    expect(onReload).toHaveBeenCalled();
    expect(screen.getByTestId("said")).toHaveTextContent("Sent");
  });

  it("names the oldest open ask when the pane has shown no turn", async () => {
    const seen = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    const ask: Ask = { id: "ask-3", kind: "permission", toolCallId: "c", revision: 1, title: "t", itemId: "i", options: [] };
    draw({ turnId: undefined, asks: [ask] });
    const user = await type("yes do it");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ askId: "ask-3" });
    expect(seen[0]).not.toHaveProperty("turnId");
  });

  it("a stale name keeps the draft, reads the pane again and says the turn moved", async () => {
    const seen = stub("send", () =>
      HttpResponse.json({ ok: false, outcome: "stale", turnId: "turn-8", askIds: [] }, { status: 409 }),
    );
    const { onSent, onReload } = draw();
    const user = await type("steer left");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/The conversation moved on/));
    expect(field()).toHaveValue("steer left");
    expect(loadDraft(undefined, "c1")).toBe("steer left");
    expect(onReload).toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("a refusal keeps the draft and shows the bridge's words", async () => {
    stub("send", () =>
      HttpResponse.json({ ok: false, outcome: "refused", reason: "refused", detail: "Name a turn." }, { status: 409 }),
    );
    draw();
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("Name a turn."));
    expect(field()).toHaveValue("hello");
  });

  it("an unknown outcome keeps the draft, and sending again carries the SAME request id", async () => {
    const seen = stub("send", (n) =>
      n === 1
        ? HttpResponse.json({ ok: false, outcome: "unknown" }, { status: 504 })
        : HttpResponse.json({ ok: true, outcome: "ok" }),
    );
    draw();
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/Not sure the message arrived/));
    expect(field()).toHaveValue("hello");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.requestId).toBe(seen[0]!.requestId);
    await waitFor(() => expect(field()).toHaveValue(""));
  });

  it("editing the text after an unknown outcome is a new intent, with a new request id", async () => {
    const seen = stub("send", (n) =>
      n === 1 ? HttpResponse.json({ ok: false, outcome: "unknown" }, { status: 504 }) : HttpResponse.json({ ok: true, outcome: "ok" }),
    );
    draw();
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    await user.type(field(), " again");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.requestId).not.toBe(seen[0]!.requestId);
  });

  it("maybe-applied keeps the draft, reads the pane and says to check the chat before sending again", async () => {
    const seen = stub("send", () => HttpResponse.json({ ok: false, outcome: "maybe-applied" }));
    const { onSent, onReload } = draw();
    const user = await type("steer left");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("said")).toHaveTextContent("May already be sent. Check the chat before you send again."),
    );
    expect(field()).toHaveValue("steer left");
    expect(loadDraft(undefined, "c1")).toBe("steer left");
    expect(onReload).toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    // The id is dropped: a send after the person has checked is a new intent.
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.requestId).not.toBe(seen[0]!.requestId);
  });

  it("a machine too old for the route says to update it and keeps the draft", async () => {
    server.use(http.post(/\/api\/pane\/[^/]+\/send$/, () => HttpResponse.json({ error: "not found" }, { status: 404 })));
    const { onReload } = draw();
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/older Collie/));
    expect(field()).toHaveValue("hello");
    expect(onReload).not.toHaveBeenCalled();
  });

  it("sends nothing from a locked or saved pane", async () => {
    const seen = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    draw({ offline: true });
    await userEvent.setup().type(field(), "hello");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
    expect(seen).toHaveLength(0);
  });
});

describe("steer", () => {
  it.each(["idle", "blocked", "done"] as const)("stays in the belt but is dimmed and off while the pane is %s", async (status) => {
    draw({ status });
    const button = await steerButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("is live while the pane is working", async () => {
    draw({ status: "working" });
    expect(await steerButton()).toBeEnabled();
  });

  it("marks the send as a steer, and switches off after it", async () => {
    const seen = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    draw({ status: "working" });
    const user = userEvent.setup();
    await user.click(await steerButton());
    expect(await steerButton()).toHaveAttribute("aria-pressed", "true");
    await user.type(field(), "left please");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ steer: true, text: "left please", turnId: "turn-7" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Steer the running turn/ })).toHaveAttribute("aria-pressed", "false"));
  });

  it("reads as off when the turn ends under a pressed switch, and the send is not a steer", async () => {
    const seen = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    const user = userEvent.setup();
    function Ending() {
      const [status, setStatus] = useState<DurableComposerProps["status"]>("working");
      return (
        <>
          <DurableComposer
            paneId="c1"
            turnId="turn-7"
            status={status}
            locked={false}
            lockedWhy=""
            offline={false}
            display={{ open: false, onToggle: vi.fn() }}
            onSent={vi.fn()}
            onReload={vi.fn()}
          />
          <button type="button" onClick={() => setStatus("idle")}>
            end the turn
          </button>
        </>
      );
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Ending /> }])} />);
    await user.click(await steerButton());
    expect(await steerButton()).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "end the turn" }));
    expect(await steerButton()).toHaveAttribute("aria-pressed", "false");
    await user.type(field(), "next");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).not.toHaveProperty("steer");
  });
});

describe("the program's section of the belt", () => {
  const group = () => screen.findByRole("group", { name: "Harness shortcuts" });

  it("holds Steer, then Stop, in that order", async () => {
    draw({ status: "working" });
    const section = await group();
    const names = within(section)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Steer the running turn instead of starting a new one", "Stop the running turn"]);
  });

  it("draws only the controls the program declared a cap for", async () => {
    declares({ steerTurn: false, abortTurn: true });
    draw({ status: "working" });
    expect(await stopButton()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Steer the running turn/ })).toBeNull();
  });

  it("draws no section for a program that declares neither, and for a bridge that said nothing", async () => {
    declares({});
    draw({ status: "working" });
    // The Display button is on the belt, so the config has been read once the section would have come.
    await screen.findByRole("button", { name: "Display settings" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Harness shortcuts" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Stop the running turn" })).toBeNull();
  });

  it("keeps the field where it is: the belt above it is the same in every state", async () => {
    // jsdom lays nothing out, so the fixed offset is pinned structurally: everything that stands
    // before the field is the same elements in idle and working, with Steer and Stop in both.
    const stand = async (status: DurableComposerProps["status"]) => {
      const { unmount } = render(
        <RouterProvider
          router={createMemoryRouter([
            {
              path: "/",
              element: (
                <DurableComposer
                  paneId="c1"
                  turnId="turn-7"
                  status={status}
                  locked={false}
                  lockedWhy=""
                  offline={false}
                  display={{ open: false, onToggle: vi.fn() }}
                  onSent={vi.fn()}
                  onReload={vi.fn()}
                />
              ),
            },
          ])}
        />,
      );
      await stopButton();
      const root = document.querySelector<HTMLElement>('[data-slot="durable-composer"]')!;
      const box = root.querySelector('[data-slot="composer-box"]')!;
      const before = [...root.children].slice(0, [...root.children].indexOf(box)).map((c) => c.getAttribute("data-slot"));
      const buttons = within(root).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
      unmount();
      return { before, buttons };
    };
    const idle = await stand("idle");
    const working = await stand("working");
    // Only the belt stands before the field: no row of its own comes and goes between them.
    expect(idle.before).toEqual(["composer-actions"]);
    expect(working.before).toEqual(idle.before);
    expect(working.buttons).toEqual(idle.buttons);
    expect(idle.buttons).toContain("Stop the running turn");
  });
});

describe("stop", () => {
  it("stays in the belt but is dimmed when the pane is idle", async () => {
    draw({ status: "idle" });
    expect(await stopButton()).toBeDisabled();
  });

  it("posts the abort route with the turn id and a request id", async () => {
    const seen = stub("abort", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { onReload } = draw({ status: "working" });
    await userEvent.setup().click(await stopButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ turnId: "turn-7" });
    expect(String(seen[0]!.requestId)).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("Stop sent"));
    expect(onReload).toHaveBeenCalled();
  });

  it("a stale abort reloads the pane and says nothing was stopped", async () => {
    stub("abort", () => HttpResponse.json({ ok: false, outcome: "stale", turnId: "turn-8", askIds: [] }, { status: 409 }));
    const { onReload } = draw({ status: "working" });
    await userEvent.setup().click(await stopButton());
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/nothing was stopped/));
    expect(onReload).toHaveBeenCalled();
  });

  it("is dimmed on a saved pane", async () => {
    draw({ status: "working", offline: true });
    expect(await stopButton()).toBeDisabled();
  });
});

describe("stop, maybe applied", () => {
  it("reads the pane and says the stop may already be applied", async () => {
    stub("abort", () => HttpResponse.json({ ok: false, outcome: "maybe-applied" }));
    const { onReload } = draw({ status: "working" });
    await userEvent.setup().click(await stopButton());
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("The stop may already be applied. Check the chat."));
    expect(onReload).toHaveBeenCalled();
  });
});

describe("the program's own actions", () => {
  const escalate: PaneAction = { id: "escalate", label: "Escalate", icon: "flag" };
  const pause: PaneAction = { id: "pause", label: "Pause", icon: "pause", disabled: true };
  const button = (name: string) => screen.findByRole("button", { name });

  beforeEach(() => declares({ steerTurn: true, abortTurn: true, programActions: true }));

  it("draws the pane's actions after Steer and Stop when the program declared programActions", async () => {
    draw({ actions: [escalate, pause] });
    expect(await button("Escalate")).toBeEnabled();
    expect(await button("Pause")).toBeDisabled();
    const names = within(screen.getByRole("group", { name: "Harness shortcuts" })).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Steer", "Stop", "Escalate", "Pause"]);
  });

  it("draws none when the program did not declare the capability, whatever the snapshot carried", async () => {
    declares({ steerTurn: true, abortTurn: true });
    draw({ actions: [escalate] });
    await stopButton();
    expect(screen.queryByRole("button", { name: "Escalate" })).toBeNull();
  });

  it("posts the action once with the turn the phone saw and a request id, says it is done, and reads the pane again", async () => {
    const seen = stub("action", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { onReload } = draw({ actions: [escalate] });
    await userEvent.setup().click(await button("Escalate"));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ actionId: "escalate", turnId: "turn-7" });
    expect(String(seen[0]!.requestId)).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("Done"));
    expect(onReload).toHaveBeenCalled();
  });

  it("a second tap while the first is in flight waits for it, so the program is asked once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: Sent[] = [];
    server.use(
      http.post<never, JsonObject>(/\/api\/pane\/[^/]+\/action$/, async ({ request }) => {
        seen.push(asJsonObject(await request.json()) ?? {});
        await gate;
        return HttpResponse.json({ ok: true, outcome: "ok" });
      }),
    );
    draw({ actions: [escalate] });
    const user = userEvent.setup();
    const tap = await button("Escalate");
    await user.click(tap);
    await waitFor(() => expect(tap).toBeDisabled());
    await user.click(tap);
    release();
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("Done"));
    expect(seen).toHaveLength(1);
  });

  it("a refusal says the bridge's own words, keeps nothing, and the next tap is a new intent", async () => {
    const seen = stub("action", () =>
      HttpResponse.json({ ok: false, outcome: "refused", reason: "refused", detail: "The durable agent did not run this action: Already escalated." }, { status: 409 }),
    );
    const { onReload } = draw({ actions: [escalate] });
    const user = userEvent.setup();
    await user.click(await button("Escalate"));
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("Already escalated."));
    expect(onReload).not.toHaveBeenCalled();
    await user.click(await button("Escalate"));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.requestId).not.toBe(seen[0]!.requestId);
  });

  it("a refusal with no words says the catalog's sentence", async () => {
    stub("action", () => HttpResponse.json({ ok: false, outcome: "refused", reason: "refused", detail: "" }, { status: 409 }));
    draw({ actions: [escalate] });
    await userEvent.setup().click(await button("Escalate"));
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("The action was refused."));
  });

  it("a stale turn reads the pane again and says the conversation moved on", async () => {
    stub("action", () => HttpResponse.json({ ok: false, outcome: "stale", turnId: "turn-8", askIds: [] }, { status: 409 }));
    const { onReload } = draw({ actions: [escalate] });
    await userEvent.setup().click(await button("Escalate"));
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/did not run/));
    expect(onReload).toHaveBeenCalled();
  });

  it("an unknown outcome keeps the request id, so tapping again carries the same one", async () => {
    const seen = stub("action", (n) => (n === 1 ? HttpResponse.json({ ok: false, outcome: "unknown", detail: "reset" }, { status: 504 }) : HttpResponse.json({ ok: true, outcome: "ok", replayed: true })));
    draw({ actions: [escalate] });
    const user = userEvent.setup();
    await user.click(await button("Escalate"));
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/Not sure the action arrived/));
    await user.click(await button("Escalate"));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.requestId).toBe(seen[0]!.requestId);
  });

  it("is dimmed when the composer is locked or the pane is a saved copy", async () => {
    draw({ actions: [escalate], offline: true });
    expect(await button("Escalate")).toBeEnabled(); // the belt greys with `locked`; the tap itself refuses offline
    const seen = stub("action", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    await userEvent.setup().click(await button("Escalate"));
    expect(seen).toHaveLength(0);
  });
});

describe("the terminal's controls are not here", () => {
  it("no keys, no typing mode, no quick keys", () => {
    draw({ status: "working" });
    for (const name of ["Keys", "Type into terminal", "Quick"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Display settings" })).toBeInTheDocument();
  });
});

// ── the thread and the composer together: pending echo, working row, partial rendering (M53 spec 10) ──────────

const BASE = 1_000_000;
let when = 0;

/** One turn of the thread as the bridge's chat window holds it. `at` is its place. */
function turn(uuid: string, role: ChatEntry["role"], text: string, over: Partial<ChatEntry> = {}): ChatEntry {
  when += 1;
  return { uuid, seq: BASE + when, ts: new Date().toISOString(), role, parts: [{ kind: "text", text }], ...over };
}

interface Live {
  setEntries: (entries: ChatEntry[]) => void;
  setWorking: (working: boolean) => void;
}

/** The composer and the thread of ONE durable pane, the way the pane view mounts them, with the thread under the test's hand. */
function drawBoth(initial: ChatEntry[] = [], over: Partial<DurableComposerProps> = {}): { live: Live } & ReturnType<typeof draw> {
  // SAFETY: both setters are assigned by `Both` on its first render, before any test reads them.
  const live = {} as Live;
  const onSent = vi.fn();
  const onReload = vi.fn();
  function Both() {
    const [entries, setEntries] = useState(initial);
    const [working, setWorking] = useState(false);
    live.setEntries = setEntries;
    live.setWorking = setWorking;
    const feed: ChatFeed = {
      window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, entries },
      loadOlder: vi.fn(),
      loadingOlder: false,
      asked: 0,
      answered: 0,
      tried: false,
    };
    return (
      <>
        <SessionStream
          feed={feed}
          address={paneScopeKey(undefined, "c1")}
          working={working}
          showToolCalls
          showCompactions={false}
          fontSize={14}
          listRef={createRef<ChatMessageListHandle>()}
          durable
        />
        <DurableComposer
          paneId="c1"
          turnId="turn-7"
          status={working ? "working" : "idle"}
          locked={false}
          lockedWhy=""
          offline={false}
          display={{ open: false, onToggle: vi.fn() }}
          onSent={onSent}
          onReload={onReload}
          {...over}
        />
        <Said />
      </>
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Both /> }])} />);
  return { live, onSent, onReload };
}

const pendingRows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="pending-turn"]')];
const working = () => screen.queryByRole("status", { name: "Working" });

/** A POST that waits for the test to let it go. */
interface Held {
  release: () => void;
  seen: Sent[];
}
function held(reply: () => Response): Held {
  const seen: Sent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  server.use(
    http.post<never, JsonObject>(/\/api\/pane\/[^/]+\/send$/, async ({ request }) => {
      seen.push(asJsonObject(await request.json()) ?? {});
      await gate;
      return reply();
    }),
  );
  return { release, seen };
}

describe("pending echo", () => {
  it("pending: the sent line is in the thread at once, the field waits with Sending…, and the program's line replaces it", async () => {
    const post = held(() => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { live, onSent } = drawBoth();
    const user = await type("go left");
    await user.click(sendButton());

    // At once: before the POST has answered, the line stands in the thread with a clock, and the field is held.
    await waitFor(() => expect(post.seen).toHaveLength(1));
    expect(pendingRows()).toHaveLength(1);
    expect(pendingRows()[0]).toHaveTextContent("go left");
    expect(pendingRows()[0]).toHaveAttribute("data-pending", "sending");
    expect(pendingRows()[0]).toHaveClass("opacity-70");
    const waiting = screen.getByPlaceholderText("Sending…");
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveValue("");
    expect(working()).toBeNull(); // not yet: the program has not taken it

    post.release();
    // The field is back, and the program has the line: the thread says it is working, before any read says so.
    await waitFor(() => expect(field()).toBeEnabled());
    expect(field()).toHaveValue("");
    expect(onSent).toHaveBeenCalled();
    expect(pendingRows()[0]).toHaveAttribute("data-pending", "sent");
    expect(working()).toBeInTheDocument();

    // The program's own line, with the request id of the send, takes its place: one line, not two.
    act(() => live.setEntries([turn("u1", "user", "go left", { requestId: String(post.seen[0]!.requestId) })]));
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
    expect(screen.getAllByText("go left")).toHaveLength(1);
  });

  it("pending: a program that does not echo the request id is matched by the same text", async () => {
    const post = held(() => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { live } = drawBoth();
    const user = await type("same words");
    await user.click(sendButton());
    post.release();
    await waitFor(() => expect(pendingRows()[0]).toHaveAttribute("data-pending", "sent"));
    act(() => live.setEntries([turn("u1", "user", "same words")]));
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
    expect(screen.getAllByText("same words")).toHaveLength(1);
  });

  it("pending: another send's request id never matches by text", async () => {
    const post = held(() => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { live } = drawBoth();
    const user = await type("again");
    await user.click(sendButton());
    post.release();
    await waitFor(() => expect(pendingRows()[0]).toHaveAttribute("data-pending", "sent"));
    act(() => live.setEntries([turn("u0", "user", "again", { requestId: "somebody-else" })]));
    expect(pendingRows()).toHaveLength(1);
    expect(screen.getAllByText("again")).toHaveLength(2);
  });

  it("pending: a stale answer leaves the line as Not sent and the words back in the field, and the next try replaces the line", async () => {
    const seen = stub("send", (n) =>
      n === 1 ? HttpResponse.json({ ok: false, outcome: "stale", turnId: "turn-8", askIds: [] }, { status: 409 }) : HttpResponse.json({ ok: true, outcome: "ok" }),
    );
    drawBoth();
    const user = await type("steer left");
    await user.click(sendButton());
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/The conversation moved on/));
    expect(field()).toHaveValue("steer left");
    expect(pendingRows()).toHaveLength(1);
    expect(pendingRows()[0]).toHaveAttribute("data-pending", "notSent");
    expect(pendingRows()[0]).toHaveTextContent("Not sent");
    expect(working()).toBeNull();

    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(2));
    await waitFor(() => expect(pendingRows()[0]).toHaveAttribute("data-pending", "sent"));
    expect(pendingRows()).toHaveLength(1); // the line that never left is gone, this try stands in its place
  });

  it("pending: an unknown outcome says sending, not confirmed, and the retry keeps one line under the same request id", async () => {
    const seen = stub("send", (n) =>
      n === 1 ? HttpResponse.json({ ok: false, outcome: "unknown" }, { status: 504 }) : HttpResponse.json({ ok: true, outcome: "ok" }),
    );
    drawBoth();
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(pendingRows()[0]).toHaveAttribute("data-pending", "unconfirmed"));
    expect(pendingRows()[0]).toHaveTextContent("Sending, not confirmed");
    expect(field()).toHaveValue("hello");
    expect(working()).toBeNull();

    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.requestId).toBe(seen[0]!.requestId);
    await waitFor(() => expect(pendingRows()[0]).toHaveAttribute("data-pending", "sent"));
    expect(pendingRows()).toHaveLength(1);
  });

  it("pending: a refusal keeps the draft and marks the line Not sent", async () => {
    stub("send", () => HttpResponse.json({ ok: false, outcome: "refused", reason: "refused", detail: "Name a turn." }, { status: 409 }));
    drawBoth();
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(pendingRows()[0]).toHaveAttribute("data-pending", "notSent"));
    expect(field()).toHaveValue("hello");
    expect(loadDraft(undefined, "c1")).toBe("hello");
  });
});

describe("working row", () => {
  it("working: three dots end the thread while the newest thing is the person's line and the pane works, and go when a reply grows", async () => {
    const { live } = drawBoth([turn("u1", "user", "go")]);
    act(() => live.setWorking(true));
    expect(working()).toBeInTheDocument();
    expect(screen.queryByText("Still working…")).toBeNull(); // the dots replace the static line on a durable pane
    expect(document.querySelectorAll('[data-slot="stream-working"] .working-dots > span')).toHaveLength(3);

    act(() => live.setEntries([turn("u1", "user", "go"), turn("r1", "assistant", "Sure, let me", { partial: true })]));
    expect(working()).toBeNull(); // the growing reply says it is working by itself
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("working: a pane that works with a tool step newest keeps the static line, and an idle pane shows no row", async () => {
    const tool: ChatEntry = turn("t1", "assistant", "", { parts: [{ kind: "tool", name: "write_note", summary: "x", id: "t1" }] });
    const { live } = drawBoth([turn("u1", "user", "go"), tool]);
    expect(working()).toBeNull();
    act(() => live.setWorking(true));
    expect(working()).toBeNull();
    expect(screen.getByText("Still working…")).toBeInTheDocument();
  });

  it("working: the dots keep the static row's box, so the swap moves nothing", () => {
    const { live } = drawBoth([turn("u1", "user", "go")]);
    act(() => live.setWorking(true));
    const row = document.querySelector('[data-slot="stream-working"]')!;
    expect(row.className).toContain("mt-1 flex items-center gap-2 py-2");
    expect(row.querySelector(".working-dots")!.className).toContain("h-4");
  });
});

describe("partial replies", () => {
  const reply = (text: string, over: Partial<ChatEntry> = {}) => turn("r1", "assistant", text, over);
  const cursors = () => document.querySelectorAll('[data-partial="true"]');

  it("partial: a reply being written has a cursor, grows in place under one id, and the final version drops the cursor", () => {
    const { live } = drawBoth([turn("u1", "user", "go"), reply("Hel", { partial: true })]);
    act(() => live.setWorking(true));
    expect(cursors()).toHaveLength(1);
    expect(cursors()[0]).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Hel")).toBeInTheDocument();

    act(() => live.setEntries([turn("u1", "user", "go"), reply("Hello, wor", { partial: true })]));
    expect(screen.queryByText("Hel")).toBeNull();
    expect(screen.getAllByText("Hello, wor")).toHaveLength(1); // the same row, longer: never a second one
    expect(cursors()).toHaveLength(1);

    act(() => live.setEntries([turn("u1", "user", "go"), reply("Hello, world")]));
    expect(screen.getAllByText("Hello, world")).toHaveLength(1);
    expect(cursors()).toHaveLength(0);
    expect(document.querySelectorAll("[data-block]")).toHaveLength(2); // the user line and the reply: replaced, not added
  });

  it("partial: a reply the pane stopped writing loses its cursor even if the final version never came", () => {
    const { live } = drawBoth([turn("u1", "user", "go"), reply("Half of", { partial: true })]);
    act(() => live.setWorking(true));
    expect(cursors()).toHaveLength(1);
    act(() => live.setWorking(false));
    expect(cursors()).toHaveLength(0);
    expect(screen.getByText("Half of")).toBeInTheDocument();
  });

  it("partial: a finished reply is drawn exactly as before, with no wrapper marks", () => {
    drawBoth([reply("All of it")]);
    expect(screen.getByText("All of it").closest("[data-partial]")).toBeNull();
    expect(document.querySelector("[aria-busy]")).toBeNull();
  });
});

describe("the Send Protocol on this machine (M56 spec 14)", () => {
  /** Serve `POST /api/send` with `reply`, and record each body. */
  function stubProtocol(reply: (n: number) => Response): Sent[] {
    const seen: Sent[] = [];
    server.use(
      http.post<never, JsonObject>("/api/send", async ({ request }) => {
        seen.push(asJsonObject(await request.json()) ?? {});
        return reply(seen.length);
      }),
    );
    return seen;
  }

  it("a program on this machine sends a plain text through POST /api/send with the revision it showed", async () => {
    const protocol = stubProtocol(() => HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [], acknowledged: "x" } }));
    const old = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { onSent } = draw({ sendProtocol: true, revision: 4242 });
    const user = await type("go left");
    await user.click(sendButton());
    await waitFor(() => expect(protocol).toHaveLength(1));
    expect(protocol[0]).toMatchObject({ pane: "c1", text: "go left", mode: "send", revision: 4242 });
    expect(String(protocol[0]!.id)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(old).toHaveLength(0);
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(onSent).toHaveBeenCalled();
    expect(screen.getByTestId("said")).toHaveTextContent("Sent");
  });

  it("a send the program takes for after its turn says Queued", async () => {
    stubProtocol(() => HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [], queued: true } }));
    draw({ sendProtocol: true, status: "working" });
    const user = await type("and then this");
    await user.click(sendButton());
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("Queued. The agent takes it after this turn."));
    expect(field()).toHaveValue("");
  });

  it("a refusal keeps the draft and tells it at the thumb in program words, never screen words", async () => {
    stubProtocol(() =>
      HttpResponse.json({
        offers: [],
        receipt: { outcome: "refused", reason: "stale_surface", keys: [] },
        detail: "The durable agent started another turn after you looked. Read the chat, then send again.",
        surface: { revision: 9, turn: "running", modal: "none", composer: "empty" },
      }),
    );
    const { onReload, onSent } = draw({ sendProtocol: true });
    const user = await type("hello");
    await user.click(sendButton());
    const notice = await screen.findByText((_, node) => node?.getAttribute("data-slot") === "composer-refusal");
    expect(notice).toHaveTextContent("The durable agent started another turn after you looked. Read the chat, then send again.");
    expect(document.querySelector('[data-slot="composer-refusal-detail"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/screen|input box/iu);
    expect(field()).toHaveValue("hello");
    expect(loadDraft(undefined, "c1")).toBe("hello");
    expect(onReload).toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("an open question refuses the send: the notice says so and Go to the question calls the card", async () => {
    stubProtocol(() =>
      HttpResponse.json({
        offers: [],
        receipt: { outcome: "refused", reason: "not_free", keys: [] },
        detail: "The durable agent waits for an answer to a question. Answer it first, then send.",
        surface: { revision: 9, turn: "running", modal: { ask: { id: "ask-0123456789abcd", kind: "permission", options: [{ id: "1", label: "Save" }], channel: "program", hash: "abc" } }, composer: "empty" },
      }),
    );
    const onAnswerDialog = vi.fn();
    draw({ sendProtocol: true, onAnswerDialog });
    const user = await type("hello");
    await user.click(sendButton());
    expect(await screen.findByText("The durable agent waits for an answer to a question. Answer it first, then send.")).toHaveAttribute("data-slot", "composer-refusal");
    await user.click(screen.getByRole("button", { name: "Go to the question" }));
    expect(onAnswerDialog).toHaveBeenCalledOnce();
  });

  it("a state Collie cannot read and an unknown end each have their own program sentence", async () => {
    stubProtocol((n) =>
      n === 1
        ? HttpResponse.json({ offers: [], receipt: { outcome: "refused", reason: "not_free", keys: [] }, surface: { revision: 0, turn: "unknown", modal: "unknown", composer: "unreachable", reason: "stale" } })
        : HttpResponse.json({ offers: [], receipt: { outcome: "unknown", reason: "no_evidence", keys: [] } }),
    );
    draw({ sendProtocol: true });
    const user = await type("hello");
    await user.click(sendButton());
    expect(await screen.findByText("Collie cannot read this conversation now. Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to the question" })).toBeNull();
    await user.click(sendButton());
    expect(await screen.findByText("The durable agent did not say it took the message. Read the chat before you send it again.")).toBeInTheDocument();
  });

  it("the program's own refusal shows its words under the program sentence", async () => {
    stubProtocol(() => HttpResponse.json({ offers: [], receipt: { outcome: "refused", reason: "write_failed", keys: [] }, detail: "The desk is closed for the night." }));
    draw({ sendProtocol: true });
    const user = await type("hello");
    await user.click(sendButton());
    expect(await screen.findByText("The durable agent did not take the message.")).toBeInTheDocument();
    expect(screen.getByText("The desk is closed for the night.")).toHaveAttribute("data-slot", "composer-refusal-detail");
  });

  it("while no answer came the retry keys on the text only: a turn that moved keeps the same request id", async () => {
    const protocol = stubProtocol((n) => (n === 1 ? HttpResponse.error() : HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [] } })));
    function Moving() {
      const [shownTurn, setShownTurn] = useState("turn-7");
      return (
        <>
          <DurableComposer paneId="c1" turnId={shownTurn} status="idle" sendProtocol locked={false} lockedWhy="" offline={false} display={{ open: false, onToggle: vi.fn() }} onSent={vi.fn()} onReload={vi.fn()} />
          <button type="button" onClick={() => setShownTurn("turn-8")}>
            move the turn
          </button>
        </>
      );
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Moving /> }])} />);
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(field()).toHaveValue("hello"));
    await user.click(screen.getByRole("button", { name: "move the turn" }));
    await user.click(sendButton());
    await waitFor(() => expect(protocol).toHaveLength(2));
    expect(protocol[1]!.id).toBe(protocol[0]!.id);
  });

  it("no answer keeps the draft, and sending again carries the SAME request id", async () => {
    const protocol = stubProtocol((n) => (n === 1 ? HttpResponse.error() : HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [] } })));
    draw({ sendProtocol: true });
    const user = await type("hello");
    await user.click(sendButton());
    await waitFor(() => expect(field()).toHaveValue("hello"));
    expect(await screen.findByText(/Tap Send again: it does not send twice/)).toHaveAttribute("data-slot", "composer-refusal");
    await user.click(sendButton());
    await waitFor(() => expect(protocol).toHaveLength(2));
    expect(protocol[1]!.id).toBe(protocol[0]!.id);
    await waitFor(() => expect(field()).toHaveValue(""));
  });

  it("a program on a crew member keeps the program's own send route", async () => {
    const protocol = stubProtocol(() => HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [] } }));
    const old = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    draw({ sendProtocol: true, scope: { host: "member" } });
    const user = await type("over the crew");
    await user.click(sendButton());
    await waitFor(() => expect(old).toHaveLength(1));
    expect(old[0]).toMatchObject({ text: "over the crew", turnId: "turn-7" });
    expect(protocol).toHaveLength(0);
  });

  it("a steer stays on the program's own route: it is not part of the Send Protocol", async () => {
    const protocol = stubProtocol(() => HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [] } }));
    const old = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    draw({ sendProtocol: true, status: "working" });
    const user = userEvent.setup();
    await user.click(await steerButton());
    await user.type(field(), "left please");
    await user.click(sendButton());
    await waitFor(() => expect(old).toHaveLength(1));
    expect(old[0]).toMatchObject({ steer: true, text: "left please" });
    expect(protocol).toHaveLength(0);
  });

  it("a bridge that does not mark the pane keeps the program's own send route", async () => {
    const protocol = stubProtocol(() => HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [] } }));
    const old = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    draw();
    const user = await type("old bridge");
    await user.click(sendButton());
    await waitFor(() => expect(old).toHaveLength(1));
    expect(protocol).toHaveLength(0);
  });
});
