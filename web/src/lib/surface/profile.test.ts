import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import ledgerJson from "../harness/verified-versions.json";
import { asJsonObject, parseJsonObject, type JsonObject, type JsonValue } from "../json";
import {
  loadProfiles,
  parseProfile,
  ProfileError,
  profileFor,
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
    expect(codex.reservedLeads).toEqual(["/", "!", "@"]);
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
  ];
  for (const [name, path, value, field] of cases) {
    it(name, () => {
      expect(failure(change(rawCodex(), path, value)).path).toBe(field);
    });
  }
});

describe("the Codex ranges and the ledger", () => {
  const row = ledgerJson.agents.codex;

  it("codex: verified through the ledger's Codex row", () => {
    const codex = loadProfiles().get("codex")!;
    const verified = codex.versions.filter((range) => range.status === "verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verifiedThrough).toBe(row.version);
    expect(verified[0]!.verifiedOn).toBe(row.verified);
    expect(verified[0]!.range.endsWith(` - ${row.version}`)).toBe(true);
    expect(profileFor("codex", row.version, { log: () => {} })?.status).toBe("verified");
  });

  it("codex: provisional above the ledger's Codex row, 0.163.0 of the lab included", () => {
    resetProfileLog();
    expect(profileFor("codex", "0.163.0", { log: () => {} })?.status).toBe("provisional");
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
  readonly enterWhileRunning: "queues" | "steers" | undefined;
  /** The key that queues a message in a turn, where Enter does not queue. */
  readonly queueKey?: string;
}

const SPEC14_CASES: readonly Spec14Case[] = [
  {
    id: "opencode",
    binary: "opencode",
    versionOutput: "1.19.2",
    version: "1.19.2",
    above: "1.19.2",
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
    enterWhileRunning: "queues",
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
    enterWhileRunning: "steers",
    queueKey: "alt+Enter",
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
    expect(p.keys.submit).toEqual(["Enter"]);
    expect(p.keys.interrupt.length).toBeGreaterThan(0);
    expect(p.keys.enterWhileRunning).toBe(c.enterWhileRunning);
    expect(p.keys.queueKey).toBe(c.queueKey);
    expect(p.reservedLeads).toEqual(["/", "!", "@"]);
    expect(p.probe.char.length).toBeGreaterThan(0);
    expect(p.paste).toEqual({ bracketed: true });
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
    const row = (ledgerJson.agents as Record<string, { version: string; verified: string }>)[c.id]!;
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
    ["a dialogsInBox flag that is no boolean", ["idle", "dialogsInBox"], "yes", "idle.dialogsInBox"],
    ["a placeholder prefix list that is no list", ["idle", "placeholders", "prefixes"], "Ask", "idle.placeholders.prefixes"],
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

  it("holds provisional for Claude 2.1.300, the field version of 2026-10-15", () => {
    expect(profileFor("claude", "2.1.300", { log: () => {} })?.status).toBe("provisional");
  });
});
