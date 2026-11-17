import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

// The queued card's `unconfirmed` state gains Send again beside Discard (M102 spec 04). Its tap first drops the
// card through the Discard request, and only when the bridge answers that it dropped THAT card does the phone send the
// card's text again, as a new send from the composer. A card that is no longer waiting sends nothing, so a stale card
// never sends twice. The pane is pinned live as the other AgentChat suites pin it (lib/liveness.ts).
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

const LOST_ID = "req-lost-00001";
const LOST_TEXT = "where did it go";

/** Mount Chat on a pane whose window carries one unconfirmed queued card; `discard` is the bridge's answer to its Discard. */
function mountWithLostCard(discard: () => Response) {
  const discards: string[] = [];
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
        queuedSends: [{ requestId: LOST_ID, state: "unconfirmed", text: LOST_TEXT }],
      }),
    ),
    http.delete(/\/api\/send\/[^/]+$/, ({ request }) => {
      discards.push(decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? ""));
      return discard();
    }),
    ...sendHandler((request) => sendAnswer(request.id, "sent")),
  );
  const agent: AgentView = { ...fixtureAgents[0]!, hasSession: true };
  const element = withHeaderHost(
    <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={paneTextWithDraft("recent pane output")} onBack={vi.fn()} onSelect={vi.fn()} />,
  );
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
  return discards;
}

describe("AgentChat: the queued card's Send again (M102 spec 04)", () => {
  it("cannot tell: Send again drops the card first, and only then sends its text as a new send", async () => {
    const discards = mountWithLostCard(() => HttpResponse.json({ result: "dismissed" }));
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(discards).toEqual([LOST_ID]);
    expect(recordedSends()[0]).toMatchObject({ text: LOST_TEXT, mode: "send" });
    // A new request: it is not the card's own id, and it names no old send.
    expect(recordedSends()[0]!.id).not.toBe(LOST_ID);
    expect(recordedSends()[0]!.resendOf).toBeUndefined();
  });

  it("cannot tell: a card the bridge says is no longer waiting sends nothing, and the card says so", async () => {
    const discards = mountWithLostCard(() => HttpResponse.json({ result: "refused", reason: "busy" }, { status: 409 }));
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText("This message is not waiting any more, so nothing was sent again.")).toBeInTheDocument();
    expect(discards).toEqual([LOST_ID]);
    expect(recordedSends()).toHaveLength(0);
  });

  it("cannot tell: a card the bridge does not know (404) sends nothing either", async () => {
    mountWithLostCard(() => new HttpResponse("no such held send on this pane", { status: 404 }));
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText("This message is not waiting any more, so nothing was sent again.")).toBeInTheDocument();
    expect(recordedSends()).toHaveLength(0);
  });

  it("cannot tell: a Discard that fails for another reason sends nothing and says why on the status line", async () => {
    mountWithLostCard(() => new HttpResponse("bridge down", { status: 500 }));
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send again" })).toBeEnabled());
    expect(recordedSends()).toHaveLength(0);
    expect(screen.queryByText("This message is not waiting any more, so nothing was sent again.")).toBeNull();
  });
});
