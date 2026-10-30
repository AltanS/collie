import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { documentCarriesOurHooks, hooksInstalledProbe, HOOKS_PROBE_TTL_MS } from "./beacon-io.ts";
import { HOOK_MARKER } from "../cli/hooks.ts";
import { parseHookTarget } from "./beacon/hook-targets.ts";

// The one question the bridge asks about the agent's settings: are OUR hooks in it? The filesystem
// half of this module needs a real disk and is exercised by the CLI's own suite; what is pinned here
// is the answer's shape and the cache in front of it.

const HOME = "/home/dev";

/** A settings document with one marked entry, as `collie hooks install claude` writes it. */
function installed(): string {
  return JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `/home/dev/.local/bin/collie beacon emit ${HOOK_MARKER}` }] }],
    },
  });
}

describe("documentCarriesOurHooks", () => {
  test("an installed settings file says yes", () => {
    expect(documentCarriesOurHooks(installed())).toBe(true);
  });

  test("the operator's own hooks are not ours", () => {
    const theirs = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } });
    expect(documentCarriesOurHooks(theirs)).toBe(false);
  });

  test("a settings file with no hooks at all says no", () => {
    expect(documentCarriesOurHooks(JSON.stringify({ model: "opus" }))).toBe(false);
  });

  test("garbage says no rather than throwing — a file we cannot read holds nothing of ours", () => {
    for (const text of ["", "{", "[]", "null", '{"hooks":"yes"}', '{"hooks":{"Stop":"nope"}}']) {
      expect(documentCarriesOurHooks(text)).toBe(false);
    }
  });
});

describe("hooksInstalledProbe", () => {
  test("one profile carrying the marker is enough", () => {
    // The target path is built with `join`, so it carries this platform's separator.
    const workSettings = join("/home/dev/.claude-work", "settings.json");
    const probe = hooksInstalledProbe({
      home: HOME,
      env: { COLLIE_TRANSCRIPT_ROOT: "/home/dev/.claude-work/projects" },
      readFile: (path) => (path === workSettings ? installed() : null),
    });
    expect(probe()).toBe(true);
  });

  test("no settings file anywhere is a no, not a throw", () => {
    expect(hooksInstalledProbe({ home: HOME, env: {}, readFile: () => null })()).toBe(false);
  });

  test("the answer is cached, then re-read — installing the hooks needs no restart", () => {
    let text: string | null = null;
    let clock = 1000;
    const probe = hooksInstalledProbe({ home: HOME, env: {}, now: () => clock, readFile: () => text });
    expect(probe()).toBe(false);
    text = installed();
    // Inside the window the cached answer stands — the declaration must not cost a disk read per call.
    clock += HOOKS_PROBE_TTL_MS - 1;
    expect(probe()).toBe(false);
    clock += 2;
    expect(probe()).toBe(true);
  });
});

describe("parseHookTarget, the optional identity fields (M76 spec 02)", () => {
  const base = { schemaVersion: 1, stateDir: "/srv/a", pid: 4242, pidStartTime: 7, bootedAt: 1 };

  test("a record without mux, instance and port still parses, and reads them as unknown", () => {
    expect(parseHookTarget(JSON.stringify(base))).toEqual({ ...base, mux: null, instance: null, port: null });
  });

  test("a record with all three carries them", () => {
    expect(parseHookTarget(JSON.stringify({ ...base, mux: "herdr", instance: "next", port: 8788 }))).toMatchObject({ mux: "herdr", instance: "next", port: 8788 });
  });

  test("a field of the wrong type or range is dropped, never a reason to refuse the record", () => {
    const wrong = { ...base, mux: 7, instance: "", port: 70000 };
    expect(parseHookTarget(JSON.stringify(wrong))).toEqual({ ...base, mux: null, instance: null, port: null });
    expect(parseHookTarget(JSON.stringify({ ...base, mux: "x".repeat(200), port: 1.5 }))).toMatchObject({ mux: null, port: null });
    expect(parseHookTarget(JSON.stringify({ ...base, mux: ["herdr"], instance: {}, port: "8788" }))).toMatchObject({ mux: null, instance: null, port: null });
  });

  test("the required fields still decide: a record with no state dir is not a record", () => {
    expect(parseHookTarget(JSON.stringify({ ...base, stateDir: "", mux: "herdr" }))).toBeNull();
  });
});
