import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { loadDraft } from "@/lib/drafts";
import { asJsonObject, type JsonObject } from "@/lib/json";
import { useStatus } from "@/lib/status";
import type { Ask } from "@/lib/types";
import { DurableComposer, type DurableComposerProps } from "./durable-composer";

// The composer of a pane with no screen against stubbed send and abort routes (ADR 0101): what each
// request names, and what each answer does to the draft.

type Sent = JsonObject;

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
  it.each(["idle", "blocked", "done"] as const)("is hidden while the pane is %s", (status) => {
    draw({ status });
    expect(screen.queryByRole("button", { name: /Steer the running turn/ })).toBeNull();
  });

  it("is shown while the pane is working", () => {
    draw({ status: "working" });
    expect(screen.getByRole("button", { name: /Steer the running turn/ })).toBeInTheDocument();
  });

  it("marks the send as a steer, and switches off after it", async () => {
    const seen = stub("send", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    draw({ status: "working" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Steer the running turn/ }));
    expect(screen.getByRole("button", { name: /Steer the running turn/ })).toHaveAttribute("aria-pressed", "true");
    await user.type(field(), "left please");
    await user.click(sendButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ steer: true, text: "left please", turnId: "turn-7" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Steer the running turn/ })).toHaveAttribute("aria-pressed", "false"));
  });
});

describe("stop", () => {
  it("is shown while a turn runs or waits, and not when the pane is idle", () => {
    draw({ status: "idle" });
    expect(screen.queryByRole("button", { name: "Stop the running turn" })).toBeNull();
  });

  it("posts the abort route with the turn id and a request id", async () => {
    const seen = stub("abort", () => HttpResponse.json({ ok: true, outcome: "ok" }));
    const { onReload } = draw({ status: "working" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop the running turn" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ turnId: "turn-7" });
    expect(String(seen[0]!.requestId)).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent("Stop sent"));
    expect(onReload).toHaveBeenCalled();
  });

  it("a stale abort reloads the pane and says nothing was stopped", async () => {
    stub("abort", () => HttpResponse.json({ ok: false, outcome: "stale", turnId: "turn-8", askIds: [] }, { status: 409 }));
    const { onReload } = draw({ status: "working" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop the running turn" }));
    await waitFor(() => expect(screen.getByTestId("said")).toHaveTextContent(/nothing was stopped/));
    expect(onReload).toHaveBeenCalled();
  });
});

describe("stop, maybe applied", () => {
  it("reads the pane and says the stop may already be applied", async () => {
    stub("abort", () => HttpResponse.json({ ok: false, outcome: "maybe-applied" }));
    const { onReload } = draw({ status: "working" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop the running turn" }));
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
