#!/usr/bin/env bun
// THE TRICKS REFERENCE, GENERATED. `docs/tricks-reference.md` is written whole from the tricks catalogue
// (`web/src/lib/tricks/catalogue.ts`), which reads its numbers from the constants the parser and the
// bridge check with. Nobody edits the page by hand.
//
//   bun scripts/tricks-reference.ts            print a diff and exit 1 when the page is stale
//   bun scripts/tricks-reference.ts --write    write the page
//
// `scripts/tricks-reference.test.ts` holds the page to the generator, parses every example with the real
// parser, and fails when a place, a part kind, a manifest key or a verb is missing from the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REASK_AFTER_MS } from "../bridge/tricks/hill.ts";
import { WATCH_WINDOW_MS } from "../bridge/tricks/service.ts";
import { TRICKS_CREW_FIRST_VERSION } from "../bridge/hill/crew.ts";
import { HILL_SUMMARY_SOFT_MAX, HILL_SUMMARY_SOFT_SENTENCES, HILL_TITLE_SOFT_MAX } from "../cli/hill-rules.ts";
import { runReferenceCli, table, word } from "./reference-kit.ts";
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
  SHARED_VALUES,
  VIEW_KINDS_OF,
  decisionViewNote,
  hillRulesOf,
  programOf,
  type CommandEntry,
  type CommandGroup,
  type Example,
  type FieldRow,
  type Limit,
  type ProgramNumbers,
} from "../web/src/lib/tricks/catalogue.ts";

/** The page, relative to the repository root. */
export const REFERENCE_PAGE = "docs/tricks-reference.md";

/** The command that writes it, as the page names it. */
export const REFERENCE_COMMAND = "bun scripts/tricks-reference.ts --write";

const HELPER_SOURCE = join(import.meta.dir, "..", "cli", "trick-kit", "trick.ts");

/** A number the helper file holds, read from its own source: the helper is copied into a trick folder as text, so nothing can import it. */
export function helperNumber(source: string, pattern: RegExp): number {
  const found = pattern.exec(source)?.[1];
  const value = found === undefined ? Number.NaN : Number(found.replaceAll("_", ""));
  if (!Number.isFinite(value)) throw new Error(`cli/trick-kit/trick.ts no longer matches ${String(pattern)}: update the generator`);
  return value;
}

/** The numbers of the program's side that the catalogue cannot import, each read from the constant that owns it. */
export function programNumbers(): ProgramNumbers {
  const helper = readFileSync(HELPER_SOURCE, "utf8");
  return {
    watchWindowMs: WATCH_WINDOW_MS,
    reaskAfterMs: REASK_AFTER_MS,
    tricksCrewFirstVersion: TRICKS_CREW_FIRST_VERSION,
    titleSoftMax: HILL_TITLE_SOFT_MAX,
    summarySoftSentences: HILL_SUMMARY_SOFT_SENTENCES,
    summarySoftMax: HILL_SUMMARY_SOFT_MAX,
    helperShCapBytes: helperNumber(helper, /const SH_CAP = (\d+) \* 1024;/u) * 1024,
    helperShTimeoutMs: helperNumber(helper, /opts\.timeoutMs \?\? (\d+)\)/u),
  };
}

function limitTable(limits: readonly Limit[]): string[] {
  return table(
    ["Limit", "Value"],
    limits.map((limit) => [limit.what, limit.value]),
  );
}

/** An example as a fenced block. */
function exampleBlock(example: Example): string[] {
  switch (example.kind) {
    case "manifest":
      return ["```toml", example.toml.trimEnd(), "```"];
    case "command":
      return ["```sh", example.text, "```"];
    case "document":
    case "node":
    case "screen":
    case "decision":
    case "tap":
      return ["```json", JSON.stringify(example.json, null, 2), "```"];
  }
}

/** The label above an example, by what it is. */
function exampleLabel(example: Example): string {
  switch (example.kind) {
    case "manifest":
      return "In `trick.toml`:";
    case "command":
      return "From a terminal:";
    case "document":
      return "A program prints:";
    case "node":
      return "A node:";
    case "screen":
      return "The agent passes `show` this file:";
    case "decision":
      return "A program lists this Decision:";
    case "tap":
      return "The answer comes back as this trigger:";
  }
}

function exampleLines(examples: readonly Example[]): string[] {
  return examples.flatMap((example) => ["", exampleLabel(example), "", ...exampleBlock(example)]);
}

function placesSection(): string[] {
  const lines: string[] = [
    "## Places",
    "",
    "A place is a spot on the phone where a trick can show (a surface). A program trick, a program on your machine that prints parts, draws in the first five. An agent view, one screen that the session's own agent draws, is the sixth.",
    "",
    ...table(
      ["Place", "Name", "Where it shows", "Drawn by"],
      PLACE_ORDER.map((id) => [word(id), PLACES[id].name, PLACES[id].where, PLACES[id].who === "program" ? "A program" : "A session's agent"]),
    ),
  ];
  for (const id of PLACE_ORDER) {
    const place = PLACES[id];
    lines.push("", `### ${word(id)}`, "", `**Where.** ${place.where}`, "", `**Shows.** ${place.shows}`, "", `**A tap.** ${place.tap}`, "", ...limitTable(place.limits), ...exampleLines(place.examples));
  }
  return lines;
}

function fieldTable(head: string, rows: readonly FieldRow[]): string[] {
  return table(
    [head, "Present", "What it holds"],
    rows.map((row) => [word(row.field), row.present, row.what]),
  );
}

function hillSection(): string[] {
  const rules = hillRulesOf(programNumbers());
  return [
    "## The Hill",
    "",
    HILL.what,
    "",
    `**From a program.** ${HILL.program}`,
    "",
    `**From an agent.** ${HILL.agent}`,
    "",
    "A Decision a program lists has these keys:",
    "",
    ...table(
      ["Key", "Type", "Needed", "Limit", "What it is"],
      HILL.keys.map((key) => [word(key.key), key.type, key.required, key.limit, key.what]),
    ),
    "",
    ...limitTable(HILL.limits),
    "",
    `**The answer.** ${HILL.answer}`,
    ...exampleLines(HILL.examples),
    "",
    "### The list is the truth",
    "",
    "After each run that succeeded, Collie makes the Hill agree with the list of `decisions`, key by key.",
    "",
    ...table(
      ["When", "Collie does"],
      rules.list.map((row) => [row.case, row.result]),
    ),
    "",
    rules.listAfter,
    "",
    "### Wording a card",
    "",
    "A person opens the card cold, between other things, so the words carry the decision.",
    "",
    ...table(
      ["Part", "How to write it"],
      rules.wording.map((row) => [row.case, row.result]),
    ),
    "",
    rules.warnings,
  ];
}

function programSection(): string[] {
  const program = programOf(programNumbers());
  return [
    "## The program",
    "",
    "A trick's program reads one JSON document on stdin, the facts, and prints one JSON document on stdout, exits 0, and may use the helper `trick.ts`. This section lists what each side holds.",
    "",
    "### What the program receives",
    "",
    "Collie writes the facts on stdin. The program ignores a field it does not know, because a later Collie at the same contract may add one.",
    "",
    ...fieldTable("Field", program.facts),
    "",
    "A session in `sessions` has these fields:",
    "",
    ...fieldTable("Field", program.session),
    "",
    "The `trigger` tells why the run happened:",
    "",
    ...table(
      ["`trigger.kind`", "When", "Other fields"],
      program.triggers.map((row) => [word(row.kind), row.when, row.fields]),
    ),
    "",
    `The kinds ${program.triggersLater.map(word).join(" and ")} are in the facts schema for a later Collie. This Collie never sends them.`,
    ...program.tap.flatMap((sentence) => ["", sentence]),
    "",
    "### What the program prints",
    "",
    "The program prints one JSON document on stdout and exits 0:",
    "",
    "```json",
    '{ "v": 1, "parts": [], "decisions": [], "asOf": "2026-11-08T09:41:00Z", "fresh": "90s" }',
    "```",
    "",
    ...table(
      ["Key", "Needed", "What it is"],
      program.output.map((row) => [word(row.key), row.required, row.what]),
    ),
    "",
    `There is no ${program.removedOutputKeys.map(word).join(" and no ")}: Collie ignores each with a note. A trick never writes into a reply box, and a tap never moves the phone. What a trick wants to show is a \`link\`. What it wants to tell the person is a Decision.`,
    "",
    "### Strict at write, tolerant at read",
    "",
    "Collie checks strictly what a person or an agent writes: `trick.toml`, `collie hill post` and a trick's Decisions. An unknown key, kind or attribute there is refused. It reads a program's output tolerantly, so a trick written for a newer Collie runs on an older one, which leaves out only what it does not know.",
    "",
    ...table(
      ["The program prints", "Collie does"],
      program.reading.map((row) => [row.case, row.result]),
    ),
    "",
    "### The helper",
    "",
    "`trick.ts` is the helper of a TypeScript trick. `run((t) => { ... })` reads the facts, calls your function once and prints the document. These are its calls:",
    "",
    ...table(
      ["Call", "What it does"],
      program.helper.map((row) => [row.call, row.what]),
    ),
    ...program.helperAfter.flatMap((sentence) => ["", sentence]),
    "",
    "### Input globs",
    "",
    "A contract 2 trick lists `inputs` in `trick.toml`: globs of files that Collie copies from each agent session's folder into the trick's `inputs/` folder before each run, through the Files view's rules. The limits of globs, files and bytes are in the [Inputs limits](#inputs).",
    "",
    ...table(
      ["Rule", "Value"],
      program.globs.map((row) => [row.rule, row.value]),
    ),
    "",
    "Each session in the facts gets `inputs`, with these fields:",
    "",
    ...fieldTable("Field", program.inputsFields),
    "",
    "The `state` is one of these:",
    "",
    ...table(
      ["`state`", "When"],
      program.inputStates.map((row) => [word(row.state), row.when]),
    ),
    "",
    "Each file in `files` has these fields:",
    "",
    ...fieldTable("Field", program.inputFiles),
    "",
    `A contract 1 trick that lists \`inputs\` is refused with: ${program.inputsContractLine}`,
    "",
    `> **Caution.** Inputs are untrusted data. ${program.inputsTrust}`,
  ];
}

function partsSection(): string[] {
  const lines: string[] = [
    "## Parts",
    "",
    'A part, in this page, is one node of a view: the building block a view is made of (the schema calls it a node kind). A node is `{ "kind": ..., "text"?: ..., "attrs"?: ..., "kids"?: ... }`, and every attribute value is text.',
    "",
    `- ${VIEW_KINDS_OF.program}`,
    `- ${VIEW_KINDS_OF.decision}`,
    `- ${VIEW_KINDS_OF.agentView}`,
    "",
    ...table(
      ["Part", "What it is", "Sits", "In a Decision's view"],
      PARTS.map((part) => [word(part.kind), part.what, part.sits, part.inDecision ? "yes" : "no"]),
    ),
  ];
  for (const part of PARTS) {
    lines.push("", `### ${word(part.kind)}`, "", part.what, "", `**Sits.** ${part.sits}.`);
    if (part.holds !== "") lines.push("", `**Holds.** ${part.holds}.`);
    if (part.text !== "") lines.push("", `**Text.** ${part.text}.`);
    if (part.attrs.length > 0) {
      lines.push(
        "",
        ...table(
          ["Attribute", "Type", "Needed", "Limit", "What it is"],
          part.attrs.map((attr) => [word(attr.name), attr.type, attr.required, attr.limit, attr.what]),
        ),
      );
    }
    if (part.agentView !== "") lines.push("", `**In an agent view.** ${part.agentView}`);
    const decision = decisionViewNote(part.kind);
    if (decision !== "") lines.push("", `**In a Decision's view.** ${decision}`);
    lines.push("", "```json", JSON.stringify(part.example, null, 2), "```");
  }
  lines.push("", "### Shared values", "", ...table(["Name", "Values"], SHARED_VALUES.map((value) => [value.name, value.values])));
  return lines;
}

function manifestSection(): string[] {
  return [
    "## Manifest keys",
    "",
    "These are all the keys of `trick.toml`. At the same contract, any other key is refused, so a typo shows.",
    "",
    ...table(
      ["Key", "Type", "Needed", "Limit", "Contract", "What it is"],
      MANIFEST.map((entry) => [word(entry.key), entry.type, entry.required, entry.limit, String(entry.contract), entry.what]),
    ),
    ...exampleLines([MANIFEST_EXAMPLE]),
  ];
}

function limitsSection(): string[] {
  const lines: string[] = ["## Limits", "", "The limits that no place, part or key owns. Every number is read from the code that checks it."];
  for (const group of LIMITS) lines.push("", `### ${group.group}`, "", ...limitTable(group.limits));
  return lines;
}

function commandsSection(): string[] {
  const groups: readonly { readonly id: CommandGroup; readonly title: string; readonly intro: string }[] = [
    { id: "trick", title: "`collie trick`", intro: "Every verb of `collie trick`." },
    { id: "trick view", title: "`collie trick view`", intro: "The verbs an agent runs to draw an agent view, as `collie trick view <trick> <verb>`." },
    { id: "hill", title: "`collie hill`", intro: "The verbs an agent or a person runs to post and read Decisions." },
  ];
  const lines: string[] = ["## Commands", ""];
  for (const group of groups) {
    const entries: readonly CommandEntry[] = COMMANDS.filter((entry) => entry.group === group.id);
    lines.push(`### ${group.title}`, "", group.intro, "", ...table(["Verb", "Usage", "What it does"], entries.map((entry) => [word(entry.verb), word(`collie ${entry.usage}`), entry.what])));
    const flagRows = entries.flatMap((entry) => entry.flags.map((flag) => [word(entry.verb), word(flag.flag), flag.what]));
    if (flagRows.length > 0) lines.push("", ...table(["Verb", "Flag", "What it does"], flagRows));
    lines.push("");
  }
  lines.pop();
  return lines;
}

function laterSection(): string[] {
  return [
    "## Not in this Collie yet",
    "",
    "A trick that names one of these still runs. This Collie leaves the word out, says so in a note, and the rest draws.",
    "",
    ...table(
      ["Kind", "Word", "What it will be"],
      LATER.map((entry) => [entry.kind === "place" ? "place" : "manifest key", word(entry.word), entry.what]),
    ),
  ];
}

/** The whole page, as the generator writes it. */
export function renderReference(): string {
  const lines: string[] = [
    "# Tricks reference",
    "",
    `<!-- This page is generated by \`${REFERENCE_COMMAND}\` from web/src/lib/tricks/catalogue.ts. Do not edit it by hand. -->`,
    "",
    "This page lists every place, part, manifest key, limit and command of a ColliePWA trick, and it is complete. It is generated from the code, so it cannot drift. It is the one list: other pages link here and do not repeat its tables.",
    "",
    ...placesSection(),
    "",
    ...hillSection(),
    "",
    ...partsSection(),
    "",
    ...manifestSection(),
    "",
    ...programSection(),
    "",
    ...limitsSection(),
    "",
    ...commandsSection(),
    "",
    ...laterSection(),
  ];
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) process.exit(runReferenceCli(process.argv.slice(2), REFERENCE_PAGE, REFERENCE_COMMAND, renderReference()));
