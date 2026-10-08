import { describe, expect, it } from "vitest";

import { looksMisdirected } from "./direct-misdirect";

// The phone trap of 2026-10-07: "Type into terminal" armed once, then every
// chat message streamed into the shell as `command not found`. The classifier
// below is what names that state on disarm so the composer can offer the way
// back. Fail-closed everywhere: an unknown shell or a key burst must answer
// false (status quo), never true.
describe("looksMisdirected", () => {
  it("fires on a chat sentence answered by bash", () => {
    expect(
      looksMisdirected(
        "bleibt wieder hängen so instabil war es nicht mal",
        "andiw@omaya:~$ bleibt wieder hängen so instabil war es nicht mal\nbleibt: command not found",
      ),
    ).toBe(true);
  });

  it("fires on zsh, fish and powershell rejections", () => {
    expect(looksMisdirected("please restart the service now", "zsh: command not found: please")).toBe(true);
    expect(looksMisdirected("please restart the service now", "Unknown command: please")).toBe(true);
    expect(
      looksMisdirected(
        "please restart the service now",
        "please: The term 'please' is not recognized as the name of a cmdlet",
      ),
    ).toBe(true);
  });

  it("fires on a German shell", () => {
    expect(
      looksMisdirected("mach mal das licht an bitte", "bash: mach: Befehl nicht gefunden"),
    ).toBe(true);
  });

  it("stays quiet on key bursts (picker, y/n, arrows)", () => {
    expect(looksMisdirected("y", "y\nok")).toBe(false);
    expect(looksMisdirected("mod", "mod\nsleep 10")).toBe(false);
    expect(looksMisdirected("", "anything")).toBe(false);
  });

  it("stays quiet when the terminal never rejected anything", () => {
    expect(looksMisdirected("a normal chat message here", "some transcript without errors")).toBe(false);
  });

  it("stays quiet when the typed text never appears on screen", () => {
    // The late check runs on mirror updates after the disarm: without the
    // session's own command name on screen, a rejection belongs to someone
    // else's typing, not this session's.
    expect(looksMisdirected("deploy the thing now please", "ls: command not found")).toBe(false);
  });

  it("stays quiet on an unknown shell dialect", () => {
    // Fail-closed catalogue: Klingon shells keep the status quo (no notice),
    // they never buy a false one.
    expect(looksMisdirected("a normal chat message here", "Qapla: ghobe' command")).toBe(false);
  });
});
