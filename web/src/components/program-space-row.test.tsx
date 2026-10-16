import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ServerSummary, SessionSummary } from "@/lib/types";
import { ProgramSection } from "./program-section";
import { ProgramSpaceRow } from "./program-space-row";

// A PROGRAM'S ROW AND ITS SECTION (M55 spec 13): the row's states, its two counts, and the section that
// draws nothing with no program and names a crew member's machine.

function program(name: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    name,
    isPrimary: false,
    reachable: true,
    agents: 0,
    working: 0,
    blocked: 0,
    kind: "program",
    mux: "pi-durable",
    caps: { paneGrid: false },
    where: "local",
    state: "ready",
    experimental: true,
    ...over,
  };
}

function renderRow(session: SessionSummary, member?: string) {
  const onOpen = vi.fn();
  const { container } = render(<ProgramSpaceRow session={session} member={member} onOpen={onOpen} />);
  const row = container.querySelector<HTMLElement>('[data-slot="program-space"]')!;
  const slot = (name: string) => row.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  return { row, slot, onOpen };
}

describe("ProgramSpaceRow: the row's states", () => {
  it("a ready program: its name, the badge, its runtime and place, and the open count alone when nothing waits", () => {
    const { row, slot } = renderRow(program("desk", { agents: 3 }));
    expect(slot("program-space-name")?.textContent).toBe("desk");
    expect(within(row).getByText("Experimental")).toBeInTheDocument();
    expect(slot("program-space-line")?.textContent).toBe("pi-durable, local");
    expect(slot("program-space-open")?.textContent).toBe("33 open conversations");
    expect(within(slot("program-space-open")!).getByText("3 open conversations")).toHaveClass("sr-only");
    // Zero waiting is hidden, not drawn as a 0.
    expect(slot("program-space-waiting")).toBeNull();
    expect(slot("program-space-state")).toBeNull();
    expect(within(row).getByText("Ready")).toHaveClass("sr-only");
  });

  it("a ready program with questions waiting: the waiting count in the needs-you ink, beside the open count", () => {
    const { slot } = renderRow(program("desk", { agents: 3, blocked: 2 }));
    const waiting = slot("program-space-waiting")!;
    expect(waiting).toHaveClass("text-status-blocked");
    expect(within(waiting).getByText("2")).toBeInTheDocument();
    expect(within(waiting).getByText("2 conversations wait on you")).toHaveClass("sr-only");
    // The open count stays last, so it holds the right edge whether or not something waits.
    const counts = slot("program-space-counts")!;
    expect(counts.lastElementChild).toBe(slot("program-space-open"));
  });

  it("one waiting conversation reads in the singular", () => {
    const { slot } = renderRow(program("desk", { agents: 1, blocked: 1 }));
    expect(within(slot("program-space-waiting")!).getByText("1 conversation waits on you")).toBeInTheDocument();
    expect(within(slot("program-space-open")!).getByText("1 open conversation")).toBeInTheDocument();
  });

  it("a starting program says Starting instead of counts", () => {
    const { row, slot } = renderRow(program("desk", { state: "starting", agents: 2, blocked: 1 }));
    expect(row.dataset.state).toBe("starting");
    expect(slot("program-space-state")?.textContent).toBe("Starting");
    expect(slot("program-space-state")).not.toHaveClass("text-muted-foreground");
    expect(slot("program-space-counts")).toBeNull();
  });

  it("an unreachable program says Unreachable in the muted ink, and the row still opens", async () => {
    const session = program("billing", { mux: "acme-billing", where: "remote", state: "unreachable", reachable: false });
    const { row, slot, onOpen } = renderRow(session);
    expect(row.dataset.state).toBe("unreachable");
    expect(slot("program-space-state")?.textContent).toBe("Unreachable");
    expect(slot("program-space-state")).toHaveClass("text-muted-foreground");
    expect(slot("program-space-counts")).toBeNull();
    expect(slot("program-space-line")?.textContent).toBe("acme-billing, remote");
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(session);
  });

  it("a program refused for its wire version says Version mismatch in the same muted ink, and the row still opens", async () => {
    const session = program("desk", {
      state: "unreachable",
      reachable: false,
      notice: "The durable agent speaks wire v3, this Collie speaks v1. Update Collie, or the agent's SDK.",
    });
    const { row, slot, onOpen } = renderRow(session);
    expect(row.dataset.state).toBe("unreachable");
    expect(slot("program-space-state")?.textContent).toBe("Version mismatch");
    expect(slot("program-space-state")).toHaveClass("text-muted-foreground");
    expect(slot("program-space-counts")).toBeNull();
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(session);
  });

  it("a card with no state word reads its counts only while reachable", () => {
    const { slot } = renderRow(program("desk", { state: undefined, reachable: false, agents: 4, blocked: 2 }));
    expect(slot("program-space-state")?.textContent).toBe("Unreachable");
    expect(slot("program-space-counts")).toBeNull();
  });

  it("a crew member's program names the member after its place", () => {
    const { slot } = renderRow(program("support"), "minibuch");
    expect(slot("program-space-line")?.textContent).toBe("pi-durable, local, minibuch");
  });

  it("the tap hands the whole session, host included", async () => {
    const session = program("support", { host: "minibuch" });
    const { row, onOpen } = renderRow(session);
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(session);
  });
});

describe("ProgramSection", () => {
  it("draws nothing with no program session", () => {
    const { container } = render(<ProgramSection programs={[]} onOpen={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("draws a Durable agents heading with the count and one row per program, in order", () => {
    const { container } = render(<ProgramSection programs={[program("desk"), program("billing")]} onOpen={() => {}} />);
    const section = container.querySelector<HTMLElement>('[data-slot="program-section"]')!;
    expect(within(section).getByRole("heading").textContent).toContain("Durable agents");
    expect(within(section).getByRole("heading").textContent).toContain("2");
    const names = [...section.querySelectorAll('[data-slot="program-space-name"]')].map((n) => n.textContent);
    expect(names).toEqual(["desk", "billing"]);
  });

  it("in a crew, names the member on a member's program and no machine on the lead's own", () => {
    const servers: ServerSummary[] = [
      { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
      { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
    ];
    const { container } = render(
      <ProgramSection
        programs={[program("desk", { host: "bluefin" }), program("support", { host: "minibuch", where: "remote" })]}
        servers={servers}
        onOpen={() => {}}
      />,
    );
    const lines = [...container.querySelectorAll('[data-slot="program-space-line"]')].map((n) => n.textContent);
    expect(lines).toEqual(["pi-durable, local", "pi-durable, remote, minibuch"]);
  });
});
