import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";

import { __resetActionsPalette, isActionsPaletteOpen } from "@/lib/actions-palette/state";
import { __resetPins, setPinned, usePins } from "@/lib/pins";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { forgetRecentPanes, rememberRecentPane } from "@/lib/recent-panes";
import { __resetShortcutRegistry, registerShortcutHandler, runShortcutAction } from "@/lib/shortcuts/registry";
import type { AgentView } from "@/lib/types";

import { ActionsButton, ActionsPaletteDoor } from "./actions-palette";
import { ThreadSidebar } from "./agent-sidebar";

// THE ACTIONS PALETTE (ADR 0165): one modal at the top, a search field, Recent and Suggested before
// typing, one ranked list after, and a command only where its handler answers.

function pane(id: string, label: string): AgentView {
  return {
    paneId: `w1:${id}`,
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/webapp",
    focused: false,
    paneLabel: label,
  };
}

const PANES = [pane("p1", "alpha"), pane("p2", "bravo"), pane("p3", "charlie"), { ...pane("p4", "delta"), workspaceId: "w2", workspaceLabel: "api", workspaceNumber: 2, tabId: "w2:t1" }];
const WORKSPACES = [
  { workspaceId: "w1", number: 1, label: "webapp", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 3 },
  { workspaceId: "w2", number: 2, label: "api", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 1 },
];

function Where() {
  const { pathname } = useLocation();
  return <p data-testid="where">{pathname}</p>;
}

function mount(path = "/", openPane?: AgentView) {
  const element = (
    <>
      <ActionsButton />
      <ActionsPaletteDoor scope={{}} openPane={openPane} />
      <Where />
    </>
  );
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "*", loader: () => null, element }], {
    initialEntries: [path],
    hydrationData: {
      loaderData: {
        [ROOT_ROUTE_ID]: {
          agents: PANES,
          shellPanes: [],
          workspaces: WORKSPACES,
          tabs: [],
          scope: {},
        },
      },
    },
  });
  render(<RouterProvider router={router} />);
  return router;
}

const palette = () => screen.getByRole("dialog", { name: "Actions" });
const field = () => screen.getByRole("textbox", { name: "Search commands and panes" });
const highlighted = () => palette().querySelector('[data-highlighted="true"]');

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  localStorage.clear();
  forgetRecentPanes();
  __resetPins();
});
afterEach(() => {
  __resetShortcutRegistry();
  __resetActionsPalette();
});

describe("the Actions palette", () => {
  it("opens from the header button and from open_actions, with the field focused", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(palette()).toBeInTheDocument();
    expect(field()).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      expect(runShortcutAction("open_actions")).toBe(true);
    });
    expect(palette()).toBeInTheDocument();
  });

  it("the header button says the palette is open while it stands", async () => {
    const user = userEvent.setup();
    mount();
    const button = screen.getByRole("button", { name: "Actions" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(palette()).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on × with an empty field, and × clears a typed one first", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.type(field(), "zzz");
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(field()).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(isActionsPaletteOpen()).toBe(false);
  });

  it("shows Recent, newest first and without the open pane, then Suggested; the first row is highlighted", async () => {
    const user = userEvent.setup();
    rememberRecentPane(PANES[0]!, 1);
    rememberRecentPane(PANES[1]!, 2);
    rememberRecentPane(PANES[2]!, 3);
    for (const id of ["new_tab", "new_shell", "find", "zen_mode"] as const) registerShortcutHandler(id, () => {});
    mount("/pane/w1%3Ap3", PANES[2]);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const recent = within(palette()).getByRole("heading", { name: "Recent" }).closest("section")!;
    expect(within(recent).getAllByRole("button").map((b) => b.textContent)).toEqual([expect.stringContaining("bravo"), expect.stringContaining("alpha")]);
    const suggested = within(palette()).getByRole("heading", { name: "Suggested" }).closest("section")!;
    expect(within(suggested).getAllByRole("button").map((b) => b.textContent)).toEqual([
      expect.stringContaining("New tab"),
      expect.stringContaining("New shell"),
      expect.stringContaining("Find in output"),
      expect.stringContaining("Zen mode"),
    ]);
    expect(highlighted()?.textContent).toContain("bravo");
  });

  it("leads with Suggested on the dashboard when no pane was opened yet", async () => {
    const user = userEvent.setup();
    for (const id of ["new_agent", "new_space", "new_shell", "settings"] as const) registerShortcutHandler(id, () => {});
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(palette()).queryByRole("heading", { name: "Recent" })).toBeNull();
    expect(highlighted()?.textContent).toContain("New agent");
  });

  it("lists only the commands whose handler answers here", async () => {
    const user = userEvent.setup();
    registerShortcutHandler("settings", () => {});
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.type(field(), "close");
    expect(within(palette()).queryByText("Close pane")).toBeNull();
    await user.clear(field());
    await user.type(field(), "settings");
    expect(within(palette()).getByText("Command")).toBeInTheDocument();
  });

  it("ranks commands, spaces and panes in one list, and says when nothing matches", async () => {
    const user = userEvent.setup();
    registerShortcutHandler("settings", () => {});
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.type(field(), "webapp");
    expect(within(palette()).getByText("Space")).toBeInTheDocument();
    await user.clear(field());
    await user.type(field(), "qqqq");
    expect(within(palette()).getByText("Nothing matches “qqqq”.")).toBeInTheDocument();
  });

  it("runs the highlighted command on Enter, after it closes", async () => {
    const user = userEvent.setup();
    const ran = vi.fn(() => expect(isActionsPaletteOpen()).toBe(false));
    registerShortcutHandler("settings", ran);
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.type(field(), "settings{Enter}");
    expect(ran).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never highlights Close pane first, and Enter on it runs its handler, which opens the confirm", async () => {
    const user = userEvent.setup();
    const openConfirm = vi.fn();
    registerShortcutHandler("close_pane", openConfirm);
    registerShortcutHandler("close_tab", () => {});
    mount("/pane/w1%3Ap1", PANES[0]);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    // Only Close rows match: none is highlighted, so Enter does nothing until an arrow picks one.
    await user.type(field(), "close{Enter}");
    expect(openConfirm).not.toHaveBeenCalled();
    expect(highlighted()).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(highlighted()?.textContent).toContain("Close pane");
    await user.keyboard("{Enter}");
    expect(openConfirm).toHaveBeenCalledOnce();
  });

  it("puts a safe row first when one matches beside a Close row", async () => {
    const user = userEvent.setup();
    registerShortcutHandler("close_pane", () => {});
    mount("/pane/w1%3Ap2", PANES[1]);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    // "c" matches Close pane first on the tie rule, and panes after it: a pane leads instead.
    await user.type(field(), "c");
    const rows = [...palette().querySelectorAll("[data-palette-row]")];
    expect(rows.some((row) => (row.textContent ?? "").startsWith("Close pane"))).toBe(true);
    expect(highlighted()?.textContent).not.toContain("Close pane");
    expect(highlighted()).toBe(rows[0]);
  });

  it("opens a pane row the way the switcher does", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.type(field(), "charlie{Enter}");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/pane/w1%3Ap3"));
  });

  it("before typing holds Recent, Suggested and All panes, in that order", async () => {
    const user = userEvent.setup();
    rememberRecentPane(PANES[0]!, 1);
    registerShortcutHandler("new_tab", () => {});
    mount("/pane/w1%3Ap2", PANES[1]);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const labels = within(palette())
      .getAllByRole("heading")
      .map((h) => h.textContent)
      .filter((text) => ["Recent", "Suggested", "All panes"].includes(text ?? ""));
    expect(labels).toEqual(["Recent", "Suggested", "All panes"]);
    // A pane in Recent is also in All panes, and the palette's field is the only search field.
    const all = palette().querySelector<HTMLElement>('[data-slot="actions-all-panes"]')!;
    expect(within(all).getByText("alpha")).toBeInTheDocument();
    expect(within(palette()).getAllByRole("textbox")).toHaveLength(1);
  });

  it("lists in All panes exactly what the Switch pane sheet lists, pinned first", async () => {
    const user = userEvent.setup();
    act(() => setPinned(PANES[3]!, true, PANES));
    mount("/pane/w1%3Ap1", PANES[0]);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const inPalette = [...palette().querySelectorAll('[data-slot="actions-all-panes"] [data-slot="pane-row"]')].map((row) =>
      row.getAttribute("data-pane-key"),
    );
    function Sheet() {
      const pins = usePins();
      return (
        <div data-testid="sheet">
          <ThreadSidebar agents={PANES} shellPanes={[]} currentPaneKey="" onSelect={() => {}} tabs={[]} workspaces={WORKSPACES} scope={{}} pins={pins} />
        </div>
      );
    }
    render(<Sheet />);
    const inSheet = [...screen.getByTestId("sheet").querySelectorAll('[data-slot="pane-row"]')].map((row) => row.getAttribute("data-pane-key"));
    expect(inPalette).toEqual(inSheet);
    expect(inPalette[0]).toBe(palette().querySelector('[data-slot="actions-all-panes"] [data-slot="pane-row"]')?.getAttribute("data-pane-key"));
    expect(inSheet[0]).toContain("w1:p4");
    // The open pane is marked the way the sheet marks it.
    const open = [...palette().querySelectorAll('[data-slot="actions-all-panes"] [aria-current="page"]')];
    expect(open.map((row) => row.textContent)).toEqual([expect.stringContaining("alpha")]);
  });

  it("walks with the arrows from Suggested into All panes, and Enter opens that pane", async () => {
    const user = userEvent.setup();
    registerShortcutHandler("settings", () => {});
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(highlighted()?.textContent).toContain("Settings");
    await user.keyboard("{ArrowDown}");
    const row = highlighted()!;
    expect(row.getAttribute("data-slot")).toBe("pane-row");
    expect(row.closest('[data-slot="actions-all-panes"]')).not.toBeNull();
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(highlighted()).toBe(row);
    await user.keyboard("{Enter}");
    const key = row.getAttribute("data-pane-key") ?? "";
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/pane/${encodeURIComponent(key.split("\u0000").at(-1) ?? "")}`));
  });

  it("drops all three parts for the one ranked list once something is typed", async () => {
    const user = userEvent.setup();
    rememberRecentPane(PANES[0]!, 1);
    registerShortcutHandler("settings", () => {});
    mount();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.type(field(), "settings");
    expect(within(palette()).queryByRole("heading", { name: "All panes" })).toBeNull();
    expect(within(palette()).queryByRole("heading", { name: "Recent" })).toBeNull();
    expect(palette().querySelector('[data-slot="actions-all-panes"]')).toBeNull();
    expect(highlighted()?.textContent).toContain("Settings");
  });
});
