import { createHash } from "node:crypto";

import { MORPH_SKILL_TEMPLATE } from "./docs-embed.ts";
import { morphClosedSetLines, morphCycleCommands, morphExampleLines, morphHelp, morphKindLines, MORPH_RULES, morphUsageLines } from "./morph.ts";

// The Morph skill: the rules an agent needs to draw a Morph screen, installed opt-in into a harness by
// `collie skill install --skill morph` (cli/skill-install.ts), so a session never has to read `morph help`.
//
// ONE SOURCE. The rules list, the kinds, the closed sets, the commands and the examples are the very
// lines `collie morph help` prints (cli/morph.ts), filled in at render time. The skill and the help
// cannot drift.
//
// THE RULES ID. A short hash of every rule text Morph gives an agent: this template with its sections
// filled, and the help, both with the binary, the collie version and the id itself left as placeholders.
// Any change to a rule, a kind, a value, a command or an example changes the id; a new path or a new
// release that changed none of them does not. The CLI prints it (skill, help) and the bridge compares
// the id a `morph start --rules <id>` carries with its own (bridge/morph/service.ts): a session that gave
// the current one holds the rules, and its next request comes without the `[rules: ...]` tail.

/** The placeholders the template and the hash leave as they are. */
const BIN = "{{COLLIE_BIN}}";
const VERSION = "{{COLLIE_VERSION}}";
const RULES_ID = "{{MORPH_RULES_ID}}";

/** The session placeholder the skill's commands carry: the agent copies the address from the request's head. */
const SESSION = null;

/** The template with every generated section filled; the binary, the version and the rules id stay placeholders. */
function filledTemplate(): string {
  const sections = {
    "{{MORPH_CYCLE}}": [
      ...morphCycleCommands({ bin: BIN, session: SESSION, rulesId: RULES_ID }).map((line, i) => `${String(i + 1)}. \`${line.replace(/ {3}\(.*\)$/u, "")}\``),
      "",
      "Then `pending`, `remove`, `choice` and `keep` as the rules say, and end your turn. A tap on the phone comes back as a new request.",
    ].join("\n"),
    "{{MORPH_RULES}}": MORPH_RULES.filter((line) => line.startsWith("- ")).join("\n"),
    "{{MORPH_KINDS}}": fenced(morphKindLines()),
    "{{MORPH_CLOSED_SETS}}": fenced(morphClosedSetLines()),
    "{{MORPH_EXAMPLES}}": fenced(morphExampleLines({ bin: BIN, session: SESSION })),
    "{{MORPH_USAGE}}": fenced(morphUsageLines(BIN).map((line) => line.replace(/^ {2}/u, ""))),
  } as const;
  let text = MORPH_SKILL_TEMPLATE;
  for (const [key, value] of Object.entries(sections)) text = text.replaceAll(key, () => value);
  return text;
}

/** Lines in a plain fence, so a harness reads them as they stand. */
function fenced(lines: readonly string[]): string {
  return ["```text", ...lines, "```"].join("\n");
}

/**
 * Every rule text Morph gives an agent, as the rules id hashes it: the skill's filled template and the
 * help, with the binary path, the collie version and the id left as placeholders.
 */
export function morphRulesSource(): string {
  return `${filledTemplate()}\n${morphHelp(null, RULES_ID).join("\n")}`;
}

/** The id of a rules text: the first 8 hex characters of its sha256. */
export function rulesIdOf(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 8);
}

let cachedId: string | null = null;

/**
 * The rules id: the first 8 hex characters of the sha256 of the skill's filled template and the help,
 * both with the binary path, the collie version and the id itself as placeholders. The one function the
 * CLI (skill render, `morph help`) and the bridge (`morph start --rules`) both use.
 */
export function morphRulesId(): string {
  cachedId ??= rulesIdOf(morphRulesSource());
  return cachedId;
}

/** The skill's text for one binary and one collie version, front matter and stamp included. */
export function renderMorphSkillText({ binary, version }: { binary: string; version: string }): string {
  return filledTemplate()
    .replaceAll(RULES_ID, () => morphRulesId())
    .replaceAll(BIN, () => binary)
    .replaceAll(VERSION, () => version)
    .replace(/\n+$/u, "\n");
}
