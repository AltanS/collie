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
    fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith("Copied to clipboard", "success"));
    expect(container.querySelector("pre")?.textContent).toBe(code);
    expect(container.querySelector("mark")?.textContent).toBe("ready");
    const button = within(container).getByRole("button", { name: "Copy" });
    expect(button.textContent).toBe("");
    expect(button.parentElement).toBe(container.querySelector("pre")?.parentElement);
    expect(button.parentElement?.className).toBe("relative min-w-0");
  });

  it("copies the table's exact Markdown, not its formatted or squared-off cells", async () => {
    const table = "  | **Name** | Cost |\n  | :--- | ---: |\n  | x \\| y | `low` | extra |\n  | short |";
    const { container } = render(<MarkdownText text={`before\n\n${table}\n\nafter`} />);
    fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(table));
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("table")?.parentElement?.className).toContain("overflow-x-auto");
    const button = within(container).getByRole("button", { name: "Copy" });
    expect(button.textContent).toBe("");
    expect(button.parentElement).toBe(container.querySelector("table")?.parentElement?.parentElement);
    expect(button.parentElement?.className).toBe("relative min-w-0");
    expect(within(container).getByText("after")).toBeInTheDocument();
  });

  it("copies the entire command and output separately despite their previews", async () => {
    const command = Array.from({ length: 8 }, (_, i) => `  command ${i}`).join("\n");
    const output = Array.from({ length: 14 }, (_, i) => `  output ${i}`).join("\n") + "\n\n";
    const { container } = render(<ToolCard tool={{ kind: "execute", command, output }} status="done" />);
    fireEvent.click(within(container).getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(1, command));
    expect(within(container).queryByRole("button", { name: "Copy command output" })).toBeNull();
    fireEvent.click(within(container).getByRole("button", { expanded: false }));
    expect(container.querySelector("pre")?.textContent).not.toContain("output 0\n");
    fireEvent.click(within(container).getByRole("button", { name: "Copy command output" }));
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, output));
    const commandButton = within(container).getByRole("button", { name: "Copy command" });
    const outputButton = within(container).getByRole("button", { name: "Copy command output" });
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
    fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(original));
    const button = within(container).getByRole("button", { name: "Copy" });
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
