import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { AskAnswerCard, noteLine, type AskAnswerCardProps } from "./ask-answer-card";

function card(over: Partial<AskAnswerCardProps> = {}) {
  const onPick = vi.fn();
  const view = render(<AskAnswerCard kind="option" number={1} title="Keep both routes" answered={false} intent="keep" onPick={onPick} {...over} />);
  return { ...view, onPick, root: () => view.container.querySelector<HTMLElement>('[data-slot="ask-card"]')! };
}

describe("the answer card", () => {
  it("is a button with the title, its digit and the lines the agent sent", () => {
    const { root } = card({ does: "Older phones keep working.", cost: "Two code paths.", why: "Nothing is lost.", recommended: true });
    expect(screen.getByRole("button", { name: /Keep both routes/u })).toBeInTheDocument();
    expect(root().querySelector('[data-slot="ask-card-then"]')).toHaveTextContent("ThenOlder phones keep working.");
    expect(root().querySelector('[data-slot="ask-card-cost"]')).toHaveTextContent("CostTwo code paths.");
    expect(root().querySelector('[data-slot="ask-card-why"]')).toHaveTextContent("WhyNothing is lost.");
    expect(root().querySelector("span.tabular-nums")).toHaveTextContent("1");
  });

  it("picks on a tap", async () => {
    const { onPick } = card();
    await userEvent.click(screen.getByRole("button"));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("draws no line the agent did not send", () => {
    const { root } = card();
    expect(root().querySelector('[data-slot="ask-card-then"]')).toBeNull();
    expect(root().querySelector('[data-slot="ask-card-cost"]')).toBeNull();
    expect(root().querySelector('[data-slot="ask-card-why"]')).toBeNull();
  });

  it("reads the agent's words in the content face", () => {
    const { root } = card({ does: "Older phones keep working." });
    expect(root().querySelector('[data-slot="ask-card-title"]')).toHaveClass("font-content");
    expect(root().querySelector('[data-slot="ask-card-then"] .font-content')).not.toBeNull();
  });

  it("keeps its box when it becomes the answer: one pixel border, the same parts, only the badge word and the foot change", () => {
    const rest = card({ recommended: true });
    expect(rest.root().querySelector("button")!.className).not.toMatch(/\bborder-(2|4)\b/u);
    expect(rest.root().querySelector('[data-slot="ask-badge-recommended"]')).not.toBeNull();
    expect(rest.root().querySelector('[data-slot="ask-badge-answered"]')).not.toBeNull();
    expect(rest.root().querySelector('[data-slot="ask-card-foot"]')).toHaveClass("h-4");
    rest.unmount();

    const done = card({ recommended: true, answered: true, note: "for now\n  and later" });
    const button = done.root().querySelector("button")!;
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.className).not.toMatch(/\bborder-(2|4)\b/u);
    expect(done.root().querySelector('[data-slot="ask-badge-recommended"]')).not.toBeNull();
    expect(done.root().querySelector('[data-slot="ask-badge-answered"]')).not.toBeNull();
    expect(done.root().querySelector('[data-slot="ask-card-foot"]')).toHaveTextContent("Note: for now and later");
    expect(done.root().querySelector('[data-slot="ask-card-foot"]')).toHaveClass("h-4");
  });

  it("marks the picked card the way the answered one is marked, before it is answered", () => {
    const { root } = card({ picked: true });
    expect(root()).toHaveAttribute("data-state", "picked");
    expect(root().querySelector("button")).toHaveClass("border-primary");
  });

  it("draws Your own answer with a dashed edge and its prompt, then the text it holds", () => {
    const { root, rerender, onPick } = card({ kind: "own", intent: "own", number: 3, title: "Your own answer", line: "Write what the agent should do instead." });
    expect(root().querySelector("button")).toHaveClass("border-dashed");
    expect(root()).toHaveTextContent("Write what the agent should do instead.");
    rerender(<AskAnswerCard kind="own" number={3} title="Your own answer" intent="own" line="Write what the agent should do instead." answered text="Ask me again" onPick={onPick} />);
    expect(root().querySelector('[data-slot="ask-card-text"]')).toHaveTextContent("Ask me again");
  });

  it("folds whitespace in a note", () => {
    expect(noteLine("  a\n\n b  ")).toBe("a b");
  });
});
