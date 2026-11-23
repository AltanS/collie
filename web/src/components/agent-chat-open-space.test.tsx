import type { ComponentProps } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `open_space` in the pane view, where the space has a page (the phone and the tablet): the key runs the door
// the space's name makes, one code path (agent-chat.tsx `openSpace`). On a large screen the layout answers, not
// the pane (wide-layout-open-space.test.tsx). Set up as agent-chat-shortcuts.test.tsx does.
vi.mock("@/lib/theme/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/theme/store")>();
  return {
    ...original,
    useActiveTheme: () => {
      const active = original.useActiveTheme();
      return { ...active, theme: { ...active.theme, surface: { ...active.theme.surface, tabs: "plain", composer: "field" } } };
    },
  };
});
vi.mock("@/lib/chat-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-gate")>()),
  LAST_RESORT_NO_JOURNAL_MS: 2_000_000_000,
}));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

import { __resetShortcutRegistry, isShortcutActionAvailable, runShortcutAction } from "@/lib/shortcuts/registry";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
afterEach(() => {
  __resetShortcutRegistry();
  vi.unstubAllGlobals();
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

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
  const router = createMemoryRouter([{ path: "*", element: withHeaderHost(<><AgentChat {...props} /><Where /></>) }]);
  const view = render(<RouterProvider router={router} />);
  return { agent, router, view };
}

describe("AgentChat, open_space", () => {
  it("opens the space's page where there is one, as the door does", async () => {
    const { agent, router } = renderChat();
    expect(isShortcutActionAvailable("open_space")).toBe(true);
    act(() => {
      expect(runShortcutAction("open_space")).toBe(true);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/space/${encodeURIComponent(agent.workspaceId)}`));
  });

  it("stands down on a large screen, where the layout answers", () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
        ({
          matches: /min-width:\s*(\d+)px/.test(query) && 1440 >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1]),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    renderChat();
    expect(isShortcutActionAvailable("open_space")).toBe(false);
  });
});
