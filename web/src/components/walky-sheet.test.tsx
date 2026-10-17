import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WalkyLogProvider } from "@/components/walky-log";
import { fixtureWalkyAgent, fixtureWalkyOperator } from "@/test/handlers";
import type { WalkyRow } from "@/lib/walky";

import { WalkySheet } from "./walky-sheet";

// The pane's Messages sheet (M62 spec 05): newest first, each row with its kind, sender, age, body and
// receipt state, and a Reply on an agent message only.

function sheet(rows: readonly WalkyRow[] | null, over: Partial<React.ComponentProps<typeof WalkySheet>> = {}) {
  const props: React.ComponentProps<typeof WalkySheet> = { open: true, onClose: vi.fn(), onReply: vi.fn(), canReply: true, ...over };
  render(
    <WalkyLogProvider rows={rows}>
      <WalkySheet {...props} />
    </WalkyLogProvider>,
  );
  return props;
}

const bodies = () => [...document.querySelectorAll('[data-slot="walky-list-row"]')].map((el) => el.getAttribute("data-kind"));

describe("WalkySheet", () => {
  it("lists the messages newest first, whatever order they arrived in", () => {
    sheet([fixtureWalkyAgent, fixtureWalkyOperator]);
    // The operator message is a minute newer in the fixtures.
    expect(bodies()).toEqual(["operator", "agent"]);
  });

  it("shows kind, sender, body and the receipt state with who verified it", () => {
    sheet([fixtureWalkyAgent, fixtureWalkyOperator]);
    const agentRow = screen.getByText("Tests are green on fix-465. You can merge.").closest('[data-slot="walky-list-row"]');
    if (!(agentRow instanceof HTMLElement)) throw new Error("no row for the agent message");
    const inside = within(agentRow);
    expect(inside.getByText("agent")).toBeInTheDocument();
    expect(inside.getByText("collie-workspace#fix-465")).toBeInTheDocument();
    expect(inside.getByText("typed into the pane")).toBeInTheDocument();
    expect(inside.getByText(/signed by bluefin/)).toBeInTheDocument();
    // The other row was not typed, and says why.
    expect(screen.getByText("waiting in the inbox, not typed: dialog open")).toBeInTheDocument();
  });

  it("offers Reply on the agent message only, and hands the row to the caller", async () => {
    const user = userEvent.setup();
    const props = sheet([fixtureWalkyAgent, fixtureWalkyOperator]);
    const replies = screen.getAllByRole("button", { name: /^Reply/ });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toHaveAccessibleName("Reply to collie-workspace#fix-465");
    await user.click(replies[0]!);
    expect(props.onReply).toHaveBeenCalledExactlyOnceWith(fixtureWalkyAgent);
  });

  it("offers no Reply to a device that may not write", () => {
    sheet([fixtureWalkyAgent], { canReply: false });
    expect(screen.queryByRole("button", { name: /^Reply/ })).toBeNull();
  });

  it("offers no Reply to an agent message with no address", () => {
    sheet([{ ...fixtureWalkyAgent, from: { ...fixtureWalkyAgent.from, address: null } }]);
    expect(screen.queryByRole("button", { name: /^Reply/ })).toBeNull();
  });

  it("says so when there are none, and when the machine keeps none", () => {
    sheet([]);
    expect(screen.getByText("No messages for this pane yet.")).toBeInTheDocument();
  });

  it("says the machine does not keep messages when the list could not be read", () => {
    sheet(null);
    expect(screen.getByText("This machine does not keep messages yet.")).toBeInTheDocument();
  });
});
