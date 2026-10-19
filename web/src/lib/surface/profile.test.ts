import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import ledgerJson from "../harness/verified-versions.json";
import { asJsonObject, parseJsonObject, type JsonObject, type JsonValue } from "../json";
import {
  findProfile,
  forPlatform,
  loadProfiles,
  parseProfile,
  ProfileError,
  profileFor,
  profileForPlatform,
  resetProfileLog,
  versionFromOutput,
  type Profile,
} from "./profile";
import { PROFILE_FILES } from "./profiles/index";

const PROFILES_DIR = join(import.meta.dirname, "profiles");
const profileFiles = readdirSync(PROFILES_DIR).filter((name) => name.endsWith(".json"));

function rawClaude(): JsonObject {
  const raw = parseJsonObject(readFileSync(join(PROFILES_DIR, "claude.json"), "utf8"));
  if (raw === undefined) throw new Error("claude.json is not a JSON object");
  return raw;
}

/** Set (or, with undefined, delete) the value at a path of keys inside a parsed profile. */
function change(raw: JsonObject, path: readonly (string | number)[], value: JsonValue | undefined): JsonObject {
  const copy: JsonObject = JSON.parse(JSON.stringify(raw));
  let node: JsonValue | undefined = copy;
  for (const key of path.slice(0, -1)) {
    node = Array.isArray(node) ? node[Number(key)] : asJsonObject(node)?.[String(key)];
  }
  const last = path.at(-1)!;
  if (Array.isArray(node)) node[Number(last)] = value ?? null;
  else if (value === undefined) delete asJsonObject(node)![String(last)];
  else asJsonObject(node)![String(last)] = value;
  return copy;
}

/** The error a bad file raises, so a test can read the path. */
function failure(raw: JsonValue): ProfileError {
  try {
    parseProfile(raw);
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("parseProfile accepted a bad profile");
}

describe("every profile file", () => {
  it("is registered, and parses", () => {
    expect(profileFiles.length).toBeGreaterThan(0);
    expect(Object.keys(PROFILE_FILES).toSorted()).toEqual(profileFiles.map((name) => name.replace(/\.json$/, "")).toSorted());
    for (const name of profileFiles) {
      const profile = parseProfile(parseJsonObject(readFileSync(join(PROFILES_DIR, name), "utf8"))!);
      expect(`${profile.id}.json`).toBe(name);
    }
    expect([...loadProfiles().keys()].toSorted()).toEqual(profileFiles.map((name) => name.replace(/\.json$/, "")).toSorted());
  });

  it("carries every field the spec names, in the Claude file", () => {
    const claude = parseProfile(rawClaude());
    expect(claude.identity.versionCommand).toEqual(["claude", "--version"]);
    expect(claude.versions.length).toBeGreaterThan(0);
    expect(claude.idle.frame.prompt.pattern).toContain("(?<draft>");
    expect(claude.idle.placeholders.sgr).toBe(2);
    expect(claude.idle.placeholders.texts).toContain("Press up to edit queued messages");
    expect(claude.idle.volatile.below.maxRows).toBe(8);
    expect(claude.keys.submit).toEqual(["Enter"]);
    expect(claude.keys.interrupt).toEqual(["Escape"]);
    expect(claude.keys.enterWhileRunning).toBe("queues");
    expect(claude.keys.queuedRow?.hintGap).toBe(1);
    expect(claude.reservedLeads).toEqual(["/", "!", "@"]);
    // The slice 0 lab (M56 spec 01, LAB.md table 1) named the inert character; spec 05 writes it in.
    expect(claude.probe.char).toBe("⌁");
    expect(claude.probe.status).toBe("verified");
    expect(claude.paste).toEqual({ bracketed: true });
    // M56 spec 08: an ask that left the screen is voided after this lifetime.
    expect(claude.ask).toEqual({ lifetimeMs: 5000 });
    expect(claude.hooks.PermissionRequest).toBe("ask");
    expect(claude.hooks.Stop).toBe("edge");
  });

  it("matches the long-paste form with and without a line count", () => {
    const { collapse } = parseProfile(rawClaude());
    const form = new RegExp(collapse.pattern, "u");
    expect(form.exec("[Pasted text #3]")?.groups?.lines).toBeUndefined();
    expect(form.exec("[Pasted text #3 +59 lines]")?.groups?.lines).toBe("59");
  });

  it("matches the queued rows Claude Code 2.1.301 draws (claude--v2301-working-queued-message--w100)", () => {
    const queuedRow = parseProfile(rawClaude()).keys.queuedRow!;
    const start = new RegExp(queuedRow.pattern, "u");
    const hint = new RegExp(queuedRow.hint, "u");
    expect(start.exec("❯ QUEUEDMSG please add a title")?.groups?.text).toBe("QUEUEDMSG please add a title");
    expect(start.exec("❯")).toBeNull();
    expect(hint.test("  ctrl+enter to send now")).toBe(true);
    expect(hint.test("  ctrl+enter to send now, or more")).toBe(false);
  });

  it("matches the frame anchors on a real box", () => {
    const { idle } = parseProfile(rawClaude());
    const rule = "─".repeat(40);
    expect(new RegExp(idle.frame.top.pattern, "u").test(rule)).toBe(true);
    expect(new RegExp(idle.frame.top.pattern, "u").test("── lab-project ──")).toBe(true);
    expect(new RegExp(idle.frame.bottom.pattern, "u").test(rule)).toBe(true);
    const prompt = new RegExp(idle.frame.prompt.pattern, "u");
    expect(prompt.exec("❯ hello there")?.groups?.draft).toBe("hello there");
    expect(prompt.exec("❯")?.groups?.draft).toBeUndefined();
    expect(prompt.exec("!important")).toBeNull();
  });
});

function rawCodex(): JsonObject {
  const raw = parseJsonObject(readFileSync(join(PROFILES_DIR, "codex.json"), "utf8"));
  if (raw === undefined) throw new Error("codex.json is not a JSON object");
  return raw;
}

describe("the codex profile (M56 spec 13)", () => {
  it("codex: carries every field the spec names", () => {
    const codex = parseProfile(rawCodex());
    expect(codex.identity.versionCommand).toEqual(["codex", "--version"]);
    expect(versionFromOutput(codex, "codex-cli 0.163.0")).toBe("0.163.0");
    expect(codex.idle.frame.top).toMatchObject({ blank: true, column: 0 });
    expect(codex.idle.frame.prompt.pattern).toContain("(?<draft>");
    expect(codex.idle.frame.bottom.column).toBe(2);
    expect(codex.idle.placeholders.sgr).toBe(2);
    expect(codex.idle.runningRows?.length).toBeGreaterThan(0);
    // Tab sends on an idle box and queues in a turn (lab, 0.150.0, 0.159.2, 0.163.0): Enter steers a turn.
    expect(codex.keys.submit).toEqual(["Tab"]);
    expect(codex.keys.commandSubmit).toEqual(["Enter"]);
    expect(codex.keys.enterWhileRunning).toBe("steers");
    expect(codex.keys.queueKey).toBe("Tab");
    // `/` opens a command and `!` a shell command on Codex; an `@` text is a message, and takes Tab.
    // Lab, 0.163.0, 2026-10-16: Tab on an idle `!ls` does nothing (the box is in Shell mode), and a
    // queued `!ls` runs as a shell command after the turn, so `!` is never sent with Tab.
    expect(codex.reservedLeads).toEqual(["/", "!"]);
    expect(codex.probe).toMatchObject({ char: "⌁", status: "verified" });
    expect(codex.hooks["agent-turn-complete"]).toBe("edge");
    expect(codex.edges?.events["agent-turn-complete"]).toBe("stop");
  });

  it("codex: the prompt anchor takes the box and its draft, and never a numbered dialog row", () => {
    const prompt = new RegExp(parseProfile(rawCodex()).idle.frame.prompt.pattern, "u");
    expect(prompt.exec("› hello there")?.groups?.draft).toBe("hello there");
    expect(prompt.exec("›")?.groups?.draft).toBeUndefined();
    expect(prompt.exec("› 1. Yes, proceed (y)")).toBeNull();
    expect(prompt.exec("› 12. Other")).toBeNull();
  });

  it("codex: the bottom anchor takes the status row and never a hint row", () => {
    const bottom = new RegExp(parseProfile(rawCodex()).idle.frame.bottom.pattern, "u");
    expect(bottom.test("  GPT-6-Luna low · ~/project")).toBe(true);
    expect(bottom.test("  tab to queue message                     88% context left")).toBe(true);
    expect(bottom.test("  ← for agents · ? for shortcuts")).toBe(false);
    expect(bottom.test("  ? for shortcuts")).toBe(false);
    expect(bottom.test("  tab to queue message")).toBe(false);
  });

  it("codex: the running rows take a spinner on the status row and the queue hint", () => {
    const signs = parseProfile(rawCodex()).idle.runningRows!.map((source) => new RegExp(source, "u"));
    const any = (row: string): boolean => signs.some((sign) => sign.test(row));
    expect(any("  gpt-5.5 medium · ~/project · ⠋")).toBe(true);
    expect(any("  tab to queue message")).toBe(true);
    expect(any("  GPT-6-Luna low · ~/project")).toBe(false);
  });

  it("codex: matches the queued rows Codex 0.163.0 draws after Tab (lab, 2026-10-16)", () => {
    const queuedRow = parseProfile(rawCodex()).keys.queuedRow!;
    expect(new RegExp(queuedRow.pattern, "u").exec("  ↳ then add a short summary")?.groups?.text).toBe("then add a short summary");
    expect(new RegExp(queuedRow.hint, "u").test("    shift+← edit last queued message")).toBe(true);
    // Codex 0.150.0 draws the same rows with another edit key (lab, 2026-10-16).
    expect(new RegExp(queuedRow.hint, "u").test("    alt + ↑ edit last queued message")).toBe(true);
    expect(queuedRow.hintGap).toBe(0);
  });

  it("claude: the footer rows name the agents panel and its hints, and no statusline row (incident 2026-10-16)", () => {
    const rows = parseProfile(rawClaude()).idle.volatile.below.footerRows!;
    const nameOf = (text: string): string | null => rows.find((row) => new RegExp(row.pattern, "u").test(text))?.name ?? null;
    expect(nameOf("  ● main")).toBe("agents-panel-main");
    expect(nameOf("  ◯ general-purpose   Reading profileFor in profile.ts      2m 3s · ↓ 120.1k tokens")).toBe("agents-panel-agent");
    expect(nameOf("❯ ◯ alright-it-seems  alright it seems a new issue arrived      31s · ↓ 40.2k tokens")).toBe("agents-panel-agent");
    expect(nameOf("  ↓ to manage")).toBe("agents-panel-manage-hint");
    expect(nameOf("  ⏵⏵ bypass permissions on (shift+tab to cycle) · 2 background tasks · ↓ to view · ← 11 agents")).toBe("tasks-view-hint");
    expect(nameOf("  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell · ← 11 agents")).toBeNull();
    expect(nameOf("  CTX:8% CACHE:99% LIMITS 5h:9%/4h:21m 7d:70%/4d:06h")).toBeNull();
    expect(nameOf("  [Fable·medium] ~/projects/sample-workspace on main*")).toBeNull();
  });

  it("claude: the agents screen's key-hint row under its own box is another screen's, no conversation footer is (claude-lab--agents-screen)", () => {
    const screens = parseProfile(rawClaude()).idle.volatile.below.otherScreens!;
    const nameOf = (text: string): string | null => screens.find((row) => new RegExp(row.pattern, "u").test(text))?.name ?? null;
    // The hint row as the w82 and w40 captures hold it.
    expect(nameOf("  enter to return · space to reply · ctrl+x to delete · ? for shortcuts")).toBe("agents screen");
    expect(nameOf("  enter to return · ? for shortcuts")).toBe("agents screen");
    expect(nameOf("  ⏸ manual mode on · ← 11 agents")).toBeNull();
    expect(nameOf("  ⏸ manual mode on · ? for shortcuts · ← for agents")).toBeNull();
    expect(nameOf("  ? for shortcuts")).toBeNull();
    expect(nameOf("  ⏵⏵ bypass permissions on (shift+tab to cycle) · 2 background tasks · ↓ to view · ← 11 agents")).toBeNull();
    // Codex names none: its box is not affected.
    expect(parseProfile(rawCodex()).idle.volatile.below.otherScreens).toBeUndefined();
  });

  it("claude: the slash list under the box names its pointed command, in the 2.1.291 and the 2.1.302 layout (field case 2026-10-17)", () => {
    const list = parseProfile(rawClaude()).idle.volatile.below.commandList!;
    const pointer = new RegExp(list.pointer, "u");
    const entry = new RegExp(list.entry, "u");
    const wrapped = new RegExp(list.wrapped, "u");
    const commandOf = (re: RegExp, text: string): string | null => re.exec(text)?.groups?.["command"] ?? null;
    // 2.1.302 at 119 columns: the description in a second column at column 43, on the pointer's own row.
    expect(commandOf(pointer, `  ❯ /model${" ".repeat(33)}Set the AI model for Claude Code (currently Sonnet 5.5)`)).toBe("/model");
    expect(commandOf(entry, `    /auto-mode-setup${" ".repeat(23)}Teach auto mode about your environment, plus optional rule tweaks`)).toBe("/auto-mode-setup");
    expect(wrapped.test(`${" ".repeat(43)}boundaries, exports, and locality of behavior.`)).toBe(true);
    // 2.1.291 at 82 columns: the pointed description wraps; a name cut at 40 columns starts with "…".
    expect(commandOf(pointer, "  ❯ /model                          Set the AI model for Claude Code (currently")).toBe("/model");
    expect(commandOf(entry, "    …o-mode-setup  Teach auto mode")).toBe("…o-mode-setup");
    // Not a list row: the box's own prompt, a dialog's pointed option, a status row.
    expect(pointer.test("❯ /model")).toBe(false);
    expect(pointer.test(" ❯ 1. Yes")).toBe(false);
    expect(entry.test("  model · ctx 3%")).toBe(false);
    expect(parseProfile(rawCodex()).idle.volatile.below.commandList).toBeUndefined();
  });

  it("pi and omp: the slash list under the box names its command without the lead (field case 2026-10-17, 1.22.5)", () => {
    const read = (id: string) => {
      const list = loadProfiles().get(id)!.idle.volatile.below.commandList!;
      const commandOf = (source: string, text: string): string | null => new RegExp(source, "u").exec(text)?.groups?.["command"] ?? null;
      return { list, pointer: (text: string) => commandOf(list.pointer, text), entry: (text: string) => commandOf(list.entry, text), wrapped: (text: string) => new RegExp(list.wrapped, "u").test(text) };
    };
    const stock = read("pi");
    expect(stock.list).toMatchObject({ lead: "/", sides: ["under"], footer: { maxRows: 4 } });
    // Stock pi 0.87.1 and 1.3.0, pi 1.2.0 with editor padding, OmO on pi.
    expect(stock.pointer("→ model          <provider/model> — Select model (opens selector UI)")).toBe("model");
    expect(stock.pointer(" → settings       Open settings menu")).toBe("settings");
    expect(stock.pointer("  → compact     Manually compact the session context")).toBe("compact");
    expect(stock.entry("  scoped-models  Enable/disable models for Ctrl+P cycling")).toBe("scoped-models");
    expect(stock.entry("    favorite-models  Manage favorite models for Ctrl+P cycling")).toBe("favorite-models");
    expect(stock.wrapped("  (1/145)")).toBe(true);
    expect(stock.entry("  (1/145)")).toBeNull();
    // Not a list row: the box's text, the folder and stats rows, a selector's search row.
    expect(stock.entry("/model")).toBeNull();
    expect(stock.entry("~/project (main)")).toBeNull();
    expect(stock.entry("0.0%/200k (auto)")).toBeNull();
    expect(stock.pointer("> ")).toBeNull();
    const omp = read("omp");
    expect(omp.list).toMatchObject({ lead: "/", sides: ["under"] });
    expect(omp.list.footer).toBeUndefined();
    // omp 18.6.1 draws an icon column, omp 18.8 too, older omp none; a scrollbar cell ends the row.
    expect(omp.pointer(`❯ ⬢  model         Model: none selected${" ".repeat(60)}█`)).toBe("model");
    expect(omp.entry(`  🏃 prewalk       Arm or restart a one-shot model handoff${" ".repeat(40)}█`)).toBe("prewalk");
    expect(omp.entry("  👁️  advisor       Advisor: off")).toBe("advisor");
    expect(omp.pointer("❯ 🕘 resume       Resume a different session")).toBe("resume");
    expect(omp.pointer("❯ new                     Start a new session")).toBe("new");
    expect(omp.pointer("❯ skill:sample-doc-tool   Read a sample document bundle")).toBe("skill:sample-doc-tool");
    expect(omp.wrapped(`${" ".repeat(19)}advisor)${" ".repeat(50)}│`)).toBe(true);
    // Not a list row: the open box's prompt row, its top edge, a picker's pointed provider.
    expect(omp.entry("╰─ /model")).toBeNull();
    expect(omp.pointer(" π > ⬢ no-model > 📁 …/project > ◫ 7.1K/? ⟲ ▶────")).toBeNull();
    expect(omp.pointer("│ ❯ ⬢ All models          34 │  All available models")).toBeNull();
  });

  it("codex: the rows above may lose text, and the hint rows under the box are named (lab, 0.163.0)", () => {
    const codex = parseProfile(rawCodex());
    expect(codex.idle.volatile.above.losesText).toBe(true);
    const hints = codex.idle.volatile.below.hints!.map((source) => new RegExp(source, "u"));
    expect(hints.some((hint) => hint.test("  ← for agents · ? for shortcuts"))).toBe(true);
    expect(hints.some((hint) => hint.test("  tab to queue message"))).toBe(true);
    expect(hints.some((hint) => hint.test("  GPT-6-Luna low · ~/project"))).toBe(false);
  });

  it("codex: the running rows take the queued-message hint Codex 0.163.0 draws in a turn", () => {
    const signs = parseProfile(rawCodex()).idle.runningRows!.map((source) => new RegExp(source, "u"));
    expect(signs.some((sign) => sign.test("  shift+← edit last queued message"))).toBe(true);
  });

  it("codex: matches the long-paste form", () => {
    const form = new RegExp(parseProfile(rawCodex()).collapse.pattern, "u");
    expect(form.exec("[Pasted Content 1500 chars]")?.groups?.chars).toBe("1500");
  });

  it("a list of commands that run at once in a turn parses with its note; omp ships /goal", () => {
    const keys = parseProfile(change(change(rawCodex(), ["keys", "commandsRunInTurn"], ["/status", "/model"]), ["keys", "commandsRunInTurnNote"], "Lab note.")).keys;
    expect(keys.commandsRunInTurn).toEqual(["/status", "/model"]);
    expect(keys.commandsRunInTurnNote).toBe("Lab note.");
    expect(parseProfile(rawCodex()).keys.commandsRunInTurn).toBeUndefined();
    expect(loadProfiles().get("omp")?.keys.commandsRunInTurn).toEqual(["/goal"]);
  });

  const cases: [string, (string | number)[], JsonValue | undefined, string][] = [
    ["codex: Escape as the queue key", ["keys", "queueKey"], "Escape", "keys.queueKey"],
    ["codex: Enter as the queue key", ["keys", "queueKey"], "Enter", "keys.queueKey"],
    ["codex: Escape as a command key", ["keys", "commandSubmit"], ["Escape"], "keys.commandSubmit"],
    ["codex: no command key", ["keys", "commandSubmit"], [], "keys.commandSubmit"],
    ["codex: a queue key on a harness whose Enter queues", ["keys", "enterWhileRunning"], "queues", "keys.queueKey"],
    ["codex: an unknown Enter mode", ["keys", "enterWhileRunning"], "sometimes", "keys.enterWhileRunning"],
    ["codex: a blank prompt anchor", ["idle", "frame", "prompt", "blank"], true, "idle.frame.prompt.blank"],
    ["codex: a blank anchor that matches text", ["idle", "frame", "top", "pattern"], "^x$", "idle.frame.top.pattern"],
    ["codex: a blank anchor off column 0", ["idle", "frame", "top", "column"], 2, "idle.frame.top.column"],
    ["codex: a running row that is no expression", ["idle", "runningRows", 0], "[unclosed", "idle.runningRows[0]"],
    ["codex: losesText that is not true", ["idle", "volatile", "above", "losesText"], false, "idle.volatile.above.losesText"],
    ["codex: a hint row that is no expression", ["idle", "volatile", "below", "hints", 0], "[unclosed", "idle.volatile.below.hints[0]"],
    ["codex: hint rows that are no list", ["idle", "volatile", "below", "hints"], "? for shortcuts", "idle.volatile.below.hints"],
    ["codex: no command that runs in a turn", ["keys", "commandsRunInTurn"], [], "keys.commandsRunInTurn"],
    ["codex: a command that runs in a turn with a space in it", ["keys", "commandsRunInTurn"], ["/goal pause"], "keys.commandsRunInTurn"],
    ["codex: a command that runs in a turn of one character", ["keys", "commandsRunInTurn"], ["!"], "keys.commandsRunInTurn"],
    ["codex: a command that runs in a turn with no reserved lead", ["keys", "commandsRunInTurn"], ["goal"], "keys.commandsRunInTurn"],
    ["codex: a command that runs in a turn and is never held", ["keys", "commandsRunInTurn"], ["/quit"], "keys.commandsRunInTurn"],
    ["codex: a note on commands that run in a turn that is no text", ["keys", "commandsRunInTurnNote"], 3, "keys.commandsRunInTurnNote"],
  ];
  for (const [name, path, value, field] of cases) {
    it(name, () => {
      expect(failure(change(rawCodex(), path, value)).path).toBe(field);
    });
  }
});

describe("the Codex range", () => {
  const row = ledgerJson.agents.codex;

  it("codex: verified through 0.163.0, where the live sends of spec 13 passed on 0.150.0, 0.159.2 and 0.163.0", () => {
    const codex = loadProfiles().get("codex")!;
    const verified = codex.versions.filter((range) => range.status === "verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]!.range).toBe("0.150.0 - 0.163.0");
    expect(verified[0]!.verifiedThrough).toBe("0.163.0");
    expect(verified[0]!.verifiedOn).toBe("2026-10-16");
    expect(codex.probe.note).toContain("0.150.0, 0.159.2 and 0.163.0");
    for (const version of ["0.150.0", row.version, "0.163.0"]) {
      resetProfileLog();
      expect(profileFor("codex", version, { log: () => {} })?.status, version).toBe("verified");
    }
  });

  it("codex: the ledger's canary row sits inside the range, and a version above it is provisional", () => {
    resetProfileLog();
    expect(profileFor("codex", row.version, { log: () => {} })?.range?.range).toBe("0.150.0 - 0.163.0");
    expect(profileFor("codex", "0.164.0", { log: () => {} })?.status).toBe("provisional");
  });
});

/**
 * The profiles of M56 spec 14. Each row names the harness's own samples: rows its anchors must take
 * and rows they must refuse. The ledger rows (verified-versions.json) and the profile ranges must say
 * the same thing, as for Codex.
 */
interface Spec14Case {
  readonly id: string;
  readonly binary: string;
  readonly versionOutput: string;
  readonly version: string;
  /** A version above the ledger row, which the profile reads as provisional. */
  readonly above: string;
  /** Rows an idle box is made of: each must match the anchor it names. */
  readonly takes: readonly { readonly anchor: "top" | "prompt" | "bottom"; readonly row: string; readonly draft?: string }[];
  /** Rows an anchor must refuse. */
  readonly refuses: readonly { readonly anchor: "top" | "prompt" | "bottom"; readonly row: string }[];
  readonly collapse: { readonly text: string; readonly group: string; readonly value: string };
  /** The reserved leads, where they are not `/`, `!` and `@`: pi and OMP read an `@` text as a message. */
  readonly reservedLeads?: readonly string[];
  /** The keys that send a text on an idle box. */
  readonly submit: readonly string[];
  /** The keys that send a command, where they differ from `submit`. */
  readonly commandSubmit?: readonly string[];
  /** What the profile says of its probe: provisional means every send takes the probed path (a live send has not passed inside the range). */
  readonly probeStatus: "verified" | "provisional";
  /** The status of the ledger-version range, when it is not `verified`. */
  readonly rangeStatus?: "provisional";
  readonly enterWhileRunning: "queues" | "steers" | undefined;
  /** The key that queues a message in a turn, where Enter does not queue. */
  readonly queueKey?: string;
  /** The pause after the text write the profile names (`paste.settleMs`, #507), where it names one. */
  readonly pasteSettleMs?: number;
}

const SPEC14_CASES: readonly Spec14Case[] = [
  {
    id: "opencode",
    binary: "opencode",
    versionOutput: "1.19.2",
    version: "1.19.2",
    above: "1.19.4",
    takes: [
      { anchor: "top", row: "  ┃" },
      { anchor: "prompt", row: "  ┃  hello there", draft: "hello there" },
      { anchor: "prompt", row: "  ┃" },
      { anchor: "bottom", row: "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀" },
    ],
    refuses: [
      { anchor: "bottom", row: "  ┃" },
      { anchor: "bottom", row: "  ────────────────" },
      { anchor: "top", row: "  ┃  hello there" },
    ],
    collapse: { text: "[Pasted ~12 lines]", group: "lines", value: "12" },
    submit: ["Enter"],
    probeStatus: "provisional",
    enterWhileRunning: "queues",
  },
  {
    id: "grok",
    binary: "grok",
    versionOutput: "1.0.46 (2765805b9442) [stable]\n",
    version: "1.0.46",
    above: "1.0.52",
    takes: [
      { anchor: "top", row: "  ╭──────────────────────────────────╮" },
      { anchor: "top", row: "╭──────────────────────────────────" },
      { anchor: "prompt", row: "  │ ❯ testing stuff                  │", draft: "testing stuff" },
      { anchor: "prompt", row: "  │ ❯                                │" },
      { anchor: "bottom", row: "  ╰───────────────── Grok 4.6 (high) · auto ─╯" },
    ],
    refuses: [
      { anchor: "prompt", row: "  │   continuation row               │" },
      { anchor: "top", row: "  ┌──────────────────────────────────┐" },
      { anchor: "bottom", row: "  ╭──────────────────────────────────╮" },
    ],
    collapse: { text: "[Pasted 3003 chars]", group: "", value: "" },
    submit: ["Enter"],
    probeStatus: "provisional",
    enterWhileRunning: undefined,
  },
  {
    id: "agy",
    binary: "agy",
    versionOutput: "1.1.17\n",
    version: "1.1.17",
    above: "1.3.5",
    takes: [
      { anchor: "top", row: "────────────────────" },
      { anchor: "prompt", row: ">" },
      { anchor: "prompt", row: "> hello there", draft: "hello there" },
      { anchor: "bottom", row: "────────────────────" },
    ],
    refuses: [
      { anchor: "prompt", row: "  > hello there" },
      { anchor: "top", row: "──── hello" },
    ],
    collapse: { text: "[Pasted 12 lines]", group: "", value: "" },
    submit: ["Enter"],
    probeStatus: "provisional",
    rangeStatus: "provisional",
    enterWhileRunning: undefined,
  },
  {
    id: "muse",
    binary: "muse",
    versionOutput: "Muse Code 1.4.7\n",
    version: "1.4.7",
    above: "1.4.8",
    takes: [
      { anchor: "top", row: "── Voice input (⌥ + v to start) ────────────────" },
      { anchor: "top", row: "────────────────────────────────" },
      { anchor: "prompt", row: "❯" },
      { anchor: "prompt", row: "❯ hello muse draft", draft: "hello muse draft" },
      { anchor: "bottom", row: "────────────────────────────────" },
    ],
    refuses: [
      { anchor: "prompt", row: "  hello muse draft" },
      { anchor: "bottom", row: "── Voice input (⌥ + v to start) ────────────────" },
    ],
    collapse: { text: "[Image #1]", group: "", value: "" },
    submit: ["Enter"],
    probeStatus: "provisional",
    enterWhileRunning: undefined,
    pasteSettleMs: 350,
  },
  {
    id: "omp",
    binary: "omp",
    versionOutput: "omp/18.6.1\n",
    version: "18.6.1",
    above: "18.6.1",
    takes: [
      { anchor: "top", row: "╭── π  > ⬢ Auto > 🗑 …/scratchpad/omp-sandbox > ⑂ master > ◫ 11.5%/200K ⟲ > (sub) ▶────────" },
      { anchor: "top", row: " π > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 ▶──4%──────────" },
      { anchor: "top", row: " ⠇ 4s > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 ▶──5%──────────" },
      { anchor: "prompt", row: "╰─ hello there", draft: "hello there" },
      { anchor: "prompt", row: "│  hello there", draft: "hello there" },
      { anchor: "prompt", row: `╰─${" ".repeat(60)}⇧⇥ to change thinking effort`, draft: "" },
    ],
    refuses: [
      { anchor: "top", row: " π · ⬢ no-model · 🗑 collie-omp-shape-sandbox" },
      { anchor: "prompt", row: "   hello there" },
    ],
    collapse: { text: "📄 #3", group: "", value: "" },
    reservedLeads: ["/", "!"],
    submit: ["ctrl+q"],
    commandSubmit: ["Enter"],
    probeStatus: "provisional",
    enterWhileRunning: "steers",
    queueKey: "ctrl+q",
  },
  {
    id: "pi",
    binary: "pi",
    versionOutput: "0.87.1\n",
    version: "0.87.1",
    above: "1.1.0",
    takes: [
      { anchor: "top", row: "─".repeat(40) },
      { anchor: "top", row: "── ⠴ Working ─────────────────────────" },
      { anchor: "prompt", row: "hello there", draft: "hello there" },
      { anchor: "prompt", row: "  hello there", draft: "hello there" },
      { anchor: "prompt", row: "❯ hello there", draft: "hello there" },
      { anchor: "prompt", row: "❯", draft: "" },
      { anchor: "prompt", row: `❯${" ".repeat(60)}…/omo-lab/work`, draft: "" },
      { anchor: "bottom", row: "─".repeat(40) },
    ],
    refuses: [
      { anchor: "bottom", row: "── ⠴ Working ─────────────────────────" },
      { anchor: "top", row: "hello there" },
    ],
    collapse: { text: "[paste #2 +12 lines]", group: "lines", value: "12" },
    reservedLeads: ["/", "!"],
    submit: ["alt+Enter"],
    commandSubmit: ["Enter"],
    probeStatus: "verified",
    enterWhileRunning: "steers",
    queueKey: "alt+Enter",
  },
  {
    id: "hermes",
    binary: "hermes",
    versionOutput: "Hermes Agent v0.22.2 (2026.9.24) · stable · local d923a5eb487a\nInstall directory: /opt/hermes\n",
    version: "0.22.2",
    above: "0.22.3",
    takes: [
      { anchor: "top", row: "─".repeat(64) },
      { anchor: "prompt", row: "❯" },
      { anchor: "prompt", row: "❯ hello there", draft: "hello there" },
      { anchor: "prompt", row: "assistant ❯ hello there", draft: "hello there" },
      // A clarify's typed answer: Hermes's own input row, `✎` in front (alone below 64 columns).
      { anchor: "prompt", row: "✎ ❯ CockroachDB 23.2", draft: "CockroachDB 23.2" },
      { anchor: "prompt", row: "✎ Firebird", draft: "Firebird" },
      // A turn running: Hermes's input row with `☤` in front. The same glyph is the profile's running
      // row, so the box is found and the turn reads running.
      { anchor: "prompt", row: "☤ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel", draft: "msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel" },
      { anchor: "prompt", row: "☤ msg=interrupt", draft: "msg=interrupt" },
      { anchor: "bottom", row: "─".repeat(64) },
    ],
    refuses: [
      // A clarify waiting for a choice, an approval, a password: none takes text.
      { anchor: "prompt", row: "? ❯" },
      { anchor: "prompt", row: "⚠ ❯" },
      { anchor: "prompt", row: "🔐 ❯" },
      { anchor: "top", row: " ☤ lab-model │ ctx -- │ [░░░░░░░░░░] -- │ 0s │ ⏲ 0s" },
    ],
    collapse: { text: "[Pasted text #2: 12 lines → /home/u/.hermes/pastes/paste_2_101500.txt]", group: "lines", value: "12" },
    reservedLeads: ["/", "!"],
    submit: ["Enter"],
    probeStatus: "provisional",
    enterWhileRunning: "steers",
  },
  {
    id: "cursor",
    binary: "cursor-agent",
    versionOutput: "2026.10.16-e3cb207\n",
    version: "2026.10.16",
    above: "2026.10.20",
    takes: [
      { anchor: "top", row: ` ${"▄".repeat(40)}` },
      { anchor: "prompt", row: "  → hello there", draft: "hello there" },
      { anchor: "prompt", row: `  → Add a follow-up${" ".repeat(60)}ctrl+c to stop`, draft: "Add a follow-up" },
      { anchor: "prompt", row: "  ! echo hi", draft: "echo hi" },
      { anchor: "bottom", row: ` ${"▀".repeat(40)}` },
    ],
    refuses: [
      { anchor: "prompt", row: "  !important" },
      { anchor: "prompt", row: "    → a wrapped row" },
      { anchor: "prompt", row: "   → /model [filter]           Select model (Tab to edit)" },
      { anchor: "top", row: ` ${"▀".repeat(40)}` },
      { anchor: "bottom", row: ` ${"▄".repeat(40)}` },
    ],
    collapse: { text: "[Pasted text #1 +301 lines]", group: "lines", value: "301" },
    submit: ["Enter"],
    probeStatus: "verified",
    enterWhileRunning: "queues",
    rangeStatus: "provisional",
  },
];

describe.each(SPEC14_CASES)("the $id profile (M56 spec 14)", (c) => {
  const profile = (): Profile => loadProfiles().get(c.id)!;
  const pattern = (anchor: "top" | "prompt" | "bottom"): RegExp => new RegExp(profile().idle.frame[anchor].pattern, "u");

  it(`${c.id}: carries every field the spec names`, () => {
    const p = profile();
    expect(p.identity.versionCommand[0]).toBe(c.binary);
    expect(versionFromOutput(p, c.versionOutput)).toBe(c.version);
    expect(p.idle.frame.prompt.pattern).toContain("(?<draft>");
    expect(p.idle.runningRows?.length).toBeGreaterThan(0);
    expect(p.keys.submit).toEqual(c.submit);
    expect(p.keys.commandSubmit).toEqual(c.commandSubmit);
    expect(p.probe.status).toBe(c.probeStatus);
    expect(p.keys.interrupt.length).toBeGreaterThan(0);
    expect(p.keys.enterWhileRunning).toBe(c.enterWhileRunning);
    expect(p.keys.queueKey).toBe(c.queueKey);
    expect(p.reservedLeads).toEqual(c.reservedLeads ?? ["/", "!", "@"]);
    expect(p.probe.char.length).toBeGreaterThan(0);
    expect(p.paste).toEqual(c.pasteSettleMs === undefined ? { bracketed: true } : { bracketed: true, settleMs: c.pasteSettleMs });
    expect(p.hooks).toBeDefined();
  });

  it(`${c.id}: the anchors take the rows of an idle box and refuse the others`, () => {
    for (const { anchor, row, draft } of c.takes) {
      const hit = pattern(anchor).exec(row);
      expect(hit, `${anchor}: ${row}`).not.toBeNull();
      if (draft !== undefined) expect(hit?.groups?.["draft"]).toBe(draft);
    }
    for (const { anchor, row } of c.refuses) expect(pattern(anchor).test(row), `${anchor}: ${row}`).toBe(false);
  });

  it(`${c.id}: matches its own long-paste form`, () => {
    const hit = new RegExp(profile().collapse.pattern, "u").exec(c.collapse.text);
    if (c.collapse.group === "") expect(hit).not.toBeNull();
    else expect(hit?.groups?.[c.collapse.group]).toBe(c.collapse.value);
  });

  it(`${c.id}: verified through the ledger row, provisional above it`, () => {
    // SAFETY: the ledger is this repo's own committed JSON; every agent row has a version and a verified date, and the key is a harness id from this table.
    const row = (ledgerJson.agents as Record<string, { version: string; verified: string } | undefined>)[c.id];
    if (c.rangeStatus === "provisional") {
      expect(profile().versions.map((range) => range.status)).toEqual(["provisional"]);
      expect(profileFor(c.id, row?.version ?? c.version, { log: () => {} })?.status).toBe("provisional");
      return;
    }
    if (row === undefined) throw new Error(`${c.id} has a verified range and no ledger row`);
    const verified = profile().versions.filter((range) => range.status === "verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verifiedThrough).toBe(row.version);
    expect(verified[0]!.verifiedOn).toBe(row.verified);
    expect(verified[0]!.range.endsWith(` - ${row.version}`)).toBe(true);
    expect(profileFor(c.id, row.version, { log: () => {} })?.status).toBe("verified");
    resetProfileLog();
    expect(profileFor(c.id, c.above, { log: () => {} })?.status).toBe(c.above === row.version ? "verified" : "provisional");
  });

  it(`${c.id}: the probe is verified or says why not`, () => {
    const p = profile();
    expect(["verified", "provisional"]).toContain(p.probe.status);
    expect(p.probe.note.length).toBeGreaterThan(0);
  });
});

describe("the frame schema of the interior walk (M56 spec 14)", () => {
  const rawOpencode = (): JsonObject => parseJsonObject(readFileSync(join(PROFILES_DIR, "opencode.json"), "utf8"))!;
  const cases: [string, (string | number)[], JsonValue | undefined, string][] = [
    ["an unknown walk", ["idle", "frame", "walk"], "diagonal", "idle.frame.walk"],
    ["rows that are no expression", ["idle", "frame", "rows"], "[unclosed", "idle.frame.rows"],
    ["a trailer row that is no expression", ["idle", "frame", "trailer", "row"], "[unclosed", "idle.frame.trailer.row"],
    ["a continuation with no text group", ["idle", "frame", "continuation"], "^ *┃ .*$", "idle.frame.continuation"],
    ["an overlay row that is no expression", ["idle", "overlayRows", 0], "[unclosed", "idle.overlayRows[0]"],
    ["an under row that is no expression", ["idle", "frame", "under"], "[unclosed", "idle.frame.under"],
    ["an underPainted flag that is no boolean", ["idle", "frame", "underPainted"], "yes", "idle.frame.underPainted"],
    ["an underPainted flag with no under pattern", ["idle", "frame", "underPainted"], true, "idle.frame.underPainted"],
    ["a dialogsInBox flag that is no boolean", ["idle", "dialogsInBox"], "yes", "idle.dialogsInBox"],
    ["a placeholder prefix list that is no list", ["idle", "placeholders", "prefixes"], "Ask", "idle.placeholders.prefixes"],
    ["an answer prompt that is no expression", ["idle", "answerPrompt"], "[unclosed", "idle.answerPrompt"],
  ];
  for (const [name, path, value, field] of cases) {
    it(`refuses ${name}`, () => {
      expect(failure(change(rawOpencode(), path, value)).path).toBe(field);
    });
  }

  it("keeps rows, a trailer and a continuation out of the edges walk", () => {
    expect(failure(change(rawOpencode(), ["idle", "frame", "walk"], "edges")).path).toMatch(/^idle\.frame\./u);
    expect(failure(change(rawClaude(), ["idle", "frame", "rows"], "^x$")).path).toBe("idle.frame.rows");
    expect(failure(change(rawClaude(), ["idle", "frame", "bottom", "open"], true)).path).toBe("idle.frame.bottom.open");
  });

  it("names the alternate frame shape in the path of a bad field", () => {
    const raw = parseJsonObject(readFileSync(join(PROFILES_DIR, "omp.json"), "utf8"))!;
    expect(failure(change(raw, ["idle", "frameAlternates", 1, "bottom", "pattern"], "[unclosed")).path).toBe("idle.frameAlternates[1].bottom.pattern");
    expect(failure(change(raw, ["idle", "frameAlternates"], "no list")).path).toBe("idle.frameAlternates");
    expect(parseProfile(raw).idle.frameAlternates).toHaveLength(4);
  });

  it("omp 18.11 (issue 497): the chips of every symbol preset collapse, the Nerd Font pointer points, and a skill is listed under its namespace", () => {
    const omp = parseProfile(parseJsonObject(readFileSync(join(PROFILES_DIR, "omp.json"), "utf8"))!);
    // pi-tui's symbols.ts: the paste chip is 📄 (unicode) or U+F15C (nerd), the image chip 🖼 or U+F03E;
    // the ascii preset's `txt` and `img` are left out, as its `+ - |` box is not read either.
    const chip = new RegExp(`^(?:${omp.collapse.pattern})$`, "u");
    for (const text of ["📄 #3", "🖼 #1", "\u{F15C} #2", "\u{F03E} #1"]) expect(chip.test(text), text).toBe(true);
    for (const text of ["img #1", "txt #1", "#1", "🖼#1"]) expect(chip.test(text), text).toBe(false);
    const list = omp.idle.volatile.below.commandList!;
    const pointer = new RegExp(list.pointer, "u");
    expect(pointer.exec("\u{F054} \u{F0EE5} model                Switch model")?.groups?.["command"]).toBe("model");
    expect(pointer.exec("❯ ✦ skill:wrap-up   Wrap up the session")?.groups?.["command"]).toBe("skill:wrap-up");
    expect(pointer.test("> model   Switch model")).toBe(false);
    expect(list.namespaces).toEqual(["skill:"]);
    expect(omp.idle.inlineHint).toEqual({ fg: ["rgb(107,114,128)"] });
  });

  it("omp 18.11 (issue 497): the prompt and continuation rows leave the box's right border out of the draft", () => {
    const omp = parseProfile(parseJsonObject(readFileSync(join(PROFILES_DIR, "omp.json"), "utf8"))!);
    const prompt = new RegExp(omp.idle.frame.prompt.pattern, "u");
    const continuation = new RegExp(omp.idle.frame.continuation!, "u");
    const draft = (row: string): string | undefined => prompt.exec(row)?.groups?.["draft"];
    expect(draft("╰─ box at one hundred and thirty columns wide, ending here.                   ─╯")).toBe("box at one hundred and thirty columns wide, ending here.");
    expect(draft("╰─ text that fills the row ─╯")).toBe("text that fills the row");
    expect(draft("╰─ text under the cursor╯")).toBe("text under the cursor");
    expect(draft("│  a draft row that fills the box  │")).toBe("a draft row that fills the box");
    expect(draft("╰─ hello there")).toBe("hello there");
    expect(draft(`╰─${" ".repeat(60)}⇧⇥ to change thinking effort${" ".repeat(4)}─╯`)).toBe("");
    // A border glyph the person typed stays when the box's own border follows it.
    expect(draft("╰─ a │    ─╯")).toBe("a │");
    const text = (row: string): string | undefined => continuation.exec(row)?.groups?.["text"];
    expect(text("│  Collie wrap probe: the quick brown fox jumps over the lazy dog while the    │")?.trim()).toBe("Collie wrap probe: the quick brown fox jumps over the lazy dog while the");
    expect(text("│  a row with the scroll thumb  █")?.trim()).toBe("a row with the scroll thumb");
    expect(text("│  a row with no border")?.trim()).toBe("a row with no border");
  });

  it("checks the notice heads: each compiles and none matches a blank row", () => {
    expect(failure(change(rawClaude(), ["idle", "notices", 0, "head"], "[unclosed")).path).toBe("idle.notices[0].head");
    expect(failure(change(rawClaude(), ["idle", "notices", 0, "head"], "^\\s*$")).path).toBe("idle.notices[0].head");
    expect(failure(change(rawClaude(), ["idle", "notices"], "no list")).path).toBe("idle.notices");
    expect(failure(change(rawClaude(), ["idle", "notices", 0], "no object")).path).toBe("idle.notices[0]");
    expect(parseProfile(rawClaude()).idle.notices).toEqual([
      { head: "^✦ (?:Heads up|You should know) ·(?:\\s|$)" },
      { head: "^● How is Claude doing this session\\? \\(optional\\)$" },
    ]);
    expect(parseProfile(rawOpencode()).idle.notices).toBeUndefined();
  });

  it("accepts a profile that names no hook", () => {
    expect(parseProfile(rawOpencode()).hooks).toEqual({});
  });
});

describe("parseProfile names the failing field", () => {
  const cases: [string, (string | number)[], JsonValue | undefined, string][] = [
    ["a missing section", ["keys"], undefined, "keys"],
    ["a missing nested field", ["keys", "clear", "slack"], undefined, "keys.clear.slack"],
    ["a wrong type", ["idle", "volatile", "below", "maxRows"], "8", "idle.volatile.below.maxRows"],
    ["an unknown status", ["versions", 0, "status"], "good", "versions[0].status"],
    ["a bad range", ["versions", 0, "range"], "2.1 to 2.2", "versions[0].range"],
    ["a range that ends before it starts", ["versions", 0, "range"], "2.1.9 - 2.1.1", "versions[0].range"],
    ["a verified range with no proof", ["versions", 0, "verifiedOn"], null, "versions[0]"],
    ["no ranges at all", ["versions"], [], "versions"],
    ["a broken expression", ["collapse", "pattern"], "[unclosed", "collapse.pattern"],
    ["a prompt anchor with no hole", ["idle", "frame", "prompt", "pattern"], "^❯ .*$", "idle.frame.prompt.pattern"],
    ["a missing tail bound", ["idle", "frame", "maxTailRows"], undefined, "idle.frame.maxTailRows"],
    ["Escape as the clear key", ["keys", "clear", "key"], "Escape", "keys.clear.key"],
    ["a probe of two characters", ["probe", "char"], "ab", "probe.char"],
    ["a paste flag that is not a boolean", ["paste", "bracketed"], "yes", "paste.bracketed"],
    ["a paste settle that is not a whole number", ["paste", "settleMs"], 1.5, "paste.settleMs"],
    ["a paste settle below its floor", ["paste", "settleMs"], 0, "paste.settleMs"],
    ["a paste settle above its ceiling", ["paste", "settleMs"], 99_999, "paste.settleMs"],
    ["an ask lifetime that is not a whole number", ["ask", "lifetimeMs"], 1.5, "ask.lifetimeMs"],
    ["an ask lifetime below its floor", ["ask", "lifetimeMs"], 10, "ask.lifetimeMs"],
    ["an unknown hook kind", ["hooks", "Stop"], "level", "hooks.Stop"],
    ["an unknown edge kind", ["edges", "events", "Stop"], "level", "edges.events.Stop"],
    ["an edge on an event hooks does not list as an edge", ["edges", "events", "PermissionRequest"], "dialog", "edges.events.PermissionRequest"],
    ["an edge key that is not Event or Event:detail", ["edges", "events", "Stop now"], "stop", "edges.events.Stop now"],
    ["a settle time below its floor", ["edges", "settleMs"], 10, "edges.settleMs"],
    ["a missing re-read delay", ["edges", "rereadMs"], undefined, "edges.rereadMs"],
    ["an empty submit key list", ["keys", "submit"], [], "keys.submit"],
    ["a bad id", ["id"], "Claude Code", "id"],
    ["a queued row pattern with no text group", ["keys", "queuedRow", "pattern"], "^❯ .*$", "keys.queuedRow.pattern"],
    ["a queued row hint that is no expression", ["keys", "queuedRow", "hint"], "[unclosed", "keys.queuedRow.hint"],
    ["a queued row gap below zero", ["keys", "queuedRow", "hintGap"], -1, "keys.queuedRow.hintGap"],
    ["footer rows that are no list", ["idle", "volatile", "below", "footerRows"], "● main", "idle.volatile.below.footerRows"],
    ["a footer row with no name", ["idle", "volatile", "below", "footerRows", 0, "name"], undefined, "idle.volatile.below.footerRows[0].name"],
    ["a footer row name used twice", ["idle", "volatile", "below", "footerRows", 1, "name"], "agents-panel-main", "idle.volatile.below.footerRows[1].name"],
    ["a footer row that is no expression", ["idle", "volatile", "below", "footerRows", 0, "pattern"], "[unclosed", "idle.volatile.below.footerRows[0].pattern"],
    ["a footer row that matches a blank row", ["idle", "volatile", "below", "footerRows", 0, "pattern"], "^\\s*$", "idle.volatile.below.footerRows[0].pattern"],
    ["other screens that are no list", ["idle", "volatile", "below", "otherScreens"], "enter to return", "idle.volatile.below.otherScreens"],
    ["an other screen with no name", ["idle", "volatile", "below", "otherScreens", 0, "name"], undefined, "idle.volatile.below.otherScreens[0].name"],
    ["an other screen row that is no expression", ["idle", "volatile", "below", "otherScreens", 0, "pattern"], "[unclosed", "idle.volatile.below.otherScreens[0].pattern"],
    ["an other screen row that matches a blank row", ["idle", "volatile", "below", "otherScreens", 0, "pattern"], "^\\s*$", "idle.volatile.below.otherScreens[0].pattern"],
    ["a command list that is no object", ["idle", "volatile", "below", "commandList"], "❯ /", "idle.volatile.below.commandList"],
    ["a command list with no pointer pattern", ["idle", "volatile", "below", "commandList", "pointer"], undefined, "idle.volatile.below.commandList.pointer"],
    ["a command list entry with no command group", ["idle", "volatile", "below", "commandList", "entry"], "^ {2,6}/\\S+$", "idle.volatile.below.commandList.entry"],
    ["a command list wrapped row that matches a blank row", ["idle", "volatile", "below", "commandList", "wrapped"], "^\\s*$", "idle.volatile.below.commandList.wrapped"],
    ["a command list lead with a space in it", ["idle", "volatile", "below", "commandList", "lead"], "/ ", "idle.volatile.below.commandList.lead"],
    ["an empty command list lead", ["idle", "volatile", "below", "commandList", "lead"], "", "idle.volatile.below.commandList.lead"],
    ["command list sides that are no list", ["idle", "volatile", "below", "commandList", "sides"], "under", "idle.volatile.below.commandList.sides"],
    ["no command list side", ["idle", "volatile", "below", "commandList", "sides"], [], "idle.volatile.below.commandList.sides"],
    ["an unknown command list side", ["idle", "volatile", "below", "commandList", "sides"], ["under", "left"], "idle.volatile.below.commandList.sides[1]"],
    ["a command list side named twice", ["idle", "volatile", "below", "commandList", "sides"], ["under", "under"], "idle.volatile.below.commandList.sides[1]"],
    ["a command list footer that is no object", ["idle", "volatile", "below", "commandList", "footer"], "^\\S", "idle.volatile.below.commandList.footer"],
    ["a command list footer that matches a blank row", ["idle", "volatile", "below", "commandList", "footer"], { pattern: "^\\s*$", maxRows: 2 }, "idle.volatile.below.commandList.footer.pattern"],
    ["a command list footer of no rows", ["idle", "volatile", "below", "commandList", "footer"], { pattern: "^\\S", maxRows: 0 }, "idle.volatile.below.commandList.footer.maxRows"],
    ["command list namespaces that are no list", ["idle", "volatile", "below", "commandList", "namespaces"], "skill:", "idle.volatile.below.commandList.namespaces"],
    ["no command list namespace", ["idle", "volatile", "below", "commandList", "namespaces"], [], "idle.volatile.below.commandList.namespaces"],
    ["an empty command list namespace", ["idle", "volatile", "below", "commandList", "namespaces"], [""], "idle.volatile.below.commandList.namespaces[0]"],
    ["a command list namespace with a space in it", ["idle", "volatile", "below", "commandList", "namespaces"], ["skill: x"], "idle.volatile.below.commandList.namespaces[0]"],
    ["a command list namespace named twice", ["idle", "volatile", "below", "commandList", "namespaces"], ["skill:", "skill:"], "idle.volatile.below.commandList.namespaces[1]"],
    ["an inline hint that is no object", ["idle", "inlineHint"], "rgb(107,114,128)", "idle.inlineHint"],
    ["an inline hint with no colour", ["idle", "inlineHint"], { fg: [] }, "idle.inlineHint.fg"],
    ["an inline hint colour written as hex", ["idle", "inlineHint"], { fg: ["#6b7280"] }, "idle.inlineHint.fg[0]"],
    ["an inline hint colour out of range", ["idle", "inlineHint"], { fg: ["rgb(107,114,256)"] }, "idle.inlineHint.fg[0]"],
    ["an inline hint colour named twice", ["idle", "inlineHint"], { fg: ["rgb(1,2,3)", "rgb(1,2,3)"] }, "idle.inlineHint.fg[1]"],
    ["a hold on an event hooks does not list as an ask", ["hold", "event"], "Stop", "hold.event"],
    ["a hold tool event hooks does not list as an edge", ["hold", "toolEvent"], "PermissionRequest", "hold.toolEvent"],
    ["a hold limit at the hook timeout", ["hold", "limitMs"], 300000, "hold.limitMs"],
    ["a hold with no deny option", ["hold", "options"], [{ label: "Yes", decision: "allow" }], "hold.options"],
    ["a hold decision that is neither allow nor deny", ["hold", "decisions", 0, "decision"], "ask", "hold.decisions[0].decision"],
    ["a hold decided line that is no expression", ["hold", "decidedLine"], "[unclosed", "hold.decidedLine"],
    ["a missing hold denied line", ["hold", "deniedLine"], undefined, "hold.deniedLine"],
  ];
  for (const [name, path, value, field] of cases) {
    it(name, () => {
      expect(failure(change(rawClaude(), path, value)).path).toBe(field);
    });
  }

  it("refuses something that is not an object", () => {
    expect(failure(null).path).toBe("profile");
    expect(failure([]).path).toBe("profile");
  });
});

describe("profileFor", () => {
  beforeEach(() => resetProfileLog());

  /** The Claude file under another id, with the given ranges. */
  function demo(ranges: JsonValue): ReadonlyMap<string, Profile> {
    const raw = change(change(rawClaude(), ["id"], "demo"), ["versions"], ranges);
    return new Map([["demo", parseProfile(raw)]]);
  }

  /** A profile with three ranges: verified, revoked, verified, and a gap after the last. */
  function layered(): ReadonlyMap<string, Profile> {
    return demo([
      { range: "1.0.0 - 1.4.9", status: "verified", verifiedThrough: "1.4.9", verifiedOn: "2026-01-01" },
      { range: "1.5.0 - 1.5.9", status: "revoked", verifiedThrough: null, verifiedOn: null },
      { range: "1.6.0 - 1.9.9", status: "verified", verifiedThrough: "1.9.9", verifiedOn: "2026-02-01" },
    ]);
  }

  it("returns the verified status inside a verified range", () => {
    const lines: string[] = [];
    const match = profileFor("demo", "1.2.3", { profiles: layered(), log: (line) => lines.push(line) });
    expect(match?.status).toBe("verified");
    expect(match?.range?.range).toBe("1.0.0 - 1.4.9");
    expect(lines).toEqual([]);
  });

  it("returns the revoked profile inside a revoked range, and logs it once", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const profiles = layered();
    expect(profileFor("demo", "1.5.2", { profiles, log })?.status).toBe("revoked");
    expect(profileFor("demo", "1.5.2", { profiles, log })?.status).toBe("revoked");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1.5.2");
    expect(profileFor("demo", "1.5.3", { profiles, log })?.status).toBe("revoked");
    expect(lines).toHaveLength(2);
  });

  it("falls back to the nearest older profile as provisional above every range", () => {
    const lines: string[] = [];
    const match = profileFor("demo", "2.0.0", { profiles: layered(), log: (line) => lines.push(line) });
    expect(match?.status).toBe("provisional");
    expect(match?.profile.id).toBe("demo");
    expect(match?.range?.range).toBe("1.6.0 - 1.9.9");
    expect(lines).toHaveLength(1);
  });

  it("falls back as provisional in a gap, taking the range below it", () => {
    const profiles = demo([
      { range: "1.0.0 - 1.1.0", status: "verified", verifiedThrough: "1.1.0", verifiedOn: "2026-01-01" },
      { range: "1.5.0 - 1.6.0", status: "verified", verifiedThrough: "1.6.0", verifiedOn: "2026-01-02" },
    ]);
    const match = profileFor("demo", "1.3.0", { profiles, log: () => {} });
    expect(match?.status).toBe("provisional");
    expect(match?.range?.range).toBe("1.0.0 - 1.1.0");
  });

  it("treats a version below every range as provisional", () => {
    const match = profileFor("demo", "0.9.0", { profiles: layered(), log: () => {} });
    expect(match?.status).toBe("provisional");
  });

  it("gives provisional when the binary version cannot be read", () => {
    const lines: string[] = [];
    const match = profileFor("demo", null, { profiles: layered(), log: (line) => lines.push(line) });
    expect(match?.status).toBe("provisional");
    expect(match?.version).toBeNull();
    expect(lines[0]).toContain("could not be read");
  });

  it("returns null for a harness with no profile", () => {
    expect(profileFor("nothing-here", "1.0.0", { log: () => {} })).toBeNull();
  });

  it("reads the version from the binary's own output, never a screen", () => {
    const claude = parseProfile(rawClaude());
    expect(versionFromOutput(claude, "2.1.300 (Claude Code)")).toBe("2.1.300");
    expect(versionFromOutput(claude, "no version here")).toBeNull();
  });
});

describe("the Claude ranges and the ledger", () => {
  const row = ledgerJson.agents.claude;

  it("agree: verified through the ledger's Claude row", () => {
    const claude = loadProfiles().get("claude")!;
    const verified = claude.versions.filter((range) => range.status === "verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verifiedThrough).toBe(row.version);
    expect(verified[0]!.verifiedOn).toBe(row.verified);
    expect(verified[0]!.range.endsWith(` - ${row.version}`)).toBe(true);
    expect(profileFor("claude", row.version, { log: () => {} })?.status).toBe("verified");
  });

  it("agree: provisional above the ledger's Claude row", () => {
    const [major, minor, patch] = row.version.split(".").map(Number);
    const above = `${String(major)}.${String(minor)}.${String(patch! + 1)}`;
    resetProfileLog();
    const match = profileFor("claude", above, { log: () => {} });
    expect(match?.status).toBe("provisional");
    expect(match?.profile.id).toBe("claude");
  });

  it("serves Claude 2.1.300, the field version of 2026-10-15, by the ledger's row", () => {
    // Provisional while the ledger is below 2.1.300, verified once a lab pass moves the row to it or past it.
    // A fixed "provisional" here went red on the first real bump, so the nightly lab's own pass commit failed CI.
    const [rowMajor = 0, rowMinor = 0, rowPatch = 0] = row.version.split(".").map(Number);
    const key = (major: number, minor: number, patch: number): number => major * 1_000_000 + minor * 1_000 + patch;
    const verified = key(rowMajor, rowMinor, rowPatch) >= key(2, 1, 300);
    expect(profileFor("claude", "2.1.300", { log: () => {} })?.status).toBe(verified ? "verified" : "provisional");
  });
});

describe("keys that differ by platform (M56 spec 14 review)", () => {
  const raw = (): JsonObject => parseJsonObject(readFileSync(join(PROFILES_DIR, "pi.json"), "utf8"))!;

  it("pi sends and queues with Alt+Enter, and with Ctrl+Q on Windows", () => {
    const pi = loadProfiles().get("pi")!;
    expect(pi.keys.submit).toEqual(["alt+Enter"]);
    expect(pi.keys.queueKey).toBe("alt+Enter");
    const win = forPlatform(pi, "win32");
    expect(win.keys.submit).toEqual(["ctrl+q"]);
    expect(win.keys.queueKey).toBe("ctrl+q");
    expect(win.keys.commandSubmit).toEqual(["Enter"]);
    expect(forPlatform(pi, "linux")).toBe(pi);
    expect(forPlatform(pi, "darwin")).toBe(pi);
  });

  it("the bridge's match carries the platform's keys", () => {
    const match = profileForPlatform("pi", "0.87.1", "win32", { log: () => {} });
    expect(match?.profile.keys.submit).toEqual(["ctrl+q"]);
    expect(match?.status).toBe("verified");
    expect(profileForPlatform("pi", "0.87.1", "linux", { log: () => {} })?.profile.keys.submit).toEqual(["alt+Enter"]);
    expect(profileForPlatform("nothing-known", "1.0.0", "win32")).toBeNull();
  });

  it("a profile with no platform entry is returned as it is", () => {
    const claude = loadProfiles().get("claude")!;
    expect(forPlatform(claude, "win32")).toBe(claude);
  });

  it("keys.submit may be a list or an object with a default; an unknown platform, a missing default and an empty list are named", () => {
    expect(parseProfile(change(raw(), ["keys", "submit"], ["alt+Enter"])).keys.submitByPlatform).toBeUndefined();
    expect(failure(change(raw(), ["keys", "submit"], { win32: ["ctrl+q"] })).path).toBe("keys.submit.default");
    expect(failure(change(raw(), ["keys", "submit"], { default: ["alt+Enter"], plan9: ["ctrl+q"] })).path).toBe("keys.submit.plan9");
    expect(failure(change(raw(), ["keys", "submit"], { default: ["alt+Enter"], win32: [] })).path).toBe("keys.submit.win32");
  });

  it("keys.queueKey names one key per platform, never Enter or Escape", () => {
    expect(failure(change(raw(), ["keys", "queueKey"], { default: "alt+Enter", win32: "Enter" })).path).toBe("keys.queueKey");
    expect(failure(change(raw(), ["keys", "queueKey"], { default: "Escape", win32: "ctrl+q" })).path).toBe("keys.queueKey");
    expect(failure(change(raw(), ["keys", "queueKey"], { win32: "ctrl+q" })).path).toBe("keys.queueKey.default");
    expect(parseProfile(change(raw(), ["keys", "queueKey"], "alt+Enter")).keys.queueKeyByPlatform).toBeUndefined();
  });
});

describe("other names of a harness (M56 spec 14 review)", () => {
  const raw = (): JsonObject => parseJsonObject(readFileSync(join(PROFILES_DIR, "agy.json"), "utf8"))!;

  it("agy answers to antigravity too, and the profile for either name is the agy profile", () => {
    const profiles = loadProfiles();
    expect(findProfile(profiles, "agy")?.id).toBe("agy");
    expect(findProfile(profiles, "antigravity")?.id).toBe("agy");
    expect(findProfile(profiles, "nothing-known")).toBeUndefined();
    expect(profileFor("antigravity", "1.1.17", { log: () => {} })?.profile.id).toBe("agy");
  });

  it("a name that repeats the id, is not a word, or is empty is named", () => {
    expect(failure(change(raw(), ["identity", "agentNames"], ["agy"])).path).toBe("identity.agentNames");
    expect(failure(change(raw(), ["identity", "agentNames"], ["Not A Name"])).path).toBe("identity.agentNames");
    expect(failure(change(raw(), ["identity", "agentNames"], [])).path).toBe("identity.agentNames");
  });

  it("no name of one profile is the id or the name of another", () => {
    const claimed = new Map<string, string>();
    for (const profile of loadProfiles().values()) {
      for (const name of [profile.id, ...(profile.identity.agentNames ?? [])]) {
        expect(claimed.has(name), `${name} of ${profile.id} is also ${claimed.get(name) ?? ""}`).toBe(false);
        claimed.set(name, profile.id);
      }
    }
  });
});
