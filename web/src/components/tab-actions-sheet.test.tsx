import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import type { TabView } from "@/lib/types";
import { TabActionsSheet } from "./tab-actions-sheet";

// The long-press tab actions sheet — now STRUCTURALLY IDENTICAL to the pane sheet (the user asked for
// them to match): an action-list first view (Rename / Close tab), with rename tucked behind its own
// tap so opening the sheet never shoves a keyboard-triggering input at you. Two tab-specific rules,
// both live-verified: a blank tab label can't be saved (herdr has no "clear" for a tab), and the
// close confirm names the blast radius (closing a tab kills every pane in it). Wired to the bridge
// via lib/api (exercised through MSW); the parent gets onRenamed / onClosed side-effect callbacks.

beforeEach(() => clearStatus());

const tab: TabView = {
  tabId: "w1:t1",
  workspaceId: "w1",
  number: 1,
  label: "1",
  focused: true,
  paneCount: 2,
};

function renderSheet(overrides: Partial<React.ComponentProps<typeof TabActionsSheet>> = {}) {
  const props: React.ComponentProps<typeof TabActionsSheet> = {
    open: true,
    onClose: vi.fn(),
    tab,
    onRenamed: vi.fn(),
    onClosed: vi.fn(),
    ...overrides,
  };
  render(<TabActionsSheet {...props} />);
  return props;
}

describe("TabActionsSheet — action list", () => {
  it("opens on the action list, not the rename input", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
  });

  it("color-codes the Close tab row as destructive from the first tap, not just once armed", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: "Close tab" })).toHaveClass("text-destructive");
  });
});

describe("TabActionsSheet — rename", () => {
  it("stays on the action list until Rename is tapped, then shows the prefilled input", async () => {
    const user = userEvent.setup();
    renderSheet({ tab: { ...tab, label: "deploy" } });
    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this tab")).toHaveValue("deploy");
  });

  it("autofocuses the input once rename mode opens", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByPlaceholderText("name this tab")).toHaveFocus());
  });

  it("Back returns to the action list without saving", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("posts the trimmed label, then calls onRenamed and closes", async () => {
    const user = userEvent.setup();
    let body: unknown;
    let url = "";
    server.use(
      http.post(/\/api\/tab\/[^/]+\/rename$/, async ({ request }) => {
        url = request.url;
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByPlaceholderText("name this tab");
    await user.clear(input);
    await user.type(input, "  api  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledTimes(1));
    expect(body).toEqual({ label: "api" });
    expect(url).toContain("/api/tab/w1%3At1/rename");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("disables Save on a blank field — a tab has no clear", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    await user.clear(screen.getByPlaceholderText("name this tab"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("does NOT revalidate or close when the rename fails (error goes to the status channel)", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(/\/api\/tab\/[^/]+\/rename$/, () =>
        HttpResponse.json({ ok: false, error: "tab not found" }),
      ),
    );
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByPlaceholderText("name this tab");
    await user.clear(input);
    await user.type(input, "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(props.onRenamed).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("resets back to the action list when the sheet reopens, even mid-rename", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TabActionsSheet open={true} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this tab")).toBeInTheDocument();

    rerender(
      <TabActionsSheet open={false} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    rerender(
      <TabActionsSheet open={true} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );

    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("resets back to the action list when the target tab changes, even mid-rename", async () => {
    const user = userEvent.setup();
    const other: TabView = { ...tab, tabId: "w1:t2", label: "2" };
    const { rerender } = render(
      <TabActionsSheet open={true} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this tab")).toBeInTheDocument();

    rerender(
      <TabActionsSheet open={true} onClose={vi.fn()} tab={other} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );

    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  // The label is user text; it must render only as an <input> value / text node, never markup — same
  // XSS boundary as pane labels and pane output.
  it("renders a markup-looking label as literal text, injecting nothing", async () => {
    const user = userEvent.setup();
    const xss = "<img src=x onerror=alert(1)>";
    renderSheet({ tab: { ...tab, label: xss } });
    expect(document.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this tab")).toHaveValue(xss);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("TabActionsSheet — close", () => {
  it("closes only after a two-tap confirm, then calls onClosed and closes the sheet", async () => {
    const user = userEvent.setup();
    let url = "";
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );
    const props = renderSheet();

    await user.click(screen.getByRole("button", { name: "Close tab" }));
    expect(props.onClosed).not.toHaveBeenCalled(); // first tap only arms

    // Armed, the row names the blast radius (paneCount = 2).
    await user.click(screen.getByRole("button", { name: "Tap again to close 2 panes" }));
    await waitFor(() => expect(props.onClosed).toHaveBeenCalledExactlyOnceWith("w1:t1"));
    expect(url).toContain("/api/tab/w1%3At1/close");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("singularises the blast-radius confirm when the tab holds one pane", async () => {
    const user = userEvent.setup();
    renderSheet({ tab: { ...tab, paneCount: 1 } });
    await user.click(screen.getByRole("button", { name: "Close tab" }));
    expect(screen.getByRole("button", { name: "Tap again to close 1 pane" })).toBeInTheDocument();
  });

  it("does NOT close the sheet or fire onClosed when the close fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, () =>
        HttpResponse.json({ ok: false, error: "tab not found" }),
      ),
    );
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Close tab" }));
    await user.click(screen.getByRole("button", { name: "Tap again to close 2 panes" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument());
    expect(props.onClosed).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("TabActionsSheet — read-only", () => {
  it("shows a note and no write actions when the device isn't authorised", () => {
    renderSheet({ readOnly: true });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
  });
});
