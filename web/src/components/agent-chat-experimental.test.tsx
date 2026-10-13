import type { ComponentProps } from "react";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorCommands } from "@/lib/operator-config";
import { noteSessionCards } from "@/lib/session-cards";
import type { SessionSummary } from "@/lib/types";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// THE PANE HEADER'S EXPERIMENTAL BADGE (M55 spec 02): a pane of a program session wears the badge beside
// its name, the one its row wears in the Spaces list. A terminal session's header does not.

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => __resetOperatorCommands());

function session(over: Partial<SessionSummary> & { name: string }): SessionSummary {
  return { isPrimary: false, reachable: true, agents: 0, working: 0, blocked: 0, ...over };
}

const SESSIONS: SessionSummary[] = [
  session({ name: "default", isPrimary: true, kind: "terminal", mux: "reference", caps: { paneGrid: true }, experimental: false }),
  session({ name: "desk", kind: "program", mux: "pi-durable", caps: { paneGrid: false }, where: "local", state: "ready", experimental: true }),
];

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = fixtureAgents[0]!;
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<AgentChat {...props} />) }]);
  return render(<RouterProvider router={router} />).container;
}

const badge = (container: HTMLElement) =>
  container.querySelector('[data-slot="pane-lines"] [data-slot="experimental-badge"]');

describe("pane header: the Experimental badge of a program session", () => {
  it("a pane of a program session wears the badge beside its name", () => {
    noteSessionCards(SESSIONS, undefined);
    const container = renderChat({ scope: { session: "desk" } });
    expect(badge(container)?.textContent).toBe("Experimental");
  });

  it("a pane of the terminal session wears none", () => {
    noteSessionCards(SESSIONS, undefined);
    const container = renderChat();
    expect(badge(container)).toBeNull();
  });

  it("a pane on a bridge that sends no session card wears none", () => {
    const container = renderChat({ scope: { session: "desk" } });
    expect(badge(container)).toBeNull();
  });
});
