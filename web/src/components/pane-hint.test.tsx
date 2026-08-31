import { render, screen } from "@testing-library/react";

import { AgentCard } from "./agent-card";
import { PaneHint } from "./pane-hint";
import { fixtureShellPanes } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

// The hint, present and absent — and the absent case is the one that matters. A pane carries no
// sentence on almost every install, so a component that rendered an empty box, a bullet or a stray
// icon would be a permanent decoration bought for a rare explanation.
//
// The wording itself is the BRIDGE's (bridge/beacon/hint.ts) and is deliberately not asserted here:
// this side renders what it was handed, verbatim, which is exactly what "does not interpret it"
// means.

const SENTENCE = "This pane may be running an agent. Install Collie's hooks on the host to identify it.";

const shell = (over: Partial<AgentView> = {}): AgentView => ({ ...fixtureShellPanes[0]!, ...over });

describe("PaneHint", () => {
  it("renders the sentence it was handed, verbatim", () => {
    render(<PaneHint hint={SENTENCE} />);
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
  });

  it("renders nothing at all without one", () => {
    const { container } = render(<PaneHint hint={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty sentence — no box, no icon", () => {
    const { container } = render(<PaneHint hint="" />);
    expect(container).toBeEmptyDOMElement();
  });

  // The operator's rule: a card row must not grow past one line for the hint. The sentence
  // truncates with an ellipsis instead of wrapping, so every row in a list keeps the same pitch.
  it("truncates the sentence instead of wrapping it", () => {
    render(<PaneHint hint={SENTENCE} />);
    expect(screen.getByText(SENTENCE)).toHaveClass("truncate");
  });
});

describe("AgentCard carries the hint", () => {
  it("shows it on a pane that has one", () => {
    render(<AgentCard agent={shell({ hint: SENTENCE })} onClick={() => {}} />);
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
  });

  it("shows nothing on a pane without one, and the row is otherwise unchanged", () => {
    render(<AgentCard agent={shell()} onClick={() => {}} />);
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
    // Still the same row: a shell pane, badged as one, whatever the hint did or did not say.
    expect(screen.getByText(/shell/i)).toBeInTheDocument();
  });
});
