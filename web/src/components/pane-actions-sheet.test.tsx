import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";
import { PaneActionsSheet } from "./pane-actions-sheet";

// The long-press pane actions sheet: rename (set/clear the label) and close (two-tap kill). Both are
// wired straight to the bridge via lib/api (exercised through MSW here); the parent gets onRenamed /
// onClosed callbacks for the revalidate/navigate side-effects.

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

function renderSheet(overrides: Partial<React.ComponentProps<typeof PaneActionsSheet>> = {}) {
  const props: React.ComponentProps<typeof PaneActionsSheet> = {
    open: true,
    onClose: vi.fn(),
    pane: agent,
    onRenamed: vi.fn(),
    onClosed: vi.fn(),
    ...overrides,
  };
  render(<PaneActionsSheet {...props} />);
  return props;
}

describe("PaneActionsSheet — rename", () => {
  it("prefills the input from the pane's current label", () => {
    renderSheet({ pane: { ...agent, paneLabel: "deploy" } });
    expect(screen.getByPlaceholderText("name this pane")).toHaveValue("deploy");
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
    await user.type(screen.getByPlaceholderText("name this pane"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The sheet stays open (Save still enabled) and neither side-effect fires.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(props.onRenamed).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
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

describe("PaneActionsSheet — read-only", () => {
  it("shows a note and no write actions when the device isn't authorised", () => {
    renderSheet({ readOnly: true });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("name this pane")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
  });
});
