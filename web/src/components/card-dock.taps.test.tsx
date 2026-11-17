import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CardDock } from "@/components/card-dock";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { fixtureRows } from "@/test/surface-corpus";

// M102 spec 11, "No tap vanishes", the ask cards: a card whose options are off for the whole pane (a
// read-only device, a pane that is gone) says why, in one line on the card. A disabled option takes no tap,
// so the words stand on the card all the while the options are off, and go when they come back.

afterEach(() => cleanup());

const MENU = () => claudeBuildBlocks(fixtureRows("claude--menu-model-picker.txt"));

describe("CardDock taps", () => {
  it("no tap vanishes: a card off for a read-only device says so on the card", () => {
    render(<CardDock blocks={MENU()} onMenuAction={vi.fn()} promptDisabled promptDisabledReason="Read-only, not authorised" />);
    expect(screen.getByText("Read-only, not authorised")).toBeInTheDocument();
    // The options are off, and the reason stands beside them.
    expect(screen.getAllByRole("button").filter((button) => button.hasAttribute("disabled")).length).toBeGreaterThan(0);
  });

  it("no tap vanishes: a card for a gone pane says the pane is gone", () => {
    render(<CardDock blocks={MENU()} onMenuAction={vi.fn()} promptDisabled promptDisabledReason="Pane is gone" />);
    expect(screen.getByText("Pane is gone")).toBeInTheDocument();
  });

  it("no tap vanishes: a live card draws no reason line", () => {
    render(<CardDock blocks={MENU()} onMenuAction={vi.fn()} promptDisabledReason="Pane is gone" />);
    expect(screen.queryByText("Pane is gone")).toBeNull();
  });

  it("no tap vanishes: a dock with no dialog card draws no reason line", () => {
    render(<CardDock blocks={[]} promptDisabled promptDisabledReason="Pane is gone" />);
    expect(screen.queryByText("Pane is gone")).toBeNull();
  });
});
