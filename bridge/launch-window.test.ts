import { describe, expect, test } from "bun:test";

import { FOREGROUND_READ_MS, LAUNCH_WINDOW_MS, LaunchWindow, PENDING_PROBE_MS, foregroundHarnessOf, harnessOfProcesses, type ForegroundHarness } from "./launch-window.ts";

/** The profiles' binaries as `bridge/index.ts` builds them: program name to harness id. */
const BINARIES: ReadonlyMap<string, string> = new Map([
  ["omp", "omp"],
  ["claude", "claude"],
  ["kiro-cli", "kiro"],
]);

/** What a fake foreground read answers now: a harness id, null for a plain shell, undefined for no read. */
interface Seen {
  now: string | null | undefined;
}

/** A foreground read that answers what `seen` holds now. */
function reader(seen: Seen): ForegroundHarness {
  return () => Promise.resolve(seen.now);
}

describe("the launch window: a launch's mark", () => {
  test("a marked pane names its harness until the window passes, then settles", async () => {
    let now = 1_000;
    const window = new LaunchWindow(() => now);
    expect(window.expecting("main", "%1")).toBeNull();
    window.mark("main", "%1", "omp");
    expect(window.expecting("main", "%1")).toBe("omp");
    now += LAUNCH_WINDOW_MS - 1;
    expect(await window.starting("main", "%1", null)).toBe("omp");
    now += 1;
    expect(window.expecting("main", "%1")).toBeNull();
    // A settled pane is not opened again by the same harness's process.
    expect(await window.starting("main", "%1", null, reader({ now: "omp" }))).toBeNull();
  });

  test("the session is part of the key: the same pane id on another session is not marked", () => {
    const window = new LaunchWindow();
    window.mark("main", "%1", "omp");
    expect(window.expecting("other", "%1")).toBeNull();
  });

  test("a shell in the foreground does not end a mark whose process was never seen: the typed line may not have run yet", async () => {
    const window = new LaunchWindow();
    window.mark("main", "%1", "omp");
    const seen: Seen = { now: null };
    expect(await window.starting("main", "%1", null, reader(seen))).toBe("omp");
    seen.now = "omp";
    expect(await window.starting("main", "%1", null, reader(seen))).toBe("omp");
    // The agent was up and is gone again: a shell now ends the window.
    seen.now = null;
    expect(await window.starting("main", "%1", null, reader(seen))).toBeNull();
  });

  test("a bounded number of windows: the oldest goes first", () => {
    const window = new LaunchWindow();
    for (let i = 0; i < 70; i++) window.mark("main", `%${String(i)}`, "omp");
    expect(window.expecting("main", "%0")).toBeNull();
    expect(window.expecting("main", "%69")).toBe("omp");
  });
});

describe("the launch window: the pane's foreground process", () => {
  test("a harness binary in the foreground of a pane nobody marked opens the window; a frame read ends it", async () => {
    const window = new LaunchWindow();
    const seen: Seen = { now: "omp" };
    expect(await window.starting("main", "%2", null, reader(seen))).toBe("omp");
    expect(await window.starting("main", "%2", null, reader(seen))).toBe("omp");
    window.framed("main", "%2", "omp");
    expect(await window.starting("main", "%2", null, reader(seen))).toBeNull();
  });

  test("a plain shell in the foreground opens nothing, and ends a window its process opened", async () => {
    const window = new LaunchWindow();
    const seen: Seen = { now: null };
    expect(await window.starting("main", "%2", null, reader(seen))).toBeNull();
    seen.now = "omp";
    expect(await window.starting("main", "%2", null, reader(seen))).toBe("omp");
    seen.now = null;
    expect(await window.starting("main", "%2", null, reader(seen))).toBeNull();
  });

  test("a harness that left the pane and starts again gets a new window", async () => {
    const window = new LaunchWindow();
    const seen: Seen = { now: "omp" };
    await window.starting("main", "%2", null, reader(seen));
    window.framed("main", "%2", "omp");
    expect(await window.starting("main", "%2", null, reader(seen))).toBeNull();
    seen.now = null;
    expect(await window.starting("main", "%2", null, reader(seen))).toBeNull();
    seen.now = "omp";
    expect(await window.starting("main", "%2", null, reader(seen))).toBe("omp");
  });

  test("no foreground read (an adapter without one, a failed or slow read) keeps whatever stands: a shell pane stays a shell", async () => {
    const window = new LaunchWindow();
    expect(await window.starting("main", "%3", null)).toBeNull();
    expect(await window.starting("main", "%3", null, reader({ now: undefined }))).toBeNull();
    window.mark("main", "%3", "omp");
    expect(await window.starting("main", "%3", null, reader({ now: undefined }))).toBe("omp");
  });

  test("another harness in the foreground replaces the window", async () => {
    const window = new LaunchWindow();
    window.mark("main", "%4", "omp");
    expect(await window.starting("main", "%4", null, reader({ now: "claude" }))).toBe("claude");
  });

  test("a process window ends at the bound, and the same process does not open it again", async () => {
    let now = 0;
    const window = new LaunchWindow(() => now);
    const seen: Seen = { now: "omp" };
    expect(await window.starting("main", "%5", null, reader(seen))).toBe("omp");
    now += LAUNCH_WINDOW_MS;
    expect(await window.starting("main", "%5", null, reader(seen))).toBeNull();
  });
});

describe("the launch window: the multiplexer names an agent", () => {
  test("the first poll is a baseline: an agent named then opens nothing", async () => {
    const window = new LaunchWindow();
    window.observe("main", [{ paneId: "%1", agent: "omp" }]);
    expect(await window.starting("main", "%1", "omp")).toBeNull();
  });

  test("a shell the multiplexer names an agent on later opens the window for that agent only", async () => {
    const window = new LaunchWindow();
    window.observe("main", [{ paneId: "%1", agent: null }]);
    window.observe("main", [{ paneId: "%1", agent: "omp" }]);
    expect(await window.starting("main", "%1", "omp")).toBe("omp");
    expect(await window.starting("main", "%1", "claude")).toBeNull();
    window.framed("main", "%1", "omp");
    expect(await window.starting("main", "%1", "omp")).toBeNull();
  });

  test("a new pane named an agent on its first poll opens the window", async () => {
    const window = new LaunchWindow();
    window.observe("main", []);
    window.observe("main", [{ paneId: "%7", agent: "claude" }]);
    expect(await window.starting("main", "%7", "claude")).toBe("claude");
  });

  test("a launch's mark keeps its own start when the multiplexer names its agent", async () => {
    let now = 0;
    const window = new LaunchWindow(() => now);
    window.observe("main", [{ paneId: "%1", agent: null }]);
    window.mark("main", "%1", "omp");
    now += LAUNCH_WINDOW_MS - 10;
    window.observe("main", [{ paneId: "%1", agent: "omp" }]);
    expect(await window.starting("main", "%1", "omp")).toBe("omp");
    now += 10;
    expect(await window.starting("main", "%1", "omp")).toBeNull();
  });

  test("an agent that exits is forgotten, and a pane the poll no longer lists is too", async () => {
    const window = new LaunchWindow();
    window.observe("main", [{ paneId: "%1", agent: null }, { paneId: "%2", agent: null }]);
    window.observe("main", [{ paneId: "%1", agent: "omp" }, { paneId: "%2", agent: "omp" }]);
    window.framed("main", "%1", "omp");
    window.observe("main", [{ paneId: "%1", agent: null }]);
    expect(window.expecting("main", "%2")).toBeNull();
    // %1's agent left: when it is named again, it is starting again.
    window.observe("main", [{ paneId: "%1", agent: "omp" }]);
    expect(await window.starting("main", "%1", "omp")).toBe("omp");
  });

  test("the names one harness goes by fold into one", async () => {
    const window = new LaunchWindow(undefined, (name) => (name === "antigravity" ? "agy" : name));
    window.observe("main", [{ paneId: "%1", agent: null }]);
    window.observe("main", [{ paneId: "%1", agent: "antigravity" }]);
    expect(await window.starting("main", "%1", "agy")).toBe("agy");
    expect(await window.starting("main", "%1", "antigravity")).toBe("agy");
  });
});

describe("harnessOfProcesses", () => {
  test("argv[0] names the binary, as a path or a Windows program", () => {
    expect(harnessOfProcesses([{ argv: ["claude", "--resume"] }], BINARIES)).toBe("claude");
    expect(harnessOfProcesses([{ argv: ["/home/op/.local/bin/kiro-cli", "chat"] }], BINARIES)).toBe("kiro");
    expect(harnessOfProcesses([{ argv: ["C:\\Users\\op\\bin\\OMP.EXE"] }], BINARIES)).toBe("omp");
  });

  test("a script run by an interpreter names the binary by its first plain argument (the gang's omp, 18.12.6)", () => {
    expect(harnessOfProcesses([{ argv: ["bun", "/x/omp-18.12.6/node_modules/.bin/omp", "--approval-mode", "write"] }], BINARIES)).toBe("omp");
    expect(harnessOfProcesses([{ argv: ["node", "--no-warnings", "/usr/lib/node_modules/.bin/omp"] }], BINARIES)).toBe("omp");
  });

  test("a shell, an editor, an interpreter running something else, or an empty argv is no harness", () => {
    expect(harnessOfProcesses([{ argv: ["bash"] }, { argv: [] }], BINARIES)).toBeNull();
    expect(harnessOfProcesses([{ argv: ["vim", "omp"] }], BINARIES)).toBeNull();
    expect(harnessOfProcesses([{ argv: ["node", "server.js"] }], BINARIES)).toBeNull();
    expect(harnessOfProcesses([{ argv: ["sh", "/lab/start-omp.sh"] }], BINARIES)).toBeNull();
  });

  test("any process of the foreground group counts", () => {
    expect(harnessOfProcesses([{ argv: ["sh", "-c", "x"] }, { argv: ["claude"] }], BINARIES)).toBe("claude");
  });
});

describe("foregroundHarnessOf", () => {
  const binaries = (): ReadonlyMap<string, string> => BINARIES;

  test("an adapter with no foreground read gives no reader", () => {
    expect(foregroundHarnessOf(undefined, binaries)).toBeUndefined();
  });

  test("a read maps to a harness or to null for a plain shell", async () => {
    const of = foregroundHarnessOf((paneId) => Promise.resolve({ ok: true as const, value: [{ argv: paneId === "%1" ? ["omp"] : ["zsh"] }] }), binaries)!;
    expect(await of("%1")()).toBe("omp");
    expect(await of("%2")()).toBeNull();
  });

  test("a refusal, a throw and a slow read are no read", async () => {
    expect(await foregroundHarnessOf(() => Promise.resolve({ ok: false as const }), binaries)!("%1")()).toBeUndefined();
    expect(await foregroundHarnessOf(() => Promise.reject(new Error("socket gone")), binaries)!("%1")()).toBeUndefined();
    const slow = foregroundHarnessOf(() => new Promise<never>(() => undefined), binaries, 5)!;
    expect(await slow("%1")()).toBeUndefined();
    expect(FOREGROUND_READ_MS).toBeLessThan(LAUNCH_WINDOW_MS);
  });
});

describe("the launch window: a drawn box that reads no keys (gang three, 2026-10-26)", () => {
  test("a box read ends a window; once a probe went unseen in it, only a probe that shows does", () => {
    const window = new LaunchWindow(() => 1_000);
    window.mark("main", "%1", "omp");
    window.drawn("main", "%1", "omp");
    expect(window.expecting("main", "%1")).toBeNull();
    window.mark("main", "%2", "omp");
    expect(window.deaf("main", "%2", "omp")).toBe(1);
    expect(window.deaf("main", "%2", "omp")).toBe(2);
    window.drawn("main", "%2", "omp");
    expect(window.expecting("main", "%2")).toBe("omp");
    expect(window.pending("main", "%2")).toBe(2);
    window.framed("main", "%2", "omp");
    expect(window.expecting("main", "%2")).toBeNull();
    expect(window.pending("main", "%2")).toBe(0);
  });

  test("a window a box read ended opens again for a deaf probe, inside the bound it opened with, never past it", () => {
    let now = 1_000;
    const window = new LaunchWindow(() => now);
    window.mark("main", "%1", "omp");
    now += 10_000;
    window.drawn("main", "%1", "omp");
    expect(window.deaf("main", "%1", "omp")).toBe(1);
    expect(window.expecting("main", "%1")).toBe("omp");
    now += LAUNCH_WINDOW_MS - 10_000;
    expect(window.expecting("main", "%1")).toBeNull();
    expect(window.deaf("main", "%1", "omp")).toBe(0);
  });

  test("each deaf character blocks for PENDING_PROBE_MS from when it was typed; it still keeps the window from a box read", () => {
    let now = 1_000;
    const window = new LaunchWindow(() => now);
    window.mark("main", "%1", "omp");
    // Typed at 1 000, noted 900 ms later after the probe's reads.
    now += 900;
    expect(window.deaf("main", "%1", "omp", 1_000)).toBe(1);
    now = 1_000 + PENDING_PROBE_MS - 1;
    expect(window.pending("main", "%1")).toBe(1);
    now = 1_000 + PENDING_PROBE_MS;
    expect(window.pending("main", "%1")).toBe(0);
    // A new probe that also goes unseen blocks for its own life; the old one counts no more.
    expect(window.deaf("main", "%1", "omp")).toBe(2);
    expect(window.pending("main", "%1")).toBe(1);
    // Both still keep a box read from ending the window: only a probe that shows, or the bound, does.
    window.drawn("main", "%1", "omp");
    expect(window.expecting("main", "%1")).toBe("omp");
    expect(PENDING_PROBE_MS).toBeLessThan(LAUNCH_WINDOW_MS);
  });

    test("no window, another harness, or a pane that settled from a send's proof: not starting, nothing changes", () => {
    const window = new LaunchWindow(() => 1_000);
    expect(window.deaf("main", "%1", "omp")).toBe(0);
    window.mark("main", "%2", "omp");
    expect(window.deaf("main", "%2", "claude")).toBe(0);
    expect(window.pending("main", "%2")).toBe(0);
    window.framed("main", "%3", "omp");
    expect(window.deaf("main", "%3", "omp")).toBe(0);
    expect(window.expecting("main", "%1")).toBeNull();
    expect(window.expecting("main", "%3")).toBeNull();
  });
});
