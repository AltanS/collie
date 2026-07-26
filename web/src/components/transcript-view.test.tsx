import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TranscriptView } from "./transcript-view";
import type { TranscriptEntry } from "@/lib/types";

// TranscriptView renders the agent's own conversation log — the only history a Claude pane can have
// (its terminal runs on the alternate screen, which keeps no scrollback). The load-bearing
// behaviours: tool output stays collapsed so prose isn't buried, every string renders as TEXT (the
// same XSS boundary as the mirror), and a compaction summary is visibly not a human turn.

const turn = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: "u1",
  ts: "2026-07-25T06:22:21.253Z",
  role: "user",
  parts: [{ kind: "text", text: "hello" }],
  ...over,
});

describe("TranscriptView", () => {
  it("renders a human turn and an assistant turn with their role labels", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "what changed?" }] }),
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [{ kind: "text", text: "One commit." }],
          }),
        ]}
      />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("what changed?")).toBeInTheDocument();
    expect(screen.getByText("One commit.")).toBeInTheDocument();
  });

  it("shows a tool call's summary but keeps its output collapsed until tapped", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Bash",
                summary: "git log --oneline",
                result: { text: "abc1234 the commit body" },
              },
            ],
          }),
        ]}
      />,
    );

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("git log --oneline")).toBeInTheDocument();
    // Collapsed by default — a real thread is mostly tool traffic, and expanding it all buries the prose.
    expect(screen.queryByText(/abc1234 the commit body/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/abc1234 the commit body/)).toBeInTheDocument();
  });

  it("a tool call with no result isn't expandable (nothing to reveal)", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [{ kind: "tool", name: "Read", summary: "/a.ts" }],
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("flags truncated output rather than silently dropping the tail", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Read",
                summary: "/big",
                result: { text: "start of output", truncated: true },
              },
            ],
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/output truncated/)).toBeInTheDocument();
  });

  it("marks a compaction summary as its own thing, not as something a human said", () => {
    render(
      <TranscriptView
        entries={[turn({ role: "summary", parts: [{ kind: "text", text: "…prior context…" }] })]}
      />,
    );
    expect(screen.getByText(/Context compacted/)).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  // Markdown introduced ONE new way for log content to reach the browser: an <a href>. A hostile
  // scheme must never survive as a real link — the parser refuses it and the text stays literal.
  it("never turns an unsafe link target into an anchor", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({ parts: [{ kind: "text", text: "[tap me](javascript:alert(1))" }] }),
        ]}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText(/tap me/)).toBeInTheDocument();
  });

  it("a safe link renders as an anchor that can't reach back into the app", () => {
    const { container } = render(
      <TranscriptView
        entries={[turn({ parts: [{ kind: "text", text: "[docs](https://example.com)" }] })]}
      />,
    );
    const a = container.querySelector("a");
    expect(a).toHaveAttribute("href", "https://example.com");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("renders log text as TEXT, never as markup (the XSS boundary)", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <TranscriptView entries={[turn({ parts: [{ kind: "text", text: hostile }] })]} />,
    );
    // The characters survive verbatim…
    expect(screen.getByText(hostile)).toBeInTheDocument();
    // …and no element was ever constructed from them.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders prose as formatted Markdown", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({ parts: [{ kind: "text", text: "## Heading\n\n**bold** and `code`" }] }),
        ]}
      />,
    );
    // The syntax is consumed into structure rather than shown literally…
    expect(screen.queryByText(/## Heading/)).not.toBeInTheDocument();
    expect(screen.getByText("Heading")).toBeInTheDocument();
    // …and the emphasis/code become real elements.
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("code")).toHaveTextContent("code");
  });

  it("tool output is NOT markdown-parsed — it's command output, kept verbatim", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Bash",
                summary: "cat notes.md",
                result: { text: "## literal heading\n**literal stars**" },
              },
            ],
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/## literal heading/)).toBeInTheDocument();
  });

  it("groups turns under a day divider, once per day", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "a", ts: "2026-07-25T06:00:00.000Z" }),
          turn({ uuid: "b", ts: "2026-07-25T07:00:00.000Z" }),
          turn({ uuid: "c", ts: "2026-07-26T08:00:00.000Z" }),
        ]}
      />,
    );
    const day25 = new Date("2026-07-25T06:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    const day26 = new Date("2026-07-26T08:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    expect(screen.getAllByText(day25)).toHaveLength(1);
    expect(screen.getAllByText(day26)).toHaveLength(1);
  });

  it("survives a turn with no timestamp (no divider, no crash)", () => {
    render(<TranscriptView entries={[turn({ ts: "" })]} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});

// Grouping: a real thread is overwhelmingly long runs of assistant turns, so only the first turn of
// a run carries the role/time header. Without this the scroll length roughly doubles with nothing
// new in it.
describe("TranscriptView — speaker grouping", () => {
  it("labels only the first turn of a consecutive run", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "one" }] }),
          turn({ uuid: "a2", role: "assistant", parts: [{ kind: "text", text: "two" }] }),
          turn({ uuid: "a3", role: "assistant", parts: [{ kind: "text", text: "three" }] }),
        ]}
      />,
    );
    expect(screen.getAllByText("claude")).toHaveLength(1);
    // Every turn's content still renders — only the repeated header is suppressed.
    for (const t of ["one", "two", "three"]) expect(screen.getByText(t)).toBeInTheDocument();
  });

  it("re-labels when the speaker changes back", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "one" }] }),
          turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "ask" }] }),
          turn({ uuid: "a2", role: "assistant", parts: [{ kind: "text", text: "two" }] }),
        ]}
      />,
    );
    expect(screen.getAllByText("claude")).toHaveLength(2);
    expect(screen.getAllByText("You")).toHaveLength(1);
  });

  it("a day divider restarts the run even for the same speaker", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "a1", role: "assistant", ts: "2026-07-25T06:00:00.000Z" }),
          turn({ uuid: "a2", role: "assistant", ts: "2026-07-26T06:00:00.000Z" }),
        ]}
      />,
    );
    expect(screen.getAllByText("claude")).toHaveLength(2);
  });
});

// Machine-injected content (a background task finishing, a local command's output) is real and
// belongs on screen, but it is NOT speech — it must never be attributed to the user or the agent.
describe("TranscriptView — system notes", () => {
  it("renders a note set apart, attributed to neither party", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ role: "note", parts: [{ kind: "text", text: 'Agent "issue 8 fixes" finished' }] }),
        ]}
      />,
    );
    expect(screen.getByText(/System/)).toBeInTheDocument();
    expect(screen.getByText(/Agent "issue 8 fixes" finished/)).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
  });

  it("keeps a compaction summary distinct from an ordinary note", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "s", role: "summary", parts: [{ kind: "text", text: "…prior…" }] }),
          turn({ uuid: "n", role: "note", parts: [{ kind: "text", text: "task done" }] }),
        ]}
      />,
    );
    expect(screen.getByText(/Context compacted/)).toBeInTheDocument();
    expect(screen.getByText(/System/)).toBeInTheDocument();
  });
});
