import { describe, expect, test } from "bun:test";

import { documentCarriesOurHooks, hooksInstalledProbe, HOOKS_PROBE_TTL_MS } from "./beacon-io.ts";
import { HOOK_MARKER } from "../cli/hooks.ts";

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
    const probe = hooksInstalledProbe({
      home: HOME,
      env: { COLLIE_TRANSCRIPT_ROOT: "/home/dev/.claude-work/projects" },
      readFile: (path) => (path === "/home/dev/.claude-work/settings.json" ? installed() : null),
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
