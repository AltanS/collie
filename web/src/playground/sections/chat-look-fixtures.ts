// The five threads the "Chat look" round draws, as the journal hands them to Chat (`ChatEntry[]`), so the
// real `SessionStream` turns them into its own blocks. DEV-ONLY, like the page.
//
// Each case is one shape the eye meets in Chat: a short exchange, a long Markdown answer, a run of tool steps,
// a code block beside a table, and a thread that waits on the person.

import type { ChatEntry, TranscriptPart } from "@/lib/types";

/** One fixed morning, so every frame prints the same times. */
const T0 = Date.parse("2026-11-10T09:12:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let seq = 1_000;
function entry(uuid: string, minutes: number, role: ChatEntry["role"], parts: TranscriptPart[]): ChatEntry {
  seq += 1;
  return { uuid, seq, ts: at(minutes), role, parts };
}
const text = (t: string): TranscriptPart => ({ kind: "text", text: t });
const user = (uuid: string, minutes: number, t: string) => entry(uuid, minutes, "user", [text(t)]);
const agent = (uuid: string, minutes: number, ...parts: TranscriptPart[]) => entry(uuid, minutes, "assistant", parts);

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
function tool(id: string, name: string, call: NonNullable<ToolPart["call"]>, result?: ToolPart["result"]): ToolPart {
  return { kind: "tool", id, name, summary: name, call, result };
}
const ok = (t = ""): ToolPart["result"] => ({ text: t });

// ── 1. Short exchange ────────────────────────────────────────────────────────

const SHORT: ChatEntry[] = [
  user("s1", 0, "Why does the dashboard flash white on reload?\nIt started after the theme change."),
  agent(
    "s2",
    1,
    text(
      "The theme script runs after the first paint, so the page draws one frame in the default palette. Move `theme-init.js` into the head, before the stylesheet, and the class lands before anything is drawn.",
    ),
  ),
  user("s3", 4, "Does that cover the installed app too?"),
  agent("s4", 5, text("Yes. The installed app loads the same page, so the same fix covers it.")),
];

// ── 2. Long answer ───────────────────────────────────────────────────────────

const LONG_ANSWER = `## What the guard checks

Before Collie presses Enter it reads the screen again and asks one question: is the text it typed still the only thing in the input box?

- It finds the input box by its own frame, not by counting rows.
- It compares the box with \`the message just typed\`.
- A long message may collapse to \`[Pasted text #1 +12 lines]\`, which also counts as proof.

### When it refuses

> A dialog that opened while you typed takes the Enter key. The guard sees the dialog and stops.

Nothing is sent twice: a refused send keeps your words in the composer. The rules are in the [send guard notes](https://colliepwa.dev/docs/send-guard).`;

const LONG: ChatEntry[] = [
  user("l1", 0, "Explain how the send guard decides it is safe to press Enter."),
  agent("l2", 1, text(LONG_ANSWER)),
];

// ── 3. Work run ──────────────────────────────────────────────────────────────

const TEST_FAIL = `bun test v1.3.4

web/src/components/tab-strip.test.tsx:
(pass) draws one chip per tab
(pass) scrolls the open tab into view
(fail) marks the open tab as the current page
  expected: aria-current="page"
  received: aria-selected="true"
(pass) keeps the strip label when compact

 3 pass
 1 fail
Ran 4 tests across 1 file. [212.00ms]`;

const TAB_DIFF = [
  {
    header: "@@ -41,7 +41,7 @@",
    lines: [
      "       <Chip",
      "         key={tab.id}",
      "         label={tab.name}",
      "-        aria-selected={tab.id === openId}",
      "+        aria-current={tab.id === openId ? \"page\" : undefined}",
      "         onClick={() => onOpen(tab.id)}",
      "       />",
    ],
  },
];

const WORK: ChatEntry[] = [
  user("w1", 0, "The tab strip test fails on main. Fix it."),
  agent("w2", 1, text("I will find the failing case first.")),
  agent(
    "w3",
    1,
    tool("w3-read", "Read", { kind: "read", path: "/home/me/collie/web/src/components/tab-strip.tsx", range: [1, 120] }, ok()),
    tool("w3-grep", "Grep", { kind: "search", query: "aria-current", where: "/home/me/collie/web/src", hits: 3 }, ok("web/src/components/space-strip.tsx\nweb/src/components/tab-bar.tsx\nweb/src/components/ui/chip.tsx")),
    tool("w3-test", "Bash", { kind: "execute", command: "bun run --cwd web test src/components/tab-strip.test.tsx", exitCode: 1 }, { text: TEST_FAIL, isError: true }),
    tool("w3-read2", "Read", { kind: "read", path: "/home/me/collie/web/src/components/ui/chip.tsx", range: [30, 90] }, ok()),
    tool("w3-edit", "Edit", { kind: "edit", path: "/home/me/collie/web/src/components/tab-strip.tsx", added: 1, removed: 1, diff: TAB_DIFF }, ok()),
    // Still running in the background, so the run is live and draws open, as it does while you watch.
    tool("w3-watch", "Bash", { kind: "execute", command: "bun run --cwd web test --watch src/components", description: "Watch the strip tests", background: true, ongoing: true }, ok("watching 12 files")),
  ),
  agent("w4", 3, text("Found it: the strip set `aria-selected`, and the test asks for `aria-current`. Checking the other strips.")),
  agent(
    "w5",
    4,
    tool("w5-read", "Read", { kind: "read", path: "/home/me/collie/web/src/components/space-strip.tsx" }, ok()),
    tool("w5-read2", "Read", { kind: "read", path: "/home/me/collie/web/src/components/pane-strip.tsx" }, ok()),
    tool("w5-grep", "Grep", { kind: "search", query: "aria-selected", where: "/home/me/collie/web/src" }, ok("web/src/components/ui/segmented.tsx")),
    tool("w5-test", "Bash", { kind: "execute", command: "bun run --cwd web test src/components" }, ok(" 41 pass\n 0 fail")),
  ),
  agent(
    "w6",
    6,
    text("Fixed in `tab-strip.tsx`: the open tab now carries `aria-current=\"page\"`, as the space and pane strips already do. All 41 strip tests pass. The segmented control keeps `aria-selected`, which is right for a tab list."),
  ),
];

// ── 4. Code and table ────────────────────────────────────────────────────────

const CODE_ANSWER = `Here is the helper. The long line is the one the back-off table below describes.

\`\`\`ts
export async function withRetry<T>(run: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { tries = 3, base = 250, cap = 4_000 } = opts;
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (attempt === tries) break;
      if (!isRetryable(error)) throw error;
      const wait = Math.min(cap, base * 2 ** (attempt - 1)) + jitter(base);
      await sleep(wait);
    }
  }
  throw last;
}

function jitter(base: number): number {
  return Math.floor(Math.random() * base);
}
\`\`\`

| Backend | Retries | Back-off | Notes |
| --- | --- | --- | --- |
| Herdr | 3 | 250 ms, doubling | socket is one-shot |
| tmux | 2 | 500 ms flat | control mode reconnects |
| zellij | 3 | 250 ms, doubling | plugin pipe |
| herdr-core | 1 | none | replay only |`;

const CODE: ChatEntry[] = [
  user("c1", 0, "Show me the retry helper and how the backends compare."),
  agent("c2", 1, text(CODE_ANSWER)),
];

// ── 5. Waiting ───────────────────────────────────────────────────────────────

const WAITING: ChatEntry[] = [
  entry("q0", 0, "summary", [text("The conversation so far.")]),
  user("q1", 2, "Clean up the old worktrees."),
  agent("q2", 3, text("There are three. I will ask before I delete any.")),
  entry("q3", 3, "note", [text("Conversation resumed.")]),
  agent(
    "q4",
    4,
    tool("q4-ask", "AskUserQuestion", {
      kind: "question",
      name: "AskUserQuestion",
      summary: "Which worktrees should I remove?",
      questions: [
        {
          header: "Worktrees",
          question: "Which worktrees should I remove?",
          multiple: true,
          options: [
            { label: "fix-748", description: "merged 2 days ago" },
            { label: "look/hill", description: "no commits for 3 weeks" },
            { label: "m90-pins", description: "1 commit not pushed" },
          ],
        },
      ],
    }),
  ),
];

/** The line the person sent in case 5, still on its way: the phone's own pending line (lib/durable-pending.ts). */
export const WAITING_PENDING = { requestId: "pg-chat-look-pending", text: "Keep m90-pins, it has work I have not pushed." } as const;

export const CHAT_LOOK_CASES = [
  { value: "short", label: "1 Short exchange" },
  { value: "long", label: "2 Long answer" },
  { value: "work", label: "3 Work run" },
  { value: "code", label: "4 Code and table" },
  { value: "waiting", label: "5 Waiting" },
] as const;

export type ChatLookCase = (typeof CHAT_LOOK_CASES)[number]["value"];

export const CHAT_LOOK_THREADS = {
  short: SHORT,
  long: LONG,
  work: WORK,
  code: CODE,
  waiting: WAITING,
} as const satisfies Record<ChatLookCase, ChatEntry[]>;
