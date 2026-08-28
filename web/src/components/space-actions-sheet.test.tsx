import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The one destructive action a space has, and the two guards around it: it exists only for a
// worktree (Collie never closes a space), and `force` is reachable only after a dirty refusal.
vi.mock("@/lib/api", () => ({ removeWorktree: vi.fn(), apiErrorFields: vi.fn(() => ({})) }));

import { removeWorktree } from "@/lib/api";
import { SpaceActionsSheet } from "./space-actions-sheet";
import type { WorkspaceView } from "@/lib/types";

const mockRemove = vi.mocked(removeWorktree);

function space(extra: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: "w9",
    number: 2,
    label: "feature",
    focused: false,
    activeTabId: "w9:t1",
    tabCount: 1,
    paneCount: 1,
    ...extra,
  };
}

const WORKTREE = space({ repoRoot: "/repo", isWorktree: true });
const PLAIN = space({ workspaceId: "w1", label: "ADHD" });

function renderSheet(target: WorkspaceView, readOnly = false) {
  const onRemoved = vi.fn();
  const onClose = vi.fn();
  render(
    <SpaceActionsSheet open onClose={onClose} space={target} readOnly={readOnly} onRemoved={onRemoved} />,
  );
  return { onRemoved, onClose };
}

beforeEach(() => vi.clearAllMocks());

describe("SpaceActionsSheet", () => {
  it("offers nothing on a space that is not a worktree — Collie never closes a space", () => {
    renderSheet(PLAIN);
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.getByText(/never closes a space/i)).toBeInTheDocument();
  });

  it("offers nothing to a read-only device", () => {
    renderSheet(WORKTREE, true);
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it("takes two taps, and the first attempt never forces", async () => {
    mockRemove.mockResolvedValue({ ok: true, path: "/repo/.worktrees/feature", forced: false });
    const { onRemoved } = renderSheet(WORKTREE);

    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(mockRemove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /remove worktree\?/i }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("w9", "w9", false, undefined));
    expect(onRemoved).toHaveBeenCalled();
  });

  it("re-arms as a discard only after the multiplexer refuses for being dirty", async () => {
    mockRemove.mockResolvedValueOnce({
      ok: false,
      error: "dirty",
      code: "worktree.dirty",
      detail: { reason: "contains modified or untracked files" },
    });
    renderSheet(WORKTREE);

    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove worktree\?/i }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("w9", "w9", false, undefined));

    mockRemove.mockResolvedValueOnce({ ok: true, path: "/repo/.worktrees/feature", forced: true });
    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /discard changes and remove\?/i }));
    await waitFor(() => expect(mockRemove).toHaveBeenLastCalledWith("w9", "w9", true, undefined));
  });
});
