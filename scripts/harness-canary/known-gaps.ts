// known-gaps.json: the scenarios the canary is allowed to see fail without failing the run.
//
// Same discipline as the lab corpus's `knownRaw`: every entry says why and points at the issue or
// spec that owns the fix, and the fix deletes the entry. A pass on a listed scenario is printed as a
// stale entry, so a gap that closed does not stay listed.

import { readFileSync } from "node:fs";
import { asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json";
import { isScenarioId, type ScenarioId } from "./verdict";

export interface KnownGap {
  readonly agent: string;
  readonly scenario: ScenarioId;
  /** Why the scenario fails today, in one or two sentences. */
  readonly reason: string;
  /** The issue, spec or ADR that owns the fix, for example `#294` or `M37/03`. */
  readonly ref: string;
}

export const KNOWN_GAPS_FILE = new URL("./known-gaps.json", import.meta.url).pathname;

/** A reference the fix can be found under: an issue or PR number, a milestone spec, or an ADR. */
const REF = /^(#\d+|M\d+\/\d+|ADR \d{4})(\b.*)?$/;

/**
 * Parse and check the file's text. Throws with the entry's position on anything malformed, since a
 * gap that cannot be read must not silently stop covering its scenario, nor silently start to.
 */
export function parseKnownGaps(text: string): KnownGap[] {
  const doc = asJsonObject(parseJson(text));
  const list = doc?.gaps;
  if (!Array.isArray(list)) throw new Error("known-gaps.json: expected { \"gaps\": [...] }");
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const entry = asJsonObject(raw);
    const agent = asJsonString(entry?.agent)?.trim() ?? "";
    const scenario = asJsonString(entry?.scenario) ?? "";
    const reason = asJsonString(entry?.reason)?.trim() ?? "";
    const ref = asJsonString(entry?.ref)?.trim() ?? "";
    const where = `known-gaps.json gaps[${i}]`;
    if (agent === "") throw new Error(`${where}: agent is required`);
    if (!isScenarioId(scenario)) throw new Error(`${where}: unknown scenario "${scenario}"`);
    if (reason === "") throw new Error(`${where}: reason is required`);
    if (!REF.test(ref)) throw new Error(`${where}: ref must name an issue (#123), a spec (M37/03) or an ADR (ADR 0053)`);
    const key = `${agent}/${scenario}`;
    if (seen.has(key)) throw new Error(`${where}: ${key} is listed twice`);
    seen.add(key);
    return { agent, scenario, reason, ref };
  });
}

export function loadKnownGaps(path = KNOWN_GAPS_FILE): KnownGap[] {
  return parseKnownGaps(readFileSync(path, "utf8"));
}
