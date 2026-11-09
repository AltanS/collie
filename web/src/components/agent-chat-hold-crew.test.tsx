import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { t } from "@/lib/i18n";
import type { JsonValue } from "@/lib/json";
import { useStatus } from "@/lib/status";
import { holdHash, type HoldNote } from "@/lib/surface/hold";
import type { AgentView } from "@/lib/types";
import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";
import { HOLD_TAP_GUARD_MS } from "./hook-hold-card";

// The hook hold card on a crew member's pane (M56 spec 12). A held permission has no dialog on the
// screen, so the key route has nothing to press: the card answers the member's ask through the ask
// route, which the lead carries to the member (`POST /api/ask/<id>?host=<member>`). Before this the
// card was drawn on a member's pane with its buttons off (minibuch, 2026-11-09).

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const HOST = "minibuch";
const BASE = fixtureAgents[0]!;
const NOTE: HoldNote = {
  askId: "ask-0d0d0d0d0d0d0d",
  state: "held",
  tool: "Bash",
  input: "git status",
  agent: false,
  options: ["Yes", "No"],
  hash: holdHash("Bash", "git status", ["Yes", "No"]),
  adopted: false,
  since: 1,
};

interface Posted {
  readonly path: string;
  readonly host: string | null;
  readonly body: JsonValue;
}

function StatusLine() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

/** Mount Chat on a member's Claude pane that carries a hook hold; `answer` is the lead's reply to the tap. */
function mountMemberHold(answer: () => Response) {
  const posted: Posted[] = [];
  server.use(
    http.post(/\/api\/ask\/[^/]+$/, async ({ request }) => {
      const url = new URL(request.url);
      // SAFETY: the phone's own JSON.stringify body is JSON, a JsonValue.
      posted.push({ path: decodeURIComponent(url.pathname), host: url.searchParams.get("host"), body: (await request.json()) as JsonValue });
      return answer();
    }),
  );
  const agent: AgentView = { ...BASE, host: HOST, sendProtocol: true, hold: NOTE };
  const router = createMemoryRouter([
    {
      path: "/",
      element: withHeaderHost(
        <>
          <StatusLine />
          <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text="" onBack={vi.fn()} onSelect={vi.fn()} scope={{ host: HOST }} />
        </>,
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return posted;
}

async function tapYes() {
  const yes = await screen.findByRole("button", { name: /Yes/ });
  expect(yes).toBeEnabled();
  // The card ignores a tap in its first moments (HOLD_TAP_GUARD_MS); this one comes after them.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOLD_TAP_GUARD_MS);
  await userEvent.click(yes);
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentChat: the hook hold card on a crew member's pane", () => {
  it("is enabled, and a tap posts one Answer to the member's ask through the forwarded route", async () => {
    const posted = mountMemberHold(() => HttpResponse.json({ receipt: { askId: NOTE.askId, outcome: "sent", keys: [], channel: "hook", decision: "allow" } }));
    await tapYes();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      path: `/api/ask/${NOTE.askId}`,
      host: HOST,
      body: { pane: BASE.paneId, hash: NOTE.hash, optionId: "1", origin: "person_tap", via: "hold-card" },
    });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Sent"));
  });

  it("a member that predates the route answers 404, and the status line says so instead of hanging", async () => {
    const posted = mountMemberHold(() => HttpResponse.json({ error: "not found" }, { status: 404 }));
    await tapYes();
    await waitFor(() => expect(posted).toHaveLength(1));
    // The member's own refusal, as the phone shows any refused write: no card change, no wait.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("not found"));
  });

  it("an unknown outcome on the link reads as the ask route's own unknown", async () => {
    mountMemberHold(() => HttpResponse.json({ receipt: { askId: NOTE.askId, outcome: "unknown", reason: "no_evidence" } }));
    await tapYes();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(t("chat.status.askUnknown")));
  });
});
