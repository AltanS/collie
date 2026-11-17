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

  /**
   * The race of the M102 review 2, G: the person's own send starts while the card's Discard is on its way, so the
   * composer refuses the card's send once the card is gone. `beforeRelease` runs while both requests still wait.
   */
  async function raceTheDrop(beforeRelease: (box: HTMLElement, user: ReturnType<typeof userEvent.setup>) => Promise<void>) {
    let releaseDiscard: () => void = () => undefined;
    const discardWaits = new Promise<void>((resolve) => {
      releaseDiscard = resolve;
    });
    const discards = mountWithLostCard(() => HttpResponse.json({ result: "dismissed" }));
    // The bridge's Discard answers only when the test says so, and the person's own send hangs until then too.
    let openSend: () => void = () => undefined;
    const sendWaits = new Promise<void>((resolve) => {
      openSend = resolve;
    });
    // The person's own send ends `sent`, or refused when the test lets it fail.
    let firstFails = false;
    const releaseSend = (fail = false) => {
      firstFails = fail;
      openSend();
    };
    const posted: string[] = [];
    let dropped = false;
    server.use(
      http.delete(/\/api\/send\/[^/]+$/, async ({ request }) => {
        discards.push(decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? ""));
        await discardWaits;
        dropped = true;
        return HttpResponse.json({ result: "dismissed" });
      }),
      // Once the bridge has dropped the card, its window no longer carries it.
      http.get(/\/api\/pane\/[^/]+\/chat/, () =>
        HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          page: "live",
          gen: FIXTURE_CHAT_GEN,
          rev: dropped ? 2 : 1,
          head: FIXTURE_SEQ_BASE + fixtureTranscript.length - 1,
          oldest: FIXTURE_SEQ_BASE,
          hasOlder: false,
          upserts: fixtureTranscript.map((e, i) => Object.assign({}, e, { seq: FIXTURE_SEQ_BASE + i })),
          queuedSends: dropped ? [] : [{ requestId: LOST_ID, state: "unconfirmed", text: LOST_TEXT }],
        }),
      ),
      http.post("/api/send", async ({ request }) => {
        const body = parseJsonObject(await request.text());
        posted.push(asJsonString(body?.text) ?? "");
        const first = posted.length === 1;
        if (first) await sendWaits;
        const id = asJsonString(body?.id) ?? "";
        return HttpResponse.json(first && firstFails ? sendAnswer(id, "refused", "busy", { offers: ["keys"] }) : sendAnswer(id, "sent"));
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
    await beforeRelease(box, user);
    releaseDiscard();
    // The composer cannot start the card's send now: it says why.
    expect(await screen.findByText(/Another send from this phone is still running\. Wait for it to end\./u)).toBeInTheDocument();
    return { box, user, posted, releaseSend };
  }

  it("a refusal after the drop with an empty box puts the card's text in the box, alone, and nothing sends it (the M102 review 2, G)", async () => {
    // The running send let go of the box at its tap (M104), so the box is empty when the card's text comes back.
    const { box, posted, releaseSend } = await raceTheDrop(async () => undefined);
    await waitFor(() => expect(box).toHaveValue(LOST_TEXT));
    expect(document.querySelector('[data-slot="composer-held-back"]')).toBeNull();
    // The running send lands: the card's text stays in the box, and nothing sends it.
    releaseSend();
    await waitFor(() => expect(posted).toEqual(["other words"]));
    expect(box).toHaveValue(LOST_TEXT);
  });

  it("a refusal after the drop with a draft in the box never merges the two: the text waits on Put back, as a calm send's does (the M102 review 3)", async () => {
    // The person types a new draft while their own send runs.
    const { box, user, posted, releaseSend } = await raceTheDrop((field, u) => u.type(field, "my new words"));
    const kept = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="composer-held-back"]');
      expect(found).toHaveTextContent(`Not sent, kept here: ${LOST_TEXT}`);
      return found!;
    });
    expect(kept).toBeInTheDocument();
    expect(box).toHaveValue("my new words");
    releaseSend();
    await waitFor(() => expect(posted).toEqual(["other words"]));
    // Put back over a draft says to empty the box first, and merges nothing.
    await user.click(screen.getByRole("button", { name: "Put back" }));
    expect(await screen.findByText("Empty the box first, then tap Put back.")).toBeInTheDocument();
    expect(box).toHaveValue("my new words");
    // Once the box is empty, Put back writes the card's text into it, and nothing is sent.
    await user.clear(box);
    await user.click(screen.getByRole("button", { name: "Put back" }));
    await waitFor(() => expect(box).toHaveValue(LOST_TEXT));
    expect(posted).toEqual(["other words"]);
  });

  it("a refusal after the drop with a draft in the box, and then the running send FAILS: both texts wait on Put back, none is lost (the M102 review 3)", async () => {
    const { box, user, posted, releaseSend } = await raceTheDrop((field, u) => u.type(field, "my new words"));
    await waitFor(() => expect(document.querySelector('[data-slot="composer-held-back"]')).toHaveTextContent(`Not sent, kept here: ${LOST_TEXT}`));
    releaseSend(true);
    // The failed send's text cannot go into the box, which holds the new draft: it joins the list, the newest.
    await waitFor(() => expect(document.querySelector('[data-slot="composer-held-back"]')).toHaveTextContent("Not sent, kept here: other words"));
    expect(screen.getByText("2 texts wait here. This is the newest.")).toBeInTheDocument();
    expect(box).toHaveValue("my new words");
    await user.clear(box);
    await user.click(screen.getByRole("button", { name: "Put back" }));
    await waitFor(() => expect(box).toHaveValue("other words"));
    expect(document.querySelector('[data-slot="composer-held-back"]')).toHaveTextContent(`Not sent, kept here: ${LOST_TEXT}`);
    expect(posted).toEqual(["other words"]);
  });
});

