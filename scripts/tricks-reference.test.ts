import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hillHelp, HILL_SUBCOMMANDS } from "../cli/hill.ts";
import { HILL_SUMMARY_SOFT_MAX, HILL_SUMMARY_SOFT_SENTENCES, HILL_TITLE_SOFT_MAX, hillWordingWarnings } from "../cli/hill-rules.ts";
import * as helper from "../cli/trick-kit/trick.ts";
import { TRICK_SUBCOMMANDS } from "../cli/trick.ts";
import { VIEW_SUBCOMMANDS, viewUsageLines } from "../cli/trick-view.ts";
import { REASK_AFTER_MS } from "../bridge/tricks/hill.ts";
import { WATCH_WINDOW_MS } from "../bridge/tricks/service.ts";
import { TRICKS_CREW_FIRST_VERSION } from "../bridge/hill/crew.ts";
import { parseAgentView } from "../web/src/lib/agent-view/wire.ts";
import { HILL_NODE_PREFIX, HILL_STATES } from "../web/src/lib/hill/wire.ts";
import {
  COMMANDS,
  HILL,
  hillRulesOf,
  LATER,
  LIMITS,
  MANIFEST,
  MANIFEST_EXAMPLE,
  PARTS,
  PLACE_ORDER,
  PLACES,
  programOf,
  type Example,
} from "../web/src/lib/tricks/catalogue.ts";
import {
  AGENT_VIEW_PLACE,
  DECISION_KEYS,
  DOCUMENT_KEYS,
  FACTS_KEYS,
  INPUT_DEPTH_MAX,
  INPUT_FILE_FACT_KEYS,
  INPUT_STATES,
  INPUTS_FACT_KEYS,
  inputGlobMatches,
  inputGlobProblem,
  LATER_PLACE_WORDS,
  LATER_TRIGGERS,
  MANIFEST_KEYS,
  NODE_ATTRS,
  NODE_KINDS,
  PLACE_KINDS,
  SESSION_FACT_KEYS,
  SESSION_STATUSES,
  TRICK_FACT_KEYS,
  TRIGGER_KEYS,
  TRIGGER_KINDS,
  parseFacts,
  parseManifest,
  CLOSED_KEY_LINE,
  parseTrickDocument,
  parseTrickDocumentText,
  TAP_REFUSALS,
  TAP_REFUSED_LINES,
  type PlaceKind,
} from "../web/src/lib/tricks/schema.ts";
import type { JsonValue } from "../web/src/lib/json.ts";
import { helperNumber, programNumbers, REFERENCE_COMMAND, REFERENCE_PAGE, renderReference } from "./tricks-reference.ts";

// THE TRICKS REFERENCE (docs/tricks-reference.md) is generated from the catalogue. This file holds it to
// the code in five ways:
//   1. the page on disk is exactly what the generator writes (a stale page fails, with the command);
//   2. every example in the catalogue passes the real parser it is an example of;
//   3. the page names every place, part kind, node attribute, manifest key, Decision key, later word and
//      verb that the code has, and the catalogue names nothing the code lacks;
//   4. the commands list equals the CLI's own verb lists, and every flag it names is in the CLI's usage;
//   5. the words stay plain: no em dash, no private path;
//   6. the program's tables (what it receives, what it prints, the helper, the input globs, the Hill's
//      list rules) have an entry for every field, key, trigger kind and state the schema lists, and each
//      sentence about how Collie reads or runs a thing is held to the code that does it.
// It lives in scripts/, which `bun test ./scripts` runs in CI (the `check` job and the Windows job).

const ROOT = join(import.meta.dir, "..");

/** A text file of the checkout with LF line ends: a Windows checkout may hand back CRLF. */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replaceAll("\r\n", "\n");
}

const PAGE = read(REFERENCE_PAGE);

/** A Document that holds one part of a program, to run through the real parser. */
function sessionWith(view: JsonValue): JsonValue {
  return { v: 1, parts: [{ at: "session", id: "main", view: [view] }] };
}

/** A manifest example as the parser reads it: parsed from TOML, as the bridge does. */
function parseManifestToml(toml: string): ReturnType<typeof parseManifest> {
  // SAFETY: `Bun.TOML.parse` answers with a parsed document, and `parseManifest` checks every key it reads, as in `bridge/tricks/discover.ts`.
  return parseManifest(Bun.TOML.parse(toml) as JsonValue);
}

/** Whether a node tree shows a node of this kind: its compact JSON holds `"kind":"<kind>"`. */
function showsKind(node: JsonValue, kind: string): boolean {
  return JSON.stringify(node).includes(`"kind":"${kind}"`);
}

function checkExample(example: Example, label: string): void {
  switch (example.kind) {
    case "document": {
      const parsed = parseTrickDocument(example.json);
      expect(parsed.refusals, label).toEqual([]);
      expect(parsed.notes, label).toEqual([]);
      expect(parsed.parts.length, label).toBeGreaterThan(0);
      return;
    }
    case "node": {
      const parsed = parseTrickDocument(sessionWith(example.json));
      expect(parsed.refusals, label).toEqual([]);
      expect(parsed.notes, label).toEqual([]);
      return;
    }
    case "screen": {
      const parsed = parseAgentView(example.json);
      expect(parsed.refusals, label).toEqual([]);
      return;
    }
    case "manifest": {
      const parsed = parseManifestToml(example.toml);
      expect(parsed.refusals, label).toEqual([]);
      expect(parsed.manifest, label).toBeDefined();
      return;
    }
    case "decision": {
      const parsed = parseTrickDocument({ v: 1, parts: [], decisions: [example.json] });
      expect(parsed.refusals, label).toEqual([]);
      expect(parsed.decisions.length, label).toBe(1);
      return;
    }
    case "tap": {
      const facts = parseFacts({ contract: 1, trigger: example.json, trick: { id: "legs", dir: "/tmp/legs", state: "/tmp/legs-state" }, memberId: "m_abcdefghij", host: "lodge", sessions: [], spaces: [] });
      expect(facts.refusals, label).toEqual([]);
      return;
    }
    case "command": {
      const help = hillHelp().join("\n");
      for (const flag of example.text.match(/--[a-z-]+/gu) ?? []) expect(help, `${label} ${flag}`).toContain(flag);
      return;
    }
  }
}

describe("the page is the generator's output", () => {
  test(`docs/tricks-reference.md is current (run: ${REFERENCE_COMMAND})`, () => {
    expect(PAGE).toBe(renderReference());
  });

  test("it says it is generated, and by which command, on the line after the title", () => {
    const lines = PAGE.split("\n");
    expect(lines[0]).toBe("# Tricks reference");
    expect(lines[2]).toContain("generated");
    expect(lines[2]).toContain(REFERENCE_COMMAND);
  });

  test("it is plain Markdown: no HTML tag but its one comment, no SVG, no image", () => {
    // Code blocks and code spans may hold `<id>` placeholders, which are not tags.
    const prose = PAGE.replace(/<!--[\s\S]*?-->/u, "").replace(/```[\s\S]*?```/gu, "").replace(/`[^`\n]*`/gu, "");
    expect(prose).not.toMatch(/<\/?[a-z][^>]*>/iu);
    expect(PAGE).not.toMatch(/\.svg|!\[/u);
  });

  test("it carries no em dash and no private path", () => {
    expect(PAGE).not.toContain("\u2014");
    expect(PAGE).not.toMatch(/concepts\/|experiments\/|decisions\/|\/var\/home\/|\/home\//u);
  });

  test("it names ColliePWA once, at first mention, and Collie after", () => {
    expect(PAGE.split("ColliePWA").length - 1).toBe(1);
    expect(PAGE.indexOf("ColliePWA")).toBeLessThan(PAGE.indexOf("Collie "));
  });
});

describe("every example passes the real parser", () => {
  for (const id of PLACE_ORDER) {
    PLACES[id].examples.forEach((example, i) => {
      test(`place ${id}, example ${String(i + 1)}`, () => checkExample(example, `place ${id}`));
    });
  }

  for (const part of PARTS) {
    test(`part ${part.kind}`, () => {
      checkExample({ kind: "node", json: part.example }, `part ${part.kind}`);
      expect(showsKind(part.example, part.kind), `the example of ${part.kind} shows a ${part.kind}`).toBe(true);
    });
  }

  HILL.examples.forEach((example, i) => {
    test(`the Hill, example ${String(i + 1)}`, () => checkExample(example, "hill"));
  });

  test("the manifest example", () => checkExample(MANIFEST_EXAMPLE, "manifest example"));

  test("each place's example draws in that place", () => {
    for (const id of PLACE_KINDS) {
      const example = PLACES[id].examples[0];
      expect(example?.kind).toBe("document");
      if (example?.kind !== "document") continue;
      const parsed = parseTrickDocument(example.json);
      expect(parsed.parts.map((part) => part.place)).toEqual([id satisfies PlaceKind]);
    }
  });

  test("the agent view example is a manifest that adds an agent view and a screen the agent view parser takes", () => {
    const [manifest, screen] = PLACES[AGENT_VIEW_PLACE].examples;
    expect(manifest?.kind).toBe("manifest");
    expect(screen?.kind).toBe("screen");
    if (manifest?.kind !== "manifest") return;
    expect(parseManifestToml(manifest.toml).manifest?.agentView).toBe(true);
  });

  test("a part's example also reads as an agent view, except where its own note says the agent names pictures by ref", () => {
    for (const part of PARTS) {
      if (part.kind === "image" || part.kind === "compare") continue;
      if (part.kind === "col" || part.kind === "cell") continue;
      const parsed = parseAgentView([part.example]);
      expect(parsed.refusals, `agent view, ${part.kind}`).toEqual([]);
    }
  });
});

describe("the page names everything the code has", () => {
  test("every place", () => {
    expect(Object.keys(PLACES).toSorted()).toEqual([...PLACE_KINDS, AGENT_VIEW_PLACE].toSorted());
    for (const id of PLACE_ORDER) expect(PAGE, id).toContain(`### \`${id}\`\n`);
  });

  test("every part kind and every attribute of it", () => {
    expect(PARTS.map((part) => part.kind)).toEqual([...NODE_KINDS]);
    for (const part of PARTS) {
      expect(PAGE, part.kind).toContain(`### \`${part.kind}\`\n`);
      expect(part.attrs.map((attr) => attr.name)).toEqual([...NODE_ATTRS[part.kind]]);
      for (const attr of part.attrs) {
        expect(attr.what, `${part.kind}.${attr.name}`).not.toBe("");
        expect(attr.limit, `${part.kind}.${attr.name}`).not.toBe("");
        expect(PAGE, `${part.kind}.${attr.name}`).toContain(`| \`${attr.name}\` | ${attr.type} |`);
      }
    }
  });

  test("every manifest key", () => {
    expect(MANIFEST.map((entry) => entry.key)).toEqual([...MANIFEST_KEYS]);
    for (const key of MANIFEST_KEYS) expect(PAGE, key).toContain(`| \`${key}\` |`);
  });

  test("every key of a Decision", () => {
    expect(HILL.keys.map((entry) => entry.key)).toEqual([...DECISION_KEYS]);
    for (const key of DECISION_KEYS) expect(PAGE, key).toContain(`| \`${key}\` |`);
  });

  test("every limit group, and every place or key the parser calls later", () => {
    for (const group of LIMITS) expect(PAGE, group.group).toContain(`### ${group.group}\n`);
    const later = LATER.map((entry) => entry.word);
    expect(later.toSorted()).toEqual([...Object.keys(LATER_PLACE_WORDS), ...LATER_TRIGGERS].toSorted());
    for (const word of later) expect(PAGE, word).toContain(`| \`${word}\` |`);
  });

  test("every verb of collie trick, collie trick view and collie hill", () => {
    expect(COMMANDS.filter((entry) => entry.group === "trick").map((entry) => entry.verb)).toEqual([...TRICK_SUBCOMMANDS]);
    expect(COMMANDS.filter((entry) => entry.group === "trick view").map((entry) => entry.verb)).toEqual([...VIEW_SUBCOMMANDS]);
    expect(COMMANDS.filter((entry) => entry.group === "hill").map((entry) => entry.verb)).toEqual([...HILL_SUBCOMMANDS]);
    for (const entry of COMMANDS) expect(PAGE, `${entry.group} ${entry.verb}`).toContain(`\`collie ${entry.usage.replaceAll("|", "\\|")}\``);
  });
});

describe("the commands match the CLI's own usage", () => {
  const TRICK_SOURCES = ["cli/trick.ts", "cli/trick-dev.ts", "cli/trick-add.ts", "cli/trick-propose.ts", "cli/trick-guide.ts"];
  const trickSource = TRICK_SOURCES.map(read).join("\n");

  /** The `--flag` words of every usage line of `collie trick <verb>` in the CLI's source. */
  function flagsIn(text: string): Set<string> {
    return new Set(text.match(/--[a-z][a-z-]*/gu) ?? []);
  }

  test("every flag of a collie trick verb is in the CLI's source, and its usage line is printed as written", () => {
    for (const entry of COMMANDS.filter((command) => command.group === "trick")) {
      for (const flag of entry.flags) expect(trickSource, `${entry.verb} ${flag.flag}`).toContain(flag.flag);
      if (entry.verb === "list" || entry.verb === "view") continue;
      // `on` and `off` share one usage line, written once with the verb as a template word.
      const printed = entry.verb === "on" || entry.verb === "off" ? "usage: collie trick ${verb} <id>" : `usage: collie ${entry.usage}`;
      expect(trickSource, `${entry.verb} usage`).toContain(printed);
    }
  });

  test("the flags of the collie trick usage lines are all listed", () => {
    const usageLines = trickSource.split("\n").filter((line) => /usage: collie trick (?!view)/u.test(line) || line.includes("DEV_USAGE ="));
    const inSource = flagsIn(usageLines.join("\n"));
    const listed = new Set(COMMANDS.filter((entry) => entry.group === "trick").flatMap((entry) => entry.flags.map((flag) => flag.flag)));
    for (const flag of inSource) expect(listed.has(flag), `${flag} is in a usage line but not in the catalogue`).toBe(true);
    for (const flag of listed) expect(trickSource, flag).toContain(flag);
  });

  test("the trick view verbs and flags are exactly the verbs' own usage lines", () => {
    const usage = viewUsageLines().join("\n");
    for (const entry of COMMANDS.filter((command) => command.group === "trick view")) {
      expect(usage, entry.verb).toContain(entry.usage);
      for (const flag of entry.flags) expect(usage, `${entry.verb} ${flag.flag}`).toContain(flag.flag);
    }
    const listed = new Set(COMMANDS.filter((entry) => entry.group === "trick view").flatMap((entry) => entry.flags.map((flag) => flag.flag)));
    for (const flag of flagsIn(usage)) expect(listed.has(flag), `${flag} is in a usage line but not in the catalogue`).toBe(true);
  });

  test("the hill verbs and flags are exactly collie hill's own help", () => {
    const help = hillHelp().join("\n");
    const listed = new Set(COMMANDS.filter((entry) => entry.group === "hill").flatMap((entry) => entry.flags.map((flag) => flag.flag)));
    for (const flag of listed) expect(help, flag).toContain(flag);
    const usageOnly = hillHelp().filter((line) => /^ {2}\S/u.test(line) || line.startsWith("usage:")).join("\n");
    for (const flag of flagsIn(usageOnly)) {
      if (flag === "--help") continue;
      expect(listed.has(flag), `${flag} is in collie hill's usage but not in the catalogue`).toBe(true);
    }
  });
});

// ── The program, the helper, the input globs and the Hill's list rules ───────────────────────────

const NUMBERS = programNumbers();
const PROGRAM = programOf(NUMBERS);
const RULES = hillRulesOf(NUMBERS);

/** The part of the page from one heading up to the next heading of the same or a higher level. */
function sectionOf(heading: string): string {
  const level = heading.match(/^#+/u)?.[0].length ?? 0;
  const lines = PAGE.split("\n");
  const start = lines.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#+ /u.test(line) && (line.match(/^#+/u)?.[0].length ?? 0) <= level);
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

/** A table row of the page that starts with this first cell. */
function rowOf(section: string, first: string): string {
  const row = section.split("\n").find((line) => line.startsWith(`| ${first} |`));
  expect(row, first).toBeDefined();
  return row ?? "";
}

/** GitHub's slug of a heading: lower case, only letters, digits, spaces, hyphens and underscores, spaces to hyphens. */
function slugOf(heading: string): string {
  return heading.replaceAll("`", "").toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-");
}

describe("the program section", () => {
  test("it sits after the manifest keys and before the limits, with its five subsections in order", () => {
    const at = (heading: string): number => PAGE.indexOf(`\n${heading}\n`);
    const order = ["## Manifest keys", "## The program", "### What the program receives", "### What the program prints", "### Strict at write, tolerant at read", "### The helper", "### Input globs", "## Limits"];
    const places = order.map(at);
    for (const [i, heading] of order.entries()) expect(places[i], heading).toBeGreaterThan(-1);
    expect(places).toEqual(places.toSorted((a, b) => a - b));
  });

  test("every heading of the page has its own anchor", () => {
    const outside = PAGE.replace(/```[\s\S]*?```/gu, "");
    const slugs = outside.split("\n").filter((line) => /^#{2,4} /u.test(line)).map((line) => slugOf(line.replace(/^#+ /u, "")));
    const twice = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
    expect(twice).toEqual([]);
    expect(slugs).toContain("input-globs");
    expect(slugs).toContain("inputs");
  });

  test("every key of the facts, of a session, of its inputs and of an input file has a row, and the schema lists no other", () => {
    expect(PROGRAM.facts.map((row) => row.field)).toEqual([...FACTS_KEYS]);
    expect(PROGRAM.session.map((row) => row.field)).toEqual([...SESSION_FACT_KEYS]);
    expect(PROGRAM.inputsFields.map((row) => row.field)).toEqual([...INPUTS_FACT_KEYS]);
    expect(PROGRAM.inputFiles.map((row) => row.field)).toEqual([...INPUT_FILE_FACT_KEYS]);
    const receives = sectionOf("### What the program receives");
    for (const key of [...FACTS_KEYS, ...SESSION_FACT_KEYS]) expect(receives, key).toContain(`| \`${key}\` |`);
    for (const row of [...PROGRAM.facts, ...PROGRAM.session, ...PROGRAM.inputsFields, ...PROGRAM.inputFiles]) {
      expect(row.what, row.field).not.toBe("");
      expect(row.present, row.field).not.toBe("");
    }
    const globs = sectionOf("### Input globs");
    for (const key of [...INPUTS_FACT_KEYS, ...INPUT_FILE_FACT_KEYS]) expect(globs, key).toContain(`| \`${key}\` |`);
    expect(rowOf(receives, "`trick`")).toContain(TRICK_FACT_KEYS.map((key) => `\`${key}\``).join(", "));
  });

  test("the status row names every status the facts carry, and the page has a row for every input state", () => {
    const status = rowOf(sectionOf("### What the program receives"), "`status`");
    for (const word of SESSION_STATUSES) expect(status, word).toContain(`\`${word}\``);
    expect(PROGRAM.inputStates.map((row) => row.state)).toEqual([...INPUT_STATES]);
    const globs = sectionOf("### Input globs");
    for (const state of INPUT_STATES) expect(globs, state).toContain(`| \`${state}\` |`);
  });

  test("every trigger kind is a row of the table or is named as one this Collie never sends", () => {
    const sent = PROGRAM.triggers.map((row) => row.kind);
    expect([...sent, ...PROGRAM.triggersLater].toSorted()).toEqual([...TRIGGER_KINDS].toSorted());
    expect(sent).toEqual(["start", "timer", "tap"]);
    const receives = sectionOf("### What the program receives");
    for (const row of PROGRAM.triggers) {
      expect(receives, row.kind).toContain(`| \`${row.kind}\` |`);
      const other = TRIGGER_KEYS[row.kind].filter((key) => key !== "kind");
      expect(row.fields, row.kind).toBe(other.length === 0 ? "none" : other.map((key) => `\`${key}\``).join(", "));
    }
    for (const kind of PROGRAM.triggersLater) expect(receives, kind).toContain(`\`${kind}\``);
    expect(receives).toContain(`\`${HILL_NODE_PREFIX}<key>\``);
  });

  test("the timer runs only while a phone has watched, for as long as the bridge says", () => {
    const timer = PROGRAM.triggers.find((row) => row.kind === "timer");
    expect(NUMBERS.watchWindowMs).toBe(WATCH_WINDOW_MS);
    expect(timer?.when).toContain("5 minutes");
    expect(WATCH_WINDOW_MS).toBe(5 * 60_000);
  });

  test("a trigger of each sent kind passes the facts parser", () => {
    const trick = { id: "legs", dir: "/tmp/legs", state: "/tmp/legs-state" };
    for (const trigger of [{ kind: "start" }, { kind: "timer" }]) {
      const parsed = parseFacts({ contract: 1, trigger, trick, memberId: "m_abcdefghij", host: "lodge", sessions: [], spaces: [] });
      expect(parsed.refusals, trigger.kind).toEqual([]);
    }
  });

  test("a document key is a row, and the keys of the first schema are ignored with a note that says they are gone", () => {
    expect(PROGRAM.output.map((row) => row.key)).toEqual([...DOCUMENT_KEYS]);
    const prints = sectionOf("### What the program prints");
    for (const key of DOCUMENT_KEYS) expect(prints, key).toContain(`| \`${key}\` |`);
    expect(rowOf(prints, "`v`")).toContain(`from 1 to ${String(helper.CONTRACT)}`);
    expect(PROGRAM.removedOutputKeys).toEqual(["draft", "open"]);
    for (const key of PROGRAM.removedOutputKeys) {
      expect(prints, key).toContain(`\`${key}\``);
      const parsed = parseTrickDocument({ v: 1, parts: [], [key]: "x" });
      expect(parsed.refusals, key).toEqual([]);
      expect(parsed.notes.map((note) => `${note.code} ${note.path}`), key).toEqual([`ignored /${key}`]);
      expect(parsed.notes[0]?.reason, key).toContain("is gone");
    }
  });

  test("a document with a v from 1 to this Collie's contract reads, and a higher one is refused whole", () => {
    for (let v = 1; v <= helper.CONTRACT; v += 1) expect(parseTrickDocument({ v, parts: [] }).documentRefused, String(v)).toBe(false);
    expect(parseTrickDocument({ v: helper.CONTRACT + 1, parts: [] }).documentRefused).toBe(true);
  });

  test("the default of fresh is three times every, at least a minute, or ten minutes with no timer", () => {
    const fresh = rowOf(sectionOf("### What the program prints"), "`fresh`");
    expect(fresh).toContain("3 times `every`");
    expect(fresh).toContain("at least 1 minute");
    expect(fresh).toContain("10 minutes for a trick with no timer");
    expect(fresh).toContain("5s to 24h");
  });
});

describe("the reading rules are what the parser does", () => {
  const ok = { at: "status", id: "ci", chip: { text: "ok" } };
  const parts = (...list: JsonValue[]): JsonValue => ({ v: 1, parts: list });

  test("an unknown node kind, and a part in an unknown place, are left out with a dropped note", () => {
    const node = parseTrickDocument(parts({ at: "session", id: "m", view: [{ kind: "zzz" }, { kind: "para", text: "hi" }] }));
    expect(node.refusals).toEqual([]);
    expect(node.notes.map((note) => note.code)).toEqual(["dropped"]);
    expect(node.parts.length).toBe(1);
    const place = parseTrickDocument(parts(ok, { at: "zzz", id: "x" }));
    expect(place.refusals).toEqual([]);
    expect(place.notes.map((note) => note.code)).toEqual(["dropped"]);
    expect(place.parts.length).toBe(1);
  });

  test("an unknown key on the document, a part or a node, and an unknown attribute, are ignored with a note", () => {
    const top = parseTrickDocument({ v: 1, parts: [ok], zzz: 1 });
    const part = parseTrickDocument(parts({ ...ok, zzz: 1 }));
    const attr = parseTrickDocument(parts({ at: "session", id: "m", view: [{ kind: "para", text: "hi", attrs: { zzz: "1" } }] }));
    for (const parsed of [top, part, attr]) {
      expect(parsed.refusals).toEqual([]);
      expect(parsed.notes.map((note) => note.code)).toEqual(["ignored"]);
      expect(parsed.parts.length).toBe(1);
    }
  });

  test("at contract 2 an unknown key in a part leaves that part out with the closed-key line; the document's own keys stay open", () => {
    const closed = parseTrickDocument(parts({ ...ok, zzz: 1 }, { at: "status", id: "ok", chip: { text: "ok" } }), { contract: 2 });
    expect(closed.parts.length).toBe(1);
    expect(closed.refusals.map((refusal) => [refusal.code, refusal.part])).toEqual([["unknown-key", "ci"]]);
    expect(closed.refusals[0]?.reason.endsWith(CLOSED_KEY_LINE)).toBe(true);
    const top = parseTrickDocument({ v: 2, parts: [ok], zzz: 1 }, { contract: 2 });
    expect(top.refusals).toEqual([]);
    expect(top.notes.map((note) => note.code)).toEqual(["ignored"]);
    expect(top.parts.length).toBe(1);
    expect(PAGE).toContain(CLOSED_KEY_LINE);
    expect(PAGE).toContain("at the top of the document");
  });

  test("the page names every tap refusal with the bridge's own line, and that from.session is not proof", () => {
    for (const refused of TAP_REFUSALS) expect(PAGE).toContain(`| \`${refused}\` | \`${refused === "changed" ? "changed" : "rejected"}\` |`);
    for (const line of Object.values(TAP_REFUSED_LINES)) expect(PAGE).toContain(line);
    expect(PAGE).toContain("`from.session` is not proof of who tapped");
  });

  test("a bad value refuses its part alone, a bad Decision refuses itself alone, and a bad asOf leaves the parts", () => {
    const part = parseTrickDocument(parts(ok, { at: "dashboard", id: "d", item: { label: "" } }));
    expect(part.refusedParts).toEqual(["d"]);
    expect(part.parts.map((p) => p.place)).toEqual(["status"]);
    expect(part.documentRefused).toBe(false);
    const decision = parseTrickDocument({ v: 1, parts: [ok], decisions: [{ key: "a" }] });
    expect(decision.refusedDecisions).toEqual(["a"]);
    expect(decision.parts.length).toBe(1);
    const asOf = parseTrickDocument({ v: 1, parts: [ok], asOf: "yesterday" });
    expect(asOf.refusals.map((refusal) => refusal.path)).toEqual(["/asOf"]);
    expect(asOf.parts.length).toBe(1);
  });

  test("a document that is too big, not JSON, not an object, with no usable v or with parts that are no list is refused whole", () => {
    const wholes = [parseTrickDocument(parts()), parseTrickDocument("x"), parseTrickDocument({ v: 1, parts: "x" }), parseTrickDocument({ parts: [] }), parseTrickDocument({ v: 99, parts: [] })];
    expect(wholes.map((parsed) => parsed.documentRefused)).toEqual([false, true, true, true, true]);
    expect(parseTrickDocumentText("{ not json").documentRefused).toBe(true);
    expect(parseTrickDocumentText(`{"v":1,"parts":[],"pad":"${"x".repeat(70_000)}"}`).documentRefused).toBe(true);
  });

  test("a Decision, like a manifest, is read strictly: an unknown key refuses it", () => {
    const strict = parseTrickDocument({ v: 1, parts: [], decisions: [{ key: "a", title: "Rerun it?", summary: "It failed.", zzz: 1 }] });
    expect(strict.refusedDecisions).toEqual(["a"]);
    expect(parseManifestToml('id = "legs"\nname = "Legs"\nrun = "program.ts"\nplaces = ["belt"]\nzzz = 1\n').refusals.length).toBeGreaterThan(0);
  });

  test("every row of the page's table is a row of the catalogue", () => {
    const section = sectionOf("### Strict at write, tolerant at read");
    for (const row of PROGRAM.reading) expect(section, row.case).toContain(`| ${row.case} | ${row.result} |`);
  });
});

describe("the helper table names real calls", () => {
  const facts: helper.Facts = { contract: 1, trigger: { kind: "timer" }, trick: { id: "legs", dir: "/nonexistent", state: "/nonexistent" }, host: "lodge", memberId: "m_abcdefghij", sessions: [], spaces: [] };
  const source = read("cli/trick-kit/trick.ts");
  const builders = new Set(Object.keys(helper.v));
  const exported = new Set(Object.keys(helper));

  test("each call of the table is a method or a field of the helper's Trick, a builder of `v`, or an export", () => {
    const methods = new Set(Object.getOwnPropertyNames(helper.Trick.prototype));
    const fields = new Set(["facts", "config", "tap", "state"]);
    for (const row of PROGRAM.helper) {
      expect(row.names.length, row.call).toBeGreaterThan(0);
      for (const name of row.names) {
        if (name.startsWith("t.")) {
          const call = name.slice(2);
          expect(methods.has(call) || fields.has(call), name).toBe(true);
          if (fields.has(call)) expect(source, name).toMatch(new RegExp(`readonly ${call}\\b`, "u"));
          continue;
        }
        if (name.startsWith("v.")) {
          expect(builders.has(name.slice(2)), name).toBe(true);
          continue;
        }
        expect(exported.has(name), name).toBe(true);
      }
    }
  });

  test("the table's own words show on the page, and every call is written into a cell", () => {
    const section = sectionOf("### The helper");
    for (const row of PROGRAM.helper) expect(section, row.call).toContain(`| ${row.call} |`);
  });

  test("v has a builder for every node kind but col and cell, which v.table makes", () => {
    for (const kind of NODE_KINDS) expect(builders.has(kind), kind).toBe(kind !== "col" && kind !== "cell");
    for (const recipe of ["checks", "stat", "beforeAfter"]) expect(builders.has(recipe), recipe).toBe(true);
    const table = helper.v.table({ columns: ["A"], rows: [["x"]] });
    expect((table.kids ?? []).map((kid) => kid.kind)).toEqual(["col", "cell"]);
  });

  test("a run that calls neither t.decide nor t.keepDecisions prints decisions [], and t.keepDecisions leaves the key out even after t.decide", () => {
    expect(new helper.Trick(facts).document().decisions).toEqual([]);
    const asked = new helper.Trick(facts);
    asked.decide({ key: "a", title: "Rerun it?", summary: "It failed." });
    expect(asked.document().decisions?.length).toBe(1);
    asked.keepDecisions();
    expect("decisions" in asked.document()).toBe(false);
    expect(PROGRAM.helperAfter.join("\n")).toContain('prints `"decisions": []`');
  });

  test("the helper prints the contract of its facts as v, and the fresh and asOf calls set their keys", () => {
    const t = new helper.Trick({ ...facts, contract: 2 });
    t.fresh("90s");
    t.asOf(0);
    const doc = t.document();
    expect(doc.v).toBe(2);
    expect(doc.fresh).toBe("90s");
    expect(doc.asOf).toBe("1970-01-01T00:00:00.000Z");
  });

  test("t.sh keeps the cap and waits the time that the table says, read from the helper's own source", () => {
    expect(NUMBERS.helperShCapBytes).toBe(256 * 1024);
    expect(NUMBERS.helperShTimeoutMs).toBe(5000);
    const row = PROGRAM.helper.find((entry) => entry.names.includes("t.sh"));
    expect(row?.what).toContain("256 KiB");
    expect(row?.what).toContain("5 seconds");
    expect(() => helperNumber("no cap here", /const SH_CAP = (\d+) \* 1024;/u)).toThrow();
  });

  test("a trick's t.sh never throws and answers ok false for a program that is not there", async () => {
    const t = new helper.Trick(facts);
    const none = await t.sh(null);
    expect(none.ok).toBe(false);
    const missing = await t.sh("/nonexistent/program");
    expect(missing.ok).toBe(false);
  });

  test("t.log's once writes one line for one rid, so a retried tap records nothing twice", () => {
    const state = mkdtempSync(join(tmpdir(), "reference-log-"));
    try {
      const t = new helper.Trick({ ...facts, trick: { ...facts.trick, state } });
      const log = t.log("answers");
      expect(log.once("rid-1", { intent: "wake" })).toBe(true);
      expect(log.once("rid-1", { intent: "wake" })).toBe(false);
      expect(log.once("", { intent: "wake" })).toBe(false);
      expect(log.all().length).toBe(1);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("the input globs are the schema's rules", () => {
  test("each refused shape of the table is refused, and the ordinary globs read", () => {
    const refused = ["", "/etc/passwd", "~/notes", "**/x.md", "a/**", "./x", "a/../b", "a//b", "a/", ".git/config", ".GIT/config", "a/.Git", ".env", ".env.local", ".envrc", "sub/.ENV", "a?.md", "a[1].md", "{a,b}.md", "a\\b", "a\u0007b", Array.from({ length: INPUT_DEPTH_MAX + 1 }, () => "a").join("/")];
    for (const glob of refused) expect(inputGlobProblem(glob), JSON.stringify(glob)).toBeDefined();
    for (const glob of ["TODO.md", "shots/*.png", "docs/*/notes.md", "*", Array.from({ length: INPUT_DEPTH_MAX }, () => "a").join("/")]) expect(inputGlobProblem(glob), glob).toBeUndefined();
  });

  test("a star matches inside one step and never a leading dot or a .env file", () => {
    expect(inputGlobMatches("shots/*.png", "shots/a.png")).toBe(true);
    expect(inputGlobMatches("shots/*.png", "shots/deep/a.png")).toBe(false);
    expect(inputGlobMatches("*", ".hidden")).toBe(false);
    expect(inputGlobMatches("*", ".env")).toBe(false);
    expect(inputGlobMatches("*", "notes.md")).toBe(true);
  });

  test("the page says each of the three rules, and the refusal sentence is the parser's", () => {
    const globs = sectionOf("### Input globs");
    expect(PROGRAM.globs.map((row) => row.rule)).toEqual(["Shape", "`*`", "Refused"]);
    for (const row of PROGRAM.globs) expect(globs, row.rule).toContain(`| ${row.rule} | ${row.value} |`);
    expect(globs).toContain(`1 to ${String(INPUT_DEPTH_MAX)} steps`);
    expect(globs).toContain(PROGRAM.inputsContractLine);
    const manifest = parseManifestToml('id = "legs"\nname = "Legs"\nrun = "program.ts"\nplaces = ["belt"]\ninputs = ["TODO.md"]\n');
    expect(manifest.refusals.map((refusal) => refusal.reason)).toContain(PROGRAM.inputsContractLine);
  });

  test("the page calls inputs untrusted data and says the globs are part of the powers", () => {
    expect(PAGE).toContain("> **Caution.** Inputs are untrusted data.");
    expect(PROGRAM.inputsTrust).toContain("part of the trick's powers");
  });

  test("a session that is older than the crew floor reads as older, with the floor the bridge names", () => {
    expect(NUMBERS.tricksCrewFirstVersion).toBe(TRICKS_CREW_FIRST_VERSION);
    const older = PROGRAM.inputStates.find((row) => row.state === "older");
    expect(older?.when).toContain(TRICKS_CREW_FIRST_VERSION);
  });
});

describe("the Hill's list rules and the wording of a card", () => {
  test("the re-ask wait is the bridge's, and the states that may ask again are states the Hill has", () => {
    expect(NUMBERS.reaskAfterMs).toBe(REASK_AFTER_MS);
    const row = RULES.list.find((entry) => entry.case.includes("closed without the person"));
    expect(row?.result).toContain("at most once every 10 minutes");
    expect(REASK_AFTER_MS).toBe(10 * 60_000);
    for (const state of ["undeliverable", "expired", "withdrawn"]) {
      expect(HILL_STATES.map(String), state).toContain(state);
      expect(row?.case, state).toContain(`\`${state}\``);
    }
  });

  test("the rules cover a new key, changed content, a dropped key, an answered key, a re-ask, no key, an empty list and a failed run", () => {
    const cases = RULES.list.map((row) => row.case);
    for (const wanted of ["A new `key`", "A listed `key` with changed content", "A `key` the list no longer holds", "A `key` the person answered or dismissed", "A document with no `decisions` key", "`decisions` is `[]`", "A failed or timed-out run"]) expect(cases, wanted).toContain(wanted);
    const section = sectionOf("### The list is the truth");
    for (const row of RULES.list) expect(section, row.case).toContain(`| ${row.case} | ${row.result} |`);
    expect(section).toContain(RULES.listAfter);
  });

  test("the wording limits are the CLI's, and its warnings fire where the page says they do", () => {
    expect(NUMBERS.titleSoftMax).toBe(HILL_TITLE_SOFT_MAX);
    expect(NUMBERS.summarySoftSentences).toBe(HILL_SUMMARY_SOFT_SENTENCES);
    expect(NUMBERS.summarySoftMax).toBe(HILL_SUMMARY_SOFT_MAX);
    const wording = sectionOf("### Wording a card");
    expect(wording).toContain(RULES.warnings);
    expect(RULES.warnings).toContain(`${String(HILL_TITLE_SOFT_MAX)} characters`);
    expect(RULES.warnings).toContain(`${String(HILL_SUMMARY_SOFT_MAX)} characters`);
    const good = { title: "Ship 1.28.1 to Stable now?", summary: "It ships the fix. CI is green.", options: [{ intent: "ship", label: "Ship it" }] };
    expect(hillWordingWarnings(good)).toEqual([]);
    expect(hillWordingWarnings({ ...good, title: `${"x".repeat(HILL_TITLE_SOFT_MAX)}?` }).length).toBeGreaterThan(0);
    expect(hillWordingWarnings({ ...good, title: "Ship it" }).length).toBeGreaterThan(0);
    expect(hillWordingWarnings({ ...good, summary: "One. Two. Three." }).length).toBeGreaterThan(0);
    expect(hillWordingWarnings({ ...good, options: [{ intent: "yes", label: "Yes" }] }).length).toBeGreaterThan(0);
  });

  test("the Hill section points at the rules and does not repeat them in its own words", () => {
    expect(HILL.program).toContain("#the-list-is-the-truth");
  });
});
