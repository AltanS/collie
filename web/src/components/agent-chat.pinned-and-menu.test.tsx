import { type ComponentProps } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

// AgentChat, the new cases of the pinned Actions button and the pane's three dots. They
// sit beside agent-chat.test.tsx, which is over the size cap and may not grow (scripts/test-file-size.test.ts).
// The helpers are that file's few lines, copied: a test file exports nothing.

// The default theme names `folder` and `box`; these cases were written for the plain words (see agent-chat.test.tsx).
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
// The pane is pinned live: the liveness gating has its own suites.
const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

import { __resetActionsPalette, isActionsPaletteOpen, openActionsPalette } from "@/lib/actions-palette/state";
import { __resetBeltIntents } from "@/lib/belt-intent";
import { __resetHarnessPrefs } from "@/lib/harness-prefs";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import { __resetStripsCollapsed } from "@/lib/strips-collapsed";
import { __resetZen } from "@/lib/zen";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
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
afterEach(() => {
  __resetBeltIntents();
  __resetActionsPalette();
});

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = fixtureAgents[0]!; // a blocked claude agent
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    // A real claude pane: the transcript row plus the input box under it.
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<AgentChat {...props} />) }]);
  const { container } = render(<RouterProvider router={router} />);
  return { props, container };
}

type User = ReturnType<typeof userEvent.setup>;
async function openPaneMenu(user: User) {
  await user.click(screen.getByRole("button", { name: "Pane actions" }));
}

describe("AgentChat — the pane's three dots", () => {
  // "My menu is open" (ui/button.tsx `TRIGGER_OPEN`): the three dots carry `aria-expanded` and `aria-haspopup`
  // and read the sheet's own open state, on every width. The look is CSS keyed on the attribute, so the
  // attribute following the sheet is the whole contract here; the engine check is e2e/wide-sheets.spec.ts.
  it("says it is open while its menu is open, and not before or after", async () => {
    const user = userEvent.setup();
    renderChat();
    const menu = screen.getByRole("button", { name: "Pane actions" });
    expect(menu).toHaveAttribute("aria-haspopup", "dialog");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu.className).toContain("aria-expanded:bg-(--state-open)");
    await openPaneMenu(user);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(menu).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });
});

describe("AgentChat — the pinned Actions button says it is open", () => {
  const pinned = (container: HTMLElement, name: string) => within(container.querySelector<HTMLElement>('[data-slot="composer-actions"]')!).getByRole("button", { name });

  it("is aria-expanded while the Actions palette is open, wears the shared open look, and keeps its box", () => {
    const { container } = renderChat();
    const button = pinned(container, "Actions");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button.className).toContain("aria-expanded:bg-(--state-open)");
    expect(button.querySelector("svg")!.getAttribute("class")).toContain("text-primary");
    act(() => openActionsPalette());
    expect(pinned(container, "Actions")).toHaveAttribute("aria-expanded", "true");
    // Fill and ink only: the open look names no size, border or padding, and the icon takes the open ink.
    expect(button.className).not.toMatch(/aria-expanded:(?:size|w-|h-|p[xy]?-|border|min-)/);
    expect(button.querySelector("svg")!.getAttribute("class")).toContain("text-control-on-foreground");
  });
});

describe("AgentChat — the focused column of a large screen's strip (ADR 0120)", () => {
  it("keeps the belt's pinned Actions button, as on a phone, but not the phone's drag up to the pane list", async () => {
    const user = userEvent.setup();
    const phone = renderChat();
    const phoneButton = within(phone.container).getByRole("button", { name: "Actions" });
    expect(phone.container.querySelector('[data-slot="composer-actions"]')!.className).toContain("touch-pan-x");
    cleanup();
    const { container } = renderChat({ inStrip: true });
    const belt = container.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    const button = within(belt).getByRole("button", { name: "Actions" });
    // The same button: the same label, outside the scrolling track, pinned in the belt.
    expect(button.getAttribute("aria-label")).toBe(phoneButton.getAttribute("aria-label"));
    expect(belt.querySelector(".overflow-x-auto")!.contains(button)).toBe(false);
    // The drag up is the phone's gesture: the wide belt is not a drag surface.
    expect(belt.className).not.toContain("touch-pan-x");
    // A press opens the Actions palette, as the shortcut does.
    expect(isActionsPaletteOpen()).toBe(false);
    await user.click(button);
    expect(isActionsPaletteOpen()).toBe(true);
    // The belt stays whole, with the reply box under it.
    expect(within(container).getByRole("button", { name: "Keys" })).toBeInTheDocument();
    expect(within(container).getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    // The column is the bound, so the phone's width ladder stands down.
    expect(container.querySelector(".md\\:max-w-screen-md")).toBeNull();
  });
});
