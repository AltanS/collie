import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

// Edit on the chat's two queue cards (ADR 0122, the 2026-11-22 addendum), through the pane view. The waiting card's
// Edit is ONE bridge request (`POST /api/pane/:id/dequeue`) with a request id minted on the phone; its `taken` texts
// go into the composer, first, before any draft; every other end is one status line or none; a lost answer keeps
// the id, so the next tap replays and never presses twice. The "Back in the box" card's Edit is that card's
// Discard, and only after the bridge emptied the box does the card's text go into the composer.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

import { clearStatus } from "@/lib/status";
import { forgetHostVersions } from "@/hooks/use-host-version";
import { resetPinsForTests } from "@/lib/loaders";
import { fixtureAgents, FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureTranscript, paneTextWithDraft, recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/msw";
import { asJsonString, parseJsonObject, type JsonObject } from "@/lib/json";
import type { AgentView } from "@/lib/types";
import { AgentChat } from "./agent-chat";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  forgetHostVersions();
  resetPinsForTests();
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "chat", showToolCalls: true }));
});

const EDIT = "Take the waiting messages back into the box to edit them";
const EDIT_BACK = "Take this message back into the box to edit it";

interface Window {
  queued?: string[];
  dequeueQueued?: string[];
  queuedSends?: JsonObject[];
}

/** Mount Chat on a pane whose window carries `window`; `answer` is the bridge's reply to each take-back request. */
function mount(window: Window, answer: (body: JsonObject) => Response, over: Partial<AgentView> = {}) {
  const asked: JsonObject[] = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+\/chat/, () =>
      HttpResponse.json({
        paneId: "w1:p1",
        available: true,
        page: "live",
        gen: FIXTURE_CHAT_GEN,
        rev: 1,
        head: FIXTURE_SEQ_BASE + fixtureTranscript.length - 1,
        oldest: FIXTURE_SEQ_BASE,
        hasOlder: false,
        upserts: fixtureTranscript.map((e, i) => Object.assign({}, e, { seq: FIXTURE_SEQ_BASE + i })),
        ...window,
      }),
    ),
    http.post(/\/api\/pane\/[^/]+\/dequeue$/, async ({ request }) => {
      const body = parseJsonObject(await request.text()) ?? {};
      asked.push(body);
      return answer(body);
    }),
    ...sendHandler((request) => sendAnswer(request.id, request.mode === "discard" ? "discarded" : "sent")),
  );
  const agent: AgentView = { ...fixtureAgents[0]!, hasSession: true, ...over };
  const element = withHeaderHost(
    <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={paneTextWithDraft("recent pane output")} onBack={vi.fn()} onSelect={vi.fn()} />,
  );
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
  return asked;
}

const WAITING: Window = { queued: ["first", "second"], dequeueQueued: ["Up"] };
const receipt = (body: JsonObject, rest: JsonObject) => HttpResponse.json({ requestId: asJsonString(body.requestId) ?? "", ...rest });

describe("AgentChat: Edit on the waiting card", () => {
  it("taken into an empty composer: the texts in queue order, one newline between, the caret in the box", async () => {
    const asked = mount(WAITING, (body) => receipt(body, { outcome: "taken", texts: ["first", "second"] }));
    await userEvent.click(await screen.findByRole("button", { name: EDIT }));
    const box = screen.getByRole("textbox");
    await waitFor(() => expect(box).toHaveValue("first\nsecond"));
    expect(box).toHaveFocus();
    expect(asked).toHaveLength(1);
    // The request id alone: the phone sends no text and no key.
    expect(Object.keys(asked[0]!)).toEqual(["requestId"]);
    expect(recordedSends()).toHaveLength(0);
  });

  it("taken over a draft: the taken text first, then a newline, then the draft, and nothing is dropped", async () => {
    mount(WAITING, (body) => receipt(body, { outcome: "taken", texts: ["first", "second"] }));
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox");
    await user.type(box, "my draft");
    await user.click(await screen.findByRole("button", { name: EDIT }));
    await waitFor(() => expect(box).toHaveValue("first\nsecond\nmy draft"));
    expect(recordedSends()).toHaveLength(0);
  });

  it("too_late says it already went out, and the composer is untouched", async () => {
    mount(WAITING, (body) => receipt(body, { outcome: "too_late" }));
    await userEvent.click(await screen.findByRole("button", { name: EDIT }));
    expect(await screen.findByText("It already went out.")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("in_box says nothing and types nothing: the agent's box holds the text", async () => {
    const asked = mount(WAITING, (body) => receipt(body, { outcome: "in_box" }));
    await userEvent.click(await screen.findByRole("button", { name: EDIT }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByText("It already went out.")).toBeNull();
  });

  it("unknown says to read the chat, and the next tap replays the same request id", async () => {
    const asked = mount(WAITING, (body) => receipt(body, { outcome: "unknown" }));
    const button = await screen.findByRole("button", { name: EDIT });
    await userEvent.click(button);
    expect(await screen.findByText("The text may have reached the agent. Read the chat.")).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]!.requestId).toBe(asked[0]!.requestId);
  });

  it("a lost answer keeps the id too, and a stated answer lets it go", async () => {
    let lost = true;
    const asked = mount(WAITING, (body) => (lost ? HttpResponse.error() : receipt(body, { outcome: "too_late" })));
    const button = await screen.findByRole("button", { name: EDIT });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    lost = false;
    await userEvent.click(button);
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]!.requestId).toBe(asked[0]!.requestId);
    expect(await screen.findByText("It already went out.")).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[2]!.requestId).not.toBe(asked[0]!.requestId);
  });

  it("a refusal says the existing sentence: a draft in the agent's box", async () => {
    mount(WAITING, (body) => receipt(body, { outcome: "refused", reason: "draft_present" }));
    await userEvent.click(await screen.findByRole("button", { name: EDIT }));
    expect(await screen.findByText("The box held a draft.")).toBeInTheDocument();
  });

  it("an older bridge (404) reads as a build with no take-back and presses nothing", async () => {
    mount(WAITING, () => new HttpResponse("not found", { status: 404 }));
    await userEvent.click(await screen.findByRole("button", { name: EDIT }));
    expect(await screen.findByText("The input box could not be reached.")).toBeInTheDocument();
  });

  it("is withheld when the bridge declares no dequeue key", async () => {
    mount({ queued: ["first"] }, () => HttpResponse.json({}));
    expect(await screen.findByText("Waiting to send")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: EDIT })).toBeNull();
  });
});

describe("AgentChat: Edit on the Back in the box card", () => {
  const BACK: JsonObject = { requestId: "req-back-00001", state: "returned", text: "second message" };

  it("discards the agent's box with the card's id, then takes the card's text into the composer, before the draft", async () => {
    mount({ queuedSends: [BACK] }, () => HttpResponse.json({}));
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox");
    await user.type(box, "my draft");
    await user.click(await screen.findByRole("button", { name: EDIT_BACK }));
    await waitFor(() => expect(box).toHaveValue("second message\nmy draft"));
    expect(recordedSends()).toHaveLength(1);
    expect(recordedSends()[0]).toMatchObject({ mode: "discard", resendOf: "req-back-00001", text: "" });
  });

  it("a Discard the bridge refused takes nothing into the composer", async () => {
    mount({ queuedSends: [BACK] }, () => HttpResponse.json({}));
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "draft_changed")));
    await userEvent.click(await screen.findByRole("button", { name: EDIT_BACK }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: EDIT_BACK })).toBeEnabled());
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});
