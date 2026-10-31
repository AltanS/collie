// The pure parts of driving an agent: options, startup answers, draft clearing, colour answers.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { herdrMuxFactory } from "../../bridge/mux/herdr/adapter";
import { muxAck, muxOk, type MuxAdapter, type MuxGrid, type MuxOutcome } from "../../bridge/mux/types";
import { claude } from "./agents/claude";
import { CODEX_ARGS, codex } from "./agents/codex";
import { kiro } from "./agents/kiro";
import { muse } from "./agents/muse";
import { opencode } from "./agents/opencode";
import { pi } from "./agents/pi";
import { backspaceSweep, launchedThrough, launchLine, resolveBinary, versionCommandThrough } from "./agents/profile";
import { DEFAULT_AGENTS, parseArgs } from "./args";
import { buildRecipe } from "../../bridge/launcher-recipes";
import { colorAnswers, unfinishedTail } from "./client";
import { cleanEnv } from "./herdr";
import { JOURNAL_MESSAGE, MESSAGES, README_TOKEN, NARROW_DRAFT_IDS, SEND_IDS, messageById } from "./messages";
import { lastPointedRow } from "./dialogs";
import { answeredBelow, opaqueTokenRead, pressableBar } from "./scenarios";
import { loadReaders, type Adapter } from "./readers";
import { installTransport } from "./transport";
import { DEFAULT_SCENARIOS } from "./verdict";

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

describe("parseArgs", () => {
  test("defaults run the four default agents and the six default scenarios at the pane's own width", () => {
    const o = parseArgs([], "/repo");
    expect(o).not.toBe("help");
    if (o === "help") return;
    expect(o.agents).toEqual([...DEFAULT_AGENTS]);
    expect(o.scenarios).toEqual([...DEFAULT_SCENARIOS]);
    expect(o.cols).toBeNull();
    expect(o.readers).toBe("/repo");
    expect(o.record).toBe(false);
    expect(o.via).toBeNull();
  });

  test("omp and muse run only when named, and --via is resolved against the host", () => {
    const o = parseArgs(["--agent", "omp,muse", "--via", "/tmp/launchers"], "/repo");
    if (o === "help") throw new Error("help");
    expect(o.agents).toEqual(["omp", "muse"]);
    expect(DEFAULT_AGENTS).not.toContain("omp");
    expect(DEFAULT_AGENTS).not.toContain("muse");
    expect(o.via).toBe(resolve("/tmp/launchers"));
  });

  test("grok, hermes and agy run only when named, and options only when asked for", () => {
    const o = parseArgs(["--agent", "grok,hermes,agy", "--scenario", "options"], "/repo");
    if (o === "help") throw new Error("help");
    expect(o.agents).toEqual(["grok", "hermes", "agy"]);
    expect(o.scenarios).toEqual(["options"]);
    expect(DEFAULT_SCENARIOS).not.toContain("options");
  });

  test("the harness bar is pressed only when asked for", () => {
    const o = parseArgs(["--agent", "muse", "--scenario", "bar"], "/repo");
    if (o === "help") throw new Error("help");
    expect(o.scenarios).toEqual(["bar"]);
    expect(DEFAULT_SCENARIOS).not.toContain("bar");
  });

  test("--agent, --scenario, --cols, --readers", () => {
    const o = parseArgs(["--agent", "claude,codex", "--scenario", "idle,drafts", "--cols", "80", "--readers", "/tmp/c1131"], "/repo");
    if (o === "help") throw new Error("unexpected help");
    expect(o.agents).toEqual(["claude", "codex"]);
    expect(o.scenarios).toEqual(["idle", "drafts"]);
    expect(o.cols).toBe(80);
    // The flag is resolved against the host: `/tmp/c1131` is `C:\tmp\c1131` on Windows.
    expect(o.readers).toBe(resolve("/tmp/c1131"));
  });

  test("refuses what it does not know", () => {
    expect(() => parseArgs(["--agent", "gemini"], "/repo")).toThrow(/unknown agent/);
    expect(() => parseArgs(["--via"], "/repo")).toThrow(/needs a value/);
    expect(() => parseArgs(["--scenario", "plan"], "/repo")).toThrow(/unknown scenario/);
    expect(() => parseArgs(["--cols", "200"], "/repo")).toThrow(/--cols/);
    expect(() => parseArgs(["--readers"], "/repo")).toThrow(/needs a value/);
    expect(() => parseArgs(["--bogus"], "/repo")).toThrow(/unknown option/);
  });

  test("--dialogs adds dialogs and busy once, after whatever --scenario chose", () => {
    const all = parseArgs(["--dialogs"], "/repo");
    if (all === "help") throw new Error("unexpected help");
    expect(all.scenarios).toEqual(["idle", "drafts", "sends", "journal", "narrow", "start-exit", "dialogs", "busy"]);
    const some = parseArgs(["--scenario", "idle,busy", "--dialogs"], "/repo");
    if (some === "help") throw new Error("unexpected help");
    expect(some.scenarios).toEqual(["idle", "busy", "dialogs"]);
    const named = parseArgs(["--scenario", "dialogs"], "/repo");
    if (named === "help") throw new Error("unexpected help");
    expect(named.scenarios).toEqual(["dialogs"]);
  });

  test("--help", () => {
    expect(parseArgs(["--help"], "/repo")).toBe("help");
  });
});

describe("startup answers", () => {
  test("Claude's trust question: walk to yes, then Enter", () => {
    const onNo = ["Quick safety check", " ❯ No, exit", "   Yes, I trust this folder"];
    const onYes = ["Quick safety check", "   No, exit", " ❯ Yes, I trust this folder"];
    expect(claude.startupAnswer(onNo)).toEqual(["Down"]);
    expect(claude.startupAnswer(onYes)).toEqual(["Enter"]);
    expect(claude.startupAnswer(["❯ Try \"fix lint errors\""])).toBeNull();
  });

  test("Codex's trust question: Enter only with the pointer on trust", () => {
    const onYes = ["  Trust this folder? Codex can read", "› 1. Trust and continue", "  2. Quit"];
    const onQuit = ["  Trust this folder? Codex can read", "  1. Trust and continue", "› 2. Quit"];
    expect(codex.startupAnswer(onYes)).toEqual(["Enter"]);
    expect(codex.startupAnswer(onQuit)).toEqual(["Up"]);
    expect(codex.startupAnswer(["› Ask Codex to do anything"])).toBeNull();
  });

  test("Muse's trust question: Enter only with the pointer on trust", () => {
    const onYes = ["Do you trust this workspace?", "> 1  Trust and continue", "  2  Quit"];
    const onQuit = ["Do you trust this workspace?", "  1  Trust and continue", "> 2  Quit"];
    expect(muse.startupAnswer(onYes)).toEqual(["Enter"]);
    expect(muse.startupAnswer(onQuit)).toEqual(["Up"]);
    expect(muse.startupAnswer(["> "])).toBeNull();
  });

  test("Codex starts without its update prompt, which would answer Update now", () => {
    expect(codex.launch(null)).toContain("-c check_for_update_on_startup=false");
  });

  test("OpenCode starts without its update dialog, whose Confirm would update the install", () => {
    expect(opencode.launch(null)).toBe("clear; OPENCODE_DISABLE_AUTOUPDATE=1 opencode");
    expect(launchedThrough(opencode, "/opt/launchers/opencode").launch(null)).toBe("clear; OPENCODE_DISABLE_AUTOUPDATE=1 /opt/launchers/opencode");
  });

  test("Kiro starts the New sheet's program on V3, whatever the host's Kiro setting says", () => {
    const built = buildRecipe("kiro", []);
    if (!built.ok) throw new Error(built.reason);
    expect(kiro.launch(null)).toBe(`clear; ${built.command} chat --v3`);
    expect(launchedThrough(kiro, "/opt/launchers/kiro").launch(null)).toBe("clear; /opt/launchers/kiro chat --v3");
  });

  test("pi starts with --approve, so the canary's fresh project draws no trust card", () => {
    expect(pi.launch(null)).toBe("clear; pi --approve --thinking off");
    expect(launchedThrough(pi, "/opt/pi/bin/pi").launch(80)).toBe("clear; stty cols 80; /opt/pi/bin/pi --approve --thinking off");
  });

  test("Codex is never cleared with Ctrl+C", () => {
    expect(codex.clearFallback).toBeNull();
    for (const m of MESSAGES) expect(codex.clearKeys(m.text)).not.toContain("ctrl+c");
  });
});

describe("drafts and messages", () => {
  test("a Backspace sweep covers every character with slack, counting graphemes", () => {
    expect(backspaceSweep("abc")).toHaveLength(19);
    expect(backspaceSweep("🚀✅")).toHaveLength(18);
    expect(new Set(backspaceSweep("x"))).toEqual(new Set(["Backspace"]));
  });

  test("a launcher replaces only the command word, quoted when the path needs it", () => {
    expect(launchedThrough(claude, "/opt/launchers/claude").launch(null)).toBe("clear; /opt/launchers/claude --model haiku");
    expect(launchedThrough(codex, "/opt/launchers/codex").launch(80)).toBe(`clear; stty cols 80; /opt/launchers/codex ${CODEX_ARGS}`);
    expect(launchedThrough(claude, "/my dir/it's").launch(null)).toBe("clear; '/my dir/it'\\''s' --model haiku");
    expect(claude.launch(null)).toBe("clear; claude --model haiku");
  });

  test("launchLine sets the width only when asked", () => {
    expect(launchLine(null, "claude")).toBe("clear; claude");
    expect(launchLine(50, "claude")).toBe("clear; stty cols 50; claude");
  });

  // A deliberate inventory. `16-read` is NOT in it: the drafts sweep types every kind of message and
  // that one is an ordinary single line, so it belongs to the sends and not to this list (M41/05).
  test("fifteen draft kinds, including the pasted rule", () => {
    expect(MESSAGES).toHaveLength(15);
    expect(new Set(MESSAGES.map((m) => m.id)).size).toBe(15);
    expect(messageById("15-rule").text).toContain("────");
  });

  // The rule is a SHORT reply, so a send that lands costs one short model turn. "only OK" was its
  // wording, not its point: 16-read asks for the README token instead, because a prompt answerable
  // without opening the file lets an agent skip the tool call the journal scenario exists to see.
  test("four sends: plain, the rule, Chinese and the read; each asks for a one-word reply", () => {
    expect(SEND_IDS).toEqual(["01-plain", "15-rule", "09-cjk", "16-read"]);
    for (const id of [...SEND_IDS, ...NARROW_DRAFT_IDS]) {
      expect(messageById(id).text).toMatch(/only OK|只回复 OK|only the token it names/);
    }
  });

  test("the journal send cannot be answered without opening the file", () => {
    expect(JOURNAL_MESSAGE.text).not.toMatch(/only OK/);
    expect(JOURNAL_MESSAGE.text).toContain("token");
  });

  // The `journal` scenario needs a tool item in the agent's own log, and a Bash command would park
  // Claude on a permission dialog nobody is there to answer (messages.ts says so at the constant).
  test("the journal send asks for a file READ, never a shell command", () => {
    expect(JOURNAL_MESSAGE.id).toBe("16-read");
    expect(JOURNAL_MESSAGE.text).toContain("Read the file README.md");
    expect(JOURNAL_MESSAGE.text).not.toMatch(/\brun\b|`|echo/i);
  });
});

describe("opaqueTokenRead", () => {
  const chip = (draft: string) => /^📄 #\d+$/.test(draft);
  const omp: Adapter = { agent: "omp", extractInputDraft: () => null, draftIsOpaque: chip };

  test("a token with no evidence of its content counts as the draft read back", () => {
    expect(opaqueTokenRead(omp, "📄 #1")).toBe(true);
  });

  test("real text, no draft or no adapter is not a token read", () => {
    expect(opaqueTokenRead(omp, "Reply with only OK.")).toBe(false);
    expect(opaqueTokenRead(omp, null)).toBe(false);
    expect(opaqueTokenRead(undefined, "📄 #1")).toBe(false);
  });

  test("a harness whose token can be matched to the send keeps that stricter check", () => {
    const matched: Adapter = { ...omp, agent: "claude", draftCarriesSend: () => false };
    expect(opaqueTokenRead(matched, "📄 #1")).toBe(false);
  });
});

describe("answeredBelow", () => {
  const plain = messageById("01-plain");
  const read = JOURNAL_MESSAGE;

  test("the read send expects the token the README holds, and no other message declares an answer", () => {
    expect(read.answer).toBe(README_TOKEN);
    for (const m of MESSAGES) expect(m.answer).toBeUndefined();
  });

  test("the token below the read prompt counts, with a bullet, a period or neither", () => {
    for (const row of [README_TOKEN, `• ${README_TOKEN}`, `⏺ ${README_TOKEN}.`, `  ${README_TOKEN}  `]) {
      expect(answeredBelow([`› ${read.text}`, row], read.text, read.answer)).toBe(true);
    }
  });

  test("an OK row still answers a message with no declared answer", () => {
    for (const row of ["OK", "• OK", "⏺ OK."]) expect(answeredBelow([`› ${plain.text}`, row], plain.text)).toBe(true);
  });

  test("a token reply does not satisfy an OK message, and OK does not satisfy the read", () => {
    expect(answeredBelow([`› ${plain.text}`, README_TOKEN], plain.text)).toBe(false);
    expect(answeredBelow([`› ${read.text}`, "OK"], read.text, read.answer)).toBe(false);
  });

  test("prose that holds the token mid-sentence, or a token above the prompt, does not count", () => {
    expect(answeredBelow([`› ${read.text}`, `The token is ${README_TOKEN}, as the file says.`], read.text, read.answer)).toBe(false);
    expect(answeredBelow([README_TOKEN, `› ${read.text}`], read.text, read.answer)).toBe(false);
  });
});

describe("the canary's client answers colour queries", () => {
  test("background, foreground and palette, with the query's own terminator", () => {
    expect(colorAnswers(`x${ESC}]11;?${ESC}\\`)).toEqual([`${ESC}]11;rgb:1e1e/1e1e/2e2e${ESC}\\`]);
    expect(colorAnswers(`${ESC}]10;?${BEL}`)).toEqual([`${ESC}]10;rgb:cdcd/d6d6/f4f4${BEL}`]);
    expect(colorAnswers(`${ESC}]4;196;?${BEL}`)).toEqual([`${ESC}]4;196;rgb:ffff/0000/0000${BEL}`]);
    expect(colorAnswers(`${ESC}]11;rgb:0/0/0${BEL}`)).toEqual([]);
  });

  test("a query cut in two is carried to the next read, a finished one is not", () => {
    expect(unfinishedTail(`abc${ESC}]11`)).toBe(`${ESC}]11`);
    expect(unfinishedTail(`abc${ESC}]11;?${BEL}`)).toBe("");
    expect(unfinishedTail(`abc${ESC}\\`)).toBe("");
    expect(unfinishedTail("abc")).toBe("");
  });
});

test("cleanEnv drops the operator's Herdr and Claude Code markers and points at the canary socket", () => {
  const env = cleanEnv(
    { PATH: "/bin", HERDR_PANE_ID: "w3Q:p27", HERDR_SOCKET_PATH: "/op.sock", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" },
    "/canary.sock",
    "/cfg.toml",
  );
  expect(env).toEqual({ PATH: "/bin", HERDR_SOCKET_PATH: "/canary.sock", HERDR_CONFIG_PATH: "/cfg.toml" });
});

describe("lastPointedRow", () => {
  test("takes the dialog's pointer, not an echoed prompt above it", () => {
    const texts = ["❯ Use the AskUserQuestion tool to ask me", "Which fruit?", "  1. Apple", "❯ 2. Banana", "  3. Type something."];
    expect(lastPointedRow(texts, "❯")).toBe("2. Banana");
    expect(lastPointedRow(["no pointer here"], "❯")).toBeNull();
  });
});

describe("pressableBar", () => {
  test("presses the picker buttons in bar order, never Compact and never a two-tap row", () => {
    const bar = [
      { id: "model", command: "/model" },
      { id: "compact", command: "/compact" },
      { id: "wipe", command: "/clear", confirm: true },
      { id: "resume", command: "/resume" },
    ];
    expect(pressableBar(bar).map((i) => i.id)).toEqual(["model", "resume"]);
    expect(pressableBar([])).toEqual([]);
  });
});

describe("loadReaders on this checkout", () => {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const rule = "─".repeat(40);

  test("loads draftCarriesSend and routes sendGuardedReply through /api/send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-canary-readers-"));
    const globals = ["localStorage", "document", "fetch"] as const;
    const saved = new Map(globals.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    let box = "";
    let revision = 1;
    const typed: string[] = [];
    const render = (): string =>
      ["> earlier", "", rule, box === "" ? "❯ \u001b[2mTry something\u001b[0m" : `❯ ${box}`, rule, "  status row"].join("\n");
    const baseMux = herdrMuxFactory.create({ endpoint: "/unused.sock", timeoutMs: 5000, options: {} });
    const mux: MuxAdapter = {
      ...baseMux,
      readGrid: (paneId: string): Promise<MuxOutcome<MuxGrid>> =>
        Promise.resolve(muxOk({ paneId, text: render(), truncated: false, revision })),
      typeText: (_paneId: string, text: string) => {
        typed.push(text);
        box += text;
        revision++;
        return Promise.resolve(muxAck());
      },
      writeKeys: (_paneId: string, keys: readonly string[]) => {
        for (const key of keys) {
          if (key === "Enter") box = "";
          else if (key === "Backspace") box = [...box].slice(0, -1).join("");
        }
        revision++;
        return Promise.resolve(muxAck());
      },
    };
    try {
      const transport = installTransport(
        {
          socket: "/unused.sock",
          isOwnedPane: (id: string) => id === "w1:p1",
          paneInfo: () => ({ agent: "claude", status: "idle", session: null }),
        },
        dir,
        { mux, versionOf: () => Promise.resolve("2.1.200") },
      );
      const readers = await loadReaders(repoRoot);
      if (readers.markLive !== undefined) transport.onLiveRead(readers.markLive);
      expect(readers.draftCarriesSend("ship it\nplease", "ship it please")).toBe(true);
      expect(readers.draftCarriesSend("ship it", "something else")).toBe(false);
      expect(readers.barFor?.("claude").map((i) => i.id)).toEqual(["model", "effort", "compact", "resume"]);

      await transport.readScreen("w1:p1");
      const sent = await readers.sendGuardedReply("w1:p1", "Reply with only OK.", "claude");
      expect(sent).toEqual({ status: "sent" });
      expect(typed).toContain("Reply with only OK.");
      expect(transport.audit.length).toBe(1);

      const bar = await readers.sendGuardedReply("w1:p1", "/model", "claude");
      expect(bar).toEqual({ status: "sent" });
      expect(transport.audit.length).toBe(2);

      // A legacy `--readers` checkout's one-shot send posts `{ text, submit: true }` with no `id`.
      const legacyRes = await fetch("/api/pane/w1%3Ap1/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "legacy one-shot", submit: true }),
      });
      expect(legacyRes.status).toBe(200);
      expect(typed).toContain("legacy one-shot");
      expect(transport.audit.length).toBe(3);
    } finally {
      for (const k of globals) {
        const desc = saved.get(k);
        if (desc !== undefined) Object.defineProperty(globalThis, k, desc);
        else Reflect.deleteProperty(globalThis, k);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("the binary the canary measures", () => {
  const tree = (): string => mkdtempSync(join(tmpdir(), "canary-bin-"));
  const exe = (dir: string, name: string): string => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  };

  test("a stray node_modules/.bin in front of PATH never wins; every agent follows the same rule", () => {
    const root = tree();
    try {
      for (const name of ["pi", "omp", "claude"]) {
        exe(join(root, "home", "node_modules", ".bin"), name);
        const real = exe(join(root, "nvm", "bin"), name);
        const pathVar = [join(root, "home", "node_modules", ".bin"), join(root, "nvm", "bin")].join(delimiter);
        expect(resolveBinary(name, pathVar)).toBe(real);
      }
      expect(resolveBinary("pi", join(root, "home", "node_modules", ".bin"))).toBeNull();
      expect(resolveBinary("nope", join(root, "nvm", "bin"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the version command and the launch line name the same path", () => {
    expect(versionCommandThrough(pi, "/real/bin/pi")).toEqual(["/real/bin/pi", "--version"]);
    expect(launchedThrough(pi, "/real/bin/pi").launch(null)).toContain("/real/bin/pi ");
    expect(versionCommandThrough(kiro, "/real/bin/kiro-cli")).toEqual(["/real/bin/kiro-cli", "--version"]);
  });
});
