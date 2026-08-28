import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The sheet end to end: listing, creating, opening and the two-then-three tap removal. The api layer
// is mocked so a dirty refusal can be produced exactly, which is the behaviour worth pinning — the
// discarding confirmation must never appear before the multiplexer has actually refused.
vi.mock("@/lib/api", () => ({
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  openWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  apiErrorFields: vi.fn(() => ({})),
}));

import { createWorktree, listWorktrees, openWorktree, removeWorktree } from "@/lib/api";
import { WorktreeSheet } from "./worktree-sheet";

const mockList = vi.mocked(listWorktrees);
const mockCreate = vi.mocked(createWorktree);
const mockOpen = vi.mocked(openWorktree);
const mockRemove = vi.mocked(removeWorktree);

const PANE = {
  paneId: "%9",
  workspaceId: "w9",
  workspaceLabel: "feature",
  tabId: "w9:t1",
  cwd: "/repo/.worktrees/feature",
};

const MAIN = {
  path: "/repo",
  branch: "main",
  openWorkspaceId: "w1",
  linked: false,
  prunable: false,
};

const OPEN_WORKTREE = {
  path: "/repo/.worktrees/feature",
  branch: "feature",
  openWorkspaceId: "w9",
  linked: true,
  prunable: false,
};

const CLOSED_WORKTREE = {
  path: "/repo/.worktrees/idle",
  branch: "idle",
  openWorkspaceId: null,
  linked: true,
  prunable: false,
};

function renderSheet(overrides: Partial<Parameters<typeof WorktreeSheet>[0]> = {}) {
  const onOpened = vi.fn();
  const onRemoved = vi.fn();
  const onClose = vi.fn();
  render(
    <WorktreeSheet
      open
      onClose={onClose}
      workspaceId="w1"
      onOpened={onOpened}
      onRemoved={onRemoved}
      {...overrides}
    />,
  );
  return { onOpened, onRemoved, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ ok: true, worktrees: [MAIN, OPEN_WORKTREE, CLOSED_WORKTREE] });
});

describe("WorktreeSheet", () => {
  it("lists the repo's checkouts, the repo's own included", async () => {
    renderSheet();
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("offers no Remove for a checkout no space is showing — there would be nothing to name", async () => {
    renderSheet();
    await screen.findByText("idle");
    // Two removable-looking rows exist; only the one with an open space gets the destructive tap.
    const removes = screen.getAllByRole("button", { name: /remove/i });
    expect(removes).toHaveLength(1);
    expect(screen.getByText(/open it to be able to remove it/i)).toBeInTheDocument();
  });

  it("creates a branch and hands the caller the pane to navigate to", async () => {
    mockCreate.mockResolvedValue({ ok: true, pane: PANE, alreadyOpen: false });
    const { onOpened, onClose } = renderSheet();
    await screen.findByText("main");
    await userEvent.type(screen.getByPlaceholderText("feature/my-change"), "feature/new");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith("w1", "feature/new", undefined));
    expect(onOpened).toHaveBeenCalledWith(PANE);
    expect(onClose).toHaveBeenCalled();
  });

  it("treats an already-open worktree as an answer, not a failure", async () => {
    mockOpen.mockResolvedValue({ ok: true, pane: PANE, alreadyOpen: true });
    const { onOpened } = renderSheet();
    await screen.findByText("feature");
    await userEvent.click(screen.getAllByRole("button", { name: "Open" })[1]!);
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(PANE));
  });

  it("takes two taps to remove, and never sends force on the first attempt", async () => {
    mockRemove.mockResolvedValue({ ok: true, path: OPEN_WORKTREE.path, forced: false });
    const { onRemoved } = renderSheet();
    await screen.findByText("feature");
    const remove = screen.getByRole("button", { name: /remove/i });

    await userEvent.click(remove);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /remove worktree\?/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /remove worktree\?/i }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("w1", "w9", false, undefined));
    expect(onRemoved).toHaveBeenCalled();
  });

  it("offers to discard only after the multiplexer has refused for being dirty", async () => {
    mockRemove.mockResolvedValueOnce({
      ok: false,
      error: "dirty",
      code: "worktree.dirty",
      detail: { reason: "contains modified or untracked files" },
    });
    renderSheet();
    await screen.findByText("feature");

    await userEvent.click(screen.getByRole("button", { name: /remove/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove worktree\?/i }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("w1", "w9", false, undefined));

    // The wording now names the loss, and only now can force be sent.
    const discard = await screen.findByRole("button", { name: /remove/i });
    await userEvent.click(discard);
    const armed = await screen.findByRole("button", { name: /discard changes and remove\?/i });
    mockRemove.mockResolvedValueOnce({ ok: true, path: OPEN_WORKTREE.path, forced: true });
    await userEvent.click(armed);
    await waitFor(() => expect(mockRemove).toHaveBeenLastCalledWith("w1", "w9", true, undefined));
  });
});
