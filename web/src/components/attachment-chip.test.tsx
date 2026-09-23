import { render, screen } from "@testing-library/react";

import { AttachmentChip, type ComposerAttachment } from "./attachment-chip";

// The chip's one state beyond its face (ADR 0060, point 7): a chip whose marker the operator
// deleted from the text says, before Send, that its path will go in front of the words. The claim
// worth pinning is that the cue exists only in that state and names the file it is about.

const file: ComposerAttachment = { n: 2, path: "/up/notes.md", name: "notes.md", kind: "file" };

const chip = () => screen.getByRole("listitem");

function draw(inFront?: boolean) {
  render(
    <ul>
      <AttachmentChip attachment={file} onRemove={() => {}} inFront={inFront} />
    </ul>,
  );
}

describe("a chip whose marker is still in the text", () => {
  it("shows no in-front cue", () => {
    draw();
    expect(chip()).not.toHaveAttribute("data-in-front");
    expect(chip()).toHaveAttribute("title", "notes.md");
    expect(screen.queryByText(/Send puts/)).toBeNull();
  });
});

describe("a chip whose marker is gone", () => {
  it("says, before Send, that the file goes in front", () => {
    draw(true);
    const note = "Its marker is gone from your text, so Send puts notes.md in front.";
    expect(chip()).toHaveAttribute("data-in-front");
    expect(chip()).toHaveAttribute("title", note);
    expect(screen.getByText(note)).toHaveClass("sr-only");
  });

  it("keeps its number and its x", () => {
    draw(true);
    expect(chip()).toHaveTextContent("#2");
    expect(screen.getByRole("button", { name: "Remove notes.md" })).toBeInTheDocument();
  });
});
