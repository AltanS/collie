// The message kinds the canary types into an agent's input box.
//
// 01 to 14 are the hand set from 2026-09-26 (`/tmp/send-repro/*.txt`), the one every kind of which
// was sent live on Claude Code 2.1.283 and Codex 0.156.1 for 1.13.2. 15 is the pasted rule: a
// `────` line inside the draft, the screen 1.13.1's Claude reader lost the input box on. Every
// message asks for "only OK", so a send that does land costs one short model turn.

export interface CanaryMessage {
  /** Stable id, also the capture file name. */
  readonly id: string;
  readonly text: string;
}

const RULE = "────────────────────";

export const MESSAGES: readonly CanaryMessage[] = [
  { id: "01-plain", text: "Reply with only OK." },
  {
    id: "02-long",
    text: "Reply with only OK. This is a long line that keeps going to force the input box to wrap across rows. This is a long line that keeps going to force the input box to wrap across rows. This is a long line that keeps going to force the input box to wrap across rows. This is a long line that keeps going to force the input box to wrap across rows. This is a long line that keeps going to force the input box to wrap across rows. ",
  },
  { id: "03-two-lines", text: "Reply with only OK.\nSecond line of the message." },
  { id: "04-blank-line", text: "Reply with only OK.\n\nA paragraph after a blank line." },
  { id: "05-bullets", text: "Reply with only OK.\n- first point\n- second point" },
  { id: "06-numbered", text: "Reply with only OK.\n1. first item\n2. second item\n3. third item" },
  { id: "07-indented", text: "Reply with only OK.\n    indented code line\n    another indented line" },
  { id: "08-fence", text: "Reply with only OK.\n```\nconst x = 1;\n```" },
  { id: "09-cjk", text: "请只回复 OK。这是一条中文消息。" },
  {
    id: "10-cjk-long",
    text: "请只回复 OK。这是一条很长的中文消息，用来测试输入框换行的情况。这是一条很长的中文消息，用来测试输入框换行的情况。这是一条很长的中文消息，用来测试输入框换行的情况。这是一条很长的中文消息，用来测试输入框换行的情况。这是一条很长的中文消息，用来测试输入框换行的情况。这是一条很长的中文消息，用来测试输入框换行的情况。",
  },
  { id: "11-emoji", text: "Reply with only OK. 🚀✅ done" },
  { id: "12-question", text: "Reply with only OK.\nDo you want to proceed?\n1. Yes\n2. No" },
  { id: "13-heading", text: "# Heading\nReply with only OK." },
  {
    id: "14-long-multi",
    text: [
      "Reply with only OK.",
      ...Array.from({ length: 12 }, (_unused, i) => `Line ${i}: some more words to make this paragraph longer than usual.`),
    ].join("\n"),
  },
  { id: "15-rule", text: `Reply with only OK.\n${RULE}\nsome text\n${RULE}\nend` },
];

/**
 * The send that makes the agent USE A TOOL, so its own log holds a tool item for the `journal`
 * scenario to assert (spec M41/05). Not in {@link MESSAGES}: the drafts sweep types every kind of
 * message and this one is an ordinary single line, so it would add a draft case that tests nothing.
 *
 * A READ and not a shell command, deliberately. Claude Code asks before Bash in its default mode, so
 * "run `echo`" would park the pane on a permission dialog with nobody to answer it — the dialogs
 * scenario opens those on purpose, in panes of its own, and this one must not. A file read is
 * pre-approved on Claude, runs inside Codex's default sandbox, and needs no config on OpenCode. The
 * file is the one `freshProject()` commits, so it exists in every canary pane.
 */
export const JOURNAL_MESSAGE: CanaryMessage = {
  id: "16-read",
  // It asks for the TOKEN, not for "OK". "Reply with only OK" can be answered without opening
  // anything, and on 2026-09-30 codex 0.156.1 and 0.159.2 both did exactly that: they answered in
  // words, made no tool call, and the scenario reached no verdict. A prompt whose answer lives
  // ONLY in the file cannot be short-circuited. `run.ts` § freshProject writes the token.
  // The reply is still one word, so the cost rule above is kept.
  text: "Read the file README.md in this folder, then reply with only the token it names.",
};

/** The four real sends of scenario 3: plain, multi-line with a `────` line, Chinese, and the read. */
export const SEND_IDS: readonly string[] = ["01-plain", "15-rule", "09-cjk", "16-read"];

/** The two drafts scenario 4 types at 50 columns: one that wraps, and the pasted rule. */
export const NARROW_DRAFT_IDS: readonly string[] = ["02-long", "15-rule"];

export function messageById(id: string): CanaryMessage {
  const found = [...MESSAGES, JOURNAL_MESSAGE].find((m) => m.id === id);
  if (found === undefined) throw new Error(`no canary message ${id}`);
  return found;
}
