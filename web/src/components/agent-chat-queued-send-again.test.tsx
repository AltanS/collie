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
import { asJsonString, parseJsonObject } from "@/lib/json";
import type { Surface } from "@/lib/surface/surface";
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
function mountWithLostCard(discard: () => Response, over: Partial<AgentView> = {}) {
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
  const agent: AgentView = { ...fixtureAgents[0]!, hasSession: true, ...over };
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

  it("a composer that cannot send now keeps the card: nothing is dropped or sent, and the words say why (the M102 review, G)", async () => {
    const secret: Surface = { revision: 4, turn: "idle", modal: "none", composer: "empty", field: "secret" };
    const discards = mountWithLostCard(() => HttpResponse.json({ result: "dismissed" }), { sendProtocol: true, surface: secret });
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText("The screen asks for a sign-in code. Only the code field can send now, so nothing was sent.")).toBeInTheDocument();
    expect(discards).toEqual([]);
    expect(recordedSends()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Send again" })).toBeEnabled();
  });

  it("a send that starts while the card is being dropped keeps the card's text: nothing is lost, the words say why (the M102 review 2, G)", async () => {
    let releaseDiscard: () => void = () => undefined;
    const discardWaits = new Promise<void>((resolve) => {
      releaseDiscard = resolve;
    });
    const discards = mountWithLostCard(() => HttpResponse.json({ result: "dismissed" }));
    // The bridge's Discard answers only when the test says so, and the person's own send hangs until then too.
    let releaseSend: () => void = () => undefined;
    const sendWaits = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const posted: string[] = [];
    server.use(
      http.delete(/\/api\/send\/[^/]+$/, async ({ request }) => {
        discards.push(decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? ""));
        await discardWaits;
        return HttpResponse.json({ result: "dismissed" });
      }),
      http.post("/api/send", async ({ request }) => {
        const body = parseJsonObject(await request.text());
        posted.push(asJsonString(body?.text) ?? "");
        await sendWaits;
        return HttpResponse.json(sendAnswer(asJsonString(body?.id) ?? "", "sent"));
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Send again" }));
    await waitFor(() => expect(discards).toEqual([LOST_ID]));
    // While the Discard is on its way, the person sends something else from the box.
    const box = screen.getByRole("textbox");
    await user.type(box, "other words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posted).toEqual(["other words"]));
    releaseDiscard();
    // The composer cannot start the card's send now: it says why, and the card's text waits in the box. The running
    // send let go of the box at its tap (M104), so the card's text lands in an empty box, alone, merged with nothing.
    expect(await screen.findByText("Another send from this phone is still running. Wait for it to end.")).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveValue(LOST_TEXT));
    expect(posted).toEqual(["other words"]);
    // The running send lands: the card's text stays in the box.
    releaseSend();
    await waitFor(() => expect(box).toHaveValue(LOST_TEXT));
    expect(posted).toEqual(["other words"]);
  });
});
