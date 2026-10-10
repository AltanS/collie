import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCard } from "@/components/chat-cards";
import { MarkdownText } from "@/components/markdown-text";
import { setStatus } from "@/lib/status";

vi.mock("@/lib/status", () => ({ setStatus: vi.fn() }));

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("copyable reading blocks", () => {
  it("copies fenced code with indentation, blank lines and literal Markdown intact", async () => {
    const code = "  if (ready) {\n\tprint('**literal**');\n\n  }\n";
    const { container } = render(<MarkdownText text={`before\n\n\`\`\`ts\n${code}\n\`\`\`\n\nafter`} query="ready" />);
    const button = within(container).getByRole("button", { name: "Copy" });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith("Copied to clipboard", "success"));
    expect(container.querySelector("pre")?.textContent).toBe(code);
    expect(container.querySelector("mark")?.textContent).toBe("ready");
    expect(button.textContent).toBe("");
    expect(button.parentElement).toBe(container.querySelector("pre")?.parentElement);
    expect(button.parentElement?.className).toBe("relative min-w-0");
  });

  it("copies the table's exact Markdown, not its formatted or squared-off cells", async () => {
    const table = "  | **Name** | Cost |\n  | :--- | ---: |\n  | x \\| y | `low` | extra |\n  | short |";
    const { container } = render(<MarkdownText text={`before\n\n${table}\n\nafter`} />);
    const button = within(container).getByRole("button", { name: "Copy" });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(table));
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("table")?.parentElement?.className).toContain("overflow-x-auto");
    expect(button.textContent).toBe("");
    expect(button.parentElement).toBe(container.querySelector("table")?.parentElement?.parentElement);
    // Anchored to the table's own width, not the column's: the wrapper shrinks to fit the table
    // and stops at the column, so a narrow table's icon sits at its right edge.
    expect(button.parentElement?.className).toBe("relative min-w-0 w-fit max-w-full");
    expect(within(container).getByText("after")).toBeInTheDocument();
  });

  it("copies the entire command and output separately despite their previews", async () => {
    const command = Array.from({ length: 8 }, (_, i) => `  command ${i}`).join("\n");
    const output = Array.from({ length: 14 }, (_, i) => `  output ${i}`).join("\n") + "\n\n";
    const { container } = render(<ToolCard tool={{ kind: "execute", command, output }} status="done" />);
    const commandButton = within(container).getByRole("button", { name: "Copy command" });
    fireEvent.click(commandButton);
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(1, command));
    expect(within(container).queryByRole("button", { name: "Copy command output" })).toBeNull();
    fireEvent.click(within(container).getByRole("button", { expanded: false }));
    expect(container.querySelector("pre")?.textContent).not.toContain("output 0\n");
    const outputButton = within(container).getByRole("button", { name: "Copy command output" });
    fireEvent.click(outputButton);
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, output));
    expect(outputButton.closest(".invert")).toBeNull();
    expect(commandButton.parentElement).not.toBe(outputButton.parentElement);
    expect(commandButton.nextElementSibling?.className).toContain("min-h-11");
    expect(outputButton.nextElementSibling?.className).toContain("border-t");
    for (const button of [commandButton, outputButton]) {
      expect(button.textContent).toBe("");
      expect(button.className).toContain("absolute");
      expect(button.parentElement?.className).toBe("relative min-w-0");
      expect(button.parentElement?.className).not.toContain("[filter:");
      expect(button.parentElement?.parentElement?.className).not.toContain("overflow-hidden");
      expect(button.closest('[data-slot="card"]')?.className).not.toContain("overflow-hidden");
    }
  });

  it("copies every diff hunk even while the card shows only its first lines", async () => {
    const hunks = [
      { header: "@@ -1,20 +1,20 @@", lines: Array.from({ length: 20 }, (_, i) => `+  line ${i}`) },
      { header: "@@ -30 +30 @@", lines: ["-old", "+new"] },
    ];
    const original = hunks.map((hunk) => [hunk.header, ...hunk.lines].join("\n")).join("\n");
    const { container } = render(<ToolCard tool={{ kind: "edit", path: "/a.txt", added: 21, removed: 1, diff: hunks }} status="done" />);
    expect(container.textContent).not.toContain("line 19");
    const button = within(container).getByRole("button", { name: "Copy" });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(original));
    expect(button.textContent).toBe("");
    expect(button.parentElement?.className).toBe("relative min-w-0");
    expect(button.closest('[data-slot="card"]')?.className).not.toContain("overflow-hidden");
    expect(button.nextElementSibling?.className).toContain("overflow-hidden");
  });

  it("copies unnumbered diff headers without inventing line numbers", async () => {
    const { container } = render(<ToolCard tool={{ kind: "edit", path: "/a.txt", added: 1, removed: 1, diff: [{ header: "a.txt", lines: ["-old", "+  new"] }] }} status="done" />);
    fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("a.txt\n-old\n+  new"));
  });

  it("copies over plain HTTP: with no clipboard API the icon uses the legacy command", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    Object.defineProperty(document, "queryCommandSupported", { configurable: true, value: () => true });
    try {
      const { container } = render(<MarkdownText text={"```\nrm -rf build\n```"} />);
      fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(setStatus).toHaveBeenCalledWith("Copied to clipboard", "success"));
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
      Reflect.deleteProperty(document, "queryCommandSupported");
    }
  });

  it("keeps all four surfaces readable with no clipboard API", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const { container } = render(<>
      <MarkdownText text={"```\n  code\n```\n\n| A | B |\n| --- | --- |\n| x | y |"} />
      <ToolCard tool={{ kind: "execute", command: "run", output: "result" }} status="done" preview />
      <ToolCard tool={{ kind: "edit", path: "/a.txt", added: 1, removed: 0, diff: [{ header: "a.txt", lines: ["+new"] }] }} status="done" />
    </>);
    expect(within(container).queryByRole("button", { name: /Copy/ })).toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("pre")).toHaveLength(2);
    expect(container.textContent).toContain("new");
    expect(writeText).not.toHaveBeenCalled();
  });
});
