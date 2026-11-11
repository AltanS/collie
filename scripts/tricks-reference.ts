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
  type CommandEntry,
  type CommandGroup,
  type Example,
  type Limit,
} from "../web/src/lib/tricks/catalogue.ts";

/** The page, relative to the repository root. */
export const REFERENCE_PAGE = "docs/tricks-reference.md";

/** The command that writes it, as the page names it. */
export const REFERENCE_COMMAND = "bun scripts/tricks-reference.ts --write";

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

function hillSection(): string[] {
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
    ...limitsSection(),
    "",
    ...commandsSection(),
    "",
    ...laterSection(),
  ];
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) process.exit(runReferenceCli(process.argv.slice(2), REFERENCE_PAGE, REFERENCE_COMMAND, renderReference()));
