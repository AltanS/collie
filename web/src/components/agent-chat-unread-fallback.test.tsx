import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

// The unread card a refusal opens (M102 spec 03) stays while the pane is unread: a spinner, a clock or any other
// row may move and the revision may climb. It goes when a later read is one Collie can read. The pane is pinned
// live as the other AgentChat suites pin it.
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
const FREE: Surface = { revision: 7, turn: "idle", modal: "none", composer: "empty" };
const CAPTION = "Collie cannot read this screen. You can.";

/** A screen Collie cannot read, under a spinner row whose timer and a clock row that tick. */
function screenAt(seconds: number, clock: string): string {
  return ["Pick a mode for the lab run", "  > fast", "    careful", `✳ Wibbling… (${seconds}s · ↓ ${seconds * 10} tokens)`, `lab clock ${clock}`].join("\n");
}

function mount() {
  let show: (text: string, revision: number, surface?: Surface) => void = () => undefined;
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: fixtureAgents[0]!.paneId, text: screenAt(4, "12:15:03"), truncated: false, revision: 7 })),
    ...sendHandler((request) => sendAnswer(request.id, "refused", "not_free", { offers: ["keys"], rowsHash: "ab12cd", surface: UNREAD })),
  );
  function Harness() {
    const [pane, setPane] = useState<{ text: string; revision: number; surface: Surface }>({ text: screenAt(4, "12:15:03"), revision: 7, surface: UNREAD });
    show = (text, revision, surface = UNREAD) => act(() => setPane({ text, revision, surface }));
    const agent: AgentView = { ...fixtureAgents[0]!, sendProtocol: true, surface: { ...pane.surface, revision: pane.revision } };
    return withHeaderHost(
      <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={pane.text} revision={pane.revision} onBack={vi.fn()} onSelect={vi.fn()} />,
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
  return { show: (text: string, revision: number, surface?: Surface) => show(text, revision, surface) };
}

async function sendRefused() {
  const user = userEvent.setup();
  await user.type(await screen.findByPlaceholderText(/type a reply/i), "go on");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(recordedSends()).toHaveLength(1));
  await screen.findByText(CAPTION);
}

describe("AgentChat: the unread card a refusal opens (the M102 review, H; pass 2)", () => {
  it("stays while the spinner's timer and a clock tick on the screen", async () => {
    const m = mount();
    await sendRefused();
    m.show(screenAt(5, "12:15:04"), 8);
    m.show(screenAt(6, "12:15:05"), 9);
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=\"unread-dialog-type-anyway\"]")).toHaveTextContent("Send anyway");
  });

  it("goes when the pane is no longer unread: a later read the bridge can read", async () => {
    const m = mount();
    await sendRefused();
    m.show(["The run is done.", "lab clock 12:15:09"].join("\n"), 8, FREE);
    await waitFor(() => expect(screen.queryByText(CAPTION)).toBeNull());
  });
});

/** A screen Collie cannot read whose rows move every tick in ways that are not digits. */
function movingScreen(tick: number): string {
  return [
    "Pick a mode for the lab run",
    "  > fast",
    "    careful",
    `[${"#".repeat(tick)}${" ".repeat(8 - tick)}]`,
    `Working${".".repeat((tick % 3) + 1)}`,
    "The agent writes: " + "lorem ipsum dolor sit amet consectetur".slice(0, tick * 4),
  ].join("\n");
}

describe("AgentChat: the unread state, not the rows (the M102 review 2, H and I)", () => {
  it("the card stays while a progress bar, a dot cycle and streaming text change every row, and with new revisions", async () => {
    const m = mount();
    await sendRefused();
    for (let tick = 1; tick <= 6; tick++) m.show(movingScreen(tick), 7 + tick);
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=\"unread-dialog-type-anyway\"]")).toHaveTextContent("Send anyway");
  });

  it("the Keys drawer the person closed stays closed while the rows move, until the unread state ends", async () => {
    const user = userEvent.setup();
    const m = mount();
    await sendRefused();
    const keys = screen.getByRole("button", { name: "Keys" });
    await waitFor(() => expect(keys).toHaveAttribute("aria-expanded", "true"));
    await user.click(keys);
    await waitFor(() => expect(keys).toHaveAttribute("aria-expanded", "false"));
    for (let tick = 1; tick <= 6; tick++) m.show(movingScreen(tick), 7 + tick);
    expect(keys).toHaveAttribute("aria-expanded", "false");
  });
});
