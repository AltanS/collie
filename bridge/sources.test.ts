import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootSources,
  envSource,
  ENV_SOURCE_NAME,
  parseSources,
  planPrograms,
  PROGRAMS_OFF_LOG,
  programsOff,
  readSources,
  SOURCES_FILE,
  SourcesError,
  sourcesPath,
  sourceTransportEnv,
  sourceWhere,
} from "./sources.ts";

// THE LOADER (M55 spec 01): `sources.json` per the README contract. A bad file is a startup error that
// names the entry and the field; a missing file is an empty list. Every token here is a placeholder.

const TOKEN = "placeholder-token-placeholder-token-0000";

/** The message a bad file throws, so each row can say which field it names. */
function refusal(text: string): string {
  try {
    parseSources(text);
  } catch (err) {
    expect(err).toBeInstanceOf(SourcesError);
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`accepted: ${text}`);
}

describe("parseSources", () => {
  test("a socket source and a url source read as written", () => {
    const sources = parseSources(
      JSON.stringify([
        { name: "desk", kind: "durable", socket: "/run/user/1000/desk/desk.sock" },
        { name: "cloud-1", kind: "durable", url: "https://desk.example.workers.dev", token: TOKEN },
      ]),
    );
    expect(sources).toEqual([
      { name: "desk", kind: "durable", socket: "/run/user/1000/desk/desk.sock" },
      { name: "cloud-1", kind: "durable", url: "https://desk.example.workers.dev", token: TOKEN },
    ]);
  });

  test("an empty array is no sources", () => {
    expect(parseSources("[]")).toEqual([]);
  });

  const json = JSON.stringify;
  const table: [string, string, string][] = [
    ["not JSON", "{", "not JSON"],
    ["an object, not an array", json({ name: "desk" }), "must be an array"],
    ["an entry that is not an object", json(["desk"]), "entry 0: must be an object"],
    ["a missing name", json([{ kind: "durable", socket: "/s" }]), '"name" must match'],
    ["an uppercase name", json([{ name: "Desk", kind: "durable", socket: "/s" }]), '"name" must match'],
    ["a name that is a path", json([{ name: "../desk", kind: "durable", socket: "/s" }]), '"name" must match'],
    ["a name past 32 characters", json([{ name: "a".repeat(33), kind: "durable", socket: "/s" }]), '"name" must match'],
    ["a name that starts with a dash", json([{ name: "-desk", kind: "durable", socket: "/s" }]), '"name" must match'],
    ["an unknown kind", json([{ name: "desk", kind: "terminal", socket: "/s" }]), 'entry "desk": "kind" must be "durable"'],
    ["no kind", json([{ name: "desk", socket: "/s" }]), '"kind" must be "durable"'],
    ["socket and url both", json([{ name: "desk", kind: "durable", socket: "/s", url: "https://x.example", token: TOKEN }]), 'set "socket" or "url", not both'],
    ["neither socket nor url", json([{ name: "desk", kind: "durable" }]), 'entry "desk": set "socket" or "url"'],
    ["a url without a token", json([{ name: "desk", kind: "durable", url: "https://x.example" }]), '"url" needs "token"'],
    ["a token beside a socket", json([{ name: "desk", kind: "durable", socket: "/s", token: TOKEN }]), '"token" is only sent to a "url"'],
    ["an empty socket", json([{ name: "desk", kind: "durable", socket: " " }]), '"socket" must be a non-empty string'],
    ["a socket that is not a string", json([{ name: "desk", kind: "durable", socket: 7 }]), '"socket" must be a non-empty string'],
    ["an unknown field", json([{ name: "desk", kind: "durable", socket: "/s", port: 1 }]), 'unknown field "port"'],
    ["a name used twice", json([{ name: "desk", kind: "durable", socket: "/a" }, { name: "desk", kind: "durable", socket: "/b" }]), "the name is used twice"],
  ];

  for (const [what, text, names] of table) {
    test(`refuses ${what}, naming it`, () => {
      expect(refusal(text)).toContain(names);
    });
  }

  test("the message names the file it read, and never a token", () => {
    const message = refusal(JSON.stringify([{ name: "desk", kind: "durable", socket: "/s", token: TOKEN }]));
    expect(message).toStartWith(SOURCES_FILE);
    expect(message).not.toContain(TOKEN);
  });
});

describe("readSources", () => {
  test("a missing file is an empty list; a present one is read; a bad one throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-sources-"));
    try {
      expect(readSources(dir)).toEqual([]);
      writeFileSync(sourcesPath(dir), JSON.stringify([{ name: "desk", kind: "durable", socket: "/s" }]), { mode: 0o600 });
      expect(readSources(dir)).toEqual([{ name: "desk", kind: "durable", socket: "/s" }]);
      writeFileSync(sourcesPath(dir), "[{]");
      expect(() => readSources(dir)).toThrow(SourcesError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file sits next to .env in the config dir", () => {
    expect(sourcesPath("/home/you/.config/collie")).toBe(join("/home/you/.config/collie", "sources.json"));
  });
});

describe("the old env form", () => {
  test("maps to one source named default with whatever the three variables hold", () => {
    expect(envSource({ COLLIE_DURABLE_SOCKET: "/run/d.sock" })).toEqual({ name: ENV_SOURCE_NAME, kind: "durable", socket: "/run/d.sock" });
    expect(envSource({ COLLIE_DURABLE_URL: "https://x.example", COLLIE_DURABLE_TOKEN: TOKEN })).toEqual({
      name: "default",
      kind: "durable",
      url: "https://x.example",
      token: TOKEN,
    });
    // Nothing set is still the `default` source: its adapter says the socket is not set, as before.
    expect(envSource({ COLLIE_DURABLE_SOCKET: "  " })).toEqual({ name: "default", kind: "durable" });
  });

  test("the adapter's settings come from the entry, in the variable names the transport rules read", () => {
    expect(sourceTransportEnv({ name: "desk", kind: "durable", url: "https://x.example", token: TOKEN })).toEqual({
      COLLIE_DURABLE_SOCKET: undefined,
      COLLIE_DURABLE_URL: "https://x.example",
      COLLIE_DURABLE_TOKEN: TOKEN,
    });
  });
});

describe("the kill switch", () => {
  test("only COLLIE_PROGRAMS=off turns programs off, in any case and with spaces", () => {
    expect(programsOff({ COLLIE_PROGRAMS: "off" })).toBe(true);
    expect(programsOff({ COLLIE_PROGRAMS: " OFF " })).toBe(true);
    for (const value of [undefined, "", "on", "0", "false", "offline"]) expect(programsOff({ COLLIE_PROGRAMS: value })).toBe(false);
    expect(programsOff({})).toBe(false);
  });

  test("the boot line names the variable and the file", () => {
    expect(PROGRAMS_OFF_LOG).toBe("[bridge] programs are off (COLLIE_PROGRAMS=off); sources.json ignored");
  });

  test("off, the file is not read at all: a listed program is none, and a wrong file does not stop the boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-sources-"));
    try {
      writeFileSync(sourcesPath(dir), JSON.stringify([{ name: "desk", kind: "durable", socket: "/s" }]), { mode: 0o600 });
      expect(bootSources(dir, {})).toEqual([{ name: "desk", kind: "durable", socket: "/s" }]);
      expect(bootSources(dir, { COLLIE_PROGRAMS: "off" })).toEqual([]);
      writeFileSync(sourcesPath(dir), "[{]");
      expect(() => bootSources(dir, {})).toThrow(SourcesError);
      expect(bootSources(dir, { COLLIE_PROGRAMS: "off" })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("planPrograms", () => {
  const desk = { name: "desk", kind: "durable", socket: "/run/desk.sock" } as const;

  test("beside a terminal mux, no source is primary and every source is a session", () => {
    expect(planPrograms({ durableOnly: false, env: {}, sources: [desk], primaryName: "default" })).toEqual({ primary: undefined, others: [desk] });
  });

  test("durable-only, the env form is the primary named default, and the file's entries sit beside it", () => {
    const plan = planPrograms({ durableOnly: true, env: { COLLIE_DURABLE_SOCKET: "/run/d.sock" }, sources: [desk], primaryName: "ignored" });
    expect(plan.primary).toEqual({ name: "default", kind: "durable", socket: "/run/d.sock" });
    expect(plan.others).toEqual([desk]);
  });

  test("a source may not take the terminal session's name, nor the durable-only primary's", () => {
    expect(() => planPrograms({ durableOnly: false, env: {}, sources: [{ ...desk, name: "default" }], primaryName: "default" })).toThrow(
      'entry "default": the name is the terminal session\'s own',
    );
    expect(() => planPrograms({ durableOnly: false, env: {}, sources: [{ ...desk, name: "work" }], primaryName: "work" })).toThrow(SourcesError);
    expect(() => planPrograms({ durableOnly: true, env: {}, sources: [{ ...desk, name: "default" }], primaryName: "x" })).toThrow("durable-only");
  });
});

describe("sourceWhere", () => {
  test("a socket and a loopback url are local; any other url is remote", () => {
    expect(sourceWhere({ name: "a", kind: "durable", socket: "/s" })).toBe("local");
    expect(sourceWhere({ name: "a", kind: "durable", url: "http://127.0.0.1:8787", token: TOKEN })).toBe("local");
    expect(sourceWhere({ name: "a", kind: "durable", url: "https://desk.example.workers.dev", token: TOKEN })).toBe("remote");
  });
});
