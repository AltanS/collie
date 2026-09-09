import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AgentView } from "@/lib/types";
import { SpaceAgentsRow } from "./space-agents-row";

function agent(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  const [workspaceId] = paneId.split(":");
  return {
    paneId,
    workspaceId: workspaceId ?? "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: `${workspaceId ?? "w1"}:t1`,
    agent: "claude",
    status: "blocked",
    cwd: "/home/you/webapp",
    focused: false,
    ...extra,
  };
}

// This space's sessions: the open claude pane plus a sibling with a real session name. The row
// is scoped by its `agents` prop — the caller hands it this space's sessions only — so a
// foreign space's agent reaches the row only if the caller leaks it across.
const claude = () => agent("w1:p1", { agent: "claude", status: "blocked" });
const sibling = () =>
  agent("w1:p2", { agent: "codex", status: "working", sessionName: "redesign" });

function renderRow(overrides: Partial<React.ComponentProps<typeof SpaceAgentsRow>> = {}) {
  const props = {
    agents: [claude(), sibling()],
    currentPaneId: "w1:p1",
    onSelect: vi.fn(),
    onOpenSwitcher: vi.fn(),
    onHoldPane: vi.fn(),
    onOpenCommands: vi.fn(),
    pinOpen: false,
    commandsAvailable: true,
    commandsDisabled: false,
    ...overrides,
  };
  const result = render(<SpaceAgentsRow {...props} />);
  const row = document.querySelector<HTMLElement>('[data-slot="space-agents"]')!;
  return { props, row, ...result };
}

describe("SpaceAgentsRow", () => {
  it("lists this space's sessions by title, marking the open one current", () => {
    const { row } = renderRow();
    expect(row).toBeInTheDocument();

    // Operator label, then the agent's own session name, then the agent kind.
    expect(within(row).getByRole("button", { name: "working redesign" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "needs you claude" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(row).getByRole("button", { name: "working redesign" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("never shows a foreign space's agent", () => {
    // The caller scopes `agents` to the open pane's own space; the row renders what it is
    // given and nothing else — a w2 codex with no session name would read "codex" here.
    const { row } = renderRow();
    expect(within(row).queryByRole("button", { name: "codex" })).toBeNull();
  });

  it("leads each chip with its status dot, labelled", () => {
    // The chip carries no status word, so the dot is the only mark of the state and takes the
    // label — "needs you" on the blocked claude, "working" on the sibling.
    const { row } = renderRow();
    expect(within(row).getByRole("img", { name: "needs you" })).toBeInTheDocument();
    expect(within(row).getByRole("img", { name: "working" })).toBeInTheDocument();
  });

  it("tapping another session selects that pane", async () => {
    const user = userEvent.setup();
    const { props } = renderRow();

    await user.click(screen.getByRole("button", { name: "working redesign" }));
    expect(props.onSelect).toHaveBeenCalledWith("w1:p2");
  });

  it("opens the switcher from the up-pill", async () => {
    const user = userEvent.setup();
    const { props } = renderRow();

    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    expect(props.onOpenSwitcher).toHaveBeenCalledTimes(1);
  });

  it("opens the same switcher on a swipe up across the row", () => {
    const { props, row } = renderRow();
    expect(props.onOpenSwitcher).not.toHaveBeenCalled();

    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 700 }] });
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 205, clientY: 640 }] });

    expect(props.onOpenSwitcher).toHaveBeenCalledTimes(1);
  });

  it("holding a chip opens that pane's options without selecting it", () => {
    // Reaches the DOM as `contextmenu` (Android Chrome / right-click); the timer path is
    // covered in use-long-press.test.ts, so this pins the wiring — the right pane.
    const { props } = renderRow();

    fireEvent.contextMenu(screen.getByRole("button", { name: "working redesign" }));

    expect(props.onHoldPane).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onHoldPane).mock.calls[0]?.[0]).toMatchObject({ paneId: "w1:p2" });
    // …and the hold never switched panes on the way in.
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("renders no pin when there is nothing pickable", () => {
    renderRow({ commandsAvailable: false });
    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
  });

  it("disables the pin on a read-only device", () => {
    renderRow({ commandsAvailable: true, commandsDisabled: true });
    expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled();
  });

  it("dims the dots on a stale connection rather than hiding them", () => {
    const { row } = renderRow({ stale: true });
    expect(within(row).getByRole("img", { name: "needs you" })).toHaveClass("opacity-40");
    expect(within(row).getByRole("img", { name: "working" })).toHaveClass("opacity-40");
    // …and undims them the moment the snapshot is live again.
    cleanup();
    const live = renderRow({ stale: false });
    expect(
      within(live.row).getByRole("img", { name: "needs you" }),
    ).not.toHaveClass("opacity-40");
  });

  it("docks the pin on the configured side", () => {
    // Default (left): the pin leads the row in DOM order, ahead of the first chip. Stored
    // right: it trails after the last chip. Tab order follows the eye both ways.
    // Memory store, not the global: this jsdom ships no localStorage (see use-pin-side.test.ts).
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      clear: () => {
        store.clear();
      },
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => {
        store.delete(k);
      },
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
    });
    try {
      renderRow();
      const pin = screen.getByRole("button", { name: "Agent" });
      const firstChip = screen.getByRole("button", { name: "needs you claude" });
      expect(pin.compareDocumentPosition(firstChip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      cleanup();

      store.set("collie:pin-side:v1", JSON.stringify({ side: "right" }));
      renderRow();
      const pinRight = screen.getByRole("button", { name: "Agent" });
      const lastChip = screen.getByRole("button", { name: "working redesign" });
      expect(
        pinRight.compareDocumentPosition(lastChip) & Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
