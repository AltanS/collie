// The registry of profile files. One import per file, written here and nowhere else, so the surface
// code never spells a harness name. `profile.test.ts` lists this folder by directory and fails when
// a file is missing from the table below, so a new profile cannot sit unregistered.
import type { JsonValue } from "../../json";
import claude from "./claude.json";
import codex from "./codex.json";

/** Raw profile JSON by file stem. Parsed and checked by `parseProfile` (../profile.ts). */
export const PROFILE_FILES = { claude, codex } satisfies Readonly<Record<string, JsonValue>>;
