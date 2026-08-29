import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import type { AgentView, ServerSummary } from "@/lib/types";
import { PackProvider } from "./pack-provider";
import { PaneActionsSheet } from "./pane-actions-sheet";

// The long-press pane actions sheet: an action-list first view (Rename / Close pane), with rename
// tucked behind its own tap so opening the sheet never shoves a keyboard-triggering input at you.
// Both actions are wired straight to the bridge via lib/api (exercised through MSW here); the parent
// gets onRenamed / onClosed callbacks for the revalidate/navigate side-effects.

beforeEach(() => clearStatus());

const agent: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/webapp",
  focused: false,
};

/** The sheet's props, so a case that needs its own wrapper can render it itself. */
function renderProps(
  overrides: Partial<React.ComponentProps<typeof PaneActionsSheet>> = {},
): React.ComponentProps<typeof PaneActionsSheet> {
  return {
    open: true,
    onClose: vi.fn(),
    pane: agent,
    onRenamed: vi.fn(),
    onClosed: vi.fn(),
    ...overrides,
  };
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof PaneActionsSheet>> = {}) {
  const props = renderProps(overrides);
  render(<PaneActionsSheet {...props} />);
  return props;
}

describe("PaneActionsSheet — action list", () => {
  it("opens on the action list, not the rename input", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close pane" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("name this pane")).toBeNull();
  });

  it("color-codes the Close pane row as destructive from the first tap, not just once armed", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: "Close pane" })).toHaveClass("text-destructive");
  });
});

describe("PaneActionsSheet — rename", () => {
  it("stays on the action list until Rename is tapped, then shows the prefilled input", async () => {
    const user = userEvent.setup();
    renderSheet({ pane: { ...agent, paneLabel: "deploy" } });
    expect(screen.queryByPlaceholderText("name this pane")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this pane")).toHaveValue("deploy");
  });

  it("autofocuses the input once rename mode opens", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByPlaceholderText("name this pane")).toHaveFocus());
  });

  it("Back returns to the action list without saving", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByPlaceholderText("name this pane")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("posts the trimmed label, then calls onRenamed and closes", async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/rename$/, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByPlaceholderText("name this pane");
    await user.type(input, "  deploy  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledTimes(1));
    expect(body).toEqual({ label: "deploy" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the label by saving an empty field (sends an empty label)", async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/rename$/, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const props = renderSheet({ pane: { ...agent, paneLabel: "deploy" } });
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByPlaceholderText("name this pane"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledTimes(1));
    expect(body).toEqual({ label: "" });
  });

  it("does NOT revalidate or close when the rename fails (error goes to the status channel)", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(/\/api\/pane\/[^/]+\/rename$/, () => HttpResponse.json({ ok: false, error: "pane not found" })),
    );
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByPlaceholderText("name this pane"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The sheet stays open (Save still enabled) and neither side-effect fires.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(props.onRenamed).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("resets back to the action list when the sheet reopens, even mid-rename", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PaneActionsSheet open={true} onClose={vi.fn()} pane={agent} onRenamed={vi.fn()} onClosed={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this pane")).toBeInTheDocument();

    rerender(<PaneActionsSheet open={false} onClose={vi.fn()} pane={agent} onRenamed={vi.fn()} onClosed={vi.fn()} />);
    rerender(<PaneActionsSheet open={true} onClose={vi.fn()} pane={agent} onRenamed={vi.fn()} onClosed={vi.fn()} />);

    expect(screen.queryByPlaceholderText("name this pane")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("resets back to the action list when the target pane changes, even mid-rename", async () => {
    const user = userEvent.setup();
    const other: AgentView = { ...agent, paneId: "w1:p2" };
    const { rerender } = render(<PaneActionsSheet open={true} onClose={vi.fn()} pane={agent} onRenamed={vi.fn()} onClosed={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this pane")).toBeInTheDocument();

    rerender(<PaneActionsSheet open={true} onClose={vi.fn()} pane={other} onRenamed={vi.fn()} onClosed={vi.fn()} />);

    expect(screen.queryByPlaceholderText("name this pane")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });
});

describe("PaneActionsSheet — close", () => {
  it("closes only after a two-tap confirm, then calls onClosed and closes the sheet", async () => {
    const user = userEvent.setup();
    const props = renderSheet();

    await user.click(screen.getByRole("button", { name: "Close pane" }));
    expect(props.onClosed).not.toHaveBeenCalled(); // first tap only arms

    await user.click(screen.getByRole("button", { name: "Tap again to close" }));
    await waitFor(() => expect(props.onClosed).toHaveBeenCalledExactlyOnceWith("w1:p1"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PaneActionsSheet — locale", () => {
  it("translates its action labels once the German bundle lands", async () => {
    // Same recipe as theme-control.test.tsx: `vi.resetModules()` gives this test its own copy of
    // `@/lib/i18n`, so the locale store driven here is the same one the freshly re-imported
    // component reads from.
    vi.resetModules();
    const [{ PaneActionsSheet: FreshSheet }, { __resetLocale, setLocale, whenLocaleReady }] =
      await Promise.all([import("./pane-actions-sheet"), import("@/lib/i18n")]);
    __resetLocale();

    render(
      <FreshSheet
        open={true}
        onClose={vi.fn()}
        pane={agent}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );

    await act(async () => {
      setLocale("de");
      await whenLocaleReady("de");
    });

    expect(screen.getByRole("button", { name: "Umbenennen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pane schließen" })).toBeInTheDocument();
  });
});

describe("PaneActionsSheet — read-only", () => {
  it("shows a note and no write actions when the device isn't authorised", () => {
    renderSheet({ readOnly: true });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByPlaceholderText("name this pane")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
  });
});

// Close and rename are §10.3 writes to one specific machine — the pane's own. On a pack member the
// lead can't reach they are refused BEFORE anything is attempted: there is no queue and no retry, and
// a half-known "did the close land?" on a real terminal is the worst outcome to hand somebody.
describe("PaneActionsSheet — a pane on an unreachable machine", () => {
  const roster: ServerSummary[] = [
    { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 9_000 },
    { id: "workshop", name: "workshop", isLead: false, reachable: false, protocol: "ok", lastSeenAt: 1_000 },
  ];
  const pack = ({ children }: { children: React.ReactNode }) => (
    <PackProvider servers={roster} ts={20_000} pollMs={1500}>
      {children}
    </PackProvider>
  );

  it("replaces both actions with the machine's name and its last-seen age", () => {
    render(<PaneActionsSheet {...renderProps({ pane: { ...agent, host: "workshop" } })} />, {
      wrapper: pack,
    });
    expect(screen.getByText(/workshop is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close pane/i })).not.toBeInTheDocument();
  });

  it("leaves a pane on a reachable member of the same pack exactly as it was", () => {
    render(<PaneActionsSheet {...renderProps({ pane: { ...agent, host: "bluefin" } })} />, {
      wrapper: pack,
    });
    expect(screen.getByRole("button", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close pane/i })).toBeInTheDocument();
  });
});

// The two READ rows the pane header hands this sheet when the ⋮ opens it. The pane STRIP passes
// neither, and that asymmetry is the design: find searches the buffer the open pane already fetched,
// and a strip pill can open this sheet on a pane whose output was never loaded.
describe("PaneActionsSheet — the read rows", () => {
  it("shows neither row when the caller offers neither (the pane strip's case)", () => {
    renderSheet();
    expect(screen.queryByRole("button", { name: "Find in output" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversation history" })).toBeNull();
  });

  it("shows only the row it was given a callback for", () => {
    renderSheet({ onFind: vi.fn() });
    expect(screen.getByRole("button", { name: "Find in output" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conversation history" })).toBeNull();
  });

  it("closes the sheet BEFORE it acts, so the surface the row leads to arrives alone", async () => {
    const user = userEvent.setup();
    const onFind = vi.fn();
    const props = renderSheet({ onFind });
    await user.click(screen.getByRole("button", { name: "Find in output" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(onFind).toHaveBeenCalledTimes(1);
    // Order matters: the find bar takes over the header row, and the sheet must not still be over it.
    expect(vi.mocked(props.onClose).mock.invocationCallOrder[0]!).toBeLessThan(
      onFind.mock.invocationCallOrder[0]!,
    );
  });

  it("leads the list — reads come before the writes you arrive at deliberately", () => {
    renderSheet({ onFind: vi.fn(), onHistory: vi.fn() });
    const find = screen.getByRole("button", { name: "Find in output" });
    const rename = screen.getByRole("button", { name: "Rename" });
    expect(find.compareDocumentPosition(rename) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Neither read is a write, so neither refusal is about them. A device that may not write can still
  // search the output it already has; a machine that has stopped answering is exactly when you want
  // to read the last thing it said.
  it("survives read-only, which takes only the writes", () => {
    renderSheet({ readOnly: true, onFind: vi.fn(), onHistory: vi.fn() });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find in output" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation history" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("goes away in rename mode — that view is a sub-screen, not a section", async () => {
    const user = userEvent.setup();
    renderSheet({ onFind: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.queryByRole("button", { name: "Find in output" })).toBeNull();
  });

  // DESIGN.md §6: 44px is the floor for anything tappable, and a sheet row is a thumb target that
  // slides up under the finger. Every row in here states the floor — `min-h-11` around a 20px
  // `text-sm` line, because `px-3 py-2.5` alone drew 40.
  it("gives every row a 44px hit box", () => {
    renderSheet({ onFind: vi.fn(), onHistory: vi.fn() });
    for (const name of ["Find in output", "Conversation history", "Rename", "Close pane"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11");
    }
  });
});
