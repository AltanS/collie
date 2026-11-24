// The self-answer countdown of a Claude Code permission is left out of the binding only where it is
// the dialog's OWN countdown (web/src/lib/harness/claude/countdown.ts): alone on its rows, the only
// match, the last thing above the question. An agent writes its own command, so the same sentence
// inside the command, a second copy, or a copy in another place must stay bound, and the bridge must
// refuse a list binding whose left-out rows are anything but one countdown sentence.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { DIALOG_CONTRACT } from "../web/src/lib/harness/dialog-contract.ts";
import { detectPromptSelect } from "../web/src/lib/harness/claude/prompt-select.ts";
import { holdsOnlyCountdown, ownCountdown } from "../web/src/lib/harness/claude/countdown.ts";
import { promptsEqual } from "../web/src/lib/harness/prompt-model.ts";
import { AuditLog } from "./audit.ts";
import { loadConfig } from "./config.ts";
import type { HerdrClient, PaneRead } from "./mux/herdr/client.ts";
import { HerdrMux } from "./mux/herdr/adapter.ts";
import type { MuxAdapter } from "./mux/types.ts";
import { normalizePromptRegion, verifyPromptParts } from "./prompt-binding.ts";
import { keysPane } from "./server.ts";

class FakePaneClient {
  text = "";
  readonly keys: Array<[string, string[]]> = [];

  readPane(paneId: string): Promise<PaneRead> {
    return Promise.resolve({ pane_id: paneId, text: this.text, truncated: false, revision: 1 });
  }

  sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    this.keys.push([paneId, keys]);
    return Promise.resolve();
  }
}

function asMux(fake: Partial<HerdrClient>): MuxAdapter {
  // SAFETY: keysPane reaches only readPane and sendPaneKeys, both implemented by FakePaneClient.
  return new HerdrMux(fake as HerdrClient, () => []);
}

const BG = readFileSync(new URL("../web/src/fixtures/panes/claude--v2303-permission-bash-bg-agent-rm--w160.txt", import.meta.url), "utf8");
const DENY = (clock: string) => `⚠ Claude Code will automatically deny this request in ${clock}, to avoid blocking progress on an unattended session`;
const BLOCK = (clock: string) => `⚠ Claude Code will automatically block this request in ${clock}, to avoid holding up an unattended session`;
const WORDINGS = [
  ["deny", DENY],
  ["block", BLOCK],
] as const;
const CLOCKS = ["1:20", "1:19", "0:59", "0:05", "about 2 minutes", "about 1 minute", "about 45 seconds", "about 1 second"];
const WARN = " \u001b[0m\u001b[2m│\u001b[0m \u001b[38;2;255;193;7m";
const GUTTER = " \u001b[0m\u001b[2m│\u001b[0m ";
/** The command's last row in the capture (the one `level.py` stands on alone). */
const LAST_CMD = (row: string) => row.includes("/tmp/earshot-work/scripts/level.py") && !row.includes("sed -i");

interface ScreenOptions {
  /** The dialog's own countdown, under the explanation row, as Claude Code draws it. */
  countdown?: string;
  /** Wrap the countdown after this many words, as a narrow box does. */
  breakAfter?: number;
  /** Replace the command's last row with this text, behind the box's gutter. */
  cmd?: string;
  /** Put a row with this text, behind the gutter, in the middle of the command. */
  insideCmd?: string;
}

function screen(opts: ScreenOptions): string {
  const rows = BG.split("\n");
  if (opts.cmd !== undefined) rows[rows.findIndex(LAST_CMD)] = `${GUTTER}${opts.cmd}\r`;
  if (opts.insideCmd !== undefined) {
    const at = rows.findIndex((row) => row.includes("cp_ tap-j tap"));
    rows.splice(at, 0, `${WARN}${opts.insideCmd}\u001b[0m\r`);
  }
  if (opts.countdown !== undefined) {
    const at = rows.findIndex((row) => row.includes("Dangerous rm operation"));
    const words = opts.countdown.split(" ");
    const lines = opts.breakAfter === undefined ? [opts.countdown] : [words.slice(0, opts.breakAfter).join(" "), words.slice(opts.breakAfter).join(" ")];
    rows.splice(at + 1, 0, ...lines.map((line) => `${WARN}${line}\u001b[0m\r`));
  }
  return rows.join("\n");
}

function model(text: string) {
  const m = detectPromptSelect(splitLines(parseAnsi(text)));
  expect(m).not.toBeNull();
  return m!;
}

/** What the phone puts in `expected_prompt` for the dialog it showed (dialog-guard `sendBoundKeys`). */
function phoneBinding(text: string): string | readonly string[] {
  const m = model(text);
  const contract = DIALOG_CONTRACT["prompt-select"];
  return contract.parts?.(m) ?? contract.region(m);
}

async function tap(expected: string | readonly string[], onScreen: string) {
  const client = new FakePaneClient();
  client.text = onScreen;
  const req = new Request("http://localhost/api/pane/w1%3Ap1/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: ["1"], expected_prompt: expected }),
  });
  const res = await keysPane(asMux(client), loadConfig({}), "w1:p1", req, new AuditLog(() => undefined), "phone", "default");
  return { status: res.status, keys: client.keys };
}

describe("a countdown sentence the agent wrote is not the dialog's countdown", () => {
  test("the sentence inside the command, with the real countdown under it: the command stays bound and a changed command is refused", async () => {
    for (const [, S] of WORDINGS) {
      const shown = screen({ countdown: S("1:20"), cmd: `echo "${S("1:20")}"; rm -rf ./a` });
      const binding = phoneBinding(shown);
      expect(Array.isArray(binding)).toBe(false);
      expect(String(binding)).toContain("rm -rf ./a");
      expect(String(binding)).toContain("Dangerous rm operation");
      const other = screen({ countdown: S("1:19"), cmd: `echo "${S("1:19")}"; rm -rf ./b` });
      const refused = await tap(binding, other);
      expect(refused.status).toBe(409);
      expect(refused.keys).toEqual([]);
      // The reviewer's parts, as the old phone cut them, refused by the bridge itself.
      const rows = normalizePromptRegion(shown);
      const cmdAt = rows.findIndex((row) => row.includes("rm -rf ./a"));
      const qAt = rows.findIndex((row) => row.includes("Do you want to proceed?"));
      const edge = rows.findIndex((row) => row.includes("Bash command"));
      const oldParts = [rows.slice(edge - 1, cmdAt).join("\n"), rows.slice(qAt).join("\n")];
      expect(verifyPromptParts(other, oldParts).ok).toBe(false);
      expect((await tap(oldParts, other)).status).toBe(409);
    }
  });

  test("one match only, inside the command row, no real countdown: the command row is bound and its clock is in the ask", () => {
    for (const [, S] of WORDINGS) {
      const m = model(screen({ cmd: `echo "${S("1:20")}"; rm -rf ./a` }));
      expect(m.bindParts).toBeUndefined();
      expect(m.bindRegion).toContain(`echo "${S("1:20")}"; rm -rf ./a`);
      expect(m.askRegion).toContain(S("1:20"));
      const ticked = model(screen({ cmd: `echo "${S("1:19")}"; rm -rf ./a` }));
      expect(ticked.askRegion).not.toBe(m.askRegion);
      expect(promptsEqual(m, ticked)).toBe(false);
    }
  });

  test("two matches, the command's and the dialog's own: the whole rows are bound and a tick changes the ask", async () => {
    for (const [, S] of WORDINGS) {
      const cmd = `echo "${S("9:59")}"`;
      const shown = model(screen({ countdown: S("1:20"), cmd }));
      expect(shown.bindParts).toBeUndefined();
      expect(shown.bindRegion).toContain(S("1:20"));
      expect(shown.bindRegion).toContain(cmd);
      const ticked = model(screen({ countdown: S("1:19"), cmd }));
      expect(ticked.askRegion).not.toBe(shown.askRegion);
      expect(promptsEqual(shown, ticked)).toBe(false);
      // Fails closed: the tap a second later is refused, the person answers at the desk.
      expect((await tap(phoneBinding(screen({ countdown: S("1:20"), cmd })), screen({ countdown: S("1:19"), cmd }))).status).toBe(409);
    }
  });

  test("the sentence alone on its row but inside a multi-line command is not the countdown", async () => {
    for (const [, S] of WORDINGS) {
      const shown = model(screen({ insideCmd: S("1:20") }));
      expect(shown.bindParts).toBeUndefined();
      expect(shown.bindRegion).toContain(S("1:20"));
      const ticked = model(screen({ insideCmd: S("1:19") }));
      expect(ticked.askRegion).not.toBe(shown.askRegion);
      expect((await tap(phoneBinding(screen({ insideCmd: S("1:20") })), screen({ insideCmd: S("1:19") }))).status).toBe(409);
    }
  });

  test("the sentence alone on its row but with a row of other text between it and the question is not the countdown", () => {
    const rows = screen({ countdown: DENY("1:20") }).split("\n");
    const at = rows.findIndex((row) => row.includes("automatically deny"));
    rows.splice(at + 1, 0, `${GUTTER}rm -rf ./a\r`);
    const m = model(rows.join("\n"));
    expect(m.bindParts).toBeUndefined();
    expect(m.askRegion).toContain(DENY("1:20"));
  });
});

describe("the bridge checks the rows a list binding leaves out", () => {
  test("a forged list whose gap is a command row, or a sentence with other words beside it, is refused with nothing typed", async () => {
    const shown = screen({});
    const rows = normalizePromptRegion(shown);
    const edge = rows.findIndex((row) => row.includes("Bash command")) - 1;
    const cmdAt = rows.findIndex(LAST_CMD);
    const forged = [rows.slice(edge, cmdAt).join("\n"), rows.slice(cmdAt + 1).join("\n")];
    const changed = shown.replace("/tmp/earshot-work/scripts/level.py\r", "/tmp/earshot-work/scripts/other.py\r");
    expect(changed).not.toBe(shown);
    for (const read of [shown, changed]) {
      expect(verifyPromptParts(read, forged)).toEqual({ ok: false, reason: "not_found" });
      const refused = await tap(forged, read);
      expect(refused.status).toBe(409);
      expect(refused.keys).toEqual([]);
    }
    const quoted = screen({ cmd: `echo "${DENY("1:20")}"; rm -rf ./a` });
    const quotedRows = normalizePromptRegion(quoted);
    const quotedAt = quotedRows.findIndex((row) => row.includes("rm -rf ./a"));
    const sneaky = [quotedRows.slice(edge, quotedAt).join("\n"), quotedRows.slice(quotedAt + 1).join("\n")];
    expect(verifyPromptParts(quoted.replace("./a", "./b"), sneaky)).toEqual({ ok: false, reason: "not_found" });
  });

  test("holdsOnlyCountdown takes one sentence alone on its rows, and nothing else", () => {
    expect(holdsOnlyCountdown([` │ ${DENY("1:20")}`])).toBe(true);
    expect(holdsOnlyCountdown([` │ ${BLOCK("about 45 seconds")} │`])).toBe(true);
    const words = BLOCK("0:05").split(" ");
    expect(holdsOnlyCountdown([` │ ${words.slice(0, 9).join(" ")}`, ` │ ${words.slice(9).join(" ")}`])).toBe(true);
    expect(holdsOnlyCountdown([])).toBe(false);
    expect(holdsOnlyCountdown([` │ rm -rf ./a`])).toBe(false);
    expect(holdsOnlyCountdown([` │ echo "${DENY("1:20")}"`])).toBe(false);
    expect(holdsOnlyCountdown([` │ ${DENY("1:20")}; rm -rf ./a`])).toBe(false);
    expect(holdsOnlyCountdown([` │ ${DENY("1:20")}`, " │ rm -rf ./a"])).toBe(false);
    expect(holdsOnlyCountdown([" │ rm -rf ./a", ` │ ${DENY("1:20")}`])).toBe(false);
    expect(holdsOnlyCountdown([` │ ${DENY("1:20")}`, ` │ ${DENY("1:19")}`])).toBe(false);
    expect(holdsOnlyCountdown([` │ ${DENY("1:20").replace("⚠ ", "")}`])).toBe(false);
    expect(holdsOnlyCountdown([` │ ${DENY("1:20").replace("deny", "allow")}`])).toBe(false);
    expect(holdsOnlyCountdown([` │ ${DENY("1:20")}`, ""])).toBe(false);
  });

  test("ownCountdown wants the sentence as the last thing above the question", () => {
    const rows = [" Bash command", " │ rm -rf ./a", ` │ ${DENY("1:20")}`, "", " Do you want to proceed?", " ❯ 1. Yes"];
    expect(ownCountdown(rows, 4)).not.toBeNull();
    expect(ownCountdown(rows, 2)).toBeNull();
    const below = [" Bash command", " │ rm -rf ./a", " Do you want to proceed?", ` │ ${DENY("1:20")}`, " ❯ 1. Yes"];
    expect(ownCountdown(below, 2)).toBeNull();
  });
});

describe("the dialog's own countdown still holds still", () => {
  test("both wordings, every clock, rewrapped: one ask, a later tap gets through, another command is refused", async () => {
    for (const [, S] of WORDINGS) {
      const reference = model(screen({ countdown: S("1:20") }));
      expect(reference.bindParts).toHaveLength(2);
      for (const breakAfter of [undefined, 3, 9, 10, 14]) {
        for (const clock of CLOCKS) {
          const after = model(screen({ countdown: S(clock), breakAfter }));
          expect(after.askRegion).toBe(reference.askRegion);
          expect(promptsEqual(reference, after)).toBe(true);
        }
      }
      const shown = phoneBinding(screen({ countdown: S("1:20") }));
      for (const [clock, breakAfter] of [["1:19", undefined], ["0:05", 9], ["about 45 seconds", 10]] as const) {
        const passed = await tap(shown, screen({ countdown: S(clock), breakAfter }));
        expect(passed.status).toBe(200);
        expect(passed.keys).toEqual([["w1:p1", ["1"]]]);
      }
      const other = screen({ countdown: S("1:19"), cmd: "/tmp/earshot-work/scripts/other.py" });
      expect((await tap(shown, other)).status).toBe(409);
    }
  });
});
