import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import {
  CONFIG_SECTIONS,
  CONFIG_SETTINGS,
  envNameFor,
  settingByEnv,
  settingByKey,
  SECTION_DOC,
} from "./config-schema.ts";

// ── THE COMPLETENESS GREP ────────────────────────────────────────────────────
//
// Every `COLLIE_*` name read anywhere under `bridge/` or `cli/` must have a row in
// `bridge/config-schema.ts` or a named exemption below, with one sentence saying why it is not a
// setting. The grep runs ONE WAY: the schema may hold a name this grep does not find (an alias, a
// setting whose only reader is a doc), but no name this grep finds may be missing from the schema.
//
// The failure message names the env and the file it was found in, so a merge that brings a new
// setting in from another branch is one row away from green.

const REPO_ROOT = join(import.meta.dir, "..");
const SCANNED_DIRS = ["bridge", "cli"];

/**
 * Names that are NOT settings, each with the reason it can never be one. An entry here is a
 * decision, not a backlog: a name an operator should be able to put in a file belongs in the schema.
 */
const EXEMPT = {
  // Decide WHICH config is read, so they cannot be set by it.
  COLLIE_INSTANCE: "picks the config dir, so a file inside that dir cannot name it",
  COLLIE_CONFIG: "names the base config file itself",
  COLLIE_CONFIG_DIR: "forwarded to the detached update runner; it names where config lives",
  // The launcher's statement about this process, not the operator's about this Collie.
  COLLIE_PLUGIN_ROOT: "the checkout this binary runs from, injected by the launcher",
  COLLIE_SUPERVISOR: "which service manager is in front of this process",
  // Template tokens and test switches, never read from an environment at all.
  COLLIE_VERSION: "a token `collie docs` substitutes into a page",
  COLLIE_DOCS_TABLE: "a token `collie docs` substitutes into a page",
  COLLIE_REGEN_SOLO_BASELINE: "a switch that regenerates a test fixture",
  COLLIE_STDIN__: "a marker in the remote script `cli/remote.ts` writes",
  COLLIE_PAYLOAD__: "a marker in the remote script `cli/remote.ts` writes",
  COLLIE_PACK_SECRET:
    "named only in the update runner's redaction list, so it is a name to scrub and not a value read",
} satisfies Record<string, string>;

/** Just the names, so a lookup by a grepped string does not need an index signature. */
const EXEMPT_NAMES: ReadonlySet<string> = new Set(Object.keys(EXEMPT));

interface Found {
  readonly env: string;
  readonly file: string;
}

function sourceFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  return readdirSync(abs, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
    .map((p) => join(abs, p));
}

/** Every `COLLIE_*` name in the scanned tree, with the first file it appeared in. */
function scan(): Found[] {
  const first = new Map<string, string>();
  for (const dir of SCANNED_DIRS) {
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/COLLIE_[A-Z0-9_]*/g)) {
        if (!first.has(m[0])) first.set(m[0], relative(REPO_ROOT, file));
      }
    }
  }
  const names = [...first.keys()];
  // A name ending in `_` that another found name extends is a template prefix, not a variable:
  // `COLLIE_MUX_ENDPOINT_` is built into `…_TMUX` at the call, and bare `COLLIE_` is a doc mention.
  const isPrefix = (name: string): boolean =>
    name.endsWith("_") && names.some((other) => other !== name && other.startsWith(name));
  return names
    .filter((name) => !isPrefix(name))
    .map((env) => ({ env, file: first.get(env)! }))
    .toSorted((a, b) => a.env.localeCompare(b.env));
}

describe("the schema names every setting", () => {
  test("every COLLIE_* name in bridge/ and cli/ has a row or a named exemption", () => {
    const missing = scan()
      .filter((f) => !EXEMPT_NAMES.has(f.env) && settingByEnv(f.env) === undefined)
      .map((f) => `${f.env} (read in ${f.file})`);
    expect(
      missing,
      missing.length === 0
        ? ""
        : `add a row to bridge/config-schema.ts for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("the exemption list is live — every entry is still a name the tree uses", () => {
    const found = new Set(scan().map((f) => f.env));
    // `COLLIE_CONFIG` and `COLLIE_REGEN_SOLO_BASELINE` are named here for the reader; the first is
    // read by `bridge/config-source.ts` and the second only by a test, so neither is required.
    const optional = new Set(["COLLIE_CONFIG", "COLLIE_REGEN_SOLO_BASELINE"]);
    const stale = Object.keys(EXEMPT).filter((env) => !found.has(env) && !optional.has(env));
    expect(stale).toEqual([]);
  });

  test("every COLLIE_* name .env.example documents has a row too", () => {
    // The cross-check the Non-goals name: `.env.example` stays, stays hand-written and keeps
    // precedence, but it may not document a setting the schema has never heard of.
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const documented = [...new Set([...example.matchAll(/COLLIE_[A-Z0-9_]+/g)].map((m) => m[0]))];
    const missing = documented.filter(
      (env) => !EXEMPT_NAMES.has(env) && settingByEnv(env) === undefined,
    );
    expect(missing).toEqual([]);
  });

  test("no exemption is also a schema row — a name is a setting or it is not", () => {
    const both = Object.keys(EXEMPT).filter((env) => settingByEnv(env) !== undefined);
    expect(both).toEqual([]);
  });
});

describe("the table's own shape", () => {
  test("a key is its env name with the COLLIE_ prefix dropped and lowercased", () => {
    const wrong = CONFIG_SETTINGS.filter(
      (s) => s.env.startsWith("COLLIE_") && s.key !== s.env.replace(/^COLLIE_/, "").toLowerCase(),
    ).map((s) => `${s.section}.${s.key} vs ${s.env}`);
    expect(wrong).toEqual([]);
  });

  test("HERDR_SOCKET_PATH is the one row that declares its own key", () => {
    const declared = CONFIG_SETTINGS.filter((s) => !s.env.startsWith("COLLIE_"));
    expect(declared.map((s) => s.env)).toEqual(["HERDR_SOCKET_PATH"]);
    expect(declared[0]!.key).toBe("socket_path");
  });

  test("section and key together are unique, and so is every env name", () => {
    const keys = CONFIG_SETTINGS.map((s) => `${s.section}.${s.key}`);
    expect(keys.length).toBe(new Set(keys).size);
    const envs = CONFIG_SETTINGS.flatMap((s) => (s.alias === undefined ? [s.env] : [s.env, s.alias]));
    expect(envs.length).toBe(new Set(envs).size);
  });

  test("every row sits in a declared section, and every section has rows and a doc line", () => {
    for (const s of CONFIG_SETTINGS) expect(CONFIG_SECTIONS).toContain(s.section);
    for (const section of CONFIG_SECTIONS) {
      expect(CONFIG_SETTINGS.some((s) => s.section === section)).toBe(true);
      expect(SECTION_DOC[section].length).toBeGreaterThan(0);
    }
  });

  test("an enum's default is one of its own values, or the absent-feature empty string", () => {
    // The compiler already holds the rest: `ConfigSetting` is discriminated by `kind`, so an `int`
    // row's default is a number and a `list` row's is an array by type, not by assertion.
    for (const s of CONFIG_SETTINGS) {
      if (s.kind !== "enum") continue;
      expect(s.values.length, `${s.env} is an enum with no values`).toBeGreaterThan(0);
      if (s.default !== "") expect(s.values).toContain(s.default);
    }
  });

  test("an int row's bounds are ordered and admit its own default", () => {
    for (const s of CONFIG_SETTINGS) {
      if (s.kind !== "int") continue;
      if (s.min !== undefined && s.max !== undefined) expect(s.min).toBeLessThanOrEqual(s.max);
      // `0` is the "absent" default for the two settings whose absence is the feature being off.
      if (s.default !== 0 && s.min !== undefined) expect(s.default).toBeGreaterThanOrEqual(s.min);
      if (s.max !== undefined) expect(s.default).toBeLessThanOrEqual(s.max);
    }
  });

  test("every doc is one plain sentence", () => {
    for (const s of CONFIG_SETTINGS) {
      expect(s.doc.length, `${s.env} has no doc`).toBeGreaterThan(10);
      expect(s.doc, `${s.env}'s doc uses an em dash`).not.toContain("—");
    }
  });

  test("a row's alias, if it declares one, is never a row of its own", () => {
    const aliases = CONFIG_SETTINGS.filter((s) => s.alias !== undefined);
    for (const s of aliases) expect(settingByEnv(s.alias!)).toBe(s);
  });

  test("no row names a key that decides which config is read", () => {
    for (const env of ["COLLIE_INSTANCE", "COLLIE_CONFIG", "COLLIE_CONFIG_DIR"]) {
      expect(settingByEnv(env)).toBeUndefined();
    }
    for (const env of ["HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_ROOT"]) {
      expect(CONFIG_SETTINGS.some((s) => s.env === env)).toBe(false);
    }
  });
});

describe("the lookups", () => {
  test("settingByKey finds every row by its own section and key", () => {
    for (const s of CONFIG_SETTINGS) expect(settingByKey(s.section, s.key)).toBe(s);
  });

  test("envNameFor applies the rule rather than guessing it", () => {
    expect(envNameFor("socket_path", "mux")).toBe("HERDR_SOCKET_PATH");
    expect(envNameFor("poll_ms", "bridge")).toBe("COLLIE_POLL_MS");
    // An unknown key still yields the name it would have meant, which is what the message needs.
    expect(envNameFor("poll_mss", "bridge")).toBe("COLLIE_POLL_MSS");
  });

  test("a key in the wrong section is not found", () => {
    // `poll_ms` is a real key, in `[bridge]`. Asked for under `[network]` it is unknown, which is
    // what makes a misplaced key a problem rather than a silent success.
    expect(settingByKey("network", "poll_ms")).toBeUndefined();
    expect(settingByKey("bridge", "poll_ms")).toBeDefined();
  });
});
