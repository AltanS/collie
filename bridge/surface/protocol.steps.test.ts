// The Send Protocol against the scripted fake multiplexer: part steps. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { muxRefused } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { BOUNDS, LATE_PROBE, boxMatches, commandBoxMatches, uploadAlone, wholePaste, LOCK_BOUND_MS, locateText, probeLanding, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { OFFERED, DIALOG, FRAMELESS, FakePane, HerdrCodexPane, PROBE, type Rig, dir, neverEscape, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("S0", () => {
  test("a dialog on screen is refused not_free with the Surface, nothing typed", async () => {
    const { pane, send } = rig();
    pane.dialog = DIALOG;
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(answer.surface?.modal).not.toBe("none");
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("a draft in the box is refused draft_present with Append, Replace and Cancel", async () => {
    const { pane, send } = rig();
    pane.box = "half a thought";
    const answer = await send("hello");
    // The draft is proven first (2026-10-25): the probe and one Backspace are the only keys, and the box is as it was.
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(pane.calls).toEqual(["type:⌁"]);
    expect(pane.keysSeen).toEqual(["Backspace"]);
    expect(pane.box).toBe("half a thought");
  });

  test("a running turn on a harness that does not queue is refused turn_running, nothing typed", async () => {
    const { pane, send } = rig({ edit: (profile) => ({ ...profile, keys: { ...profile.keys, enterWhileRunning: "ignored" } }) });
    pane.over = ["✻ Thinking… (12s · esc to interrupt)"];
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(answer.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
  });

  test("a timer that ticks between the two reads is not a moved box", async () => {
    const { pane, send } = rig();
    let second = 12;
    pane.over = [`✻ Thinking… (${String(second)}s · ↓ 300 tokens)`];
    pane.beforeRead = (p) => {
      second++;
      p.over = [`✻ Thinking… (${String(second)}s · ↓ ${String(300 + second)} tokens)`];
    };
    expect((await send("hello there, agent")).receipt).toMatchObject({ outcome: "sent", queued: true });
  });

  test("a placeholder that changes on the empty box between the two reads is not a moved box", async () => {
    const { pane, send } = rig();
    pane.placeholder = "Press up to edit queued messages";
    pane.beforeRead = (p, n) => {
      if (n === 2) p.placeholder = 'Try "fix the failing tests"';
    };
    expect((await send("hello there, agent")).receipt).toMatchObject({ outcome: "sent" });
  });

  test("a suggestion painted in the placeholder colour is no draft, and its change between the reads no moved box (#510)", async () => {
    // Muse's prompt hint: ghost text in rgb(175,177,179), no faint attribute, words no text list
    // names. The profile names the colour, so the box reads free; before, every send was refused
    // draft_present.
    const { pane, send } = rig({
      edit: (profile) => ({ ...profile, idle: { ...profile.idle, placeholders: { ...profile.idle.placeholders, fg: ["rgb(175,177,179)"] } } }),
    });
    pane.placeholderPaint = "fg";
    pane.placeholder = "Run the test suite and fix any failures";
    pane.beforeRead = (p, n) => {
      if (n === 2) p.placeholder = "Now open a pull request for it";
    };
    expect((await send("hello there, agent")).receipt).toMatchObject({ outcome: "sent" });
  });

  test("a box that changes between the two reads is refused not_free", async () => {
    const { pane, send } = rig();
    pane.beforeRead = (p, n) => {
      if (n === 2) p.box = "someone typed at the desk";
    };
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(answer.detail).toMatch(/moved between two reads/u);
  });

  test("a pane that cannot be read is refused pane_gone", async () => {
    const { pane, send } = rig();
    pane.readFails = true;
    expect((await send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("a pane that now holds another program is refused pane_gone", async () => {
    const r = rig();
    let calls = 0;
    const deps = { ...r.deps, generation: () => (++calls === 1 ? "gen-1" : "gen-2") };
    const protocol = new SendProtocol(deps);
    const answer = await protocol.handle({ id: "gen-change-01", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("every read is fresh: S0 reads twice after the request arrived, never a cached screen", async () => {
    const { pane, send } = rig();
    await send("hello world");
    // two S0 reads, then S1 and S2 each at least once
    expect(pane.readsSeen).toBeGreaterThanOrEqual(4);
  });
});

describe("the probe", () => {
  test("a dialog that swallows input fails the probe, and no corrective key is sent", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.swallow = true;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("a field above the box that echoes the probe fails it: the box did not take it", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.echo = { field: "", changesList: false };
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a Backspace that does not give the box back fails the probe", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    pane.backspaceRestores = false;
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("the probe takes at most three reads, and the late-probe window two more on an idle pane", async () => {
    const { pane, send } = rig({ version: "2.1.999" });
    let probeReads = 0;
    pane.beforeRead = (p) => {
      if (p.box.includes(PROBE) || p.calls.length === 1) probeReads++;
    };
    pane.swallow = true;
    await send("hello there");
    expect(probeReads).toBeLessThanOrEqual(BOUNDS.probe.reads + LATE_PROBE.reads);
  });

  // A herdr-core crew member on workshop (2026-10-30): keys ["probe", "Backspace"], `probe_failed`,
  // "Collie could not confirm the box was clean". One write there opens a socket, attaches and paints
  // the screen, so the two writes ate the probe's read bound and the Backspace half never read.
  describe("on a multiplexer whose writes are slow (herdr-core, 2026-10-30)", () => {
    /** Every text write and key press costs `ms` on the rig's clock; reads cost nothing. */
    const slowWrites = (r: Rig, ms: number): void => {
      r.pane.beforeWrite = () => {
        r.clock.now += ms;
      };
    };
    /** The probe character shows in the box on the second read after its write, not the first. */
    const lateEcho = (pane: FakePane): void => {
      let held = false;
      let reads = 0;
      pane.afterInput = (p, what) => {
        if (what !== `type:${PROBE}`) return;
        p.box = p.box.slice(0, -PROBE.length);
        held = true;
        reads = 0;
      };
      pane.beforeRead = (p) => {
        if (!held || ++reads < 2) return;
        p.box += PROBE;
        held = false;
      };
    };

    test("writes of 300 ms each stay outside the probe's read bound: the Backspace read passes and the send goes on", async () => {
      const r = rig({ version: "2.1.999" });
      slowWrites(r, 300);
      lateEcho(r.pane);
      const answer = await r.send("hello there");
      expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(answer.receipt?.detail).toBeUndefined();
      // The two writes are their own lap; the probe's own gap is its reads (80 + 160, then 80).
      expect(answer.receipt?.gapsMs.probeWrite).toBe(600);
      expect(answer.receipt?.gapsMs.probe).toBe(320);
    });

    test("a Backspace held three seconds behind the raw probe write (herdr-core 0.1.14, measured 2026-10-30) still reads", async () => {
      // On a private hc session `terminal.keys` answered about 3030 ms after a `typeRaw`, whatever the gap
      // between them; a raw write took 1 ms. Before the fix this was the workshop receipt word for word.
      const r = rig({ version: "2.1.999" });
      r.pane.beforeWrite = (_p, what) => {
        if (what.startsWith("keys:")) r.clock.now += 3000;
      };
      const answer = await r.send("hello there");
      expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(answer.receipt?.gapsMs.probeWrite).toBe(3000);
      expect(answer.receipt?.gapsMs.probe).toBeLessThanOrEqual(BOUNDS.probe.ms);
    });

    test("a Backspace half that starts with almost no time left still reads once", async () => {
      const r = rig({ version: "2.1.999" });
      // The read that shows the probe takes 800 ms: the typed half spends 880 of its 900, 20 are left.
      let slow = true;
      let backReads = 0;
      r.pane.beforeRead = (p) => {
        if (p.box.endsWith(PROBE) && slow) {
          slow = false;
          r.clock.now += 800;
        }
        if (p.keysSeen.length === 1 && p.keysSeen[0] === "Backspace") backReads++;
      };
      const answer = await r.send("hello there");
      expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
      expect(backReads).toBeGreaterThanOrEqual(1);
    });

    test("a failed probe's receipt says where the time went: its reads and its writes", async () => {
      const r = rig({ version: "2.1.999" });
      slowWrites(r, 300);
      r.pane.backspaceRestores = false;
      const answer = await r.send("hello there");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
      expect(answer.receipt?.gapsMs.probeWrite).toBe(600);
      expect(answer.receipt?.gapsMs.probe).toBeGreaterThan(0);
      expect(answer.receipt?.gapsMs.probe).toBeLessThanOrEqual(BOUNDS.probe.ms);
    });
  });
});

describe("the write and S1", () => {
  test("a write the multiplexer refuses is refused write_failed, nothing submitted", async () => {
    const r = rig({ paste: false });
    r.pane.typeText = () => Promise.resolve(muxRefused("no room"));
    const protocol = new SendProtocol({ ...r.deps, mux: { readGrid: r.pane.readGrid, typeText: r.pane.typeText } });
    const answer = await protocol.handle({ id: "write-fail-01", text: "hello world", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "write_failed", keys: [] });
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("a write_failed receipt keeps a fixed Collie sentence, never the multiplexer's words; the log keeps them", async () => {
    const r = rig({ paste: false });
    r.pane.typeText = () => Promise.resolve(muxRefused("tmux: can't find pane: %7 /run/user/1000/tmux-1000/default"));
    const protocol = new SendProtocol({ ...r.deps, mux: { readGrid: r.pane.readGrid, typeText: r.pane.typeText } });
    const logged: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...lines: string[]): void => {
      logged.push(lines.join(" "));
    });
    let answer: SendAnswer;
    try {
      answer = await protocol.handle({ id: "write-fail-02", text: "hello world", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    } finally {
      warn.mockRestore();
    }
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "write_failed", detail: "Collie could not type into the pane." });
    const stored = r.deps.store.get("write-fail-02")?.receipt;
    expect(stored?.detail).toBe("Collie could not type into the pane.");
    expect(JSON.stringify(stored)).not.toContain("tmux");
    expect(readFileSync(join(dir, "sends", "write-fail-02.json"), "utf8")).not.toContain("/run/user");
    expect(logged.some((line) => line.includes("write_failed") && line.includes("can't find pane: %7"))).toBe(true);
  });

  test("a box that shows other text ends typed_not_submitted with Submit and Discard, no Enter", async () => {
    const { pane, send } = rig();
    pane.dropLastChar = true;
    const answer = await send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch", keys: [] });
    expect(answer.offers).toEqual(["submit", "discard", "keys"]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe("hello worl");
  });

  test("a modal cue between S0 and S1 ends typed_not_submitted modal_cue, no Enter", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.popup = ["  ❯ src/main.ts", "    src/other.ts", "  Enter to select · Esc to cancel"];
    };
    const answer = await send("see the file");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a popup under the box (more rows there) ends typed_not_submitted changed", async () => {
    const { pane, send } = rig();
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.popup = ["  src/main.ts", "  src/other.ts"];
    };
    const answer = await send("look at main");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a transcript row that moved while typing ends typed_not_submitted changed, where Enter does not queue", async () => {
    const { pane, send } = rig({ edit: (profile) => ({ ...profile, keys: { ...profile.keys, enterWhileRunning: "submits" } }) });
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.transcript[0] = "> a different question";
    };
    expect((await send("hello world")).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("a transcript row that moved while a command was typed ends typed_not_submitted changed, where Enter queues", async () => {
    const { pane, send } = rig();
    pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:")) p.transcript[0] = "> a different question";
    };
    expect((await send("/compact", { mode: "command" })).receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("commit", () => {
  test("submit-sent is on disk before the key", async () => {
    const r = rig();
    let phaseAtEnter: string | undefined;
    r.pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") phaseAtEnter = r.deps.store.list().at(-1)?.phase;
    };
    await r.send("hello world");
    expect(phaseAtEnter).toBe("submit-sent");
  });

  test("a slow submit-sent write does not spend the token: the Enter still goes out (crew browser leg case 13, 2026-10-27)", async () => {
    const r = rig();
    const realMark = r.deps.store.markSubmitSent.bind(r.deps.store);
    r.deps.store.markSubmitSent = (id: string) => {
      r.clock.now += 400;
      realMark(id);
    };
    const answer = await r.send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(r.pane.keysSeen).toContain("Enter");
  });

  test("a token that ages past 150 ms before the key is refused stale_token: typed_not_submitted, no Enter", async () => {
    const r = rig();
    const realMint = r.deps.gate.mint.bind(r.deps.gate);
    r.deps.gate.mint = (...args: Parameters<typeof realMint>) => {
      const token = realMint(...args);
      r.clock.now += 151;
      return token;
    };
    const answer = await r.send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "stale_token", keys: [] });
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("a person's key between S1 and the commit is refused stale_surface: no Enter", async () => {
    const r = rig();
    const realMark = r.deps.store.markSubmitSent.bind(r.deps.store);
    r.deps.store.markSubmitSent = (id: string) => {
      realMark(id);
      void r.deps.gate.press("%1", ["Down"], "person_tap");
    };
    const answer = await r.send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "stale_surface" });
    expect(r.pane.keysSeen).toEqual(["Down"]);
  });
});

describe("S2", () => {
  test("Enter went out but the box never emptied: unknown, never resent", async () => {
    const { pane, send } = rig();
    pane.enterSubmits = false;
    const answer = await send("hello world");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", keys: ["Enter"] });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual(["Enter"]);
  });
});

describe("the offers as new requests", () => {
  test("append: the text goes after the draft, then Enter", async () => {
    const { pane, send } = rig();
    pane.box = "first half";
    const answer = await send(" second half", { mode: "append", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> first half second half");
  });

  test("replace: the draft is cleared with Backspace (never Escape), then the text is sent", async () => {
    const { pane, send } = rig();
    pane.box = "old draft";
    const answer = await send("new words", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.transcript.at(-1)).toBe("> new words");
    expect(pane.keysSeen.filter((k) => k === "Backspace").length).toBeGreaterThanOrEqual("old draft".length);
    neverEscape(pane);
  });

  test("replace with a slash command (the belt's Model onto a draft): Replace and Cancel only, then the box is emptied and the command sent", async () => {
    const { pane, send } = rig();
    pane.box = "old draft";
    pane.afterInput = (p, what) => {
      if (what.startsWith("paste:/")) p.popup = ["  /model       Set the AI model for Claude Code", "  /mcp         Manage MCP servers"];
      if (what.endsWith("Enter")) p.popup = null;
    };
    const refused = await send("/model", { mode: "command" });
    expect(refused.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    // Add would send "old draft /model", a message nobody means: a command is offered Replace and Cancel only.
    expect(refused.offers).toEqual(["replace", "cancel"]);
    // The same request id again is a replay of the stored receipt, with the same two offers.
    const replayed = await send("/model", { id: refused.receipt!.requestId, mode: "command" });
    expect(replayed).toMatchObject({ replayed: true, receipt: { reason: "draft_present" }, offers: ["replace", "cancel"] });
    // A plain message onto the same draft keeps all three, and so does its replay.
    const plain = await send("a plain thought");
    expect(plain.offers).toEqual(["append", "replace", "cancel"]);
    expect((await send("a plain thought", { id: plain.receipt!.requestId })).offers).toEqual(["append", "replace", "cancel"]);
    const answer = await send("/model", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    // Each request that read the draft proved it with one probe; a replay reads nothing and types nothing.
    expect(pane.calls).toEqual(["type:⌁", "type:⌁", "type:⌁", "paste:/model"]);
    expect(pane.transcript.at(-1)).toBe("> /model");
    expect(pane.keysSeen.filter((k) => k === "Backspace").length).toBeGreaterThanOrEqual("old draft".length);
    neverEscape(pane);
  });

  test("replace: the clear is its own step, so S0 keeps its two reads and its own gap", async () => {
    const r = rig();
    r.pane.box = "old draft";
    let reads = 0;
    r.pane.beforeRead = () => {
      reads++;
      // Every read is slow; two of them fit S0's 1200 ms, the clear's reads would not.
      r.clock.now += 400;
    };
    const answer = await r.send("new words", { mode: "replace", rowsHash: OFFERED });
    console.log("DEBUG", JSON.stringify(answer.receipt));
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.gapsMs.s0).toBeLessThanOrEqual(1200);
    expect(answer.receipt?.gapsMs.clear).toBeGreaterThan(0);
    expect(reads).toBeGreaterThan(2);
  });

  test("replace: a clear that runs past its bound ends unknown, and no text is written", async () => {
    const r = rig();
    r.pane.box = "old draft";
    // The probe's own Backspace still works; the clear's do not.
    const base = r.pane.writeKeys;
    r.pane.writeKeys = (paneId, keys) => {
      const ack = base(paneId, keys);
      r.pane.backspaceRestores = false;
      return ack;
    };
    const answer = await r.send("new words", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(r.pane.calls).toEqual(["type:⌁"]);
    neverEscape(r.pane);
  });

  test("submit after typed_not_submitted: Enter on the text that is there", async () => {
    const { pane, send } = rig();
    pane.dropLastChar = true;
    await send("hello world");
    pane.dropLastChar = false;
    const answer = await send("hello worl", { mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(Object.keys(answer.receipt?.gapsMs ?? {}).toSorted()).toEqual(["commit", "s0", "s2"]);
    expect(pane.transcript.at(-1)).toBe("> hello worl");
  });

  test("submit is refused when the box no longer holds that text", async () => {
    const { pane, send } = rig();
    pane.box = "something else";
    expect((await send("hello", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(pane.keysSeen).toEqual([]);
  });

  /** Codex on Herdr with a row under the box that changes once the box holds more than the probe: S1 never passes. */
  const stuckCodex = () => {
    const pane = new HerdrCodexPane();
    const render = pane.render.bind(pane);
    pane.render = () => (pane.box.length > 1 ? render().replace("  GPT-6-Luna medium", "  ❯ hello-world.ts") : render());
    return { r: rig({ pane, harness: FRAMELESS }), pane };
  };
  const typedNotSubmitted = async (r: Rig, text: string): Promise<SendAnswer> => {
    const look = await r.send(text);
    return r.send(text, { rowsHash: look.rowsHash! });
  };

  test("typed_not_submitted on a pane with no frame offers Submit and Discard, and carries the rows hash it saw", async () => {
    const { r } = stuckCodex();
    const answer = await typedNotSubmitted(r, "hello there");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch", keys: ["probe", "Backspace"] });
    expect(answer.offers).toEqual(["submit", "discard", "keys"]);
    expect(answer.rowsHash).toMatch(/^[0-9a-f]+$/u);
  });

  test("submit with no frame: Enter through the gate on the rows the person saw, and sent once the box reads empty again", async () => {
    const { r, pane } = stuckCodex();
    const typed = await typedNotSubmitted(r, "hello there");
    const answer = await r.send("hello there", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe("> hello there");
    neverEscape(pane);
  });

  test("discard with no frame: Backspace as often as the text is long plus the slack, and discarded once the box reads empty", async () => {
    const { r, pane } = stuckCodex();
    const typed = await typedNotSubmitted(r, "hello there");
    pane.keysSeen = [];
    const answer = await r.send("hello there", { mode: "discard", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.box).toBe("");
    expect(pane.keysSeen).toEqual(Array.from({ length: "hello there".length + 16 }, () => "Backspace"));
    neverEscape(pane);
  });

  /** The box holds "hello ther" (one character short) after the text went in, with the earlier message of the same text standing in the history. */
  const shortBox = async () => {
    const { r, pane } = stuckCodex();
    pane.sent = ["hello there"];
    pane.dropLastChar = true;
    const typed = await typedNotSubmitted(r, "hello there");
    pane.dropLastChar = false;
    expect(typed.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.box).toBe("hello ther");
    return { r, pane, typed };
  };

  test("submit with no frame when the box holds a different text (send drill 3, 7b): Enter went, so it is sent, and the detail says the text differed", async () => {
    const { r, pane, typed } = await shortBox();
    const answer = await r.send("hello there", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(answer.detail).toBe("The box held a different text than the request when Enter went out.");
    expect(pane.transcript.at(-1)).toBe("> hello ther");
    expect(pane.box).toBe("");
    neverEscape(pane);
  });

  test("discard with no frame when the box holds a different text (send drill 3, 7d): judged by the box being empty after the Backspaces", async () => {
    const { r, pane, typed } = await shortBox();
    pane.keysSeen = [];
    const answer = await r.send("hello there", { mode: "discard", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.box).toBe("");
    expect(pane.keysSeen).toEqual(Array.from({ length: "hello ther".length + 16 }, () => "Backspace"));
    neverEscape(pane);
  });

  test("submit and discard with no frame need the rows hash, and a screen that moved since is refused with both offers again", async () => {
    const { r, pane } = stuckCodex();
    const typed = await typedNotSubmitted(r, "hello there");
    pane.keysSeen = [];
    expect((await r.send("hello there", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    // The status row under the box changes: inside the rows the hash covers.
    const drawn = pane.render.bind(pane);
    pane.render = () => drawn().replace(" · ~/", " · Reply ready · ~/");
    const moved = await r.send("hello there", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(moved.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface", keys: [] });
    expect(moved.offers).toEqual(["submit", "discard", "keys"]);
    expect(moved.rowsHash).not.toBe(typed.rowsHash);
    expect(pane.keysSeen).toEqual([]);
    expect((await r.send("hello there", { mode: "submit", rowsHash: moved.rowsHash! })).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
  });

  test("submit on a framed box that shows other text goes on the rows hash the person saw; without it, it is refused", async () => {
    const { pane, send } = rig();
    pane.dropLastChar = true;
    const typed = await send("hello world");
    expect(typed.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(typed.offers).toEqual(["submit", "discard", "keys"]);
    pane.dropLastChar = false;
    expect((await send("hello world", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    const answer = await send("hello world", { mode: "submit", rowsHash: typed.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.transcript.at(-1)).toBe("> hello worl");
    expect(answer.detail).toBe("The box held a different text than the request when Enter went out.");
  });

  test("discard: the box is emptied with Backspace, and the outcome says discarded", async () => {
    const { pane, send } = rig();
    pane.box = "do not send this";
    const answer = await send("do not send this", { mode: "discard" });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.box).toBe("");
    neverEscape(pane);
  });
});

describe("the lock", () => {
  test("a second request on the same pane while one runs is refused busy", async () => {
    const { pane, protocol } = rig();
    let release: () => void = () => undefined;
    pane.beforeRead = (_p, n) => (n === 1 ? new Promise<void>((resolve) => (release = resolve)) : undefined);
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = protocol.handle({ id: "lock-first-01", text: "first", mode: "send" }, target);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await protocol.handle({ id: "lock-second-1", text: "second", mode: "send" }, target);
    expect(second.receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    release();
    expect((await first).receipt?.outcome).toBe("sent");
  });

  test("a request past the sum of the bounds ends unknown, keeps its file and releases the lock", async () => {
    const r = rig();
    r.pane.beforeRead = (_p, n) => {
      if (n === 3) r.clock.now += LOCK_BOUND_MS + 1;
    };
    const answer = await r.send("slow multiplexer");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "bound" });
    expect(r.deps.store.get(answer.receipt!.requestId)?.phase).toBe("settled");
    r.pane.beforeRead = null;
    // The lock is free again: the next request is read, not refused busy (the text of the first is in the box).
    expect((await r.send("the next one")).receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
  });

  test("S0 past its own bound (2 reads, 1200 ms) is refused bound before anything is written", async () => {
    const r = rig();
    // Two reads of 900 ms each: 900 + 120 + 900 = 1920 ms, past S0's 1200 ms though far inside the request's bound.
    r.pane.beforeRead = () => {
      r.clock.now += 900;
    };
    const answer = await r.send("slow screen");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound", keys: [], s0: null });
    expect(answer.offers).toEqual(["keys"]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.deps.store.get(answer.receipt!.requestId)?.phase).toBe("settled");
  });

  test("S0 does not start its second read when the gap alone would cross the bound", async () => {
    const r = rig();
    r.pane.beforeRead = () => {
      r.clock.now += 1100;
    };
    const answer = await r.send("slow screen");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound" });
    expect(r.pane.readsSeen).toBe(1);
  });

  test("S0 within its bound still goes through", async () => {
    const r = rig();
    r.pane.beforeRead = (_p, n) => {
      if (n <= 2) r.clock.now += 500;
    };
    const answer = await r.send("a fair screen");
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.gapsMs.s0).toBe(1120);
  });

  test("a lock past its bound is free for the next request", () => {
    const locks = new SessionLocks();
    expect(locks.acquire("k", "a", 100, 0)).toBe(true);
    expect(locks.acquire("k", "b", 200, 50)).toBe(false);
    expect(locks.acquire("k", "b", 300, 101)).toBe(true);
    expect(locks.owns("k", "a", 101)).toBe(false);
  });
});

describe("bounded lock", () => {
  /** A multiplexer call that spends the request's bound down to 300 ms on the fake clock, then never answers. */
  function hangNearTheBound(clock: { now: number }): Promise<void> {
    clock.now += LOCK_BOUND_MS - 500;
    return new Promise<void>(() => undefined);
  }

  test("a hung text write ends unknown inside the bound, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    pane.beforeWrite = (_p, what) => (what.includes("this write never answers") ? hangNearTheBound(r.clock) : undefined);
    const started = Date.now();
    const answer = await r.send("this write never answers");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "bound", keys: [] });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.offers).toEqual(["keys"]);
    expect(r.deps.store.get(answer.receipt!.requestId)?.phase).toBe("settled");
    // The lock was released with the outcome: the next tap is read and answered, never refused busy.
    pane.beforeWrite = null;
    const next = await r.send("the next tap");
    expect(next.receipt?.reason).not.toBe("busy");
    expect(next.receipt?.outcome).toBe("sent");
    neverEscape(pane);
  });

  test("a hung Enter ends unknown inside the bound, resends nothing, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    pane.beforeWrite = (_p, what) => (what === "keys:Enter" ? hangNearTheBound(r.clock) : undefined);
    const started = Date.now();
    const answer = await r.send("this Enter never answers");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "bound" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual([]);
    pane.beforeWrite = null;
    // The text is still in the box (the Enter never left), so the next tap is refused for the draft, not for the lock.
    const next = await r.send("the next tap");
    expect(next.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    neverEscape(pane);
  });

  test("a read that hangs after Enter ends unknown at S2's bound, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    const clock = r.clock;
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    // S2 has 3000 ms; the first read after Enter spends all but 300 ms of it on the fake clock, then never answers.
    pane.beforeRead = () => {
      if (!entered) return undefined;
      clock.now += 2700;
      return new Promise<void>(() => undefined);
    };
    const started = Date.now();
    const answer = await r.send("this read never answers");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(Date.now() - started).toBeLessThan(2000);
    pane.beforeRead = null;
    entered = false;
    expect((await r.send("the next tap")).receipt?.reason).not.toBe("busy");
    neverEscape(pane);
  });

  test("a second tap inside the bound is refused busy, and the lock is free the moment the first settles", async () => {
    const pane = new FakePane();
    const { protocol } = rig({ pane });
    let release: () => void = () => undefined;
    pane.beforeRead = (_p, n) => (n === 1 ? new Promise<void>((resolve) => (release = resolve)) : undefined);
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = protocol.handle({ id: "bound-first-01", text: "first", mode: "send" }, target);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await protocol.handle({ id: "bound-second-1", text: "second", mode: "send" }, target)).receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    release();
    expect((await first).receipt?.outcome).toBe("sent");
    pane.beforeRead = null;
    expect((await protocol.handle({ id: "bound-third-01", text: "third", mode: "send" }, target)).receipt?.reason).not.toBe("busy");
  });
});

describe("the crash case", () => {
  test("submit-sent without a settled outcome reads as unknown after a restart, never resent", async () => {
    const storeDir = join(dir, "crash");
    const before = new RequestStore(storeDir);
    before.accept({ id: "crash-req-001", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    before.markSubmitSent("crash-req-001");
    // The bridge died here. A new one starts over the same directory.
    const { pane, protocol } = rig({ storeDir });
    const answer = await protocol.handle({ id: "crash-req-001", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
    expect(answer.replayed).toBe(true);
    // Read, report: the pane as it reads now rides on the answer and on the receipt as S2.
    expect(answer.receipt?.s2).toMatchObject({ revision: expect.any(Number), hash: expect.any(String) });
    expect(answer.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(answer.rowsHash).toEqual(expect.any(String));
    expect(answer.detail).toContain("restarted");
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a request the start-up recovery settled reads the pane when the phone asks again", async () => {
    const storeDir = join(dir, "crash3");
    const before = new RequestStore(storeDir);
    before.accept({ id: "crash-req-003", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    before.markSubmitSent("crash-req-003");
    new RequestStore(storeDir).recover(SendProtocol.crashReceipt);
    const { pane, protocol } = rig({ storeDir });
    pane.box = "hello";
    const answer = await protocol.handle({ id: "crash-req-003", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
    expect(answer.surface).toMatchObject({ composer: "draft" });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("a crash look that cannot read the pane still answers unknown, with no screen", async () => {
    const storeDir = join(dir, "crash4");
    const before = new RequestStore(storeDir);
    before.accept({ id: "crash-req-004", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    const { pane, protocol } = rig({ storeDir });
    pane.readFails = true;
    const answer = await protocol.handle({ id: "crash-req-004", text: "hello", mode: "send" }, { session: "main", paneId: "%1", harness: "claude" });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "crash", s2: null });
    expect(answer.surface).toBeUndefined();
  });

  test("the start-up recovery settles it the same way", () => {
    const store = new RequestStore(join(dir, "crash2"));
    store.accept({ id: "crash-req-002", session: "main", paneId: "%1", paneGeneration: "gen-1", surfaceRevision: 0, mode: "send", text: "hello" });
    store.markSubmitSent("crash-req-002");
    const [settled] = new RequestStore(join(dir, "crash2")).recover(SendProtocol.crashReceipt);
    expect(settled?.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
  });
});

describe("pure helpers", () => {
  test("boxMatches ignores white space and wrapping, and takes a one-line collapse form", () => {
    const collapse = /\[Pasted text #(?<n>\d+)(?: \+(?<lines>\d+) lines)?\]/uy;
    expect(boxMatches("hello wor ld", "", ["hello world"], collapse)).toBe(true);
    expect(boxMatches("hello world!", "", ["hello world"], collapse)).toBe(false);
    expect(boxMatches("draft more", "draft", [" more"], collapse)).toBe(true);
    expect(boxMatches("[Pasted text #2]", "", ["x".repeat(500)], collapse)).toBe(true);
    expect(boxMatches("[Pasted text #2 +11 lines]", "", ["x".repeat(500)], collapse)).toBe(false);
    expect(boxMatches("a [Pasted text #1] b", "", ["a", "y".repeat(300), "b"], collapse)).toBe(true);
    expect(boxMatches("[Pasted text #2]", "", ["short"], null)).toBe(false);
  });

  test("boxMatches takes ONE collapse form for a whole multi-line text only when it claims the text's line breaks", () => {
    const collapse = /\[Pasted text #(?<n>\d+)(?: \+(?<lines>\d+) lines)?\]/uy;
    const three = ["a", "b", "c"];
    const whole = { images: 0, image: null, lines: three, literal: three };
    expect(boxMatches("[Pasted text #4 +2 lines]", "", three, collapse, whole)).toBe(true);
    expect(boxMatches(" [Pasted text #4 +2 lines] ", "", three, collapse, whole)).toBe(true);
    expect(boxMatches("[Pasted text #4 +3 lines]", "", three, collapse, whole)).toBe(false);
    expect(boxMatches("[Pasted text #4]", "", three, collapse, whole)).toBe(false);
    expect(boxMatches("[Pasted text #4 +2 lines] tail", "", three, collapse, whole)).toBe(false);
    expect(boxMatches("draft [Pasted text #4 +2 lines]", "draft", three, collapse, whole)).toBe(true);
    expect(boxMatches("[Pasted text #4 +2 lines]", "", three, null, whole)).toBe(false);
    // A text written per line never reads as one fold: Hermes, opencode, pi and Cursor keep that rule.
    expect(boxMatches("[Pasted text #4 +2 lines]", "", three, collapse)).toBe(false);
  });

  test("boxMatches reads a whole paste's image tokens before its text, as many as were taken off", () => {
    const collapse = /\[Pasted text #(?<n>\d+)(?: \+(?<lines>\d+) lines)?\]/uy;
    const image = /\[Image #\d+\]/uy;
    const shot = "/srv/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const one = { images: 1, image, lines: ["look at this"], literal: [`look at this ${shot}`] };
    expect(boxMatches("[Image #3]look at this", "", one.lines, collapse, one)).toBe(true);
    expect(boxMatches("look at this", "", one.lines, collapse, one)).toBe(false);
    const two = { images: 2, image, lines: ["a", "b"], literal: ["a", shot, "b", shot] };
    expect(boxMatches("[Image #9] [Image #10][Pasted text #11 +1 lines]", "", two.lines, collapse, two)).toBe(true);
    expect(boxMatches("[Image #9][Pasted text #11 +1 lines]", "", two.lines, collapse, two)).toBe(false);
    // The box may wrap inside a token (ADR 0010): the row break reads as white space.
    expect(boxMatches("draft [Image #1][Pasted text #2 +1 li nes]", "draft", two.lines, collapse, { ...two, images: 1 })).toBe(true);
    expect(boxMatches("[Ima ge #1][Pasted text #2]", "", ["one long line"], collapse, { images: 1, image, lines: ["one long line"], literal: [`one long line ${shot}`] })).toBe(true);
    expect(boxMatches("[Pasted text #2 +1 lines]", "", ["one long line"], collapse, { images: 0, image, lines: ["one long line"], literal: ["one long line"] })).toBe(false);
  });

  test("boxMatches also takes the literal form of a paste whose images the harness kept as text (Claude Code 2.1.312)", () => {
    const collapse = /\[Pasted text #(?<n>\d+)(?: \+(?<lines>\d+) lines)?\]/uy;
    const image = /\[Image #\d+\]/uy;
    const shot = "/srv/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    // The field case of 2026-10-29: the first paragraph ends with the upload path, a blank line, a second paragraph.
    const literal = [`also mobile looks off ${shot}`, "", "menu should be a bottom sheet"];
    const whole = { images: 1, image, lines: ["also mobile looks off", "", "menu should be a bottom sheet"], literal };
    // 2.1.305 took the path off the paste; 2.1.312 leaves it in, on a row of its own (the frame joins rows with a space).
    expect(boxMatches("[Image #1]also mobile looks off menu should be a bottom sheet", "", whole.lines, collapse, whole)).toBe(true);
    expect(boxMatches(`also mobile looks off ${shot} menu should be a bottom sheet`, "", whole.lines, collapse, whole)).toBe(true);
    // Neither form: the path gone AND no token, or a token AND the path.
    expect(boxMatches("also mobile looks off menu should be a bottom sheet", "", whole.lines, collapse, whole)).toBe(false);
    expect(boxMatches(`[Image #1]also mobile looks off ${shot} menu should be a bottom sheet`, "", whole.lines, collapse, whole)).toBe(false);
    // A folded literal paste counts every typed line break (lab: 42 lines with the path in them fold to +41); the images form one fewer.
    const three = { images: 1, image, lines: ["see", "b"], literal: ["see", shot, "b"] };
    expect(boxMatches("[Image #1][Pasted text #2 +1 lines]", "", three.lines, collapse, three)).toBe(true);
    expect(boxMatches("[Pasted text #1 +2 lines]", "", three.lines, collapse, three)).toBe(true);
    expect(boxMatches("[Pasted text #1 +1 lines]", "", three.lines, collapse, three)).toBe(false);
    expect(boxMatches("[Pasted text #1 +3 lines]", "", three.lines, collapse, three)).toBe(false);
    // Without images there is no second form.
    const none = { images: 0, image, lines: ["see", "b"], literal: ["see", "b"] };
    expect(boxMatches("[Pasted text #1 +1 lines]", "", none.lines, collapse, none)).toBe(true);
    expect(boxMatches("[Pasted text #1 +2 lines]", "", none.lines, collapse, none)).toBe(false);
  });

  test("uploadAlone: a lone upload path takes the image form or the literal path, nothing else", () => {
    const match = profileFor("claude", "2.1.312", { log: () => undefined });
    const collapse = /\[Pasted text #(?<n>\d+)(?: \+(?<lines>\d+) lines)?\]/uy;
    const shot = "/srv/collie/uploads/_0-mvu6nr4p-8ab21b25.png";
    const windows = String.raw`C:\Users\Me Too\collie\uploads\w1-mf3x9q-0a1b2c3d.PNG`;
    const isShot = (path: string): boolean => path === shot || path === windows || path === "/srv/shots/a.png";
    const alone = uploadAlone(match, [shot], isShot);
    expect(alone).toMatchObject({ images: 1, lines: [""], literal: [shot], folds: false });
    // wholePaste reads it the same way, under its 800-character floor.
    expect(wholePaste(match, [shot], isShot)).toMatchObject({ images: 1, lines: [""], literal: [shot] });
    expect(wholePaste(match, [`  ${shot} `], isShot)).toMatchObject({ images: 1 });
    expect(uploadAlone(match, [windows], isShot)).toMatchObject({ images: 1 });
    for (const box of ["[Image #1]", " [Image #12] ", "[Ima ge #1]", shot, `${shot.slice(0, 40)} ${shot.slice(40)}`]) {
      expect(boxMatches(box, "", alone?.lines ?? [], collapse, alone)).toBe(true);
    }
    for (const box of ["", "[Image #1] x", "[Image #1][Image #2]", `[Image #1]${shot}`, "[Pasted text #1]", "[Image #1][Pasted text #2]", `${shot} x`, shot.slice(1)]) {
      expect(boxMatches(box, "", alone?.lines ?? [], collapse, alone)).toBe(false);
    }
    // Add to a draft: the draft, then either form.
    expect(boxMatches("draft [Image #1]", "draft", alone?.lines ?? [], collapse, alone)).toBe(true);
    expect(boxMatches(`draft ${shot}`, "draft", alone?.lines ?? [], collapse, alone)).toBe(true);
    // Not alone: words around the path, two lines, a missing file, another image path, no image token.
    expect(uploadAlone(match, [`see ${shot}`], isShot)).toBeNull();
    expect(wholePaste(match, [`see ${shot}`], isShot)).toBeNull();
    expect(uploadAlone(match, [shot, "b"], isShot)).toBeNull();
    expect(uploadAlone(match, ["/srv/collie/uploads/_0-mvu6nr4p-ffffffff.png"], isShot)).toBeNull();
    expect(uploadAlone(match, ["/srv/shots/a.png"], isShot)).toBeNull();
    expect(uploadAlone(match, ["/srv/collie/uploads/_0-mvu6nr4p-8ab21b25.txt"], () => true)).toBeNull();
    expect(uploadAlone(match === null ? null : { ...match, profile: { ...match.profile, paste: { bracketed: true } } }, [shot], isShot)).toBeNull();
    expect(uploadAlone(null, [shot], isShot)).toBeNull();
    // A path inside a short line is compared as written: the literal text, never an image form.
    expect(boxMatches(`see ${shot}`, "", [`see ${shot}`], collapse, null)).toBe(true);
    expect(boxMatches("[Image #1]see", "", [`see ${shot}`], collapse, null)).toBe(false);
  });

  test("a fold that counts lines (paste.foldLines, opencode #749): one line is ~1, thirty are ~30, and the line-break count no longer passes", () => {
    const opencode = profileFor("opencode", "2.2.6", { log: () => undefined });
    const collapse = new RegExp(opencode!.profile.collapse.pattern, "uy");
    const thirty = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`);
    const one = ["word ".repeat(300).trim()];
    const wholeThirty = wholePaste(opencode, thirty);
    const wholeOne = wholePaste(opencode, one);
    expect(wholeThirty).toMatchObject({ images: 0, foldsLines: true });
    expect(wholeOne).toMatchObject({ images: 0, foldsLines: true });
    expect(boxMatches("[Pasted ~30 lines]", "", thirty, collapse, wholeThirty)).toBe(true);
    expect(boxMatches("[Pasted ~1 lines]", "", one, collapse, wholeOne)).toBe(true);
    // Claude Code's count, and every other count, is another paste.
    for (const box of ["[Pasted ~29 lines]", "[Pasted ~31 lines]", "[Pasted ~30 lines] x", "[Pasted ~30 lines][Pasted ~30 lines]", "line 1"]) {
      expect(boxMatches(box, "", thirty, collapse, wholeThirty)).toBe(false);
    }
    expect(boxMatches("[Pasted ~0 lines]", "", one, collapse, wholeOne)).toBe(false);
    // A paste opencode inserts literally is compared as typed.
    expect(boxMatches("line 1 line 2", "", ["line 1", "line 2"], collapse, wholePaste(opencode, ["line 1", "line 2"]))).toBe(true);
    expect(boxMatches("line 1 line 3", "", ["line 1", "line 2"], collapse, wholePaste(opencode, ["line 1", "line 2"]))).toBe(false);
    // Claude Code keeps the line breaks: +29 for thirty lines.
    const claude = profileFor("claude", "2.1.304", { log: () => undefined });
    const claudeCollapse = new RegExp(claude!.profile.collapse.pattern, "uy");
    const claudeThirty = wholePaste(claude, thirty);
    expect(claudeThirty?.foldsLines).toBeUndefined();
    expect(boxMatches("[Pasted text #1 +29 lines]", "", thirty, claudeCollapse, claudeThirty)).toBe(true);
    expect(boxMatches("[Pasted text #1 +30 lines]", "", thirty, claudeCollapse, claudeThirty)).toBe(false);
  });

  test("wholePaste: only a profile that measured it, only a long or multi-line text without a reserved lead, upload images taken off", () => {
    const match = profileFor("claude", "2.1.304", { log: () => undefined });
    expect(match?.profile.paste?.block).toBe(true);
    const shot = "/srv/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.jpg";
    const foreign = "/srv/shots/a.jpg";
    const windows = String.raw`C:\Users\Me Too\collie\uploads\w1-mf3x9q-0a1b2c3d.PNG`;
    const isShot = (path: string): boolean => path === shot || path === foreign || path === windows;
    expect(wholePaste(match, ["short"], isShot)).toBeNull();
    expect(wholePaste(match, ["x".repeat(800)], isShot)).toBeNull();
    expect(wholePaste(match, ["x".repeat(801)], isShot)?.images).toBe(0);
    expect(wholePaste(match, ["a", "b"], isShot)).toMatchObject({ images: 0, lines: ["a", "b"] });
    for (const lead of ["/", "!", "@"]) expect(wholePaste(match, [`${lead}x`, "b"], isShot)).toBeNull();
    expect(wholePaste(match, ["see", shot], isShot)).toMatchObject({ images: 1, lines: ["see"] });
    expect(wholePaste(match, [`see ${shot}`, "b"], isShot)).toMatchObject({ images: 1, lines: ["see", "b"], literal: [`see ${shot}`, "b"] });
    expect(wholePaste(match, [`see ${shot} here`, "b"], isShot)).toMatchObject({ images: 0 });
    expect(wholePaste(match, ["see /srv/collie/uploads/w1_p1-mf3x9q-ffffffff.jpg", "b"], isShot)).toMatchObject({ images: 0 });
    // Any other image file on the disk stays text: only Collie's own upload shape is taken off.
    expect(wholePaste(match, ["see", foreign], isShot)).toMatchObject({ images: 0, lines: ["see", foreign] });
    expect(wholePaste(match, [`see ${foreign}`, "b"], isShot)).toMatchObject({ images: 0 });
    expect(wholePaste(match, [`see ${windows}`, "b"], isShot)).toMatchObject({ images: 1, lines: ["see", "b"] });
    expect(wholePaste(match === null ? null : { ...match, profile: { ...match.profile, paste: { bracketed: true } } }, ["a", "b"], isShot)).toBeNull();
    expect(wholePaste(null, ["a", "b"], isShot)).toBeNull();
  });

  test("commandBoxMatches takes the text as written, with its lead cut, or with a mode marker for the lead", () => {
    for (const box of ["!echo ok", "! echo ok", "echo ok", "$ echo ok", "[!] echo ok", "! echo ok"]) expect(commandBoxMatches(box, "", ["!echo ok"], null)).toBe(true);
    for (const box of ["echo okay", "x echo ok", "!echo", ""]) expect(commandBoxMatches(box, "", ["!echo ok"], null)).toBe(false);
  });

  test("locateText takes the lowest row, and with partial the box a Backspace shortened, never the history echo above it", () => {
    const rows = ["› say ok", "• ok", "  Worked for 1s", "› say o", "  GPT-6-Luna medium · ~/repo"];
    // An exact look finds the echo in the history: that is why Submit and Discard ask for the partial one.
    expect(locateText(rows, "say ok")).toMatchObject({ row: 0, head: "› ", partial: false });
    expect(locateText(rows, "say ok", true)).toMatchObject({ row: 3, head: "› ", text: "say o", partial: true });
    expect(locateText(rows.slice(0, 3).concat(["› say ok"]), "say ok", true)).toMatchObject({ row: 3, text: "say ok", partial: false });
    // A footer that only starts alike is not the box: it shares less than all but two characters.
    expect(locateText(["› hello there", "  hello-world.ts"], "hello there", true)).toMatchObject({ row: 0, partial: false });
    expect(locateText(["› zz", "  sa"], "say ok", true)).toBeNull();
  });

  test("probeLanding with freeBelow: the rest of the landing row may change and a row under it may go blank, never show other text", () => {
    const before = ["top", "", "› ", "", "  status", "  ← for agents · ? for shortcuts"];
    expect(probeLanding(before, ["top", "", `› ${PROBE}`, "", "  status", ""], PROBE)).toBeNull();
    expect(probeLanding(before, ["top", "", `› ${PROBE}`, "", "  status", ""], PROBE, { freeBelow: true })).toMatchObject({ row: 2, index: 2 });
    expect(probeLanding(["› Ask anything"], [`› ${PROBE}`], PROBE, { freeBelow: true })).toMatchObject({ row: 0, index: 2 });
    expect(probeLanding(before, ["top", "", `› ${PROBE}`, "", "  ❯ a list entry", ""], PROBE, { freeBelow: true })).toBeNull();
    expect(probeLanding(before, ["top!", "", `› ${PROBE}`, "", "  status", ""], PROBE, { freeBelow: true })).toBeNull();
    expect(probeLanding(before, ["top", "", `› ${PROBE}${PROBE}`, "", "  status", ""], PROBE, { freeBelow: true })).toBeNull();
  });

  test("probeLanding wants exactly one changed row and exactly the probe put in", () => {
    const before = ["top", "", "──", "", "──", "~"];
    expect(probeLanding(before, ["top", "", "──", PROBE, "──", "~"], PROBE)).toMatchObject({ row: 3, index: 0 });
    expect(probeLanding(["›"], [`› ${PROBE}`], PROBE)).toMatchObject({ row: 0, index: 2 });
    expect(probeLanding(before, ["top!", "", "──", PROBE, "──", "~"], PROBE)).toBeNull();
    expect(probeLanding(before, ["top", "", "──", `x${PROBE}`, "──", "~"], PROBE)).toBeNull();
    expect(probeLanding(before, before, PROBE)).toBeNull();
  });
});
