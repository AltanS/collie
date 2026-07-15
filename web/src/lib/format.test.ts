import { initials, shortCwd, timeAgo } from "./format";

describe("shortCwd", () => {
  it("collapses /home/<user> to ~", () => {
    expect(shortCwd("/home/you/projects/collie")).toBe("~/projects/collie");
  });

  it("collapses /Users/<user> (macOS) to ~", () => {
    expect(shortCwd("/Users/you/code/app")).toBe("~/code/app");
  });

  it("collapses /var/home/<user> (Fedora Atomic) to ~", () => {
    expect(shortCwd("/var/home/you/webapp")).toBe("~/webapp");
  });

  it("collapses the home dir itself to ~", () => {
    expect(shortCwd("/var/home/you")).toBe("~");
  });

  it("leaves paths outside home untouched", () => {
    expect(shortCwd("/etc/nginx/nginx.conf")).toBe("/etc/nginx/nginx.conf");
  });

  it("does not truncate short paths", () => {
    const out = shortCwd("/home/you/x");
    expect(out).toBe("~/x");
    expect(out).not.toContain("…");
  });

  it("truncates a long tail with a leading ellipsis, respecting max", () => {
    const out = shortCwd("/var/home/you/" + "x".repeat(40)); // default max = 32
    expect(out.startsWith("…")).toBe(true);
    expect(out).toHaveLength(32);
    expect(out.endsWith("x")).toBe(true);
    // The home "~" got truncated away — we keep the most-specific tail.
    expect(out).not.toContain("~");
  });

  it("honours a custom max", () => {
    const out = shortCwd("/home/you/a/very/long/nested/path", 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.startsWith("…")).toBe(true);
  });
});

describe("initials", () => {
  it("takes the first two letters, uppercased", () => {
    expect(initials("claude")).toBe("CL");
    expect(initials("codex")).toBe("CO");
  });

  it("ignores non-alphanumerics", () => {
    expect(initials("a-b-c")).toBe("AB");
    expect(initials("@gpt!")).toBe("GP");
  });

  it("falls back to AI when there is nothing usable", () => {
    expect(initials("")).toBe("AI");
    expect(initials("!!!")).toBe("AI");
  });

  it("handles a single-character name", () => {
    expect(initials("x")).toBe("X");
  });
});

describe("timeAgo", () => {
  const now = 1_700_000_000_000;

  it("reads 'just now' under a minute (and for now / future)", () => {
    expect(timeAgo(now, now)).toBe("just now");
    expect(timeAgo(now - 30_000, now)).toBe("just now");
    expect(timeAgo(now + 5_000, now)).toBe("just now"); // future clamps to 0
  });

  it("counts whole minutes, hours, then days", () => {
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe("3d ago");
  });

  it("floors at the unit boundaries", () => {
    expect(timeAgo(now - 119_000, now)).toBe("1m ago"); // 1m59s → 1m
    expect(timeAgo(now - 90 * 60_000, now)).toBe("1h ago"); // 90m → 1h
  });
});
