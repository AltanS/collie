import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

// The M102 safety review, H: the unread card a refusal opens (M102 spec 03) stays while a spinner, a timer or a
// clock ticks on the screen, and goes when the screen really moves on. Its identity is the screen's content with
// the ticking rows held still, never the pane revision. The pane is pinned live as the other AgentChat suites pin it.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

import { clearStatus } from "@/lib/status";
import { forgetHostVersions } from "@/hooks/use-host-version";
import { resetPinsForTests } from "@/lib/loaders";
import type { Surface } from "@/lib/surface/surface";
import type { AgentView } from "@/lib/types";
import { fixtureAgents, recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/msw";
import { AgentChat } from "./agent-chat";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  forgetHostVersions();
  resetPinsForTests();
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "raw", showToolCalls: true }));
});

const UNREAD: Surface = { revision: 7, turn: "idle", modal: "unreadable", composer: "unknown" };
const CAPTION = "Collie cannot read this screen. You can.";

/** A screen Collie cannot read, under a spinner row whose timer and a clock row that tick. */
function screenAt(seconds: number, clock: string): string {
  return ["Pick a mode for the lab run", "  > fast", "    careful", `✳ Wibbling… (${seconds}s · ↓ ${seconds * 10} tokens)`, `lab clock ${clock}`].join("\n");
}

function mount() {
  let show: (text: string, revision: number) => void = () => undefined;
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: fixtureAgents[0]!.paneId, text: screenAt(4, "12:15:03"), truncated: false, revision: 7 })),
    ...sendHandler((request) => sendAnswer(request.id, "refused", "not_free", { offers: ["keys"], rowsHash: "ab12cd", surface: UNREAD })),
  );
  function Harness() {
    const [pane, setPane] = useState({ text: screenAt(4, "12:15:03"), revision: 7 });
    show = (text, revision) => act(() => setPane({ text, revision }));
    const agent: AgentView = { ...fixtureAgents[0]!, sendProtocol: true, surface: { ...UNREAD, revision: pane.revision } };
    return withHeaderHost(
      <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={pane.text} revision={pane.revision} onBack={vi.fn()} onSelect={vi.fn()} />,
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
  return { show: (text: string, revision: number) => show(text, revision) };
}

async function sendRefused() {
  const user = userEvent.setup();
  await user.type(await screen.findByPlaceholderText(/type a reply/i), "go on");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(recordedSends()).toHaveLength(1));
  await screen.findByText(CAPTION);
}

describe("AgentChat: the unread card a refusal opens (the M102 review, H)", () => {
  it("stays while the spinner's timer and a clock tick on the screen", async () => {
    const m = mount();
    await sendRefused();
    m.show(screenAt(5, "12:15:04"), 8);
    m.show(screenAt(6, "12:15:05"), 9);
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Type it anyway" })).toBeInTheDocument();
  });

  it("goes when the screen really moves on", async () => {
    const m = mount();
    await sendRefused();
    m.show(["The run is done.", "lab clock 12:15:09"].join("\n"), 8);
    await waitFor(() => expect(screen.queryByText(CAPTION)).toBeNull());
  });
});
