import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import { __resetOperatorCommands } from "@/lib/operator-config";
import type { MuxCapability, MuxConfig, WorkspaceView } from "@/lib/types";
import { SpaceActionsSheet } from "./space-actions-sheet";

// The long-press space sheet (M53 spec 05): one row, Rename, drawn only on a machine whose multiplexer declares
// `renameSpace` (a durable program that takes renames). Same shape as the tab sheet one level up.

beforeEach(() => clearStatus());
afterEach(() => __resetOperatorCommands());

/** Serve an `/api/config` whose mux block declares exactly `capabilities`. */
function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

const space: WorkspaceView = {
  workspaceId: "triage",
  number: 1,
  label: "Triage",
  focused: false,
  activeTabId: "triage:inbox",
  tabCount: 2,
  paneCount: 3,
};

function renderSheet(overrides: Partial<React.ComponentProps<typeof SpaceActionsSheet>> = {}) {
  const props: React.ComponentProps<typeof SpaceActionsSheet> = {
    open: true,
    onClose: vi.fn(),
    space,
    onRenamed: vi.fn(),
    ...overrides,
  };
  render(<SpaceActionsSheet {...props} />);
  return props;
}

describe("SpaceActionsSheet: the Rename row follows renameSpace", () => {
  it("draws Rename when the machine declares renameSpace", async () => {
    declares({ renameSpace: true });
    renderSheet();
    expect(await screen.findByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("name this space")).toBeNull();
  });

  it("draws no Rename when renameSpace is declared false, and says the program offers no action", async () => {
    declares({ renameSpace: false });
    renderSheet();
    await waitFor(() => expect(screen.getByText("This program offers no actions for a space.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("draws no Rename on a bridge that never answered for it: a program's own control reads absent", async () => {
    server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })));
    renderSheet();
    await waitFor(() => expect(screen.getByText("This program offers no actions for a space.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });
});

describe("SpaceActionsSheet: rename", () => {
  it("opens the prefilled input behind the Rename tap and posts the trimmed name to /api/space/:id/rename", async () => {
    declares({ renameSpace: true });
    const user = userEvent.setup();
    let url = "";
    let body: unknown;
    server.use(
      http.post(/\/api\/space\/[^/]+\/rename$/, async ({ request }) => {
        url = request.url;
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const props = renderSheet();
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByPlaceholderText("name this space");
    expect(input).toHaveValue("Triage");
    await user.clear(input);
    await user.type(input, "  Support  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledTimes(1));
    expect(body).toEqual({ label: "Support" });
    expect(url).toContain("/api/space/triage/rename");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("disables Save on a blank field", async () => {
    declares({ renameSpace: true });
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    await user.clear(screen.getByPlaceholderText("name this space"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("does not revalidate or close when the program refuses the name", async () => {
    declares({ renameSpace: true });
    const user = userEvent.setup();
    server.use(
      http.post(/\/api\/space\/[^/]+\/rename$/, () =>
        HttpResponse.json({ ok: false, error: "The program did not accept this name.", code: "space.rename_failed", detail: { reason: "no" } }),
      ),
    );
    const props = renderSheet();
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByPlaceholderText("name this space");
    await user.clear(input);
    await user.type(input, "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(props.onRenamed).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("renders a markup-looking name as literal text", async () => {
    declares({ renameSpace: true });
    const user = userEvent.setup();
    const xss = "<img src=x onerror=alert(1)>";
    renderSheet({ space: { ...space, label: xss } });
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this space")).toHaveValue(xss);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("SpaceActionsSheet: read-only and saved copy replace the action", () => {
  it("shows a note instead of Rename on a read-only device", async () => {
    declares({ renameSpace: true });
    renderSheet({ readOnly: true });
    expect(await screen.findByText(/not authorised to rename spaces/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("shows the saved-copy note instead of Rename", async () => {
    declares({ renameSpace: true });
    renderSheet({ savedCopy: true });
    expect(await screen.findByText("Saved copy. Reconnect to make changes.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });
});

// M53 spec 11: a History row, drawn only when the machine declares `programHistory`. It closes the sheet and
// then hands the navigation to the route (the sheet itself needs no router).
describe("SpaceActionsSheet: durable history row follows programHistory", () => {
  it("draws History when the machine declares programHistory, and closes then acts on a tap", async () => {
    declares({ programHistory: true });
    const user = userEvent.setup();
    const onHistory = vi.fn();
    const props = renderSheet({ onHistory });
    const row = await screen.findByRole("button", { name: "History" });
    await user.click(row);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onClose).mock.invocationCallOrder[0]!).toBeLessThan(onHistory.mock.invocationCallOrder[0]!);
  });

  it("draws no History row when programHistory is declared false or never answered", async () => {
    declares({ programHistory: false, renameSpace: true });
    renderSheet({ onHistory: vi.fn() });
    expect(await screen.findByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("draws no History row when the strip gave the sheet nowhere to go", async () => {
    declares({ programHistory: true, renameSpace: true });
    renderSheet();
    expect(await screen.findByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("keeps History beside Rename, and the empty note away, when both are declared", async () => {
    declares({ programHistory: true, renameSpace: true });
    renderSheet({ onHistory: vi.fn() });
    expect(await screen.findByRole("button", { name: "History" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByText("This program offers no actions for a space.")).toBeNull();
  });
});
