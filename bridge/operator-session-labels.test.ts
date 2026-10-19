import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_SESSION_LABEL,
  cleanSessionLabel,
  createSessionLabels,
  validateSessionLabels,
  withSessionLabels,
} from "./operator-session-labels.ts";
import type { OperatorFileIo } from "./operator-file.ts";
import type { SessionEntry } from "./types.ts";

// `sessions.toml`: the operator's display labels for their sessions. Driven like the other operator
// files — the validator with parsed TOML, the reader through a fake io.

const quiet = () => {};

/** Parse a TOML source the way the reader does, then validate it. */
function rows(toml: string, warn: (m: string) => void = quiet) {
  return validateSessionLabels(Bun.TOML.parse(toml), warn);
}

describe("validateSessionLabels", () => {
  test("reads quoted and bare session names", () => {
    expect(
      rows(`
        [labels]
        "project-yt" = "УТ ОП"
        default = "Клиентский кабинет"
      `),
    ).toEqual([
      { name: "project-yt", label: "УТ ОП" },
      { name: "default", label: "Клиентский кабинет" },
    ]);
  });

  test("no file, no table and an empty table are all simply empty", () => {
    expect(validateSessionLabels(undefined, quiet)).toEqual([]);
    expect(rows(``)).toEqual([]);
    expect(rows(`[labels]`)).toEqual([]);
  });

  test("a malformed row is dropped with a warning, the rest of the file is kept", () => {
    const warnings: string[] = [];
    expect(
      rows(
        `
        [labels]
        good = "Good"
        number = 7
        blank = "   "
        table = { a = "b" }
        "" = "nameless"
        also-good = "Also good"
      `,
        (m) => warnings.push(m),
      ),
    ).toEqual([
      { name: "good", label: "Good" },
      { name: "also-good", label: "Also good" },
    ]);
    expect(warnings).toHaveLength(4);
  });

  test("a `labels` that is not a table drops the rows and says so", () => {
    const warnings: string[] = [];
    expect(rows(`labels = ["a", "b"]`, (m) => warnings.push(m))).toEqual([]);
    expect(rows(`labels = "a"`, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  test("a label of invisible format characters alone is blank, so it is dropped", () => {
    const warnings: string[] = [];
    expect(rows(`[labels]\nghost = "\\u200B\\u200F"`, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("a long label is cut and warned about", () => {
    const warnings: string[] = [];
    const long = "Я".repeat(MAX_SESSION_LABEL + 10);
    const [row] = rows(`[labels]\nlong = "${long}"`, (m) => warnings.push(m));
    expect(row?.label).toBe("Я".repeat(MAX_SESSION_LABEL));
    expect(warnings).toHaveLength(1);
  });
});

describe("cleanSessionLabel", () => {
  test("controls and bidi overrides become spaces, runs of space collapse, ends trim", () => {
    expect(cleanSessionLabel("  УТ\nОП\t\u0007x  ")).toBe("УТ ОП x");
    expect(cleanSessionLabel("a\u202Eb\u2066c")).toBe("a b c");
    expect(cleanSessionLabel("a\u200Fb\u200Ec\u061Cd")).toBe("a b c d");
    expect(cleanSessionLabel("\u200B\u2060\uFEFF\u00AD\u2028")).toBe("");
    expect(cleanSessionLabel("\u0000\u001b\u009b")).toBe("");
  });

  test("the cap counts code points, so an astral character is never split", () => {
    const label = cleanSessionLabel("🐕".repeat(MAX_SESSION_LABEL + 1));
    expect(Array.from(label)).toHaveLength(MAX_SESSION_LABEL);
    expect(label).toBe("🐕".repeat(MAX_SESSION_LABEL));
  });
});

describe("withSessionLabels", () => {
  const entries: SessionEntry[] = [
    { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
    { name: "project-yt", isPrimary: false, reachable: true, agents: 2, working: 1, blocked: 0 },
  ];

  test("adds a label to a labelled session and leaves the name, the identity, alone", () => {
    const labels = new Map([["project-yt", "УТ ОП"], ["no-such-session", "ignored"]]);
    const out = withSessionLabels(entries, (n) => labels.get(n));
    expect(out[1]).toEqual({ ...entries[1]!, label: "УТ ОП" });
    expect(out.map((e) => e.name)).toEqual(["default", "project-yt"]);
  });

  test("an unlabelled entry is the same object, so its bytes do not change", () => {
    const out = withSessionLabels(entries, () => undefined);
    expect(out[0]).toBe(entries[0]!);
    expect(out[1]).toBe(entries[1]!);
    expect("label" in out[0]!).toBe(false);
  });
});

describe("createSessionLabels", () => {
  /** A fake disk whose mtime and text the test drives. */
  function fakeIo(state: { mtime: number | null; text: string; reads: number }): OperatorFileIo {
    return {
      mtime: async () => state.mtime,
      read: async () => {
        state.reads += 1;
        return state.text;
      },
    };
  }

  test("no path (a hand-built Config) reads nothing and labels nothing", async () => {
    const state = { mtime: 1, text: `[labels]\nwork = "A"`, reads: 0 };
    const labels = createSessionLabels(null, fakeIo(state), quiet);
    await labels.refresh();
    expect(labels.labelOf("work")).toBeUndefined();
    expect(state.reads).toBe(0);
  });

  test("nothing is labelled before the first refresh, and a missing file labels nothing", async () => {
    const state = { mtime: null, text: "", reads: 0 };
    const labels = createSessionLabels("/cfg/sessions.toml", fakeIo(state), quiet);
    expect(labels.labelOf("default")).toBeUndefined();
    await labels.refresh();
    expect(labels.labelOf("default")).toBeUndefined();
    expect(state.reads).toBe(0);
  });

  test("an edit is live on the next refresh, and an unchanged mtime is not re-read", async () => {
    const state = { mtime: 1, text: `[labels]\nwork = "A"`, reads: 0 };
    const labels = createSessionLabels("/cfg/sessions.toml", fakeIo(state), quiet);
    await labels.refresh();
    await labels.refresh();
    expect(labels.labelOf("work")).toBe("A");
    expect(state.reads).toBe(1);

    state.text = `[labels]\nwork = "B"`;
    state.mtime = 2;
    await labels.refresh();
    expect(labels.labelOf("work")).toBe("B");
  });

  test("a file that stops parsing keeps the last good labels", async () => {
    const state = { mtime: 1, text: `[labels]\nwork = "A"`, reads: 0 };
    const labels = createSessionLabels("/cfg/sessions.toml", fakeIo(state), quiet);
    await labels.refresh();
    state.text = "[labels] this is not toml";
    state.mtime = 2;
    await labels.refresh();
    expect(labels.labelOf("work")).toBe("A");
  });
});

// The wiring, pinned at the source the way server.test.ts pins the snapshot route: sessions.toml rides
// the ONE snapshot builder, so the browser poll and the crew sweep both carry the labels and both keep
// the reader fresh. Display-only: the summaries are labelled, never renamed.
describe("server.ts wiring", () => {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  test("the snapshot's sessions carry the operator's labels, refreshed by the snapshot itself", () => {
    const builder = src.slice(src.indexOf("const localSnapshot = ("), src.indexOf("const watchedPaneIds = ()"));
    expect(builder).toContain("void sessionLabels.refresh();");
    expect(builder).toContain("sessions: withSessionLabels(registry.list(), sessionLabels.labelOf),");
    expect(src).toContain("createSessionLabels(cfg.sessionsFile ?? null)");
  });
});
