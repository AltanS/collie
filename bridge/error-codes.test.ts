import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { apiError, ERROR_CODES, ERROR_CODE_LIST, type ErrorCode } from "./error-codes.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE DRIFT GUARD.
//
// The error-code catalogue exists in two files that CANNOT import each other: `bridge/error-codes.ts`
// and `web/src/lib/api-error-codes.ts`. The two trees are type-checked separately (web/tsconfig.json
// includes only `src`), which is the same reason `bridge/json.ts` and `web/src/lib/json.ts` restate
// one type twice. Restating buys the separation and costs a promise: keep them identical.
//
// This file is the only thing that enforces that promise. It reads BOTH files as TEXT — no import
// from `web/` — and compares the code sets. A code added on one side and forgotten on the other
// fails here, at `bun run test`, rather than on a phone that shows an untranslated English sentence.
//
// Reading source off disk in a bridge test is established practice (`bridge/root.test.ts`,
// `bridge/prompt-binding.test.ts` both do it); nothing here touches the runtime's filesystem rules.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, "..");
const BRIDGE_CATALOGUE = join(REPO, "bridge", "error-codes.ts");
const WEB_MIRROR = join(REPO, "web", "src", "lib", "api-error-codes.ts");

/** The text between a named declaration's opening bracket and its `} as const` / `] as const`. */
function blockAfter(source: string, opener: string, closer: string): string {
  const start = source.indexOf(opener);
  expect(start, `no \`${opener}\` in the source`).toBeGreaterThan(-1);
  const end = source.indexOf(closer, start);
  expect(end, `no \`${closer}\` after \`${opener}\``).toBeGreaterThan(start);
  return source.slice(start + opener.length, end);
}

/**
 * The codes the BRIDGE file declares, read as text rather than imported.
 *
 * Keys are quoted or bare (`prompt_changed` needs no quotes), so both forms are matched — and only
 * at the start of a line, so a code mentioned inside a comment or a template is not counted.
 */
function bridgeCodesFromSource(): string[] {
  const block = blockAfter(readFileSync(BRIDGE_CATALOGUE, "utf8"), "export const ERROR_CODES = {", "} as const;");
  const codes: string[] = [];
  for (const line of block.split("\n")) {
    const match = /^\s{2}(?:"([^"]+)"|([A-Za-z_$][\w$]*)):/.exec(line);
    if (match) codes.push(match[1] ?? match[2]!);
  }
  return codes;
}

/** The codes the WEB mirror lists. Same idea, one entry per line, comments skipped. */
function webCodesFromSource(): string[] {
  const block = blockAfter(readFileSync(WEB_MIRROR, "utf8"), "export const API_ERROR_CODES = [", "] as const;");
  const codes: string[] = [];
  for (const line of block.split("\n")) {
    const match = /^\s{2}"([^"]+)",$/.exec(line);
    if (match) codes.push(match[1]!);
  }
  return codes;
}

describe("error codes — bridge and web mirror", () => {
  // Reading the bridge's own table BOTH ways is what stops this whole file from passing vacuously:
  // a regex that quietly stopped matching would otherwise compare two empty sets and say nothing.
  test("the text read of the bridge catalogue agrees with what the module exports", () => {
    expect(bridgeCodesFromSource()).toEqual([...ERROR_CODE_LIST]);
    expect(ERROR_CODE_LIST.length).toBeGreaterThan(0);
  });

  test("the web mirror lists exactly the codes the bridge can send", () => {
    const bridgeCodes = new Set(bridgeCodesFromSource());
    const webCodes = new Set(webCodesFromSource());
    const missingFromWeb = [...bridgeCodes].filter((c) => !webCodes.has(c));
    const missingFromBridge = [...webCodes].filter((c) => !bridgeCodes.has(c));
    expect({ missingFromWeb, missingFromBridge }).toEqual({ missingFromWeb: [], missingFromBridge: [] });
  });

  test("the web mirror lists each code once", () => {
    const codes = webCodesFromSource();
    expect(codes.length).toBe(new Set(codes).size);
  });

  test("codes are lower-snake, dot-grouped by surface (one grandfathered exception)", () => {
    // `prompt_changed` predates the catalogue and is matched literally by the web app's dialog guard,
    // so it keeps its un-namespaced name. Every OTHER code is `surface.thing`.
    const ungrouped = ERROR_CODE_LIST.filter((code) => !/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/.test(code));
    expect(ungrouped).toEqual(["prompt_changed"]);
  });
});

describe("apiError — the sentence comes from the catalogue", () => {
  test("a code with no slots renders its sentence and carries no detail key", () => {
    const body = apiError("upload.no_file");
    expect(body).toEqual({ error: "no file", code: "upload.no_file" });
    expect("detail" in body).toBe(false);
  });

  test("a slot is filled from detail, and the detail rides along for a translated sentence", () => {
    expect(apiError("upload.bad_type", { type: "image/tiff" })).toEqual({
      error: "unsupported type: image/tiff",
      code: "upload.bad_type",
      detail: { type: "image/tiff" },
    });
  });

  test("a passthrough template is exactly the multiplexer's own words", () => {
    expect(apiError("pane.close_failed", { reason: "no such pane" }).error).toBe("no such pane");
  });

  test("interpolation is ONE pass — a slot's value is never re-scanned for slots", () => {
    // A multiplexer's refusal is not Collie's text. If it happens to contain `{maxBytes}`, that must
    // stay literal rather than reach into this table's other values.
    const body = apiError("keys.send_failed", { reason: "pane {maxBytes} refused" });
    expect(body.error).toBe("pane {maxBytes} refused");
  });

  test("every pairing code's sentence IS the bare reason word pairing has always sent", () => {
    // web/src/lib/api.ts matches these strings against PAIR_FAILURES. Changing one silently turns a
    // named pairing failure into an unrecognised one.
    expect(apiError("pairing.no_pending").error).toBe("no-pending");
    expect(apiError("pairing.expired").error).toBe("expired");
    expect(apiError("pairing.exhausted").error).toBe("exhausted");
    expect(apiError("pairing.bad_code").error).toBe("bad-code");
    expect(apiError("pairing.duplicate_label").error).toBe("duplicate-label");
    expect(apiError("pairing.bad_request").error).toBe("bad-request");
  });
});

// ── Call sites: a slotted code must be given something to fill its slots with ─────────
//
// `renderTemplate` leaves an unfillable slot empty rather than throwing, because a wording bug must
// not become a 500 on a live phone. This is what makes that safe: the mistake is caught here, in the
// source, instead of shipping as a sentence with a hole in it.

/** Every non-test `.ts` under `bridge/`, recursively. */
function bridgeSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...bridgeSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

const SLOTTED: ReadonlySet<string> = new Set(
  ERROR_CODE_LIST.filter((code) => /\{\w+\}/.test(ERROR_CODES[code])),
);

describe("apiError call sites", () => {
  test("a code whose sentence has slots is never called without a detail object", () => {
    const offenders: string[] = [];
    for (const file of bridgeSources(join(REPO, "bridge"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/apiError\(\s*"([^"]+)"\s*(,|\))/g)) {
        const code = match[1]!;
        if (SLOTTED.has(code) && match[2] === ")") offenders.push(`${file}: apiError("${code}")`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every catalogued code is actually reachable from bridge code", () => {
    const source = bridgeSources(join(REPO, "bridge"))
      .filter((file) => !file.endsWith("error-codes.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const unused = ERROR_CODE_LIST.filter((code: ErrorCode) => !source.includes(`"${code}"`));
    expect(unused).toEqual([]);
  });
});
