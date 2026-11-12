import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { FoldPanel, MoreToggle, NoteToggle } from "./fold-toggle";

// More and Add a note (M96): a quiet toggle that says whether its part is open, points at it only while
// it is drawn, and opens it through Collapse.

function MoreFixture() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <MoreToggle data-slot="more" open={open} onToggle={() => setOpen((o) => !o)} controls="body" more="More" less="Less" />
      <FoldPanel id="body" open={open} data-slot="body">
        The body.
      </FoldPanel>
    </div>
  );
}

function NoteFixture({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <NoteToggle data-slot="note" open={open} onToggle={() => setOpen((o) => !o)} controls="note-panel" label="Add a note" disabled={disabled} />
      <FoldPanel id="note-panel" open={open}>
        <textarea aria-label="Your answer" />
      </FoldPanel>
    </div>
  );
}

describe("More", () => {
  it("opens its part, says so, and points at it only while it is drawn", () => {
    const { container } = render(<MoreFixture />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-slot="more"]')!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(container.querySelector('[data-slot="body"]')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "body");
    expect(container.querySelector("#body")).toHaveTextContent("The body.");
  });

  it("keeps both words in one slot, so the switch moves nothing", () => {
    const { container } = render(<MoreFixture />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-slot="more"]')!;
    const before = toggle.textContent;
    fireEvent.click(toggle);
    // Both words are always drawn; the open state only changes which one shows.
    expect(toggle.textContent).toBe(before);
    expect(toggle.textContent).toContain("More");
    expect(toggle.textContent).toContain("Less");
  });

  it("is 44px tall, the tap floor", () => {
    const { container } = render(<MoreFixture />);
    expect(container.querySelector('[data-slot="more"]')?.className).toContain("h-11");
  });
});

describe("Add a note", () => {
  it("offers the note with its glyph, and opens the field", () => {
    const { container, getByRole } = render(<NoteFixture />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-slot="note"]')!;
    expect(toggle).toHaveTextContent("Add a note");
    expect(toggle.querySelector('[data-icon="add-note"]')).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(getByRole("textbox", { name: "Your answer" })).toBeInTheDocument();
  });

  it("does nothing while disabled", () => {
    const { container } = render(<NoteFixture disabled />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-slot="note"]')!;
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(container.querySelector("textarea")).toBeNull();
  });
});
