import type { ComponentProps } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { asJsonString, parseJsonObject } from "@/lib/json";

// The M108 desktop-shortcut cases of AgentChat, split out of agent-chat.test.tsx (its size ceiling,
// scripts/test-file-size.test.ts). The setup below is the minimum those cases lean on: the plain tab
// row and field composer the old cases were written for, a live pane, and the Chat gate's clock
// pushed past every horizon in the file.
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
const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

import type { ActionId } from "@/lib/shortcuts/actions";
import { __resetShortcutRegistry, isShortcutActionAvailable, runShortcutAction } from "@/lib/shortcuts/registry";
import { clearStatus } from "@/lib/status";
import { setZenEnabled, __resetZen } from "@/lib/zen";
import { __resetStripsCollapsed } from "@/lib/strips-collapsed";
import { __resetHarnessPrefs } from "@/lib/harness-prefs";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { fixtureAgents, fixtureTabs, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  __resetZen();
  __resetStripsCollapsed();
  __resetHarnessPrefs();
  __resetOperatorCommands();
});

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = fixtureAgents[0]!; // a blocked claude agent
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    // A REAL claude pane: the transcript row plus the input box under it, so the composer is on screen.
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<AgentChat {...props} />) }]);
  const { container } = render(<RouterProvider router={router} />);
  return { props, container };
}

// THE KEYBOARD (M108 spec 03): each desktop shortcut calls the act a control of this pane already makes, and
// is offered only where that control is drawn. The key tap is pinned in hooks/use-shortcuts.test.tsx.
describe("AgentChat — desktop shortcuts", () => {
  afterEach(() => __resetShortcutRegistry());

  function run(id: ActionId): boolean {
    let ran = false;
    act(() => {
      ran = runShortcutAction(id);
    });
    return ran;
  }

  it("zoom turns zen mode on and off, where the pane menu offers zen", async () => {
    setZenEnabled(true);
    const { container } = renderChat({ tabs: fixtureTabs });
    expect(run("zen_mode")).toBe(true);
    await waitFor(() => expect(container.querySelector('header [data-slot="header-row"]')).toBeNull());
    expect(run("zen_mode")).toBe(true);
    await waitFor(() => expect(container.querySelector('header [data-slot="header-row"]')).not.toBeNull());
  });

  it("zoom has no way in while the setting is off", () => {
    renderChat();
    expect(run("zen_mode")).toBe(false);
  });

  it("find opens the find bar over the output", async () => {
    renderChat();
    expect(run("find")).toBe(true);
    expect(await screen.findByRole("textbox", { name: /find in output/i })).toBeInTheDocument();
  });

  it("find has no way in on a pane with no output", () => {
    renderChat({ text: "" });
    expect(run("find")).toBe(false);
  });

  it("switch_pane opens the pane list, the sheet the pull handle opens", async () => {
    renderChat();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(run("switch_pane")).toBe(true);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("close_pane opens the pane menu with Close armed, and closes nothing by itself", async () => {
    renderChat();
    expect(run("close_pane")).toBe(true);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("button", { name: /tap again to close/i })).toBeInTheDocument();
  });

  it("rename_pane opens the pane menu on its rename view", async () => {
    renderChat();
    expect(run("rename_pane")).toBe(true);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("textbox")).toBeInTheDocument();
  });

  it("the palette's pane commands answer here, and the dashboard ones do not", () => {
    renderChat();
    for (const id of ["pane_settings", "pin_pane", "open_files"] as const) expect(isShortcutActionAvailable(id), id).toBe(true);
    expect(isShortcutActionAvailable("rename_space")).toBe(false);
  });

  it("focus_composer focuses the reply box", () => {
    renderChat();
    expect(run("focus_composer")).toBe(true);
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveFocus();
  });

  it("toggle_chat_terminal flips the device's choice between the terminal and Chat", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" }));
    renderChat();
    const chosen = () => asJsonString(parseJsonObject(localStorage.getItem("collie:dash-prefs:v1") ?? "{}")?.paneView);
    expect(run("toggle_chat_terminal")).toBe(true);
    await waitFor(() => expect(chosen()).toBe("chat"));
  });
});
