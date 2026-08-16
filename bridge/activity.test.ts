import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ActivityLedger,
  coerceActivityFile,
  meaningfulTabLabel,
  meaningfulTerminalTitle,
  PRUNE_AFTER_MS,
} from "./activity.ts";

// A ledger over a throwaway state dir with a controllable clock. The debounce is set absurdly high
// so no test ever races a background write — the ones that care about disk call flush() explicitly.
function ledger(start = 1_000_000) {
  let now = start;
  const stateDir = mkdtempSync(join(tmpdir(), "collie-activity-"));
  const l = new ActivityLedger({ stateDir }, () => now, 60 * 60 * 1000);
  return {
    l,
    stateDir,
    at: (t: number) => {
      now = t;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The one derivation the whole feature rests on. Mirrors the client's `isUnseen`. */
const unseen = (a: { activeAt: number; seenAt: number } | undefined) =>
  !!a && a.activeAt > a.seenAt;

describe("meaningfulTabLabel", () => {
  test("keeps a real name", () => {
    expect(meaningfulTabLabel("fix-auth", 1)).toBe("fix-auth");
    expect(meaningfulTabLabel("fix-auth", 4)).toBe("fix-auth");
  });

  test("drops herdr's positional default in a single-tab space", () => {
    expect(meaningfulTabLabel("1", 1)).toBeUndefined();
    expect(meaningfulTabLabel("7", 1)).toBeUndefined();
  });

  test("keeps the positional label once there is something to disambiguate", () => {
    expect(meaningfulTabLabel("1", 2)).toBe("1");
    expect(meaningfulTabLabel("2", 9)).toBe("2");
  });

  test("treats blank and whitespace-only labels as absent", () => {
    expect(meaningfulTabLabel("", 3)).toBeUndefined();
    expect(meaningfulTabLabel("   ", 3)).toBeUndefined();
    expect(meaningfulTabLabel(undefined, 3)).toBeUndefined();
  });

  test("trims, so a padded label doesn't render with its padding", () => {
    expect(meaningfulTabLabel("  deploy  ", 2)).toBe("deploy");
    // …and a padded positional default is still recognised as positional.
    expect(meaningfulTabLabel("  1  ", 1)).toBeUndefined();
  });
});

describe("meaningfulTerminalTitle", () => {
  const title = (t: string | null | undefined, stripped?: string | null) =>
    meaningfulTerminalTitle(t, stripped, "claude", "moonward_os");

  test("keeps a real title", () => {
    expect(title("Reviewing the auth diff")).toBe("Reviewing the auth diff");
  });

  test("strips the status glyph Herdr leaves behind", () => {
    // Live-observed 2026-08-15 (herdr 0.8.0): the raw title keeps its spinner frame and so does
    // Herdr's "stripped" form, because Herdr only knows the settled glyph.
    expect(title("◐ Custom UI for Collie", "◐ Custom UI for Collie")).toBe("Custom UI for Collie");
    expect(title("✳ Read Notes From Underground", "Read Notes From Underground")).toBe(
      "Read Notes From Underground",
    );
  });

  test("is stable as the spinner advances — the whole point", () => {
    // Every frame of the rotation must land on ONE label, or the row's name flickers each poll.
    const frames = ["◐", "◑", "◒", "◓", "✳", "✻", "✽", "✢", "*", "·"];
    const labels = new Set(frames.map((f) => title(`${f} Reconcile the book lists`)));
    expect(labels).toEqual(new Set(["Reconcile the book lists"]));
  });

  test("leaves a title that merely opens with punctuation alone", () => {
    // The glyph rule requires a symbol from the spinner blocks; these are neither.
    expect(title("(main) vim src/app.ts")).toBe("(main) vim src/app.ts");
    expect(title("~/dev/collie — bun test")).toBe("~/dev/collie — bun test");
  });

  test("drops a title that is only a spinner frame — it names nothing", () => {
    expect(title("◐")).toBeUndefined();
    expect(title("◐   ")).toBeUndefined();
    expect(title("✳ ◐")).toBeUndefined();
  });

  test("drops a title that repeats what the row already shows", () => {
    // Herdr falls back to the process name when nothing sets a title.
    expect(title("claude")).toBeUndefined();
    expect(title("Claude")).toBeUndefined();
    expect(title("moonward_os")).toBeUndefined();
    expect(title("  MOONWARD_OS  ")).toBeUndefined();
  });

  test("drops a shell's locator title — it restates the cwd the row already shows", () => {
    // Live-observed 2026-08-15: an unattended shell pane reports bash's `\u@\h:\w` verbatim.
    expect(title("altan@bluefin:~/projects/workspace-sprqvntrs/tgl")).toBeUndefined();
    expect(title("user@host: ~/x")).toBeUndefined(); // Debian's variant spaces after the colon.
    expect(title("user@host")).toBeUndefined(); // …and some configs print no path at all.
    expect(title("◐ user@host:~")).toBeUndefined(); // the glyph strip runs first.
  });

  test("keeps a shell title that names the command it is running", () => {
    // The locator is dropped because it restates the cwd; a command title is the work itself.
    expect(title("vim foo.ts")).toBe("vim foo.ts");
    expect(title("htop")).toBe("htop");
    expect(title("make")).toBe("make");
    // Both halves of a locator are space-free, so a title that merely mentions an address stays.
    expect(title("foo@bar baz")).toBe("foo@bar baz");
  });

  test("treats blank, whitespace-only and absent titles as absent", () => {
    expect(title("")).toBeUndefined();
    expect(title("   ")).toBeUndefined();
    expect(title(undefined)).toBeUndefined();
    expect(title(null)).toBeUndefined();
    expect(title(null, null)).toBeUndefined();
  });

  test("takes Herdr's strip as a head start when it is the shorter of the two", () => {
    expect(title("✳ Reconcile the book lists", "Reconcile the book lists")).toBe(
      "Reconcile the book lists",
    );
  });

  test("works on an older server that reports no stripped form at all", () => {
    expect(meaningfulTerminalTitle("◐ Fixing the parser", undefined, "claude", "collie")).toBe(
      "Fixing the parser",
    );
  });

  test("a zero tab count (workspace missing from the poll) is treated as single-tab", () => {
    expect(meaningfulTabLabel("1", 0)).toBeUndefined();
    expect(meaningfulTabLabel("build", 0)).toBe("build");
  });
});

describe("ActivityLedger — first sighting", () => {
  test("seeds activeAt === seenAt, so a fresh install shows nothing unseen", () => {
    const { l } = ledger();
    l.ensure("default", "w0:p1");
    const a = l.get("default", "w0:p1")!;
    expect(a.activeAt).toBe(1_000_000);
    expect(a.seenAt).toBe(1_000_000);
    expect(unseen(a)).toBe(false);
  });

  test("is idempotent — a second sighting never re-stamps", () => {
    const { l, advance } = ledger();
    l.ensure("default", "w0:p1");
    advance(5000);
    l.ensure("default", "w0:p1");
    expect(l.get("default", "w0:p1")!.seenAt).toBe(1_000_000);
  });
});

describe("ActivityLedger — the unseen derivation", () => {
  test("a transition after the last look marks the pane unseen", () => {
    const { l, advance } = ledger();
    l.ensure("default", "w0:p1");
    advance(60_000);
    l.noteActive("default", "w0:p1");
    expect(unseen(l.get("default", "w0:p1"))).toBe(true);
  });

  test("opening the pane clears it", () => {
    const { l, advance } = ledger();
    l.ensure("default", "w0:p1");
    advance(60_000);
    l.noteActive("default", "w0:p1");
    advance(1000);
    l.noteSeen("default", "w0:p1");
    expect(unseen(l.get("default", "w0:p1"))).toBe(false);
  });

  test("finishing AGAIN after you looked makes it unseen again", () => {
    const { l, advance } = ledger();
    l.ensure("default", "w0:p1");
    advance(10_000);
    l.noteSeen("default", "w0:p1");
    advance(10_000);
    l.noteActive("default", "w0:p1");
    expect(unseen(l.get("default", "w0:p1"))).toBe(true);
  });

  test("noteActive preserves seenAt and noteSeen preserves activeAt", () => {
    const { l, at } = ledger();
    l.ensure("default", "w0:p1");
    at(2_000_000);
    l.noteActive("default", "w0:p1");
    at(3_000_000);
    l.noteSeen("default", "w0:p1");
    expect(l.get("default", "w0:p1")).toEqual({ activeAt: 2_000_000, seenAt: 3_000_000 });
  });

  test("noteActive on an unknown pane seeds it as seen, not as an alert", () => {
    // Defensive: a transition should always follow a sighting, but if the ledger somehow missed the
    // seed, inventing an unread alert out of nothing is the worse failure.
    const { l } = ledger();
    l.noteActive("default", "w0:p9");
    expect(unseen(l.get("default", "w0:p9"))).toBe(false);
  });
});

describe("ActivityLedger — sessions are isolated", () => {
  test("the same pane id in two sessions keeps separate state", () => {
    const { l, at } = ledger();
    l.ensure("default", "w0:p1");
    l.ensure("demo", "w0:p1");
    at(2_000_000);
    l.noteActive("default", "w0:p1");

    expect(unseen(l.get("default", "w0:p1"))).toBe(true);
    expect(unseen(l.get("demo", "w0:p1"))).toBe(false);
  });

  test("forgetting a pane in one session leaves the other alone", () => {
    const { l } = ledger();
    l.ensure("default", "w0:p1");
    l.ensure("demo", "w0:p1");
    l.forget("default", "w0:p1");
    expect(l.get("default", "w0:p1")).toBeUndefined();
    expect(l.get("demo", "w0:p1")).toBeDefined();
  });
});

describe("ActivityLedger — reconcile", () => {
  test("seeds new panes and reaps gone ones", () => {
    const { l } = ledger();
    l.reconcile("default", ["w0:p1", "w0:p2"]);
    expect(l.get("default", "w0:p1")).toBeDefined();
    expect(l.get("default", "w0:p2")).toBeDefined();

    l.reconcile("default", ["w0:p2"]);
    expect(l.get("default", "w0:p1")).toBeUndefined();
    expect(l.get("default", "w0:p2")).toBeDefined();
  });

  test("does not disturb a surviving pane's timestamps", () => {
    const { l, at } = ledger();
    l.reconcile("default", ["w0:p1"]);
    at(2_000_000);
    l.noteActive("default", "w0:p1");
    at(3_000_000);
    l.reconcile("default", ["w0:p1", "w0:p2"]);
    expect(l.get("default", "w0:p1")).toEqual({ activeAt: 2_000_000, seenAt: 1_000_000 });
  });

  test("an empty herd clears the session, and a reused pane id starts clean", () => {
    const { l, at } = ledger();
    l.reconcile("default", ["w0:p1"]);
    at(2_000_000);
    l.noteActive("default", "w0:p1");
    l.reconcile("default", []);
    expect(l.get("default", "w0:p1")).toBeUndefined();

    at(3_000_000);
    l.reconcile("default", ["w0:p1"]);
    expect(l.get("default", "w0:p1")).toEqual({ activeAt: 3_000_000, seenAt: 3_000_000 });
  });

  test("reconciling one session never touches another", () => {
    const { l } = ledger();
    l.reconcile("default", ["w0:p1"]);
    l.reconcile("demo", ["w0:p1"]);
    l.reconcile("default", []);
    expect(l.get("demo", "w0:p1")).toBeDefined();
  });
});

describe("coerceActivityFile", () => {
  const now = 1_000_000_000;

  test("keeps well-formed entries", () => {
    const raw = { default: { "w0:p1": { activeAt: now - 1000, seenAt: now - 500 } } };
    expect(coerceActivityFile(raw, now)).toEqual(raw);
  });

  test("drops entries past the prune horizon", () => {
    const raw = {
      default: {
        fresh: { activeAt: now - 1000, seenAt: now - 1000 },
        stale: { activeAt: now - PRUNE_AFTER_MS - 1, seenAt: now - PRUNE_AFTER_MS - 1 },
      },
    };
    expect(coerceActivityFile(raw, now)).toEqual({
      default: { fresh: { activeAt: now - 1000, seenAt: now - 1000 } },
    });
  });

  test("keeps an entry whose newest timestamp is inside the horizon", () => {
    // Old activity but a recent look — still live.
    const raw = {
      default: { p: { activeAt: now - PRUNE_AFTER_MS - 5000, seenAt: now - 1000 } },
    };
    expect(coerceActivityFile(raw, now).default!.p).toBeDefined();
  });

  test("drops a session left empty by pruning", () => {
    const old = now - PRUNE_AFTER_MS - 1;
    const raw = { default: { stale: { activeAt: old, seenAt: old } } };
    expect(coerceActivityFile(raw, now)).toEqual({});
  });

  test("survives garbage without throwing", () => {
    expect(coerceActivityFile(null, now)).toEqual({});
    expect(coerceActivityFile("nope", now)).toEqual({});
    expect(coerceActivityFile({ default: 42 }, now)).toEqual({});
    expect(coerceActivityFile({ default: { p: { activeAt: "x", seenAt: 1 } } }, now)).toEqual({});
    expect(coerceActivityFile({ default: { p: { activeAt: NaN, seenAt: 1 } } }, now)).toEqual({});
    expect(coerceActivityFile({ default: { p: null } }, now)).toEqual({});
  });
});

describe("ActivityLedger — persistence", () => {
  test("a flushed ledger reloads identically", async () => {
    const { l, stateDir } = ledger();
    l.reconcile("default", ["w0:p1", "w0:p2"]);
    l.noteActive("default", "w0:p1");
    await l.flush();

    const reloaded = new ActivityLedger({ stateDir }, () => 1_000_000);
    await reloaded.load();
    expect(reloaded.snapshot()).toEqual(l.snapshot());
    reloaded.stop();
  });

  test("a missing file loads as empty rather than throwing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "collie-activity-"));
    const l = new ActivityLedger({ stateDir }, () => 1);
    await l.load();
    expect(l.snapshot()).toEqual({});
    l.stop();
  });

  test("flush with nothing dirty is a no-op", async () => {
    const { l } = ledger();
    await l.flush(); // must not throw or write
    expect(l.snapshot()).toEqual({});
  });

  test("prunes stale entries on load", async () => {
    const { l, stateDir, at } = ledger();
    l.ensure("default", "w0:p1");
    await l.flush();

    const later = new ActivityLedger({ stateDir }, () => 1_000_000 + PRUNE_AFTER_MS + 1);
    await later.load();
    expect(later.get("default", "w0:p1")).toBeUndefined();
    later.stop();
    at(0);
  });
});
