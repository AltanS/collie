import { render, screen } from "@testing-library/react";

import { PackProvider } from "@/components/pack-provider";
import { SessionChip } from "@/components/session-chip";
import type { SessionSummary } from "@/lib/types";

const registry: SessionSummary[] = [
  { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
  { name: "work", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 0 },
];

const mount = (session: string | undefined, sessions: SessionSummary[] = registry) =>
  render(
    <PackProvider servers={undefined} sessions={sessions}>
      <SessionChip session={session} />
    </PackProvider>,
  );

// THE HIDE RULE IS THE COMPONENT'S OWN, which is what lets callers mount it unconditionally. If each
// caller had to ask "is this row somewhere unexpected?" first, one surface would eventually answer
// wrong — and the surface that matters is a row you are about to open and type into.
describe("SessionChip — when it says nothing", () => {
  it("renders nothing when the pane names no session", () => {
    // Every un-widened read, which is every read the app made before the "All sessions" view.
    const { container } = mount(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for the PRIMARY session", () => {
    // An absent `?s=` already means this one. Marking it would put a chip on every row of the
    // widened list and say nothing with it; the rows worth marking are the unexpected ones.
    const { container } = mount("default");
    expect(container).toBeEmptyDOMElement();
  });

});

describe("SessionChip — with no registry to compare against", () => {
  // NEVER GUESS, which is the same posture `paneScope` takes one layer down: without a registry the
  // app cannot know that this row is the primary session, so it says what it DOES know — the name.
  // Being wrong here is noise; the alternative, assuming primary and going quiet, would hide the one
  // fact that tells you a row is somewhere unexpected.
  //
  // It is also nearly unreachable in the app: a pane carries a session only on a widened body, and a
  // widened body always carries the registry that produced it. This is the harness case.
  it("mounts outside a provider without throwing, and names the session", () => {
    render(<SessionChip session="work" />);
    expect(screen.getByLabelText("In session: work")).toBeInTheDocument();
  });

  it("does the same with an empty registry", () => {
    mount("work", []);
    expect(screen.getByLabelText("In session: work")).toBeInTheDocument();
  });

  it("still says nothing when there is no session to name", () => {
    const { container } = render(<SessionChip session={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SessionChip — when it does", () => {
  it("names a non-primary session, and says what the name MEANS", () => {
    mount("work");
    // The inner text is aria-hidden, so the whole tag carries one label. A bare session name would
    // reach a screen reader as a noun with no verb.
    expect(screen.getByLabelText("In session: work")).toHaveTextContent("work");
  });

  it("is not a control — a mis-tap here means typing into the wrong terminal", () => {
    mount("work");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
