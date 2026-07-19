import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import type { TabView } from "@/lib/types";
import { TabActionsSheet } from "./tab-actions-sheet";

// The long-press tab actions sheet: rename-only (herdr has tab.close, but Collie doesn't wire it), so
// it opens straight into the prefilled rename input — no action list. A tab label can't be cleared
// (herdr stores "" literally and rejects null), so a blank field can't be saved. Wired to the bridge
// via lib/api (exercised through MSW); the parent gets onRenamed for the revalidate side-effect.

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
    ...overrides,
  };
  render(<TabActionsSheet {...props} />);
  return props;
}

describe("TabActionsSheet — rename", () => {
  it("opens straight into the prefilled rename input (no action list)", () => {
    renderSheet({ tab: { ...tab, label: "deploy" } });
    expect(screen.getByPlaceholderText("name this tab")).toHaveValue("deploy");
    // Rename-only: there's no separate "Rename" action row like the pane sheet has.
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("autofocuses the input on open", async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByPlaceholderText("name this tab")).toHaveFocus());
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
    const input = screen.getByPlaceholderText("name this tab");
    await user.clear(input);
    await user.type(input, "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(props.onRenamed).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("reprefills the current label when the sheet reopens, even mid-edit", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TabActionsSheet open={true} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} />,
    );
    await user.clear(screen.getByPlaceholderText("name this tab"));
    await user.type(screen.getByPlaceholderText("name this tab"), "half-typed");

    rerender(<TabActionsSheet open={false} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} />);
    rerender(<TabActionsSheet open={true} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} />);

    expect(screen.getByPlaceholderText("name this tab")).toHaveValue("1");
  });

  it("reprefills when the target tab changes, even mid-edit", async () => {
    const user = userEvent.setup();
    const other: TabView = { ...tab, tabId: "w1:t2", label: "2" };
    const { rerender } = render(
      <TabActionsSheet open={true} onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} />,
    );
    await user.clear(screen.getByPlaceholderText("name this tab"));
    await user.type(screen.getByPlaceholderText("name this tab"), "half-typed");

    rerender(<TabActionsSheet open={true} onClose={vi.fn()} tab={other} onRenamed={vi.fn()} />);

    expect(screen.getByPlaceholderText("name this tab")).toHaveValue("2");
  });

  // The label is user text; it must render only as an <input> value / text node, never markup — same
  // XSS boundary as pane labels and pane output.
  it("renders a markup-looking label as literal text, injecting nothing", () => {
    const xss = "<img src=x onerror=alert(1)>";
    renderSheet({ tab: { ...tab, label: xss } });
    expect(screen.getByPlaceholderText("name this tab")).toHaveValue(xss);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("TabActionsSheet — read-only", () => {
  it("shows a note and no input when the device isn't authorised", () => {
    renderSheet({ readOnly: true });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
