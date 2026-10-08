import { render, within } from "@testing-library/react";

import { BranchLabel } from "./branch-label";

describe("BranchLabel", () => {
  it("draws a short name whole, mono, and names it in words for a screen reader", () => {
    const { container } = render(<BranchLabel head={{ kind: "branch", name: "main" }} />);
    const label = container.querySelector<HTMLElement>('[data-slot="branch-label"]')!;
    expect(label).toHaveClass("font-mono");
    expect(label).toHaveAttribute("title", "main");
    expect(within(label).getByText("Branch main")).toHaveClass("sr-only");
    // The drawn text is one span, so it truncates the ordinary way.
    const drawn = label.querySelector('[aria-hidden="true"].flex')!;
    expect(drawn.children).toHaveLength(1);
    expect(drawn).toHaveTextContent(/^main$/);
  });

  it("gives way in the middle on a long name and keeps the tail whole", () => {
    const name = "perf/dashboard-poll-cadence-and-backoff";
    const { container } = render(<BranchLabel head={{ kind: "branch", name }} />);
    const drawn = container.querySelector('[data-slot="branch-label"] [aria-hidden="true"].flex')!;
    const [head, tail] = Array.from(drawn.children);
    expect(head).toHaveClass("truncate");
    expect(tail).toHaveClass("shrink-0");
    expect(tail).toHaveTextContent(/^-backoff$/);
    expect(`${head!.textContent}${tail!.textContent}`).toBe(name);
    // The screen reader still hears the whole name, whatever the eye sees.
    expect(within(container).getByText(`Branch ${name}`)).toBeInTheDocument();
  });

  it("reads a detached head as `detached @` and the seven-character sha", () => {
    const sha = "abc1234def5678abc1234def5678abc1234def56";
    const { container } = render(<BranchLabel head={{ kind: "detached", sha }} />);
    const label = container.querySelector<HTMLElement>('[data-slot="branch-label"]')!;
    expect(within(label).getByText("detached @abc1234")).toBeInTheDocument();
    expect(within(label).getByText("Detached at abc1234")).toHaveClass("sr-only");
    expect(label).toHaveAttribute("title", sha);
  });
});
