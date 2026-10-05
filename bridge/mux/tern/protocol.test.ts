import { describe, expect, test } from "bun:test";

import {
  parseEvent,
  parseListing,
  saysNoBlock,
  saysNoDaemon,
  saysNoSession,
} from "./protocol.ts";

describe("parseListing", () => {
  test("parses sessions, tabs, and blocks", () => {
    const raw = JSON.stringify({
      sessions: [
        {
          id: 1,
          name: "Default",
          shown: true,
          tabs: [
            {
              id: 11,
              number: 1,
              name: null,
              shown: true,
              blocks: [
                {
                  id: 101,
                  title: "π",
                  cwd: "/home/denis",
                  program: "/bin/zsh",
                  args: [],
                  focused: true,
                  live: true,
                  exited: null,
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseListing(raw);
    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0]?.name).toBe("Default");
    expect(parsed.sessions[0]?.tabs[0]?.blocks[0]?.id).toBe(101);
  });

  test("throws on invalid JSON or missing sessions", () => {
    expect(() => parseListing("{}")).toThrow();
    expect(() => parseListing("not-json")).toThrow();
  });
});

describe("parseEvent", () => {
  test("parses valid json event lines", () => {
    const ev = parseEvent('{"event":"pane_spawned","pane":101}');
    expect(ev).toEqual({ event: "pane_spawned", pane: 101 });
  });

  test("ignores invalid or non-event lines", () => {
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent('{"no_event_field":1}')).toBeNull();
  });
});

describe("error classifiers", () => {
  test("saysNoBlock detects missing block messages", () => {
    expect(saysNoBlock("tern send: no block is called \\`999\\`")).toBe(true);
    expect(saysNoBlock("no block found")).toBe(true);
    expect(saysNoBlock("ok")).toBe(false);
  });

  test("saysNoSession detects missing session messages", () => {
    expect(saysNoSession("there is no session called work")).toBe(true);
    expect(saysNoSession("session not found")).toBe(true);
    expect(saysNoSession("ok")).toBe(false);
  });

  test("saysNoDaemon detects disconnected daemon messages", () => {
    expect(saysNoDaemon("the session daemon did not answer")).toBe(true);
    expect(saysNoDaemon("connection refused")).toBe(true);
    expect(saysNoDaemon("no daemon running")).toBe(true);
    // The real answer of TERN_DAEMON_SOCKET pointing at a path with no daemon, as Tern spells it.
    expect(saysNoDaemon("tern: no Tern is running")).toBe(true);
    expect(saysNoDaemon("No Tern is running\n")).toBe(true);
    expect(saysNoDaemon("ok")).toBe(false);
  });
});
