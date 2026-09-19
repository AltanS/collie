import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Regression coverage for the extracted typed-block seam (typed-blocks.tsx): the presentation half of
// AnsiOutput's non-raw tail block, reusable without rendering raw terminal rows. Every block is
// derived through the REAL pipeline (parseAnsi → splitLines → claudeBuildBlocks) from the same
// fixtures the mirror tests use, so a grammar regression fails here too. The action handlers are
// injected fakes: this component never touches the network, and the guarded choreography (fresh pane
// rederivation, prompt binding, dialog-guard) lives with its callers — these tests pin the BINDING,
// not the guards.

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { AnsiOutput } from "./ansi-output";
import { TypedBlocks, type TypedBlocksProps } from "./typed-blocks";

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
function fixtureBlocks(name: string) {
  return claudeBuildBlocks(splitLines(parseAnsi(fixtureText(name))));
}
function blocksFromText(text: string) {
  return claudeBuildBlocks(splitLines(parseAnsi(text)));
}

describe("TypedBlocks — raw-only screens render no controls", () => {
  it("renders nothing when the grammar lifted no typed block", () => {
    const { container } = render(<TypedBlocks blocks={fixtureBlocks("claude--working.txt")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for another plain screen", () => {
    const { container } = render(<TypedBlocks blocks={fixtureBlocks("claude--done.txt")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a screen no grammar recognises", () => {
    // A made-up dialog shape: if a heuristic ever inferred controls for it, this fails.
    const { container } = render(
      <TypedBlocks blocks={blocksFromText("PICK ONE:\n  [1] yes   [2] no\n❯ 1")} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty block list", () => {
    const { container } = render(<TypedBlocks blocks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("TypedBlocks — each supported typed-block family renders from its own fixture", () => {
  it("prompt-select: the options are buttons, labelled by the question", () => {
    render(<TypedBlocks blocks={fixtureBlocks("claude--select-menu.txt")} />);
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("wizard: the stepper question renders with answer buttons", () => {
    render(<TypedBlocks blocks={fixtureBlocks("claude--wizard-q1.txt")} />);
    expect(
      screen.getByRole("group", { name: "Which focus area should we work on?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Parser/ })).toBeInTheDocument();
  });

  it("preview-select: the preview dialog renders with option buttons", () => {
    render(<TypedBlocks blocks={fixtureBlocks("claude--select-preview.txt")} />);
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("multi-select: the checkbox form renders checkboxes", () => {
    render(<TypedBlocks blocks={fixtureBlocks("claude--select-multiselect-checked.txt")} />);
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);
  });

  it("menu: the generic picker renders its footer's actions and keeps its region readable", () => {
    render(<TypedBlocks blocks={fixtureBlocks("claude--menu-model-picker.txt")} />);
    expect(screen.getByRole("button", { name: "Use this session only" })).toBeInTheDocument();
    expect(screen.getByText(/Most capable for your hardest/)).toBeInTheDocument();
  });

  it("autocomplete: the completion popup renders with no action buttons", () => {
    render(<TypedBlocks blocks={fixtureBlocks("claude--autocomplete-slash-short.txt")} />);
    for (const name of ["/rename", "/resume", "/release-notes"]) {
      expect(screen.getByText(name, { exact: true })).toBeInTheDocument();
    }
    expect(screen.getByText("Rename the current conversation")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("TypedBlocks — callback binding", () => {
  it("binds a prompt-select tap to onPromptAction with the freshly derived model", async () => {
    const user = userEvent.setup();
    const onPromptAction = vi.fn();
    const blocks = fixtureBlocks("claude--select-menu.txt");
    render(<TypedBlocks blocks={blocks} onPromptAction={onPromptAction} />);

    await user.click(screen.getAllByRole("button")[0]!);
    expect(onPromptAction).toHaveBeenCalledTimes(1);
    const [, prompt] = onPromptAction.mock.calls[0]!;
    const derived = blocks.find(
      (b): b is Extract<typeof b, { kind: "prompt-select" }> => b.kind === "prompt-select",
    );
    expect(derived).toBeDefined();
    expect(prompt).toBe(derived!.prompt);
  });

  it("binds a wizard answer tap to onWizardAction", async () => {
    const user = userEvent.setup();
    const onWizardAction = vi.fn();
    render(
      <TypedBlocks blocks={fixtureBlocks("claude--wizard-q1.txt")} onWizardAction={onWizardAction} />,
    );

    await user.click(screen.getByRole("button", { name: /Parser/ }));
    expect(onWizardAction).toHaveBeenCalledTimes(1);
    const [keys] = onWizardAction.mock.calls[0]!;
    expect(Array.isArray(keys)).toBe(true);
    // SAFETY: guarded by the Array.isArray check immediately above; the mock call is untyped, so the
    // assertion only narrows what has just been proven.
    expect((keys as string[]).length).toBeGreaterThan(0);
  });

  it("binds a menu action tap to onMenuAction with the footer's keys", async () => {
    const user = userEvent.setup();
    const onMenuAction = vi.fn();
    const blocks = fixtureBlocks("claude--menu-model-picker.txt");
    render(<TypedBlocks blocks={blocks} onMenuAction={onMenuAction} />);

    await user.click(screen.getByRole("button", { name: "Use this session only" }));
    expect(onMenuAction).toHaveBeenCalledTimes(1);
    const [action, menu] = onMenuAction.mock.calls[0]!;
    expect(action).toEqual({ keys: ["s"], nav: false });
    const derived = blocks.find(
      (b): b is Extract<typeof b, { kind: "menu" }> => b.kind === "menu",
    );
    expect(derived).toBeDefined();
    expect(menu).toBe(derived!.menu);
  });

  it("renders prompt buttons inert when promptDisabled is set, without needing a handler", async () => {
    const user = userEvent.setup();
    const onPromptAction = vi.fn();
    render(
      <TypedBlocks
        blocks={fixtureBlocks("claude--select-menu.txt")}
        onPromptAction={onPromptAction}
        promptDisabled
      />,
    );
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    await user.click(screen.getAllByRole("button")[0]!);
    expect(onPromptAction).not.toHaveBeenCalled();
  });

  it("renders prompt buttons disabled when no handler is injected", () => {
    render(<TypedBlocks blocks={fixtureBlocks("claude--select-menu.txt")} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe.each(["TypedBlocks", "AnsiOutput"])("%s preview and multi-select delegation", (renderer) => {
  it("binds the preview option intent and displayed model, and delegates promptDisabled", async () => {
    const user = userEvent.setup();
    const onPreviewAction = vi.fn<NonNullable<TypedBlocksProps["onPreviewAction"]>>();
    const text = fixtureText("claude--select-preview.txt");
    const blocks = blocksFromText(text);
    const derived = blocks.find((block) => block.kind === "preview-select");
    if (!derived) throw new Error("Preview fixture did not produce a preview-select block");
    const view = (promptDisabled: boolean) => renderer === "TypedBlocks" ? (
      <TypedBlocks blocks={blocks} onPreviewAction={onPreviewAction} promptDisabled={promptDisabled} />
    ) : (
      <AnsiOutput text={text} agent="claude" onPreviewAction={onPreviewAction} promptDisabled={promptDisabled} />
    );
    const { rerender } = render(view(true));

    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Rounded/ }));
    expect(onPreviewAction).not.toHaveBeenCalled();

    rerender(view(false));
    await user.click(screen.getByRole("button", { name: /Rounded/ }));
    expect(onPreviewAction).toHaveBeenCalledTimes(1);
    expect(onPreviewAction).toHaveBeenCalledWith(
      { kind: "option", option: derived.preview.options[1] },
      derived.preview,
    );
    if (renderer === "TypedBlocks") {
      expect(onPreviewAction.mock.calls[0]![1]).toBe(derived.preview);
    }
  });

  it("binds the multi-select toggle intent and displayed model, and delegates promptDisabled", async () => {
    const user = userEvent.setup();
    const onMultiSelectAction = vi.fn<NonNullable<TypedBlocksProps["onMultiSelectAction"]>>();
    const text = fixtureText("claude--select-multiselect-checked.txt");
    const blocks = blocksFromText(text);
    const derived = blocks.find((block) => block.kind === "multi-select");
    if (!derived) throw new Error("Multi-select fixture did not produce a multi-select block");
    const view = (promptDisabled: boolean) => renderer === "TypedBlocks" ? (
      <TypedBlocks blocks={blocks} onMultiSelectAction={onMultiSelectAction} promptDisabled={promptDisabled} />
    ) : (
      <AnsiOutput text={text} agent="claude" onMultiSelectAction={onMultiSelectAction} promptDisabled={promptDisabled} />
    );
    const { rerender } = render(view(true));

    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Olives/ }));
    expect(onMultiSelectAction).not.toHaveBeenCalled();

    rerender(view(false));
    expect(screen.getByRole("checkbox", { name: /Olives/ })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("checkbox", { name: /Olives/ }));
    expect(onMultiSelectAction).toHaveBeenCalledTimes(1);
    expect(onMultiSelectAction).toHaveBeenCalledWith({ kind: "toggle", n: 3 }, derived.multi);
    if (renderer === "TypedBlocks") {
      expect(onMultiSelectAction.mock.calls[0]![1]).toBe(derived.multi);
    }
  });
});

describe("AnsiOutput over the extracted seam — mixed output and raw-only mirror", () => {
  it("raw-only: renders the mirror rows and no buttons at all", () => {
    const { container } = render(
      <AnsiOutput text={fixtureText("claude--working.txt")} agent="claude" />,
    );
    expect(container.querySelector("pre")).not.toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("mixed: renders the raw question above the lifted prompt controls", () => {
    const { container } = render(
      <AnsiOutput text={fixtureText("claude--select-menu.txt")} agent="claude" />,
    );
    const mirror = container.querySelector("pre");
    expect(mirror).toHaveTextContent("Which color theme should the dashboard use?");
    expect(mirror).toHaveTextContent("Offer exactly three options: Red, Green, Blue.");
    const option = screen.getByRole("button", { name: /A warm, high-energy theme/ });
    expect(option).toBeInTheDocument();
    expect(mirror).not.toContainElement(option);
  });

  it("standalone: renders the same prompt controls without the raw rows", () => {
    const { container } = render(<TypedBlocks blocks={fixtureBlocks("claude--select-menu.txt")} />);
    expect(screen.getByRole("button", { name: /A warm, high-energy theme/ })).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
    expect(container).not.toHaveTextContent("Which color theme should the dashboard use?");
    expect(container).not.toHaveTextContent("Offer exactly three options: Red, Green, Blue.");
  });

  it("mixed: the menu's region text stays in the mirror beside the extracted controls", () => {
    render(<AnsiOutput text={fixtureText("claude--menu-model-picker.txt")} agent="claude" />);
    expect(screen.getByText(/Most capable for your hardest/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this session only" })).toBeInTheDocument();
  });

  it("an unrecognized screen stays pure raw output — no inferred action", () => {
    const { container } = render(
      <AnsiOutput text={"PICK ONE:\n  [1] yes   [2] no\n❯ 1\n"} agent="claude" />,
    );
    expect(container.querySelector("pre")).not.toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
