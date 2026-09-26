// The pure parts of driving an agent: options, startup answers, draft clearing, colour answers.

import { describe, expect, test } from "bun:test";
import { claude } from "./agents/claude";
import { codex } from "./agents/codex";
import { backspaceSweep, launchLine } from "./agents/profile";
import { CANARY_AGENTS, parseArgs } from "./args";
import { colorAnswers, unfinishedTail } from "./client";
import { cleanEnv } from "./herdr";
import { MESSAGES, NARROW_DRAFT_IDS, SEND_IDS, messageById } from "./messages";
import { SCENARIOS } from "./verdict";

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

describe("parseArgs", () => {
  test("defaults run every agent and scenario at the pane's own width", () => {
    const o = parseArgs([], "/repo");
    expect(o).not.toBe("help");
    if (o === "help") return;
    expect(o.agents).toEqual([...CANARY_AGENTS]);
    expect(o.scenarios).toEqual([...SCENARIOS]);
    expect(o.cols).toBeNull();
    expect(o.readers).toBe("/repo");
    expect(o.record).toBe(false);
  });

  test("--agent, --scenario, --cols, --readers", () => {
    const o = parseArgs(["--agent", "claude,codex", "--scenario", "idle,drafts", "--cols", "80", "--readers", "/tmp/c1131"], "/repo");
    if (o === "help") throw new Error("unexpected help");
    expect(o.agents).toEqual(["claude", "codex"]);
    expect(o.scenarios).toEqual(["idle", "drafts"]);
    expect(o.cols).toBe(80);
    expect(o.readers).toBe("/tmp/c1131");
  });

  test("refuses what it does not know", () => {
    expect(() => parseArgs(["--agent", "grok"], "/repo")).toThrow(/unknown agent/);
    expect(() => parseArgs(["--scenario", "dialogs"], "/repo")).toThrow(/unknown scenario/);
    expect(() => parseArgs(["--cols", "200"], "/repo")).toThrow(/--cols/);
    expect(() => parseArgs(["--readers"], "/repo")).toThrow(/needs a value/);
    expect(() => parseArgs(["--bogus"], "/repo")).toThrow(/unknown option/);
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

  test("launchLine sets the width only when asked", () => {
    expect(launchLine(null, "claude")).toBe("clear; claude");
    expect(launchLine(50, "claude")).toBe("clear; stty cols 50; claude");
  });

  test("fifteen message kinds, including the pasted rule", () => {
    expect(MESSAGES).toHaveLength(15);
    expect(new Set(MESSAGES.map((m) => m.id)).size).toBe(15);
    expect(messageById("15-rule").text).toContain("────");
  });

  test("three sends: plain, the rule and Chinese; each asks for only OK", () => {
    expect(SEND_IDS).toEqual(["01-plain", "15-rule", "09-cjk"]);
    for (const id of [...SEND_IDS, ...NARROW_DRAFT_IDS]) expect(messageById(id).text).toMatch(/only OK|只回复 OK/);
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
