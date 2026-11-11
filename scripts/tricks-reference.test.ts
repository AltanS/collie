import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hillHelp, HILL_SUBCOMMANDS } from "../cli/hill.ts";
import { TRICK_SUBCOMMANDS } from "../cli/trick.ts";
import { VIEW_SUBCOMMANDS, viewUsageLines } from "../cli/trick-view.ts";
import { parseAgentView } from "../web/src/lib/agent-view/wire.ts";
import {
  COMMANDS,
  HILL,
  LATER,
  LIMITS,
  MANIFEST,
  MANIFEST_EXAMPLE,
  PARTS,
  PLACE_ORDER,
  PLACES,
  type Example,
} from "../web/src/lib/tricks/catalogue.ts";
import {
  AGENT_VIEW_PLACE,
  DECISION_KEYS,
  LATER_PLACE_WORDS,
  LATER_TRIGGERS,
  MANIFEST_KEYS,
  NODE_ATTRS,
  NODE_KINDS,
  PLACE_KINDS,
  parseFacts,
  parseManifest,
  parseTrickDocument,
  type PlaceKind,
} from "../web/src/lib/tricks/schema.ts";
import type { JsonValue } from "../web/src/lib/json.ts";
import { REFERENCE_COMMAND, REFERENCE_PAGE, renderReference } from "./tricks-reference.ts";

// THE TRICKS REFERENCE (docs/tricks-reference.md) is generated from the catalogue. This file holds it to
// the code in five ways:
//   1. the page on disk is exactly what the generator writes (a stale page fails, with the command);
//   2. every example in the catalogue passes the real parser it is an example of;
//   3. the page names every place, part kind, node attribute, manifest key, Decision key, later word and
//      verb that the code has, and the catalogue names nothing the code lacks;
//   4. the commands list equals the CLI's own verb lists, and every flag it names is in the CLI's usage;
//   5. the words stay plain: no em dash, no private path.
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
