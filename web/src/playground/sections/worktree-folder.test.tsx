import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorktreeFolderSection } from "./worktree-folder";

afterEach(() => cleanup());

const card = (state: string): HTMLElement => document.querySelector<HTMLElement>(`[data-state="${state}"]`)!;
const pick = (group: string, label: string): void => {
  fireEvent.click(within(screen.getByRole("group", { name: group })).getByRole("button", { name: label }));
};

describe("the Worktree folder entry", () => {
  it("shows Default and Herdr's folder in both cards while nothing is set", async () => {
    render(<WorktreeFolderSection />);
    expect(await within(card("worktree-folder-setting")).findByText("Default")).toBeInTheDocument();
    expect(within(card("new-sheet-default-folder")).getByTestId("new-page-target")).toHaveTextContent("~/.herdr/worktrees/collie/fix-login");
  });

  it("shows a crew with a folder per machine, and the sheet on a member's repo", async () => {
    render(<WorktreeFolderSection />);
    pick("Worktree folder case", "Crew");
    pick("New sheet case", "Crew");
    await within(card("worktree-folder-setting")).findAllByTestId("worktree-folder-value");
    const rows = within(card("worktree-folder-setting")).getAllByTestId("worktree-folder-row");
    expect(rows[0]).toHaveTextContent("/home/op/trees");
    expect(rows[1]).toHaveTextContent("/home/mate/work/trees");
    expect(within(card("new-sheet-default-folder")).getByTestId("sheet-machine")).toHaveTextContent("workshop");
    expect(within(card("new-sheet-default-folder")).getByTestId("new-page-target")).toHaveTextContent("~/work/trees/collie/fix-login");
  });

  it("opens the editor in Editing, refuses a change in Read-only, and names the rule in Broken", async () => {
    render(<WorktreeFolderSection />);
    pick("Worktree folder case", "Editing");
    expect(await within(card("worktree-folder-setting")).findByLabelText("Folder on this machine")).toBeInTheDocument();
    pick("Worktree folder case", "Read-only");
    expect(await within(card("worktree-folder-setting")).findByRole("button", { name: "Change" })).toBeDisabled();
    pick("Worktree folder case", "Broken");
    expect(await within(card("worktree-folder-setting")).findByText("That folder is not there.")).toBeInTheDocument();
    pick("New sheet case", "Broken");
    expect(within(card("new-sheet-default-folder")).getByTestId("new-page-target")).toHaveTextContent("That folder is not there.");
  });
});
