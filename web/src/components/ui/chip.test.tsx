import { render } from "@testing-library/react";
import { Server } from "lucide-react";

import { Chip } from "./chip";

// The strip pill's two optional slots: a leading glyph, and a name that says the chip's act.

const glyph = <Server aria-hidden className="size-3.5" />;

describe("Chip — the leading glyph", () => {
  it("draws the glyph first, in every state, so a state change never moves the label", () => {
    const layouts = [
      { active: false },
      { active: true },
      { active: false, ring: true },
      { active: false, dimmed: true },
    ].map((state) => {
      const { container, unmount } = render(
        <Chip label="devbox" glyph={glyph} status="needs" onClick={() => {}} {...state} />,
      );
      const button = container.querySelector("button")!;
      const layout = {
        first: button.firstElementChild?.tagName.toLowerCase(),
        // The visible children only: the dimmed state's sr-only word is not drawn.
        drawn: [...button.children].filter((c) => !c.classList.contains("sr-only")).length,
        text: button.textContent?.replace("hidden", ""),
      };
      unmount();
      return layout;
    });
    expect(layouts[0]!.first).toBe("svg");
    for (const layout of layouts) expect(layout).toEqual(layouts[0]);
  });

  it("renders exactly as before when no glyph and no name are given", () => {
    const { container } = render(<Chip label="collie" active={false} status="needs" onClick={() => {}} />);
    const button = container.querySelector("button")!;
    expect(button).not.toHaveAttribute("aria-label");
    expect(button).not.toHaveAttribute("aria-describedby");
    // The status word runs straight into the label, as it always has (agent-list.test.tsx's chips).
    expect(button).toHaveAccessibleName("needs youcollie");
  });
});

describe("Chip — a name that says the act", () => {
  it("names the chip by its act and keeps the status as the description", () => {
    const { container } = render(
      <Chip
        label="devbox"
        glyph={glyph}
        ariaLabel="Show devbox's panes"
        active={false}
        dimmed
        status="needs"
        onClick={() => {}}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button).toHaveAccessibleName("Show devbox's panes");
    expect(button).toHaveAccessibleDescription("needs you");
    // The label is still what the eye reads.
    expect(button).toHaveTextContent("devbox");
  });

  it("says an unseen pane in words too, where the mark alone would have been lost", () => {
    const { container } = render(
      <Chip label="devbox" ariaLabel="Show devbox's panes" active={false} status="ready" onClick={() => {}} />,
    );
    expect(container.querySelector("button")).toHaveAccessibleDescription("unseen");
  });

  it("has no description when there is no status to say", () => {
    const { container } = render(
      <Chip label="devbox" ariaLabel="Show devbox's panes" active={false} onClick={() => {}} />,
    );
    expect(container.querySelector("button")).not.toHaveAttribute("aria-describedby");
  });
});
