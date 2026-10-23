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

describe("a collapsed paste chip", () => {
  const paste: ComposerAttachment = {
    n: 1,
    path: "line 1\nline 2\nline 3\nline 4\nline 5",
    name: "line 1",
    kind: "paste",
  };

  it("shows line and character counts and calls onSelect when tapped", () => {
    let selected = false;
    render(
      <ul>
        <AttachmentChip
          attachment={paste}
          onRemove={() => {}}
          onSelect={() => {
            selected = true;
          }}
        />
      </ul>,
    );
    expect(chip()).toHaveTextContent("5 lines · 34 chars");
    expect(chip()).toHaveTextContent("line 1");
    screen.getByRole("button", { name: "Edit pasted text #1" }).click();
    expect(selected).toBe(true);
  });

  it("says 1 line, not 1 lines, for a one-line paste", () => {
    const oneLine: ComposerAttachment = { ...paste, path: "x".repeat(300), name: "xxxx" };
    render(
      <ul>
        <AttachmentChip attachment={oneLine} onRemove={() => {}} onSelect={() => {}} />
      </ul>,
    );
    expect(chip()).toHaveTextContent("1 line · 300 chars");
    expect(chip()).not.toHaveTextContent("1 lines");
  });

  it("reaches a 44px hit area inside the strip's padding", () => {
    render(
      <ul>
        <AttachmentChip attachment={paste} onRemove={() => {}} onSelect={() => {}} />
      </ul>,
    );
    const face = screen.getByRole("button", { name: "Edit pasted text #1" });
    // h-10 (40px) with a 1px border: the padding box is 38px, and 4 + 2 of reach make 44.
    for (const cls of ["relative", "h-10", "min-w-11", "before:absolute", "before:inset-x-0", "before:-top-[4px]", "before:-bottom-[2px]", "before:content-['']"]) {
      expect(face).toHaveClass(cls);
    }
  });
});
