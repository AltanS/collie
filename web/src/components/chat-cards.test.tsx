import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  CardWaitingCtx,
  Disclosure,
  ItemView,
  ToolCard,
  ToolGroup,
  groupRuns,
  harnessLabel,
  shortPath,
  stepLine,
  type CardWaiting,
} from "./chat-cards";
import type { ChatItem, ChatToolCall } from "@/lib/chat-items";

// The blocks of a session stream. The load-bearing behaviours: a finished run folds to one line and
// a live one does not, a refusal is not drawn like a fault, every string renders as TEXT (the same
// XSS boundary as the mirror), and the host's waiting slot is the ONLY way a dialog reaches a card —
// collie itself has nothing to put there.

const tool = (t: ChatToolCall, over: Partial<Extract<ChatItem, { kind: "tool" }>> = {}): ChatItem => ({
  id: "t1",
  kind: "tool",
  tool: t,
  status: "done",
  ...over,
});

/** Render with a host's waiting slots in place, the way the one host that has any does it. */
function withWaiting(node: ReactNode, waiting: Record<string, CardWaiting>) {
  return render(<CardWaitingCtx.Provider value={waiting}>{node}</CardWaitingCtx.Provider>);
}

describe("groupRuns", () => {
  const t = (id: string): ChatItem => tool({ kind: "read", path: "/a.ts" }, { id });
  const said = (id: string): ChatItem => ({ id, kind: "reply", text: "hi" });

  it("gathers three or more consecutive steps into one run", () => {
    expect(groupRuns([t("a"), t("b"), t("c")]).map((g) => g.length)).toEqual([3]);
  });

  it("leaves a shorter run as single blocks", () => {
    expect(groupRuns([t("a"), t("b")]).map((g) => g.length)).toEqual([1, 1]);
  });

  it("breaks a run on anything that is not a step", () => {
    expect(groupRuns([t("a"), t("b"), t("c"), said("s"), t("d")]).map((g) => g.length)).toEqual([3, 1, 1]);
  });

  it("counts thinking as a step, so reasoning folds with the work around it", () => {
    const items: ChatItem[] = [t("a"), { id: "k", kind: "thinking", text: "hmm" }, t("b")];
    expect(groupRuns(items).map((g) => g.length)).toEqual([3]);
  });

  it("folds a lone step at minRun 1, which is how tool calls off is drawn", () => {
    expect(groupRuns([t("a")], 1).map((g) => g.length)).toEqual([1]);
    expect(groupRuns([t("a"), said("s")], 1).map((g) => g.length)).toEqual([1, 1]);
  });
});

describe("stepLine", () => {
  it("names the act and the thing it acted on, and says which face the subject wears", () => {
    expect(stepLine({ kind: "edit", path: "/home/me/a.ts", added: 1, removed: 0 })).toEqual({
      verb: "Edited",
      subject: "~/a.ts",
      mono: true,
    });
    expect(stepLine({ kind: "edit", path: "/a.ts", added: 1, removed: 0, created: true }).verb).toBe("Created");
    expect(stepLine({ kind: "read", path: "/a.ts" }).verb).toBe("Read");
    expect(stepLine({ kind: "search", query: "todo" })).toEqual({ verb: "Searched", subject: "todo", mono: true });
    expect(stepLine({ kind: "fetch", url: "https://x.test" }).verb).toBe("Fetched");
    expect(stepLine({ kind: "delete", path: "/a.ts" }).verb).toBe("Deleted");
    expect(stepLine({ kind: "move", path: "/a.ts", to: "/b.ts" }).verb).toBe("Moved");
  });

  it("prefers a command's own description, and falls back to its first line in mono", () => {
    expect(stepLine({ kind: "execute", command: "ls -la", description: "List files" })).toEqual({
      verb: "",
      subject: "List files",
      mono: false,
    });
    expect(stepLine({ kind: "execute", command: "ls -la\necho hi" })).toEqual({
      verb: "$",
      subject: "ls -la",
      mono: true,
    });
  });

  it("draws an agent's own words as prose, never as a path", () => {
    expect(stepLine({ kind: "task", agent: "explore", summary: "Read the corpus" })).toEqual({
      verb: "explore:",
      subject: "Read the corpus",
      mono: false,
    });
    expect(stepLine({ kind: "other", name: "Weird", summary: "line one\nline two" }).subject).toBe("line one");
  });
});

describe("shortPath", () => {
  it("shortens a home directory under either root, and leaves anything else alone", () => {
    expect(shortPath("/var/home/altan/x/a.ts")).toBe("~/x/a.ts");
    expect(shortPath("/home/altan/x/a.ts")).toBe("~/x/a.ts");
    expect(shortPath("/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("harnessLabel", () => {
  it("gives a harness its own name, and hands back anything it has not been taught", () => {
    expect(harnessLabel("claude")).toBe("Claude Code");
    expect(harnessLabel("grok")).toBe("grok");
  });
});

describe("ToolCard", () => {
  it("draws an edit with its path and the lines that moved", () => {
    render(<ToolCard tool={{ kind: "edit", path: "/home/me/src/a.ts", added: 4, removed: 2 }} status="done" />);
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("+4")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
  });

  it("says Create for a new file", () => {
    render(<ToolCard tool={{ kind: "edit", path: "/a.ts", added: 9, removed: 0, created: true }} status="done" />);
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("draws a command and opens its output on a tap", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolCard tool={{ kind: "execute", command: "ls -la", output: "one\ntwo" }} status="done" />,
    );
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    const fold = screen.getByRole("button", { expanded: false });
    expect(fold).toHaveTextContent("2");
    expect(container.querySelector("pre")).toBeNull();
    await user.click(fold);
    expect(container.querySelector("pre")).toHaveTextContent("one two");
  });

  it("draws a read as one line with its range", () => {
    render(<ToolCard tool={{ kind: "read", path: "/a.ts", range: [10, 20] }} status="done" />);
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("lines 10–20")).toBeInTheDocument();
  });

  // Every state a card can show lives in ONE reserved grid cell (`ui/one-of.tsx`), so all of them
  // are in the DOM at once and only the active layer is marked. Asking "which is shown" therefore
  // means asking the slot, not asking whether a word exists.
  it("tells a refusal apart from a fault", () => {
    const denied = render(<ToolCard tool={{ kind: "read", path: "/a.ts" }} status="denied" />);
    expect(denied.container.querySelector("[data-active]")).toHaveTextContent("denied");
    denied.unmount();
    const failed = render(<ToolCard tool={{ kind: "read", path: "/a.ts" }} status="failed" />);
    expect(failed.container.querySelector("[data-active]")).toHaveTextContent("failed");
  });

  it("names a non-zero exit code, and says nothing about a zero one", () => {
    const bad = render(<ToolCard tool={{ kind: "execute", command: "false", exitCode: 1 }} status="done" />);
    expect(bad.container.querySelector("[data-active]")).toHaveTextContent("exit 1");
    bad.unmount();
    const good = render(<ToolCard tool={{ kind: "execute", command: "true", exitCode: 0 }} status="done" />);
    expect(good.container.querySelector("[data-active]")).toBeNull();
  });

  it("renders agent text as text, never as markup", () => {
    render(<ToolCard tool={{ kind: "other", name: "Weird", summary: "<img src=x onerror=alert(1)>" }} status="done" />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("the host's waiting slot", () => {
  const card = <ToolCard tool={{ kind: "execute", command: "rm -rf /tmp/x" }} status="running" />;

  it("draws nothing of its own when no host supplied anything", () => {
    const { container } = render(card);
    expect(container.querySelector("[data-waiting]")).toBeNull();
  });

  it("anchors the card and draws what the host gave it", () => {
    const { container } = render(
      <ToolCard
        tool={{ kind: "execute", command: "rm -rf /tmp/x" }}
        status="running"
        waiting={{ id: "ask-7", body: <p>Allow this?</p> }}
      />,
    );
    expect(container.querySelector('[data-waiting="ask-7"]')).not.toBeNull();
    expect(screen.getByText("Allow this?")).toBeInTheDocument();
  });

  it("draws the host's note in the body's place once the body is gone", () => {
    render(
      <ToolCard
        tool={{ kind: "execute", command: "rm -rf /tmp/x" }}
        status="running"
        waiting={{ note: "The dialog moved to the terminal." }}
      />,
    );
    expect(screen.getByText("The dialog moved to the terminal.")).toBeInTheDocument();
  });

  it("reaches a card inside a run through the context, keyed by the item's own id", () => {
    const items: ChatItem[] = [
      tool({ kind: "read", path: "/a.ts" }, { id: "a" }),
      tool({ kind: "read", path: "/b.ts" }, { id: "b" }),
      tool({ kind: "execute", command: "rm -rf /tmp/x" }, { id: "c", status: "running" }),
    ];
    const { container } = withWaiting(<ToolGroup items={items} />, { c: { id: "ask-9", body: <p>Allow this?</p> } });
    expect(screen.getByText("Allow this?")).toBeInTheDocument();
    expect(container.querySelector('[data-waiting="ask-9"]')).not.toBeNull();
  });
});

describe("a question card", () => {
  const asked: Extract<ChatToolCall, { kind: "question" }> = {
    kind: "question",
    name: "question",
    summary: "Which color?",
    questions: [
      {
        header: "Color choice",
        question: "Which color?",
        multiple: false,
        options: [
          { label: "Red", description: "The color red" },
          { label: "Blue", description: "The color blue" },
        ],
      },
    ],
  };
  /** The marked rows: the question draws its chosen options with `aria-current`. */
  const marked = (container: HTMLElement) =>
    [...container.querySelectorAll("li[aria-current]")].map((li) => li.textContent);

  it("shows the header, the question and every option with its description", () => {
    render(<ToolCard tool={asked} status="running" />);
    expect(screen.getByText("Color choice")).toBeInTheDocument();
    expect(screen.getByText("Which color?")).toBeInTheDocument();
    expect(screen.getByText("Red")).toBeInTheDocument();
    expect(screen.getByText("The color red")).toBeInTheDocument();
    expect(screen.getByText("Blue")).toBeInTheDocument();
    expect(screen.getByText("The color blue")).toBeInTheDocument();
  });

  it("names itself Question when the call sent no header", () => {
    const bare = { ...asked, questions: [{ ...asked.questions[0]!, header: undefined }] };
    render(<ToolCard tool={bare} status="running" />);
    expect(screen.getByText("Question")).toBeInTheDocument();
  });

  it("draws no button: answering lives in the dock", () => {
    render(<ToolCard tool={asked} status="running" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("waits with the waiting dot and its own sentence", () => {
    const { container } = render(<ToolCard tool={asked} status="running" />);
    expect(screen.getByText("Waiting for an answer")).toBeInTheDocument();
    expect(container.querySelector("[data-active] [aria-label='running']")).not.toBeNull();
  });

  it("says what the host's note says in that sentence's place, once", () => {
    withWaiting(<ToolCard tool={asked} status="running" waiting={{ id: "q1", note: "Answer in the card below" }} />, {});
    expect(screen.getByText("Answer in the card below")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for an answer")).toBeNull();
  });

  it("reads the note through the context when it sits in a stream", () => {
    const { container } = withWaiting(<ItemView item={tool(asked, { id: "q1", status: "running" })} />, {
      q1: { id: "q1", note: "Answer in the card below" },
    });
    expect(screen.getByText("Answer in the card below")).toBeInTheDocument();
    expect(container.querySelector('[data-waiting="q1"]')).not.toBeNull();
  });

  it("marks the chosen label once answered, and only that one", () => {
    const { container } = render(<ToolCard tool={{ ...asked, answers: [["Blue"]] }} status="done" />);
    expect(marked(container)).toEqual(["BlueThe color blue"]);
    expect(screen.queryByText("Waiting for an answer")).toBeNull();
    expect(container.querySelector("svg.text-status-done")).not.toBeNull();
  });

  it("shows a free-text answer as its own marked row", () => {
    const { container } = render(<ToolCard tool={{ ...asked, answers: [["Teal"]] }} status="done" />);
    expect(marked(container)).toEqual(["Teal"]);
    // The two real options are still listed, unmarked.
    expect(screen.getByText("Red")).toBeInTheDocument();
    expect(screen.getByText("Blue")).toBeInTheDocument();
  });

  it("marks every pick of a multiple question and says so", () => {
    const multi = {
      ...asked,
      questions: [{ ...asked.questions[0]!, multiple: true }],
      answers: [["Red", "Blue"]],
    };
    const { container } = render(<ToolCard tool={multi} status="done" />);
    expect(screen.getByText("Pick any that apply")).toBeInTheDocument();
    expect(marked(container)).toHaveLength(2);
  });

  it("says nothing about a pick when the call completed without answers", () => {
    const { container } = render(<ToolCard tool={asked} status="done" />);
    expect(marked(container)).toEqual([]);
    expect(screen.queryByText("Waiting for an answer")).toBeNull();
    expect(screen.queryByText("Dismissed")).toBeNull();
  });

  it("says Dismissed when the reader closed it", () => {
    const { container } = render(<ToolCard tool={asked} status="denied" />);
    expect(screen.getByText("Dismissed")).toBeInTheDocument();
    expect(container.querySelector("[data-active]")).toHaveTextContent("denied");
  });

  it("gives each question its own header when the call carried several", () => {
    const two = {
      ...asked,
      questions: [
        asked.questions[0]!,
        { header: "Size", question: "Which size?", multiple: false, options: [{ label: "S" }] },
      ],
    };
    render(<ToolCard tool={two} status="running" />);
    expect(screen.getByText("Question")).toBeInTheDocument();
    expect(screen.getByText("Color choice")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("Which size?")).toBeInTheDocument();
  });

  it("renders the agent's words as text, never as markup", () => {
    const hostile = {
      ...asked,
      questions: [{ question: "<img src=x onerror=alert(1)>", multiple: false, options: [{ label: "<b>x</b>" }] }],
    };
    render(<ToolCard tool={hostile} status="running" />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(screen.getByText("<b>x</b>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("reads as the first question in a folded run, and counts among the other steps", async () => {
    expect(stepLine(asked)).toEqual({ verb: "question:", subject: "Which color?", mono: false });
    const items: ChatItem[] = [
      tool(asked, { id: "a" }),
      tool({ kind: "read", path: "/a.ts" }, { id: "b" }),
      tool({ kind: "read", path: "/b.ts" }, { id: "c" }),
    ];
    render(<ToolGroup items={items} />);
    expect(screen.getByText("2 reads, 1 other step")).toBeInTheDocument();
  });
});

describe("ToolGroup", () => {
  const finished: ChatItem[] = [
    tool({ kind: "execute", command: "ls" }, { id: "a" }),
    tool({ kind: "edit", path: "/a.ts", added: 1, removed: 1 }, { id: "b" }),
    tool({ kind: "read", path: "/b.ts" }, { id: "c" }),
  ];

  it("folds a finished run to one summary line, and opens it on a tap", async () => {
    const user = userEvent.setup();
    render(<ToolGroup items={finished} />);
    const fold = screen.getByRole("button", { expanded: false });
    expect(fold).toHaveTextContent("1 command, 1 edit, 1 read");
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    await user.click(fold);
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("counts the faults in a run on its folded row", () => {
    const items = finished.map((i, k) => (k === 0 ? { ...i, status: "failed" as const } : i));
    render(<ToolGroup items={items} />);
    expect(screen.getByText("1 failed")).toBeInTheDocument();
  });

  /** The same run with its last step still in flight, built once — three cases below need it. */
  const running: ChatItem[] = finished.map((i, k) =>
    k === 2 ? Object.assign({}, i, { status: "running" as const }) : i,
  );

  it("stays open while a step is still running, so nothing hides work in flight", () => {
    render(<ToolGroup items={running} />);
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("stays open while a host has something waiting on a step, because hiding it hides the question", () => {
    withWaiting(<ToolGroup items={finished} />, { b: { id: "ask-1", body: <p>Allow this?</p> } });
    expect(screen.getByText("Allow this?")).toBeInTheDocument();
  });

  // Tool calls OFF is the reader's standing answer to "do I want to see the steps", and a step that
  // starts running is not a reason to overrule it. Until 2026-09-30 it was: `groupRuns(items, 1)`
  // grouped every run, and then a running step opened the group anyway and `held` latched it there,
  // so a live session drew full cards with the setting off.
  it("a running step does not open the run once the reader has turned tool calls off", () => {
    render(<ToolGroup items={running} liveOpens={false} />);
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: false })).toHaveTextContent(
      "1 command, 1 edit, 1 read",
    );
  });

  it("a reader's own tap still opens it, because a tap is not a tool asking for itself", async () => {
    const user = userEvent.setup();
    render(<ToolGroup items={running} liveOpens={false} />);
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  // The memo comparator answers for `items` alone, so the prop had to be added to it. Without that,
  // a run that mounted while tool calls were on would keep drawing open after they were turned off.
  it("folds a run that latched open when the reader turns tool calls off", () => {
    const { rerender } = render(<ToolGroup items={running} liveOpens />);
    expect(screen.getByText("Edit")).toBeInTheDocument();
    rerender(<ToolGroup items={running} liveOpens={false} />);
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
  });
});

describe("ItemView", () => {
  it("draws the reader's own turn with a You caption", () => {
    render(<ItemView item={{ id: "u", kind: "user", text: "please continue" }} />);
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("please continue")).toBeInTheDocument();
  });

  it("keeps thinking behind a fold", async () => {
    const user = userEvent.setup();
    render(<ItemView item={{ id: "k", kind: "thinking", text: "weighing it up" }} />);
    expect(screen.queryByText("weighing it up")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Thinking/ }));
    expect(screen.getByText("weighing it up")).toBeInTheDocument();
  });

  it("sets a notice apart from speech", () => {
    render(<ItemView item={{ id: "n", kind: "notice", text: "Image: /api/image/7" }} />);
    expect(screen.getByText("Image: /api/image/7")).toBeInTheDocument();
  });
});

describe("a compaction", () => {
  const recap = "This session is being continued from a previous conversation. ".repeat(6);

  it("draws one marker line and no recap when the recap is withheld", () => {
    render(<ItemView item={{ id: "s", kind: "compacted", ts: "2026-09-30T08:00:00.000Z" }} />);
    expect(screen.getByText(/Context compacted/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("folds the recap behind its label and opens on a tap when it is kept", async () => {
    const user = userEvent.setup();
    render(<ItemView item={{ id: "s", kind: "compacted", text: recap }} />);
    expect(screen.queryByText(/continued from a previous/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Context compacted/ }));
    expect(screen.getByText(/continued from a previous/)).toBeInTheDocument();
  });
});

describe("a long machine note", () => {
  it("folds behind the System label, and a short one stays inline", async () => {
    const user = userEvent.setup();
    render(<ItemView item={{ id: "n", kind: "notice", text: "x ".repeat(100), note: true }} />);
    await user.click(screen.getByRole("button", { name: /System/ }));
    expect(screen.getByText(/x x x/)).toBeInTheDocument();
  });

  it("leaves a short note inline", () => {
    render(<ItemView item={{ id: "n", kind: "notice", text: "Interrupted", note: true }} />);
    expect(screen.getByText("Interrupted")).toBeInTheDocument();
  });
});

describe("Disclosure", () => {
  it("keeps its body out of the DOM until it is opened", async () => {
    const user = userEvent.setup();
    render(
      <Disclosure label="Details" icon={ChevronRight}>
        {() => <p>the body</p>}
      </Disclosure>,
    );
    expect(screen.queryByText("the body")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("the body")).toBeInTheDocument();
  });
});
