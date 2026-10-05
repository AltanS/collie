import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FIXTURE_MACHINES_TS, fixtureMachineRows } from "@/test/machine-fixtures";

import { MachineLoad } from "./machine-load";

afterEach(cleanup);

const workshop = fixtureMachineRows.find((r) => r.id === "workshop")!;
const bluefin = fixtureMachineRows.find((r) => r.id === "bluefin")!;

// On a card the firing metric's number is red. On the machine page's Status view only the bar was, and
// the number kept the ordinary ink, so the same machine read two ways. Both now use `text-status-blocked`.
describe("MachineLoad, the Status view", () => {
  it("a firing CPU number takes the blocked ink, and the memory number beside it does not", () => {
    render(<MachineLoad row={workshop} ts={FIXTURE_MACHINES_TS} size="large" />);
    expect(screen.getByText("96%").className).toContain("text-status-blocked");
    // Memory is not firing on this machine: the number keeps its ink.
    expect(screen.getByText("3.1 / 8 GB").className).not.toContain("text-status-blocked");
  });

  it("a firing memory number takes it too", () => {
    render(<MachineLoad row={{ ...workshop, firing: ["mem"] }} ts={FIXTURE_MACHINES_TS} size="large" />);
    expect(screen.getByText("3.1 / 8 GB").className).toContain("text-status-blocked");
    expect(screen.getByText("96%").className).not.toContain("text-status-blocked");
  });

  it("nothing is red on a machine with no alert firing", () => {
    render(<MachineLoad row={bluefin} ts={FIXTURE_MACHINES_TS} size="large" />);
    expect(screen.getByText("34%").className).not.toContain("text-status-blocked");
  });

  it("still says it in words", () => {
    render(<MachineLoad row={workshop} ts={FIXTURE_MACHINES_TS} size="large" />);
    expect(screen.getByText("Alert firing: CPU")).toBeTruthy();
  });
});
