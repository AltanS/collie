import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PickPage } from "../pick-page";
import round from "./worktree-folder";

afterEach(() => cleanup());
beforeEach(() => window.history.replaceState(null, "", "/pick.html?round=worktree-folder"));

function open(caseId: string): void {
  window.history.replaceState(null, "", `/pick.html?round=worktree-folder&case=${caseId}`);
  render(<PickPage {...round} />);
}

const frame = (n: number): HTMLElement => document.querySelector<HTMLElement>(`[data-option="${n}"]`)!;

describe("the Worktree folder round", () => {
  it("has two frames and one case switch with the six cases", () => {
    open("default");
    expect([...document.querySelectorAll("[data-option]")]).toHaveLength(2);
    const buttons = within(screen.getByRole("group", { name: "Case" })).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Default", "Set", "Broken", "Crew", "Editing", "Read-only"]);
  });

  it("shows Default and Herdr's folder in both frames while nothing is set", async () => {
    open("default");
    expect(await within(frame(1)).findByText("Default")).toBeInTheDocument();
    expect(within(frame(2)).getByTestId("new-page-target")).toHaveTextContent("~/.herdr/worktrees/collie/fix-login");
  });

  it("shows a saved folder in both frames", async () => {
    open("set");
    expect(await within(frame(1)).findByText("Your folder")).toBeInTheDocument();
    expect(within(frame(2)).getByTestId("new-page-target")).toHaveTextContent("~/trees/collie/fix-login");
  });

  it("shows the rule a broken folder fails in both frames", async () => {
    open("broken");
    expect(await within(frame(1)).findByText("That folder is not there.")).toBeInTheDocument();
    expect(within(frame(2)).getByTestId("new-page-target")).toHaveTextContent("That folder is not there.");
  });

  it("gives each machine of a crew its own value, and the sheet reads the member's", async () => {
    open("crew");
    await within(frame(1)).findAllByTestId("worktree-folder-value");
    const rows = within(frame(1)).getAllByTestId("worktree-folder-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("/home/op/trees");
    expect(rows[1]).toHaveTextContent("/home/mate/work/trees");
    expect(within(frame(2)).getByTestId("sheet-machine")).toHaveTextContent("workshop");
    expect(within(frame(2)).getByTestId("new-page-target")).toHaveTextContent("~/work/trees/collie/fix-login");
  });

  it("opens the editor with the picker in the Editing case", async () => {
    open("editing");
    expect(await within(frame(1)).findByLabelText("Folder on this machine")).toBeInTheDocument();
    expect(within(frame(1)).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("offers no way to change the folder on a read-only device", async () => {
    open("readonly");
    const change = await within(frame(1)).findByRole("button", { name: "Change" });
    expect(change).toBeDisabled();
    expect(within(frame(1)).getByText(/can look at the folder but not change it/u)).toBeInTheDocument();
  });

  it("keeps the case switch driving both frames", async () => {
    open("default");
    fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name: "Set" }));
    expect(await within(frame(1)).findByText("Your folder")).toBeInTheDocument();
    expect(within(frame(2)).getByTestId("new-page-target")).toHaveTextContent("~/trees/collie/fix-login");
  });
});
