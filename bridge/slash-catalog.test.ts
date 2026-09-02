import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createSlashCatalogReader, readSlashCatalogs } from "./slash-catalog.ts";

interface Dump {
  schemaVersion: number;
  harness: string;
  hint: boolean;
  herdrPaneId: string;
  paneKey: string;
  commands: { name: string; description: string }[];
}

function dump(over: Partial<Dump> = {}): Dump {
  return {
    schemaVersion: 1,
    harness: "omp",
    hint: true,
    herdrPaneId: "w5:p2",
    paneKey: "herdr-w5:p2",
    commands: [
      { name: "green", description: "Iterate on CI until green" },
      { name: "collie-catalog", description: "debug" },
      { name: "review", description: "Launch interactive code review" },
    ],
    ...over,
  };
}

describe("readSlashCatalogs", () => {
  test("maps a herdr dump to its pane id and drops the debug command", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-slash-"));
    writeFileSync(join(dir, "herdr-w5:p2.json"), JSON.stringify(dump()));
    writeFileSync(join(dir, "latest.json"), JSON.stringify(dump()));
    const rows = readSlashCatalogs(dir);
    expect([...rows.keys()]).toEqual(["w5:p2"]);
    expect(rows.get("w5:p2")?.map((c) => c.command)).toEqual(["/green", "/review"]);
  });

  test("ignores a missing directory, a broken file, and a non-omp harness", () => {
    expect(readSlashCatalogs(join(tmpdir(), "no-such-collie-slash"))).toEqual(new Map());
    const dir = mkdtempSync(join(tmpdir(), "collie-slash-"));
    writeFileSync(join(dir, "herdr-w1:p1.json"), "{");
    writeFileSync(join(dir, "herdr-w1:p2.json"), JSON.stringify(dump({ harness: "claude", herdrPaneId: "w1:p2" })));
    expect(readSlashCatalogs(dir).size).toBe(0);
  });

  test("keys off herdrPaneId when the filename is latest-shaped but not latest.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-slash-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "herdr-w9:p1.json"),
      JSON.stringify(dump({ herdrPaneId: "w9:p1", paneKey: "herdr-w9:p1" })),
    );
    expect(readSlashCatalogs(dir).get("w9:p1")?.[0]?.command).toBe("/green");
  });
});

describe("createSlashCatalogReader", () => {
  test("re-reads after a new file appears", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-slash-"));
    const read = createSlashCatalogReader(dir);
    expect(read().size).toBe(0);
    writeFileSync(join(dir, "herdr-w5:p2.json"), JSON.stringify(dump()));
    expect(read().get("w5:p2")?.map((c) => c.command)).toEqual(["/green", "/review"]);
  });
});
