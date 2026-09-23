import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkspaceChangeCount } from "@/lib/workspace-changes";

import { WorkspaceChangesList, type WorkspaceChangesRow } from "./workspace-changes-list";

const rows: WorkspaceChangesRow[] = [{ key: "a", label: "webapp", workspaceId: "w1", scope: {} }];
const at = (count?: WorkspaceChangeCount) => new Map(count ? [["a", count]] : []);
const list = (counts: Map<string, WorkspaceChangeCount>) => <WorkspaceChangesList rows={rows} counts={counts} onOpen={() => {}} />;

function line(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('[data-slot="count-line"]');
  expect(el).not.toBeNull();
  return el!;
}

describe("WorkspaceChangesList count line", () => {
  it("holds a skeleton until the first answer, then fades the answer in over it", () => {
    const { container, rerender } = render(list(at()));
    expect(line(container).dataset.state).toBe("loading");
    expect(container.querySelector(".count-skeleton--done")).toBeNull();

    rerender(list(at({ kind: "changed", files: 5, added: 10, removed: 2 })));
    expect(line(container).dataset.state).toBe("arrive");
    expect(container.querySelector(".count-skeleton--done")).not.toBeNull();
    expect(container.querySelector(".count-arrive")?.textContent).toContain("5 files");
  });

  it("changes a value in place, never back through the skeleton", () => {
    const { container, rerender } = render(list(at({ kind: "changed", files: 5, added: 10, removed: 2 })));
    rerender(list(at({ kind: "changed", files: 6, added: 12, removed: 2 })));
    expect(line(container).dataset.state).toBe("update");
    expect(container.querySelector(".count-skeleton--done")).not.toBeNull();
    expect(container.querySelector(".count-update")?.textContent).toContain("6 files");
  });

  it("shows a kept answer at once, without motion, and the same answer again changes nothing", () => {
    const { container, rerender } = render(list(at({ kind: "clean" })));
    expect(line(container).dataset.state).toBe("still");
    const before = container.innerHTML;
    rerender(list(at({ kind: "clean" })));
    expect(container.innerHTML).toBe(before);
    expect(container.querySelector(".count-arrive, .count-update")).toBeNull();
  });
});
