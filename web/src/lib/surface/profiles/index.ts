// The registry of profile files. One import per file, written here and nowhere else, so the surface
// code never spells a harness name. `profile.test.ts` lists this folder by directory and fails when
// a file is missing from the table below, so a new profile cannot sit unregistered.
import type { JsonValue } from "../../json";
import claude from "./claude.json";
import codex from "./codex.json";
import agy from "./agy.json";
import cursor from "./cursor.json";
import grok from "./grok.json";
import hermes from "./hermes.json";
import kiro from "./kiro.json";
import muse from "./muse.json";
import omp from "./omp.json";
import opencode from "./opencode.json";
import pi from "./pi.json";

/** Raw profile JSON by file stem. Parsed and checked by `parseProfile` (../profile.ts). */
export const PROFILE_FILES = { agy, claude, codex, cursor, grok, hermes, kiro, muse, omp, opencode, pi } satisfies Readonly<Record<string, JsonValue>>;
