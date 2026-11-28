import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

import { __forgetTabPaneMemory } from "@/lib/tab-pane-memory";
import type { AgentView, TabView } from "@/lib/types";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { AgentChat } from "./agent-chat";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
afterEach(() => {
  __forgetTabPaneMemory();
});

const tab1: TabView = { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 1 };
const tab2: TabView = { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "workers", focused: false, paneCount: 1 };

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = { ...fixtureAgents[0]!, paneId: "w1:p1", tabId: "w1:t1" };
  const onSelect = vi.fn();
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: [agent],
    shellPanes: [],
    tabs: [tab1, tab2],
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect,
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "*", element: withHeaderHost(<AgentChat {...props} />) }]);
  render(<RouterProvider router={router} />);
  return { agent, onSelect };
}

describe("AgentChat: goToTab with unpaned child terminals", () => {
  it("opens the visible shell parent instead of a background unpaned agent child", async () => {
    const user = userEvent.setup();
    const shellParent: AgentView = {
      ...fixtureAgents[0]!,
      paneId: "w1:p2",
      tabId: "w1:t2",
      agent: "shell",
      kind: "shell",
      status: "unknown",
      sessionName: undefined,
      terminalTitle: "build-shell",
      soleTabName: undefined,
    };
    const childAgent: AgentView = {
      ...fixtureAgents[0]!,
      paneId: "w1:p3",
      tabId: "w1:t2",
      parentPaneId: "w1:p2",
      unpaned: true,
      sessionName: "bg-worker",
      terminalTitle: "bg-worker-term",
    };
    const { agent, onSelect } = renderChat({
      agents: [{ ...fixtureAgents[0]!, paneId: "w1:p1", tabId: "w1:t1" }, childAgent],
      shellPanes: [shellParent],
    });
    expect(agent.tabId).toBe("w1:t1");
    expect(screen.queryByRole("button", { name: /bg-worker/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /workers/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
  });

  it("falls back to an unpaned pane when no visible pane exists in the target tab", async () => {
    const user = userEvent.setup();
    const onlyChild: AgentView = {
      ...fixtureAgents[0]!,
      paneId: "w1:p3",
      tabId: "w1:t2",
      parentPaneId: "w1:p99",
      unpaned: true,
      sessionName: "orphan-child",
      terminalTitle: "orphan-child-term",
    };
    const { onSelect } = renderChat({
      agents: [{ ...fixtureAgents[0]!, paneId: "w1:p1", tabId: "w1:t1" }, onlyChild],
      shellPanes: [],
    });
    expect(screen.queryByRole("button", { name: /orphan-child/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /workers/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p3");
  });
});

describe("AgentChat: closeCurrentTab with unpaned child terminals", () => {
  it("lands on the neighbour tab's visible shell parent instead of its background unpaned child", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })),
    );
    const shellParent: AgentView = {
      ...fixtureAgents[0]!,
      paneId: "w1:p2",
      tabId: "w1:t2",
      agent: "shell",
      kind: "shell",
      status: "unknown",
      sessionName: undefined,
      terminalTitle: "build-shell",
      soleTabName: undefined,
    };
    const childAgent: AgentView = {
      ...fixtureAgents[0]!,
      paneId: "w1:p3",
      tabId: "w1:t2",
      parentPaneId: "w1:p2",
      unpaned: true,
      sessionName: "bg-worker",
      terminalTitle: "bg-worker-term",
    };
    renderChat({
      agents: [{ ...fixtureAgents[0]!, paneId: "w1:p1", tabId: "w1:t1" }, childAgent],
      shellPanes: [shellParent],
      onSelect,
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: /main$/ }));
    await user.click(screen.getByRole("button", { name: "Close tab" }));
    await user.click(screen.getByRole("button", { name: "Tap again to close 1 pane" }));

    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2"));
  });
});
