import { describe, expect, test } from "bun:test";

import { formatMuxKey, MUX_MODIFIERS, MUX_NAMED_KEYS, type MuxModifier } from "../keys.ts";
import { resolveTmuxBinary, TMUX_BINARY_CANDIDATES, tmuxServerArgs } from "./exec.ts";
import { toTmuxKey } from "./keys.ts";
import {
  classifyControlLine,
  LISTING_ARGS,
  parseCreated,
  parseListing,
  saysMissing,
  saysNoServer,
  SEP,
} from "./protocol.ts";

// The pure half of the tmux adapter, pinned directly.
//
// Conformance (../conformance.test.ts) already drives all of this end-to-end through the fixture, so
// nothing here duplicates a capability check. What it adds is the two things a whole-adapter test
// cannot fail loudly on: the exact SENTENCES the real binary answers with (which decide `gone` vs
// `unreachable` vs `refused`), and the closed key table — where the hazard is silent. Probed on tmux
// 3.6b: `send-keys -t %6 Nonsense` TYPED the word "Nonsense" into the pane and exited 0, so a key
// that falls out of the table does not fail, it types.

describe("resolveTmuxBinary", () => {
  test("a configured binary must be absolute and must exist", () => {
    expect(resolveTmuxBinary("/opt/tmux/bin/tmux", (p) => p === "/opt/tmux/bin/tmux")).toBe("/opt/tmux/bin/tmux");
    // A bare name would resolve against a PATH this process does not control — the one thing the
    // fixed-path probe exists to avoid (exec.ts header, ADR 0015).
    expect(resolveTmuxBinary("tmux", () => true)).toBeNull();
    expect(resolveTmuxBinary("/nowhere/tmux", () => false)).toBeNull();
  });

  test("with nothing configured it probes the fixed candidates in order", () => {
    expect(TMUX_BINARY_CANDIDATES.at(0)).toBe("/usr/bin/tmux");
    expect(resolveTmuxBinary("", () => true)).toBe("/usr/bin/tmux");
    expect(resolveTmuxBinary("", (p) => p === "/opt/homebrew/bin/tmux")).toBe("/opt/homebrew/bin/tmux");
    expect(resolveTmuxBinary("", () => false)).toBeNull();
  });
});

describe("tmuxServerArgs", () => {
  test("a name is -L, a path is -S, and empty is tmux's own default server", () => {
    expect(tmuxServerArgs("collieprobe")).toEqual(["-L", "collieprobe"]);
    expect(tmuxServerArgs("/tmp/tmux-1000/default")).toEqual(["-S", "/tmp/tmux-1000/default"]);
    expect(tmuxServerArgs("")).toEqual([]);
    expect(tmuxServerArgs("   ")).toEqual([]);
  });
});

/**
 * A neutral chord, BUILT rather than spelled.
 *
 * Deliberate: the neutral grammar must not appear as a literal string anywhere under
 * `bridge/mux/tmux/` — a translation that matched on somebody else's spelling instead of on the
 * parsed key is the failure this whole seam exists to prevent (M10/04 verifies it with a grep). So
 * the contract's own formatter composes the input here, which is also the stronger assertion.
 */
function chord(key: string, ...modifiers: MuxModifier[]): string {
  return formatMuxKey({ modifiers, key });
}

describe("toTmuxKey", () => {
  test("every named key in the contract's alphabet has a tmux spelling", () => {
    // Totality is the safety property: a key with no entry would be handed to `send-keys` verbatim
    // and typed as text. The `satisfies` in keys.ts pins it at compile time; this pins it at run time.
    const unmapped = MUX_NAMED_KEYS.filter((key) => !toTmuxKey(key).ok);
    expect(unmapped).toEqual([]);
  });

  test("the paging and edit block tmux CAN send", () => {
    expect(toTmuxKey("PageUp")).toEqual({ ok: true, key: "PPage" });
    expect(toTmuxKey("PageDown")).toEqual({ ok: true, key: "NPage" });
    expect(toTmuxKey("Delete")).toEqual({ ok: true, key: "DC" });
    expect(toTmuxKey("Insert")).toEqual({ ok: true, key: "IC" });
    expect(toTmuxKey("Backspace")).toEqual({ ok: true, key: "BSpace" });
  });

  test("a shifted Tab is tmux's back-tab, whole — not a modified Tab", () => {
    expect(toTmuxKey(chord("Tab", "shift"))).toEqual({ ok: true, key: "BTab" });
  });

  test("modifiers become tmux's prefixes, in the contract's canonical order", () => {
    expect(toTmuxKey(chord("c", "ctrl"))).toEqual({ ok: true, key: "C-c" });
    expect(toTmuxKey(chord("Up", "alt"))).toEqual({ ok: true, key: "M-Up" });
    expect(toTmuxKey(chord("a", "ctrl", "alt", "shift"))).toEqual({ ok: true, key: "C-M-S-a" });
  });

  test("tmux has no Super/Command key, so a meta chord is refused rather than sent as Alt", () => {
    expect(toTmuxKey(chord("a", "meta"))).toEqual({ ok: false, reason: "meta" });
    // Every other modifier survives, so the door is not closed over the missing one.
    for (const modifier of MUX_MODIFIERS.filter((m) => m !== "meta")) {
      expect(toTmuxKey(`${modifier}+a`).ok).toBe(true);
    }
  });

  test("a `;` key is escaped, because tmux's argument lexer eats a bare one", () => {
    expect(toTmuxKey(";")).toEqual({ ok: true, key: "\\;" });
    expect(toTmuxKey(chord(";", "ctrl"))).toEqual({ ok: true, key: "C-\\;" });
  });

  test("anything outside the alphabet is refused before a process is spawned", () => {
    expect(toTmuxKey("Nonsense")).toEqual({ ok: false, reason: "unparsed" });
    expect(toTmuxKey(chord("Nonsense", "ctrl"))).toEqual({ ok: false, reason: "unparsed" });
    expect(toTmuxKey("")).toEqual({ ok: false, reason: "unparsed" });
  });
});

describe("parseListing", () => {
  const listing = [
    ["S", "$0", "2", "1787171890", "collie"].join(SEP),
    ["W", "@0", "$0", "0", "1", "2", "0", "agents"].join(SEP),
    ["P", "%0", "@0", "$0", "0", "1", "1", "24", "30", "bluefin", "/home/dev", "claude", "a title"].join(SEP),
  ].join("\n");

  test("the three tagged sections parse into three lists", () => {
    const parsed = parseListing(listing);
    expect(parsed.sessions).toEqual([{ id: "$0", name: "collie", windows: 2, activity: 1787171890 }]);
    expect(parsed.windows).toEqual([
      { id: "@0", sessionId: "$0", index: 0, active: true, panes: 2, autoNamed: false, name: "agents" },
    ]);
    expect(parsed.panes.at(0)?.id).toBe("%0");
    expect(parsed.panes.at(0)?.historySize).toBe(30);
    expect(parsed.panes.at(0)?.title).toBe("a title");
    // The raw foreground process name, carried as a fact and never as an identity (../types.ts §
    // MuxPane.agent). The adapter still reports this pane as a shell.
    expect(parsed.panes.at(0)?.currentCommand).toBe("claude");
  });

  test("a free-text field carrying the separator folds into itself rather than shifting the record", () => {
    const withSeparator = ["P", "%1", "@0", "$0", "0", "0", "0", "24", "0", "host", "/tmp", "bash", `odd${SEP}title`].join(SEP);
    const pane = parseListing(withSeparator).panes.at(0);
    expect(pane?.cwd).toBe("/tmp");
    expect(pane?.title).toBe(`odd${SEP}title`);
  });

  test("a malformed or unknown line is dropped, never half-read", () => {
    const parsed = parseListing(["", "garbage", ["P", ""].join(SEP), listing].join("\n"));
    expect(parsed.panes).toHaveLength(1);
  });

  test("tmux 3.4 prints the separator as the text `\\037`, and it parses to the same records", () => {
    // Byte-exact from a tmux 3.4 herd (Ubuntu 24.04), where `od -c` showed `\ 0 3 7` as four
    // separate characters where the byte should be. 3.6b does not escape it, which is the whole
    // reason this shape was never seen: on 3.4 every line failed the split, the listing parsed to
    // ZERO rows at exit code 0, and the bridge stored an empty herd while reporting `connected`.
    const escaped = listing.replaceAll(SEP, "\\037");
    expect(escaped).toContain("S\\037$0\\0372");
    expect(escaped).not.toContain(SEP);
    expect(parseListing(escaped)).toEqual(parseListing(listing));
  });

  test("only the separator is un-escaped — a title that spells it is left alone", () => {
    // On an escaping tmux a real backslash arrives doubled, so `\\037` is the operator's text and
    // not a separator. Un-escaping the vis alphabet wholesale would rewrite it on a guess.
    const line = ["P", "%2", "@0", "$0", "0", "0", "0", "24", "0", "host", "/tmp", "bash", "spells \\\\037 here"]
      .join(SEP)
      .replaceAll(SEP, "\\037");
    expect(parseListing(line).panes.at(0)?.title).toBe("spells \\\\037 here");
  });

  test("a line that carries the raw byte is never rewritten by the escape reader", () => {
    // This tmux is not escaping anything, so a literal `\037` in a title is text the operator typed.
    const line = ["P", "%3", "@0", "$0", "0", "0", "0", "24", "0", "host", "/tmp", "bash", "literal \\037 text"].join(SEP);
    expect(parseListing(line).panes.at(0)?.title).toBe("literal \\037 text");
  });

  test("a client record carries its tty — the only handle `switch-client` accepts", () => {
    const client = parseListing(["C", "collie-tmux", "0", "42", "/dev/pts/3"].join(SEP)).clients.at(0);
    expect(client).toEqual({ sessionId: "collie-tmux", control: false, activity: 42, tty: "/dev/pts/3" });
  });

  test("the listing asks for its fields rather than parsing a human table", () => {
    expect(LISTING_ARGS).toContain("-F");
    // One invocation, four commands — sessions, windows, panes, clients — joined by tmux's own `;`
    // separator, as its lexer reads it.
    expect(LISTING_ARGS.filter((arg) => arg === ";")).toHaveLength(3);
    expect(LISTING_ARGS).toContain("list-clients");
  });
});

describe("parseCreated", () => {
  test("a create verb's one line becomes the fresh pane's identity", () => {
    expect(parseCreated(["%17", "@16", "$5", "collie-live", "/tmp"].join(SEP))).toEqual({
      paneId: "%17",
      windowId: "@16",
      sessionId: "$5",
      sessionName: "collie-live",
      cwd: "/tmp",
    });
  });

  test("a create line escaped the tmux 3.4 way is the same creation", () => {
    const raw = ["%17", "@16", "$5", "collie-live", "/tmp"].join(SEP);
    expect(parseCreated(raw.replaceAll(SEP, "\\037"))).toEqual(parseCreated(raw));
  });

  test("anything without a pane id is not a creation", () => {
    expect(parseCreated("")).toBeNull();
    expect(parseCreated("\n")).toBeNull();
  });
});

describe("the sentences tmux answers with", () => {
  // Verbatim from the probe. These decide `gone` vs `unreachable` vs `refused`, which is the one
  // distinction a route branches on.
  test("a missing target is `gone`, whatever kind it was", () => {
    expect(saysMissing("can't find pane: %999")).toBe(true);
    expect(saysMissing("can't find window: @999")).toBe(true);
    expect(saysMissing("can't find session: $999")).toBe(true);
    expect(saysMissing("duplicate session: other")).toBe(false);
  });

  test("an absent server is `unreachable`, and a refusal is neither", () => {
    expect(saysNoServer("no server running on /tmp/tmux-1000/collieprobe")).toBe(true);
    expect(saysNoServer("error connecting to /tmp/tmux-1000/colliegone (No such file or directory)")).toBe(true);
    expect(saysNoServer("duplicate session: other")).toBe(false);
    expect(saysNoServer("can't find pane: %999")).toBe(false);
  });

  test("a server that died DURING the call is `unreachable` too — the transport, not a refusal", () => {
    expect(saysNoServer("server exited unexpectedly")).toBe(true);
    expect(saysNoServer("lost server")).toBe(true);
  });
});

describe("classifyControlLine", () => {
  test("`%output` names the pane that changed, carried verbatim", () => {
    expect(classifyControlLine("%output %8 \\033[32mhi\\033[0m")).toEqual({ kind: "pane", paneId: "%8" });
  });

  test("structure notifications are topology, and the rest is ignored", () => {
    for (const line of ["%window-add @11", "%window-renamed @11 x", "%unlinked-window-close @11", "%sessions-changed"]) {
      expect(classifyControlLine(line)).toEqual({ kind: "topology" });
    }
    // A `%` line this adapter was never taught is ignored rather than read as a change — so a future
    // tmux notification cannot become a topology storm on its own.
    for (const line of ["%begin 1 1 0", "%end 1 1 0", "%session-changed $0 probe", "%invented-tomorrow", "plain text"]) {
      expect(classifyControlLine(line)).toEqual({ kind: "ignore" });
    }
    expect(classifyControlLine("%exit")).toEqual({ kind: "exit" });
  });
});
