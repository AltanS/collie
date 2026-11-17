// THE SEAM (M105 spec 03, decision 1). The bus (bridge/events/) imports nothing from the API
// (bridge/api/) or the tricks code (bridge/tricks/), and the API and the tricks code do not import each
// other: both are thin listeners of the bus. This test reads the import statements of every non-test
// `.ts` file under the three folders, resolves each relative specifier to a path, and refuses a path
// inside a folder the importer may not reach. Every folder must exist and hold sources, so the scan is never vacuous.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const BRIDGE = resolve(import.meta.dir, "..");

type Area = "events" | "api" | "tricks";

/** Who may not import whom. */
const FORBIDDEN = {
  events: ["api", "tricks"],
  api: ["tricks"],
  tricks: ["api"],
} as const satisfies Record<Area, readonly Area[]>;

const AREAS: readonly Area[] = ["events", "api", "tricks"];

// `import ... from "x"`, `import type ... from "x"`, `export ... from "x"`, `import "x"`, `import("x")`.
const SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
];

/** Every module specifier a source text names. */
function specifiersOf(text: string): string[] {
  const out = new Set<string>();
  for (const pattern of SPECIFIERS) for (const match of text.matchAll(pattern)) out.add(match[1]!);
  return [...out];
}

/** The area a resolved path sits in, or null. */
function areaOf(path: string): Area | null {
  const rel = relative(BRIDGE, path);
  if (rel.startsWith("..")) return null;
  const top = rel.split(sep)[0];
  return AREAS.find((area) => area === top) ?? null;
}

/** The forbidden imports of one file, as `<specifier> -> <area>`. */
function violationsOf(file: string, text: string): string[] {
  const from = areaOf(file);
  if (from === null) return [];
  return specifiersOf(text).flatMap((specifier) => {
    if (!specifier.startsWith(".")) return [];
    const target = areaOf(resolve(dirname(file), specifier));
    const banned: readonly Area[] = FORBIDDEN[from];
    return target !== null && banned.includes(target) ? [`${specifier} -> ${target}`] : [];
  });
}

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

describe("the seam", () => {
  test("events imports nothing from api or tricks; api and tricks do not import each other", () => {
    const found = AREAS.flatMap((area) => sourcesUnder(join(BRIDGE, area))).flatMap((file) =>
      violationsOf(file, readFileSync(file, "utf8")).map((v) => `${relative(BRIDGE, file)}: ${v}`),
    );
    expect(found).toEqual([]);
  });

  test("no folder is skipped: the bus, the API and the tricks code each have sources to scan", () => {
    for (const area of AREAS) expect(sourcesUnder(join(BRIDGE, area)).length).toBeGreaterThan(0);
    expect(specifiersOf(readFileSync(join(BRIDGE, "api", "operations.ts"), "utf8"))).toContain("../events/bus.ts");
  });

  test("the scan reads real files: the bus's own imports are seen", () => {
    expect(specifiersOf(readFileSync(join(BRIDGE, "events", "sources.ts"), "utf8"))).toContain("./session-id.ts");
  });

  test("a planted import of each forbidden kind is caught, resolved by path and not by word", () => {
    const events = join(BRIDGE, "events", "x.ts");
    const api = join(BRIDGE, "api", "x.ts");
    const tricks = join(BRIDGE, "tricks", "x.ts");
    expect(violationsOf(events, `import { a } from "../tricks/run.ts";`)).toEqual(["../tricks/run.ts -> tricks"]);
    expect(violationsOf(events, `import type { A } from "../api/ids.ts";`)).toEqual(["../api/ids.ts -> api"]);
    expect(violationsOf(events, `export { b } from "../api";`)).toEqual(["../api -> api"]);
    expect(violationsOf(events, `const m = await import("../tricks/run.ts");`)).toEqual(["../tricks/run.ts -> tricks"]);
    expect(violationsOf(api, `import "../tricks/hill.ts";`)).toEqual(["../tricks/hill.ts -> tricks"]);
    expect(violationsOf(tricks, `import {\n  x,\n} from "../api/operations.ts";`)).toEqual(["../api/operations.ts -> api"]);
    // Allowed: the listeners import the bus; a name that merely contains the word is not the folder.
    expect(violationsOf(api, `import { EventBus } from "../events/bus.ts";`)).toEqual([]);
    expect(violationsOf(tricks, `import { EventBus } from "../events/bus.ts";`)).toEqual([]);
    expect(violationsOf(events, `import { a } from "./tricks-words.ts"; import { b } from "../api-shape.ts";`)).toEqual([]);
    expect(violationsOf(events, `import { a } from "../walky/api/x.ts";`)).toEqual([]);
  });
});
