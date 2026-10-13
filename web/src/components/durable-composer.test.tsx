import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { loadDraft } from "@/lib/drafts";
import { asJsonObject, type JsonObject } from "@/lib/json";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { useStatus } from "@/lib/status";
import type { Ask, MuxCapability } from "@/lib/types";
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

beforeEach(() => {
  __resetOperatorCommands();
  declares({ steerTurn: true, abortTurn: true });
});

const steerButton = () => screen.findByRole("button", { name: /Steer the running turn/ });
const stopButton = () => screen.findByRole("button", { name: "Stop the running turn" });

function stub(route: "send" | "abort", reply: (n: number) => Response): Sent[] {
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

describe("the terminal's controls are not here", () => {
  it("no keys, no typing mode, no quick keys", () => {
    draw({ status: "working" });
    for (const name of ["Keys", "Type into terminal", "Quick"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Display settings" })).toBeInTheDocument();
  });
});
